import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initProject } from "../core/workspace.js";
import { runHook } from "../hooks/handler.js";
import type { Invocation } from "../hooks/install.js";
import { claudeDesktopConfig, connectAgent, connectPaths, withBlock } from "../memory/connect.js";
import { parseDay } from "../memory/journal.js";
import { markdownFiles, memoryPaths, writeConfig } from "../memory/store.js";
import { readState } from "../memory/sync.js";
import { claudeSession, ctxOf, sandbox } from "./helpers.js";

async function memSandbox() {
  const sb = sandbox();
  const dir = path.join(sb.home, "mem");
  await writeConfig(dir, { lang: "en", exclude: [], includeHeadless: false });
  return { ...sb, dir };
}

const now = () => new Date().toISOString();
const journalKeys = async (dir: string) => {
  const keys: string[] = [];
  for (const f of await markdownFiles(memoryPaths(dir).journal)) keys.push(...parseDay(readFileSync(f, "utf8")).map((b) => b.key));
  return keys.sort();
};

test("memory hook start: journals other sessions and returns the brief, in any folder", async () => {
  const { dir, dirs, home } = await memSandbox();
  claudeSession(dirs, home, "earlier", "Plan the Osaka trip", {}, now());
  claudeSession(dirs, path.join(home, "Desktop"), "me", "hello", {}, now());
  const background: string[][] = [];
  const memory = { dir, dirs, background: (a: string[]) => void background.push(a) };

  const text = await runHook({ agent: "claude", event: "start", cwd: path.join(home, "Desktop"), sessionId: "me" }, ctxOf(dirs), memory);
  assert.match(text, /^\[baton memory\]/);
  assert.match(text, /claude "Plan the Osaka trip".*\(claude:earlier\)/);
  assert.ok(!text.includes("claude:me"), "the starting session is not listed as a past conversation");
  assert.deepEqual(await journalKeys(dir), ["claude:earlier", "claude:me"]);
  assert.deepEqual(background, []);

  // Not enabled: silent.
  assert.equal(await runHook({ agent: "claude", event: "start", cwd: home }, ctxOf(dirs), { ...memory, dir: path.join(home, "none") }), "");
});

test("memory hook start: over budget, the rest is synced in the background", async () => {
  const { dir, dirs, home } = await memSandbox();
  claudeSession(dirs, home, "a", "one", {}, now());
  const background: string[][] = [];
  const text = await runHook({ agent: "codex", event: "start", cwd: home }, ctxOf(dirs), { dir, dirs, budgetMs: -1, background: (a) => void background.push(a) });
  assert.match(text, /\[baton memory\]/);
  assert.deepEqual(background, [["mem", "sync"]]);
});

test("memory hook start: project handoff note first, then the brief", async () => {
  const { dir, dirs, project } = await memSandbox();
  await initProject(project);
  claudeSession(dirs, project, "c1", "Fix the login bug", {}, now());
  const text = await runHook({ agent: "opencode", event: "start", cwd: project, sessionId: "o1" }, ctxOf(dirs), { dir, dirs });
  const handoff = text.indexOf("[baton] Handoff detected");
  const brief = text.indexOf("[baton memory]");
  assert.ok(handoff >= 0 && brief > handoff, text);
});

test("memory hook stop: journals only this agent's own session, headless ones not at all", async () => {
  const { dir, dirs, home } = await memSandbox();
  claudeSession(dirs, home, "other", "someone else", {}, now());
  const own = claudeSession(dirs, home, "own", "Remember my dentist on Friday", { entrypoint: "claude-desktop" }, now());
  claudeSession(dirs, home, "bot", "scripted", { entrypoint: "sdk-cli" }, now());
  const memory = { dir, dirs };

  assert.equal(await runHook({ agent: "claude", event: "stop", cwd: home, sessionId: "own", transcriptPath: own }, ctxOf(dirs), memory), "");
  assert.deepEqual(await journalKeys(dir), ["claude:own"]);
  await runHook({ agent: "claude", event: "stop", cwd: home, sessionId: "bot" }, ctxOf(dirs), memory);
  assert.deepEqual(await journalKeys(dir), ["claude:own"]);
  assert.equal((await readState(dir)).sessions["claude:bot"]?.day, undefined);
});

