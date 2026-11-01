import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync as mkdirSyncFs, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeProjectDir } from "../adapters/claude.js";
import { initProject } from "../core/workspace.js";
import { codexCommands, installCodex, uninstallCodex, type Invocation } from "../hooks/install.js";
import { sandbox, writeJsonl } from "./helpers.js";

const INV: Invocation = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\dev\\多Agent 'x'\\dist\\cli.js"] };

test("codex commands: PowerShell call operator on Windows, POSIX quoting elsewhere", () => {
  const c = codexCommands(INV);
  // Codex runs hook commands through PowerShell on Windows: `&` + single-quoted literals ('' escapes ').
  assert.equal(c.commandWindows, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\dev\\多Agent ''x''\\dist\\cli.js' hook codex");
  assert.equal(c.command, "'C:\\Program Files\\nodejs\\node.exe' 'C:\\dev\\多Agent '\\''x'\\''\\dist\\cli.js' hook codex");
});

test("codex commands: the POSIX form survives a real shell", { skip: process.platform === "win32" && !hasSh() }, () => {
  const c = codexCommands({ command: "echo", args: ["a b", "it's"] });
  const out = execFileSync("sh", ["-c", c.command], { encoding: "utf8" }).trim();
  assert.equal(out, "a b it's hook codex");
});

test("codex commands: the Windows form survives real PowerShell (spaces, CJK, quotes)", { skip: process.platform !== "win32" }, () => {
  const { home } = sandbox();
  const script = path.join(home, "多 Agent 'q'", "echo.mjs");
  mkdirSyncFs(path.dirname(script), { recursive: true });
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))");
  const c = codexCommands({ command: process.execPath, args: [script] });
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", c.commandWindows], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(out), ["hook", "codex"]);
});

function hasSh(): boolean {
  return spawnSync("sh", ["-c", "true"]).status === 0;
}

test("install codex: merges into hooks.json, idempotent, uninstall keeps user hooks", async () => {
  const { home } = sandbox();
  const file = path.join(home, ".codex", "hooks.json");
  const mine = { hooks: [{ type: "command", command: "my-linter" }] };
  mkdirSyncFs(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [mine], Stop: [mine] } }));

  assert.equal(await installCodex(file, INV), "installed");
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop"]);
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 3); // Codex caps SessionEnd at 3s
  assert.equal(s.hooks.Stop[1].hooks[0].async, true);
  assert.match(s.hooks.SessionStart[0].hooks[0].commandWindows, /^& '/);

  assert.equal(await installCodex(file, INV), "unchanged");
  assert.equal(await uninstallCodex(file), "removed");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hooks, { PreToolUse: [mine], Stop: [mine] });
});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function runCli(args: string[], home: string, stdin: string): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, BATON_HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  });
  return { stdout: r.stdout, status: r.status };
}

test("baton hook codex: SessionStart answers with JSON additionalContext, Stop captures", async () => {
  const sb = sandbox();
  await initProject(sb.project);
  // Claude worked here; Codex starts afterwards.
  const claudeFile = path.join(sb.dirs.claudeProjects, encodeProjectDir(sb.project), "c1.jsonl");
  writeJsonl(claudeFile, [
    { type: "user", cwd: sb.project, message: { content: "Task DELTA-5: write delta.txt" } },
    { type: "assistant", cwd: sb.project, message: { content: [{ type: "text", text: "Done." }] } },
  ]);

  const start = runCli(["hook", "codex"], sb.home, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-new", cwd: sb.project }));
  assert.equal(start.status, 0);
  // Plain "[baton] ..." text is rejected by Codex (it looks like JSON); we must emit the structured form.
  const payload = JSON.parse(start.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /Handoff detected: claude[\s\S]*DELTA-5/);

  // Codex's own session, then its Stop hook.
  const rollout = path.join(sb.dirs.codexSessions[0]!, "2026", "rollout-cx.jsonl");
  writeJsonl(rollout, [
    { type: "session_meta", payload: { id: "cx-1", cwd: sb.project, thread_source: "user" } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Task EPSILON-6" }] } } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "ok" }] } } },
  ]);
  const later = new Date(Date.now() + 1000);
  utimesSync(rollout, later, later);
  const stop = runCli(["hook", "codex"], sb.home, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-1", cwd: sb.project, transcript_path: rollout }));
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, ""); // Stop must not print plain text
  assert.match(readFileSync(path.join(sb.project, ".baton", "RESUME.md"), "utf8"), /from a \*\*codex\*\* session[\s\S]*EPSILON-6/);
});
