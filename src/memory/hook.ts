// The memory half of `baton hook <agent>`, active wherever the shared memory is enabled
// (any folder, unlike the project handoff which needs `baton init`):
//
//   start: journal what other sessions did since last time (bounded), then hand the agent the brief
//   stop:  journal this agent's own session
//
// Never throws at the agent: failures go to memory.log.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { getAdapter } from "../adapters/index.js";
import type { AgentDirs } from "../core/paths.js";
import type { HookInput } from "../hooks/handler.js";
import { currentInvocation } from "../hooks/install.js";
import type { SessionRef } from "../model.js";
import { buildBrief } from "./brief.js";
import { sessionKey } from "./journal.js";
import { isEnabled, localEnvName, memoryLog } from "./store.js";
import { sync } from "./sync.js";

export interface MemoryHookOptions {
  dir: string;
  dirs: AgentDirs;
  /** How long the start hook may spend journaling before it answers (the rest goes to the background). */
  budgetMs?: number;
  /** Start `baton <args>` detached. Replaced in tests. */
  background?: (args: string[]) => void;
  /** Label for this environment's sessions (default: localEnvName()). */
  envName?: string;
}

const START_BUDGET_MS = 1500;
const OWN_LOOKBACK_MS = 7 * 86_400_000;

export function spawnBaton(args: string[]): void {
  const inv = currentInvocation();
  spawn(inv.command, [...inv.args, ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** This session's ref, with the origin/title only the adapter's listing knows. */
async function ownRef(input: HookInput, dirs: AgentDirs): Promise<SessionRef | undefined> {
  if (!input.sessionId) return undefined;
  const listed = await getAdapter(input.agent)
    .list(dirs, new Date(Date.now() - OWN_LOOKBACK_MS))
    .catch(() => [] as SessionRef[]);
  const hit = listed.find((r) => r.id === input.sessionId);
  if (hit || !input.transcriptPath) return hit;
  const st = await stat(input.transcriptPath).catch(() => undefined);
  return st && { agent: input.agent, id: input.sessionId, cwd: input.cwd, updatedAt: st.mtime, locator: input.transcriptPath };
}

export async function memoryHook(input: HookInput, o: MemoryHookOptions): Promise<string> {
  if (!isEnabled(o.dir)) return "";
  try {
    const envName = o.envName ?? localEnvName();
    if (input.event === "stop") {
      const ref = await ownRef(input, o.dirs);
      if (ref) await sync(o.dir, { dirs: o.dirs, only: [ref], envName });
      return "";
    }
    const r = await sync(o.dir, { dirs: o.dirs, budgetMs: o.budgetMs ?? START_BUDGET_MS, envName });
    if (r.pending) (o.background ?? spawnBaton)(["mem", "sync"]);
    const self = input.sessionId ? sessionKey({ agent: input.agent, id: input.sessionId, env: envName }) : undefined;
    return await buildBrief(o.dir, { excludeSession: self });
  } catch (e) {
    await memoryLog(o.dir, `${input.agent} ${input.event} hook failed: ${(e as Error).stack ?? e}`);
    return "";
  }
}
