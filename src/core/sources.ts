// A Source is one environment's agents: this machine, a WSL distro, or the Windows host.
// Everything above this layer (CLI, hooks, capture) works with Sources and local paths only.
//
//   adapterSource  - runs the adapters in this process against some agent dirs
//                    (local; or another environment's files read across the boundary = "direct" mode)
//   nodeSource     - runs baton inside the other environment and talks JSON (`baton export`)

import { adapters, getAdapter } from "../adapters/index.js";
import type { Event, Session, SessionRef } from "../model.js";
import { gitInfoWith, localGit, repoIdentity, type GitInfo, type GitRunner, type RepoId } from "./git.js";
import { matchByRepo } from "./match.js";
import type { AgentDirs } from "./paths.js";

export type MatchMode = "path" | "repo";

export interface SourceQuery {
  only?: string;
  exclude?: string;
  /** Also return sessions from other clones of this repository. */
  repo?: RepoId;
  /** Only consider sessions updated since (repo matching scans everything otherwise). */
  since?: Date;
  onWarning?: (msg: string) => void;
}

export interface GitView {
  info?: GitInfo;
  repo?: RepoId;
}

export interface Source {
  /** undefined for this machine, otherwise e.g. "wsl:Ubuntu". */
  readonly name?: string;
  refs(root: string, q: SourceQuery): Promise<SessionRef[]>;
  session(root: string, ref: SessionRef): Promise<Session>;
  git(root: string): Promise<GitView>;
}

const identity = (p: string) => p;

function isAbsoluteAnywhere(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Translate a session/ref coming from a source into local terms. */
export function localizeRef(r: SessionRef, toLocal: (p: string) => string, env?: string): SessionRef {
  return {
    ...r,
    cwd: toLocal(r.cwd),
    updatedAt: new Date(r.updatedAt),
    clone: r.clone ? { ...r.clone, root: toLocal(r.clone.root) } : undefined,
    env: env ?? r.env,
  };
}

export function localizeSession(s: Session, toLocal: (p: string) => string, env?: string): Session {
  const mapEvent = (e: Event): Event =>
    e.kind === "tool_call" ? { ...e, files: e.files.map((f) => (isAbsoluteAnywhere(f) ? toLocal(f) : f)) } : e;
  return { ...s, cwd: toLocal(s.cwd), updatedAt: new Date(s.updatedAt), events: s.events.map(mapEvent), env: env ?? s.env };
}

export interface AdapterSourceOptions {
  name?: string;
  dirs: AgentDirs;
  /** Local path -> path as recorded in that environment (undefined: unreachable). */
  toForeign?: (p: string) => string | undefined;
  toLocal?: (p: string) => string;
  /** git in that environment, for a directory in its own syntax. */
  gitFor?: (dir: string) => GitRunner;
  /** Agents this source cannot read, with the reason (shown once as a warning). */
  unsupported?: Partial<Record<string, string>>;
}

export function adapterSource(o: AdapterSourceOptions): Source {
  const toForeign = o.toForeign ?? identity;
  const toLocal = o.toLocal ?? identity;
  const gitFor = o.gitFor ?? localGit;
  const usable = (q: SourceQuery) =>
    adapters.filter((a) => {
      if ((q.only && a.name !== q.only) || a.name === q.exclude) return false;
      const why = o.unsupported?.[a.name];
      if (why) q.onWarning?.(`${o.name ?? "local"}: ${a.name} skipped (${why})`);
      return !why;
    });

  return {
    name: o.name,

    async refs(root, q) {
      const fRoot = toForeign(root);
      if (!fRoot) return [];
      const per = await Promise.all(
        usable(q).map(async (a) => {
          try {
            if (!(await a.available(o.dirs))) return [];
            const byPath = await a.discover(fRoot, o.dirs);
            if (!q.repo) return byPath;
            const seen = new Set(byPath.map((r) => r.id));
            const listed = (await a.list(o.dirs, q.since)).filter((r) => !seen.has(r.id));
            return [...byPath, ...matchByRepo(listed, q.repo, gitFor)];
          } catch (e) {
            q.onWarning?.(`${o.name ? o.name + ": " : ""}${a.name} discovery failed: ${(e as Error).message}`);
            return [];
          }
        }),
      );
      return per.flat().map((r) => localizeRef(r, toLocal, o.name));
    },

    async session(_root, ref) {
      // Locators are already in the source's own terms; only the content needs translating.
      const s = await getAdapter(ref.agent).load({ ...ref, cwd: toForeign(ref.cwd) ?? ref.cwd }, o.dirs);
      return localizeSession(s, toLocal, o.name);
    },

    async git(root) {
      const fRoot = toForeign(root);
      if (!fRoot) return {};
      const run = gitFor(fRoot);
      return { info: gitInfoWith(run), repo: repoIdentity(run) };
    },
  };
}

/** What `baton export` prints. Dates travel as ISO strings. */
export interface ExportPayload {
  version: 1;
  refs?: SessionRef[];
  session?: Session;
  git?: GitInfo | null;
  repo?: RepoId | null;
}

export interface NodeSourceOptions {
  name: string;
  toForeign: (p: string) => string | undefined;
  toLocal: (p: string) => string;
  /** Run the other environment's baton with these args; resolves to stdout. */
  run: (args: string[]) => Promise<string>;
}

export function nodeSource(o: NodeSourceOptions): Source {
  const call = async (args: string[]) => JSON.parse(await o.run(args)) as ExportPayload;
  return {
    name: o.name,

    async refs(root, q) {
      const fRoot = o.toForeign(root);
      if (!fRoot) return [];
      const args = ["export", "--root", fRoot];
      if (q.only) args.push("--from", q.only);
      if (q.exclude) args.push("--exclude", q.exclude);
      if (q.repo) {
        // Comma lists: URLs and hashes never contain commas, and plain args survive wsl.exe quoting.
        args.push("--repo-urls", q.repo.urls.join(",") || "-", "--repo-roots", q.repo.roots.join(",") || "-");
        if (q.since) args.push("--since", q.since.toISOString());
      }
      try {
        return ((await call(args)).refs ?? []).map((r) => localizeRef(r, o.toLocal, o.name));
      } catch (e) {
        q.onWarning?.(`${o.name}: ${(e as Error).message}`);
        return [];
      }
    },

    async session(root, ref) {
      const s = (await call(["export", "--from", ref.agent, "--session", ref.id])).session;
      if (!s) throw new Error(`${o.name}: session ${ref.id} not found`);
      return localizeSession(s, o.toLocal, o.name);
    },

    async git(root) {
      const fRoot = o.toForeign(root);
      if (!fRoot) return {};
      const p = await call(["export", "--git", "--root", fRoot]).catch(() => undefined);
      return { info: p?.git ?? undefined, repo: p?.repo ?? undefined };
    },
  };
}

// ------------------------------------------------------------- across sources

export interface Context {
  dirs: AgentDirs;
  /** sources[0] is this machine. */
  sources: Source[];
  match: MatchMode;
}

export function localSource(dirs: AgentDirs): Source {
  return adapterSource({ dirs });
}

/** First source that can read git for `root` wins (the repo may only be readable from its own side). */
export async function gitView(root: string, sources: Source[]): Promise<GitView> {
  for (const s of sources) {
    const v = await s.git(root).catch(() => ({}) as GitView);
    if (v.info || v.repo) return v;
  }
  return {};
}

export function sourceFor(ref: SessionRef, sources: Source[]): Source {
  const s = sources.find((x) => x.name === ref.env);
  if (!s) throw new Error(`environment ${ref.env} is not configured`);
  return s;
}