const INV: Invocation = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\tools\\baton's\\dist\\cli.js"] };

test("connect: MCP + rules for all three agents, idempotent, uninstall restores", async () => {
  const { home } = sandbox();
  const env = { BATON_HOME: home } as NodeJS.ProcessEnv;
  const p = { claude: connectPaths("claude", env), codex: connectPaths("codex", env), opencode: connectPaths("opencode", env) };
  for (const x of Object.values(p)) mkdirSync(path.dirname(x.rules), { recursive: true });
  const claudeJson = { userID: "u", projects: { a: {} }, mcpServers: { other: { type: "stdio", command: "x" } } };
  writeFileSync(p.claude.mcp, JSON.stringify(claudeJson, null, 2) + "\n");
  const toml = 'model = "m"\n\n[mcp_servers.other]\ncommand = "x"\n\n[projects.\'c:\\dev\']\ntrust_level = "trusted"\n';
  writeFileSync(p.codex.mcp, toml);
  writeFileSync(p.opencode.mcp, JSON.stringify({ plugin: ["p"] }));
  writeFileSync(p.codex.rules, "# My rules\n\nBe brief.\n");

  for (const a of ["claude", "codex", "opencode"] as const) {
    assert.deepEqual((await connectAgent(a, INV, false, env)).map((r) => r.outcome), ["installed", "installed"], a);
    assert.deepEqual((await connectAgent(a, INV, false, env)).map((r) => r.outcome), ["unchanged", "unchanged"], a);
  }

  const cj = JSON.parse(readFileSync(p.claude.mcp, "utf8"));
  assert.equal(cj.userID, "u");
  assert.deepEqual(cj.mcpServers.other, claudeJson.mcpServers.other);
  assert.deepEqual(cj.mcpServers.baton, { type: "stdio", command: INV.command, args: [INV.args[0], "mcp"], env: {} });

  const ct = readFileSync(p.codex.mcp, "utf8");
  assert.ok(ct.startsWith(toml.trimEnd()), "existing config untouched");
  assert.match(ct, /\[mcp_servers\.baton\]\ncommand = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"\nargs = \["C:\\\\tools\\\\baton's\\\\dist\\\\cli\.js", "mcp"\]\n# <<< baton memory\n$/);

  const oj = JSON.parse(readFileSync(p.opencode.mcp, "utf8"));
  assert.deepEqual(oj.plugin, ["p"]);
  assert.deepEqual(oj.mcp.baton, { type: "local", command: [INV.command, INV.args[0], "mcp"], enabled: true });

  const rules = readFileSync(p.codex.rules, "utf8");
  assert.match(rules, /^# My rules\n\nBe brief\.\n\n<!-- baton:memory:start -->\n## Shared memory \(baton\)/);
  assert.match(rules, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\tools\\baton's\\dist\\cli\.js" mem search/);
  assert.ok(existsSync(p.claude.rules), "a missing CLAUDE.md is created");
  assert.ok(existsSync(p.codex.rules + ".baton-backup") && existsSync(p.claude.mcp + ".baton-backup"));

  // Moved install: entries are updated in place.
  const moved = { ...INV, args: ["D:\\baton\\dist\\cli.js"] };
  assert.deepEqual((await connectAgent("codex", moved, false, env)).map((r) => r.outcome), ["updated", "updated"]);
  assert.equal((readFileSync(p.codex.mcp, "utf8").match(/\[mcp_servers\.baton\]/g) ?? []).length, 1);

  for (const a of ["claude", "codex", "opencode"] as const) {
    assert.deepEqual((await connectAgent(a, INV, true, env)).map((r) => r.outcome), ["removed", "removed"], a);
    assert.deepEqual((await connectAgent(a, INV, true, env)).map((r) => r.outcome), ["absent", "absent"], a);
  }
  assert.deepEqual(JSON.parse(readFileSync(p.claude.mcp, "utf8")), claudeJson);
  assert.equal(readFileSync(p.codex.mcp, "utf8"), toml);
  assert.deepEqual(JSON.parse(readFileSync(p.opencode.mcp, "utf8")), { plugin: ["p"], $schema: "https://opencode.ai/config.json" });
  assert.equal(readFileSync(p.codex.rules, "utf8"), "# My rules\n\nBe brief.\n");
});

test("connect: refuses a foreign 'baton' entry; passes a custom memory dir to the server", async () => {
  const { home } = sandbox();
  const env = { BATON_HOME: home } as NodeJS.ProcessEnv;
  const p = connectPaths("codex", env);
  mkdirSync(path.dirname(p.mcp), { recursive: true });
  writeFileSync(p.mcp, '[mcp_servers.baton]\ncommand = "something-else"\n');
  await assert.rejects(connectAgent("codex", INV, false, env), /did not add/);

  const c = connectPaths("claude", env);
  writeFileSync(c.mcp, JSON.stringify({ mcpServers: { baton: { command: "npx", args: ["other-baton"] } } }));
  await assert.rejects(connectAgent("claude", INV, false, env), /did not add/);

  const withDir = { ...env, BATON_MEMORY_DIR: path.join(home, "m") };
  await connectAgent("opencode", INV, false, withDir);
  assert.deepEqual(JSON.parse(readFileSync(connectPaths("opencode", env).mcp, "utf8")).mcp.baton.environment, { BATON_MEMORY_DIR: path.join(home, "m") });
});

test("connect: marked blocks are replaced, never duplicated", () => {
  const m = { start: "<!-- s -->", end: "<!-- e -->" };
  const once = withBlock("intro\n", m, "A");
  assert.equal(once, "intro\n\n<!-- s -->\nA\n<!-- e -->\n");
  assert.equal(withBlock(once + "\noutro\n", m, "B"), "intro\n\n<!-- s -->\nB\n<!-- e -->\n\noutro\n");
  assert.equal(withBlock(once, m, undefined), "intro\n");
  assert.equal(withBlock("", m, undefined), "");
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("cli: baton install connects the memory only once it is set up", () => {
  const { home } = sandbox();
  const env: NodeJS.ProcessEnv = { ...process.env, BATON_HOME: home, BATON_MEMORY_DIR: path.join(home, "mem") };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) delete env[k];
  const run = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" });

  const before = run("install");
  assert.match(before, /Shared memory is not set up/);
  assert.doesNotMatch(before, / mcp /);

  run("mem", "init");
  // Where this platform's Claude desktop app keeps its config (see claudeDesktopConfig).
  const appDir =
    process.platform === "win32"
      ? path.join(home, "AppData", "Local", "Claude-Data", "claude_test")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Claude")
        : path.join(home, ".config", "Claude");
  const appCfg = path.join(appDir, "claude_desktop_config.json");
  const appOriginal = { preferences: { sidebarMode: "chat" } };
  mkdirSync(path.dirname(appCfg), { recursive: true });
  writeFileSync(appCfg, JSON.stringify(appOriginal));
  const after = run("install");
  for (const a of ["claude", "codex", "opencode"]) {
    assert.match(after, new RegExp(`${a} +mcp +installed`));
    assert.match(after, new RegExp(`${a} +rules +installed`));
  }
  assert.match(after, /claude-desktop +mcp +installed/);
  assert.doesNotMatch(after, /claude-desktop +hooks/);
  assert.match(before, /run \/hooks/, "Codex hooks were just installed: they need trusting");
  assert.match(after, /codex +hooks +unchanged/);
  assert.doesNotMatch(after, /run \/hooks/, "unchanged hooks keep their trust: no note");
  assert.match(readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /BATON_MEMORY_DIR/);
  const removed = run("uninstall");
  for (const a of ["claude", "codex", "opencode", "claude-desktop"]) assert.match(removed, new RegExp(`${a} +mcp +removed`));
  assert.deepEqual(JSON.parse(readFileSync(appCfg, "utf8")), appOriginal);
});

test("claude app: config location per platform and install flavour", () => {
  const { home } = sandbox();
  const env = { BATON_HOME: home, LOCALAPPDATA: "C:\\real\\Local", APPDATA: "C:\\real\\Roaming" } as NodeJS.ProcessEnv;
  const roaming = path.join(home, "AppData", "Roaming", "Claude");
  const store = path.join(home, "AppData", "Local", "Claude-Data", "claude_abc123");

  assert.equal(claudeDesktopConfig(env, "win32"), undefined, "not installed");
  mkdirSync(roaming, { recursive: true });
  assert.equal(claudeDesktopConfig(env, "win32"), path.join(roaming, "claude_desktop_config.json"), "classic installer");
  writeFileSync(path.join(roaming, ".user-data-left.claude_abc123"), "");
  assert.equal(claudeDesktopConfig(env, "win32"), undefined, "data moved, new location missing");
  mkdirSync(store, { recursive: true });
  assert.equal(claudeDesktopConfig(env, "win32"), path.join(store, "claude_desktop_config.json"), "Store build");
  assert.ok(!claudeDesktopConfig(env, "win32")!.startsWith("C:\\real"), "never the real AppData under BATON_HOME");

  mkdirSync(path.join(home, "Library", "Application Support", "Claude"), { recursive: true });
  assert.equal(claudeDesktopConfig(env, "darwin"), path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  assert.equal(claudeDesktopConfig(env, "linux"), undefined);
});

test("claude app: adds only mcpServers.baton, keeps the app's preferences, uninstall restores", async () => {
  const { home } = sandbox();
  const env = { BATON_HOME: home } as NodeJS.ProcessEnv;
  const file = path.join(home, "AppData", "Local", "Claude-Data", "claude_x", "claude_desktop_config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const original = { coworkUserFilesPath: "C:\\Users\\me", preferences: { sidebarMode: "chat", epitaxyPrefs: { a: 1 } } };
  writeFileSync(file, JSON.stringify(original, null, 2));
  const out = (r: { outcome: string }[]) => r.map((x) => x.outcome);

  assert.deepEqual(out(await connectAgent("claude-desktop", INV, false, env, "win32")), ["installed"]);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cfg.preferences, original.preferences);
  assert.deepEqual(cfg.mcpServers, { baton: { command: INV.command, args: [INV.args[0], "mcp"] } });
  assert.ok(existsSync(file + ".baton-backup"));
  assert.deepEqual(out(await connectAgent("claude-desktop", INV, false, env, "win32")), ["unchanged"]);
  assert.deepEqual(out(await connectAgent("claude-desktop", { ...INV, args: ["D:\\b\\dist\\cli.js"] }, false, env, "win32")), ["updated"]);

  assert.deepEqual(out(await connectAgent("claude-desktop", INV, true, env, "win32")), ["removed"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
  assert.deepEqual(out(await connectAgent("claude-desktop", INV, true, env, "win32")), ["absent"]);

  writeFileSync(file, JSON.stringify({ mcpServers: { baton: { command: "python", args: ["other.py"] } } }));
  await assert.rejects(connectAgent("claude-desktop", INV, false, env, "win32"), /did not add/);
  const none = await connectAgent("claude-desktop", INV, false, { BATON_HOME: path.join(home, "empty") } as NodeJS.ProcessEnv, "win32");
  assert.deepEqual(none, [{ part: "mcp", outcome: "absent", file: "(Claude app not found)" }]);
});
