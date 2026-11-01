// B of "A + B": make sure every session of every agent has a journal entry, whether or not
// that agent has hooks. Incremental: a session is (re)loaded only when its updatedAt changed.
//
// Listing everything is cheap (~0.4 s for ~300 sessions on a real machine); loading is the
// expensive part, so a time budget bounds how many sessions one call loads (newest first).

import { adapters } from "../adapters/index.js";
import { isWithin, type AgentDirs } from "../core/paths.js";
import type { SessionRef } from "../model.js";
import { journalEntry, sessionKey, writeDays, type JournalEntry } from "./journal.js";
import { localEnvName, memoryPaths, readConfig, readJson, withLock, writeAtomic } from "./store.js";

export interface SyncState {
  version: 1;
  /** Sessions last updated before this are not backfilled (set by `mem init --since`). */
  floor?: string;
  lastSync?: string;
  /** key -> what was recorded; `day` is absent for sessions skipped as empty. */
  sessions: Record<string, { updatedAt: number; day?: string }>;
  /** Sessions the user asked to forget: never journaled again. */
  ignored: string[];
}

export async function readState(dir: string): Promise<SyncState> {
  const s = await readJson<Partial<SyncState>>(memoryPaths(dir).state, {});
  return { version: 1, floor: s.floor, lastSync: s.lastSync, sessions: s.sessions ?? {}, ignored: s.ignored ?? [] };
}

export async function writeState(dir: string, s: SyncState): Promise<void> {
  await writeAtomic(memoryPaths(dir).state, JSON.stringify(s, null, 1) + "\n");
}

export interface SyncOptions {
  dirs: AgentDirs;
  /** Stop loading new sessions after this many ms; the rest are reported as pending. */
  budgetMs?: number;
  /** Only these sessions (a hook syncing its own session). Default: everything listed. */
  only?: SessionRef[];
  /** Rebuild entries even when unchanged. */
  force?: boolean;
  onWarning?: (msg: string) => void;
  /** Environment label for local sessions (default: localEnvName(), "wsl:<distro>" inside WSL). */
  envName?: string;
}

export interface SyncResult {
  written: number;
  /** Started by a program, not a person: skipped unless config.includeHeadless. */
  headless: number;
  empty: number;
  unchanged: number;
  pending: number;
  failed: number;
  ms: number;
}

/**
 * Every session of this environment's agents. Each environment journals only its own sessions into
 * the shared store; `envName` labels them so WSL and host sessions never collide ("claude@wsl:Ubuntu").
 */
export async function listAllSessions(
  dirs: AgentDirs,
  since?: Date,
  onWarning?: (m: string) => void,
  envName: string | undefined = localEnvName(),
): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  for (const a of adapters) {
    if (!(await a.available(dirs).catch(() => false))) continue;
    try {
      refs.push(...(await a.list(dirs, since)).map((r) => withEnv(r, envName)));
    } catch (e) {
      onWarning?.(`${a.name}: ${(e as Error).message}`);
    }
  }
  return refs.sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime());
}

export const withEnv = <T extends { env?: string }>(x: T, envName: string | undefined): T =>
  x.env || !envName ? x : { ...x, env: envName };

export async function sync(dir: string, o: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const cfg = await readConfig(dir);
  const state = await readState(dir);
  const floor = state.floor ? new Date(state.floor) : undefined;
  const envName = o.envName ?? localEnvName();
  const refs = (o.only ?? (await listAllSessions(o.dirs, floor, o.onWarning, envName))).map((x) => withEnv(x, envName));
  const ignored = new Set(state.ignored);
  const r: SyncResult = { written: 0, headless: 0, empty: 0, unchanged: 0, pending: 0, failed: 0, ms: 0 };

  const todo = refs.filter((ref) => {
    const key = sessionKey(ref);
    if (ignored.has(key) || cfg.exclude.some((x) => isWithin(ref.cwd, x))) return false;
    if (!o.force && state.sessions[key]?.updatedAt === ref.updatedAt.getTime()) {
      r.unchanged++;
      return false;
    }
    return true;
  });

  const entries: { ref: SessionRef; entry?: JournalEntry; headless?: boolean }[] = [];
  for (const ref of todo) {
    if (ref.origin === "headless" && !cfg.includeHeadless) {
      entries.push({ ref, headless: true }); // recorded without loading, so it is not looked at again
      continue;
    }
    if (o.budgetMs !== undefined && Date.now() - t0 > o.budgetMs) {
      r.pending++;
      continue;
    }
    const adapter = adapters.find((a) => a.name === ref.agent);
    try {
      // Adapters don't know the environment; the entry's key must match the ref's.
      const s = withEnv(await adapter!.load(ref, o.dirs), ref.env);
      entries.push({ ref, entry: journalEntry(s, cfg.lang) });
    } catch (e) {
      r.failed++;
      o.onWarning?.(`${sessionKey(ref)}: ${(e as Error).message}`);
    }
  }

  if (entries.length || !state.lastSync) {
    await withLock(dir, async () => {
      // Re-read under the lock: another agent's hook may have synced meanwhile.
      const cur = await readState(dir);
      const upserts: JournalEntry[] = [];
      const remove: { key: string; day: string }[] = [];
      for (const { ref, entry, headless } of entries) {
        const key = sessionKey(ref);
        const prev = cur.sessions[key];
        if (entry) {
          upserts.push(entry);
          if (prev?.day && prev.day !== entry.day) remove.push({ key, day: prev.day });
          r.written++;
        } else {
          if (prev?.day) remove.push({ key, day: prev.day });
          if (headless) r.headless++;
          else r.empty++;
        }
        cur.sessions[key] = { updatedAt: ref.updatedAt.getTime(), day: entry?.day };
      }
      await writeDays(dir, upserts, remove);
      if (!o.only) cur.lastSync = new Date().toISOString();
      await writeState(dir, cur);
    });
  }
  r.ms = Date.now() - t0;
  return r;
}

/** Journaled session keys matching a full key, a key prefix, or an id prefix ("codex:019a", "019a"). */
export function matchSessions(st: SyncState, q: string): string[] {
  const keys = Object.keys(st.sessions).filter((k) => st.sessions[k]!.day);
  const exact = keys.filter((k) => k === q);
  if (exact.length) return exact;
  return keys.filter((k) => k.startsWith(q) || k.slice(k.indexOf(":") + 1).startsWith(q));
}

/** Remove a session's entry and never journal it again. */
export async function forgetSession(dir: string, key: string): Promise<boolean> {
  return withLock(dir, async () => {
    const st = await readState(dir);
    const prev = st.sessions[key];
    if (prev?.day) await writeDays(dir, [], [{ key, day: prev.day }]);
    if (!st.ignored.includes(key)) st.ignored.push(key);
    const known = !!prev;
    delete st.sessions[key];
    await writeState(dir, st);
    return known;
  });
}
