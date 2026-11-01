// Discovery across sources + the capture pipeline (load -> extract -> render -> save),
// shared by the CLI and the auto-capture hooks.

import type { SessionRef } from "../model.js";
import { extractCheckpoint, type Checkpoint } from "./extract.js";
import { renderCheckpoint } from "./render.js";
import { gitView, sourceFor, type Context, type MatchMode } from "./sources.js";
import { recordCapture, saveCheckpoint } from "./workspace.js";

export interface DiscoverOptions {
  only?: string;
  exclude?: string;
  onWarning?: (msg: string) => void;
  /** Override the context's match mode. */
  match?: MatchMode;
  /** Repo matching only looks at sessions this recent (default 30 days). */
  since?: Date;
}

const DEFAULT_REPO_WINDOW_MS = 30 * 86_400_000;

/** Sessions of every agent in every source that belong to `root`, newest first. */
export async function discoverAll(root: string, ctx: Context, o: DiscoverOptions = {}): Promise<SessionRef[]> {
  let repo;
  if ((o.match ?? ctx.match) === "repo") {
    repo = (await gitView(root, ctx.sources)).repo;
    if (!repo) o.onWarning?.(`${root} is not a git repository; matching by path only`);
  }
  const q = {
    only: o.only,
    exclude: o.exclude,
    onWarning: o.onWarning,
    repo,
    since: repo ? (o.since ?? new Date(Date.now() - DEFAULT_REPO_WINDOW_MS)) : undefined,
  };
  const per = await Promise.all(ctx.sources.map((s) => s.refs(root, q)));
  const seen = new Set<string>();
  return per
    .flat()
    .filter((r) => {
      const k = `${r.env ?? ""}|${r.agent}|${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export interface CaptureResult {
  checkpoint: Checkpoint;
  markdown: string;
  /** Checkpoint file written, undefined when `write` was false or the session was empty. */
  file?: string;
}

export interface CaptureOptions {
  /** Write to .baton/ (default true). */
  write?: boolean;
  /**
   * "history": new timestamped file per capture (manual `baton capture`).
   * "session": one file per session, overwritten (hooks fire every turn).
   */
  naming?: "history" | "session";
  /** Do not write anything for sessions without a single user message. */
  skipEmpty?: boolean;
}

export async function captureRef(ref: SessionRef, root: string, ctx: Context, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const { write = true, naming = "history", skipEmpty = false } = opts;
  const [session, view] = await Promise.all([sourceFor(ref, ctx.sources).session(root, ref), gitView(root, ctx.sources)]);
  session.clone = ref.clone;
  const checkpoint = extractCheckpoint(session, root);
  const markdown = renderCheckpoint(checkpoint, view.info);
  if (!write || (skipEmpty && checkpoint.session.userTurns === 0)) return { checkpoint, markdown };
  const file = await saveCheckpoint(root, markdown, ref.agent, ref.id, naming);
  await recordCapture(root, ref);
  return { checkpoint, markdown, file };
}
