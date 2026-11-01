// Auto-capture, called from agent hooks/plugins via `baton hook <agent>`.
//
//   "stop"  (send side):    the agent finished a turn / compacts / exits
//                           -> checkpoint ITS OWN session into .baton/RESUME.md
//   "start" (receive side): a new session starts
//                           -> if ANOTHER agent worked here more recently than this agent did
//                              (e.g. Codex, which has no hooks), capture that session and
//                              return a short context message for the agent to read.
//
// The handoff part is a no-op unless the project ran `baton init`, so a global install never
// litters unrelated projects; the shared-memory part (src/memory/hook.ts) runs everywhere once
// `baton mem init` was done. They never throw at the agent; failures go to .baton/hook.log / memory.log.

import { stat } from "node:fs/promises";
import { getAdapter } from "../adapters/index.js";
import { captureRef, discoverAll } from "../core/capture.js";
import { gitRoot } from "../core/git.js";
import type { Context } from "../core/sources.js";
import { oneLine } from "../core/text.js";
import { hookLog, isInitialized, readCaptures } from "../core/workspace.js";
import { memoryHook, type MemoryHookOptions } from "../memory/hook.js";
import type { AgentName, SessionRef } from "../model.js";

export type HookEvent = "start" | "stop";

export interface HookInput {
  agent: AgentName;
  event: HookEvent;
  cwd: string;
  sessionId?: string;
  /** Claude Code passes the transcript path directly. */
  transcriptPath?: string;
}

/** Map agent-specific event names onto start/stop. Unknown events are ignored. */
export function normalizeEvent(name: string | undefined): HookEvent | undefined {
  switch (name) {
    case "SessionStart":
    case "start":
      return "start";
    case "Stop":
    case "PreCompact":
    case "SessionEnd":
    case "stop":
    case "session.idle":
    case "session.compacted":
    case "session.error":
      return "stop";
    default:
      return undefined;
  }
}

function ago(d: Date): string {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

/**
 * Returns text to hand to the agent as context ("" for none): the project handoff note (projects that
 * ran `baton init`) followed by the shared-memory brief (when `memory` is given and enabled).
 */
export async function runHook(
  input: HookInput,
  ctx: Context | ((root: string) => Promise<Context>),
  memory?: MemoryHookOptions,
): Promise<string> {
  const root = gitRoot(input.cwd) ?? input.cwd;
  const parts: string[] = [];
  if (isInitialized(root)) {
    try {
      // The context may depend on the project (its .baton/config.json), hence the factory form.
      const c = typeof ctx === "function" ? await ctx(root) : ctx;
      parts.push(input.event === "start" ? await onStart(input, root, c) : (await onStop(input, root, c), ""));
    } catch (e) {
      await hookLog(root, `${input.agent} ${input.event} failed: ${(e as Error).stack ?? e}`);
    }
  }
  if (memory) parts.push(await memoryHook(input, memory));
  return parts.filter(Boolean).join("\n\n");
}

async function findOwnRef(input: HookInput, root: string, ctx: Context): Promise<SessionRef | undefined> {
  if (input.transcriptPath && input.sessionId) {
    const st = await stat(input.transcriptPath).catch(() => undefined);
    if (st) {
      return {
        agent: input.agent,
        id: input.sessionId,
        cwd: input.cwd,
        updatedAt: st.mtime,
        locator: input.transcriptPath,
      };
    }
  }
  const refs = await getAdapter(input.agent).discover(root, ctx.dirs);
  return input.sessionId ? refs.find((r) => r.id === input.sessionId) : refs[0];
}

async function onStop(input: HookInput, root: string, ctx: Context): Promise<void> {
  const ref = await findOwnRef(input, root, ctx);
  if (!ref) {
    await hookLog(root, `${input.agent} stop: session ${input.sessionId ?? "?"} not found`);
    return;
  }
  const captured = await readCaptures(root);
  if (captured[`${ref.agent}:${ref.id}`] === ref.updatedAt.getTime()) return; // nothing new
  const r = await captureRef(ref, root, ctx, { naming: "session", skipEmpty: true });
  if (r.file) await hookLog(root, `${input.agent} stop: captured ${ref.id}`);
}

/**
 * Did this agent do real work here after `since`? Sessions that never got a reply or made a
 * tool call (a failed start, a quota error on the first prompt) don't count: otherwise an
 * aborted attempt would hide the other agent's handoff.
 */
async function selfWorkedSince(since: Date, selves: SessionRef[], input: HookInput, ctx: Context): Promise<boolean> {
  const newer = selves.filter((r) => r.id !== input.sessionId && r.updatedAt >= since).slice(0, 5);
  for (const r of newer) {
    const s = await getAdapter(r.agent).load(r, ctx.dirs).catch(() => undefined);
    if (!s || s.events.some((e) => e.kind === "assistant" || e.kind === "tool_call")) return true;
  }
  return false;
}

async function onStart(input: HookInput, root: string, ctx: Context): Promise<string> {
  const warn = (m: string) => void hookLog(root, `warning: ${m}`);
  // One pass over everything (incl. other environments), split afterwards: remote calls are the slow part.
  const all = await discoverAll(root, ctx, { onWarning: warn });
  // The same agent in another environment (Claude Code in WSL vs. on Windows) is a different
  // installation with its own history, and the same agent in another clone worked on other
  // files: both count as "another agent" here.
  const isSelf = (r: SessionRef) => r.agent === input.agent && !r.env && !r.clone;
  const others = all.filter((r) => !isSelf(r));
  const selves = all.filter(isSelf);
  const other = others[0];
  if (!other) return "";
  if (await selfWorkedSince(other.updatedAt, selves, input, ctx)) return ""; // this agent was the last one here

  const r = await captureRef(other, root, ctx, { naming: "session", skipEmpty: true });
  if (!r.file) return "";
  const who = other.env ? `${other.agent} (${other.env})` : other.agent;
  await hookLog(root, `${input.agent} start: handoff from ${who} ${other.id}`);

  const cp = r.checkpoint;
  const lines = [
    `[baton] Handoff detected: ${who} worked on this project after your last session here ` +
      `(last active ${ago(other.updatedAt)}) and ${cp.interruption ? `stopped: ${cp.interruption}` : "finished its last turn"}.`,
  ];
  if (other.clone) {
    lines.push(
      `WARNING: it worked in a different clone (${other.clone.root}${other.clone.branch ? `, branch ${other.clone.branch}` : ""}); ` +
        "its uncommitted changes are not in this working tree. Check with the user / fetch that branch first.",
    );
  }
  const lastReq = cp.recentRequests[cp.recentRequests.length - 1] ?? cp.goal[cp.goal.length - 1];
  if (lastReq) lines.push(`Its last user request: "${oneLine(lastReq, 240)}"`);
  if (cp.todos?.length) {
    const open = cp.todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
    lines.push(
      `Its todo list: ${cp.todos.length - open.length}/${cp.todos.length} done` +
        (open.length ? `; open: ${open.slice(0, 5).map((t) => oneLine(t.content, 80)).join(" | ")}` : ""),
    );
  }
  lines.push(
    "Full checkpoint: .baton/RESUME.md (goal, requests, todos, recent actions, failures, files, git state).",
    "Before new work: read .baton/STATE.md and .baton/RESUME.md, verify with `git status` / `git diff`, " +
      "and fold anything important into .baton/STATE.md. If the user just says \"continue\", continue that agent's task.",
  );
  return lines.join("\n");
}
