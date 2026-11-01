import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDirs } from "../core/paths.js";
import { agentDirs } from "../core/paths.js";

// Tests describe the host environment. Run inside WSL, sessions would otherwise be labelled
// "wsl:<distro>" (localEnvName); tests that need a label pass envName explicitly.
process.env.BATON_ENV_NAME ??= "";

/** A fake HOME with empty agent dirs plus a project directory. */
export function sandbox(): { home: string; project: string; dirs: AgentDirs } {
  const home = mkdtempSync(path.join(tmpdir(), "baton-test-"));
  const project = path.join(home, "work", "my-app");
  mkdirSync(project, { recursive: true });
  const dirs = agentDirs({ BATON_HOME: home } as NodeJS.ProcessEnv);
  return { home, project, dirs };
}

export function writeJsonl(file: string, records: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

import type { Context, MatchMode, Source } from "../core/sources.js";
import { localSource } from "../core/sources.js";

/** A context with this sandbox's agents as the local source, plus any extra sources. */
export function ctxOf(dirs: AgentDirs, extra: Source[] = [], match: MatchMode = "path"): Context {
  return { dirs, sources: [localSource(dirs), ...extra], match };
}

/** A two-message Claude Code session (user asks `text`, assistant answers) in `cwd`. Returns its file. */
export function claudeSession(
  dirs: AgentDirs,
  cwd: string,
  id: string,
  text: string,
  extra: object = {},
  ts = "2026-10-20T01:00:00Z",
): string {
  const file = path.join(dirs.claudeProjects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const base = { cwd, sessionId: id, ...extra };
  const later = new Date(new Date(ts).getTime() + 60_000).toISOString();
  writeJsonl(file, [
    { ...base, type: "user", timestamp: ts, message: { role: "user", content: text } },
    { ...base, type: "assistant", timestamp: later, message: { model: "m", content: [{ type: "text", text: `re: ${text}` }] } },
  ]);
  return file;
}
