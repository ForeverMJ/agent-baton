import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Source } from "../core/sources.js";
import { configPath } from "../env/config.js";
import { runHook } from "../hooks/handler.js";
import { stableInvocation } from "../hooks/install.js";
import { parseDay } from "../memory/journal.js";
import { createMcpHandler, parseSessionKey } from "../memory/mcp.js";
import { localEnvName, markdownFiles, memoryDir, memoryPaths, writeConfig } from "../memory/store.js";
import { sync } from "../memory/sync.js";
import type { Session } from "../model.js";
import { claudeSession, ctxOf, sandbox } from "./helpers.js";

async function memSandbox() {
  const sb = sandbox();
  const dir = path.join(sb.home, "mem");
  await writeConfig(dir, { lang: "en", exclude: [], includeHeadless: false });
  return { ...sb, dir };
}

const journalKeys = async (dir: string) => {
  const keys: string[] = [];
  for (const f of await markdownFiles(memoryPaths(dir).journal)) keys.push(...parseDay(readFileSync(f, "utf8")).map((b) => b.key));
  return keys.sort();
};

test("memory location: env var, then machine config, then default", () => {
  const { home } = sandbox();
  const env = { BATON_HOME: home } as NodeJS.ProcessEnv;
  assert.equal(memoryDir(env), path.join(home, ".config", "baton", "memory"));
  mkdirSync(path.dirname(configPath(env)), { recursive: true });
  writeFileSync(configPath(env), JSON.stringify({ environments: [], memoryDir: path.join(home, "shared") }));
  assert.equal(memoryDir(env), path.join(home, "shared"));
  assert.equal(memoryDir({ ...env, BATON_MEMORY_DIR: path.join(home, "x") }), path.join(home, "x"));
  writeFileSync(configPath(env), "{ broken");
  assert.equal(memoryDir(env), path.join(home, ".config", "baton", "memory"), "unreadable config: default");
});

test("environment label: WSL sessions are journaled as agent@wsl:<distro>", async () => {
  assert.equal(localEnvName({ BATON_ENV_NAME: "wsl:Ubuntu" } as NodeJS.ProcessEnv), "wsl:Ubuntu");
  assert.equal(localEnvName({ BATON_ENV_NAME: "" } as NodeJS.ProcessEnv), undefined);
  assert.deepEqual(parseSessionKey("claude@wsl:Ubuntu:abc-1"), { agent: "claude", env: "wsl:Ubuntu", id: "abc-1" });
  assert.deepEqual(parseSessionKey("codex:019a"), { agent: "codex", env: undefined, id: "019a" });

  const { dir, dirs, home } = await memSandbox();
  claudeSession(dirs, home, "w1", "Set up Foundry in WSL", {}, new Date().toISOString());
  claudeSession(dirs, home, "me", "hello", {}, new Date().toISOString());
  const memory = { dir, dirs, envName: "wsl:Ubuntu" };
  const brief = await runHook({ agent: "claude", event: "start", cwd: home, sessionId: "me" }, ctxOf(dirs), memory);
  assert.deepEqual(await journalKeys(dir), ["claude@wsl:Ubuntu:me", "claude@wsl:Ubuntu:w1"]);
  assert.match(brief, /claude@wsl:Ubuntu "Set up Foundry in WSL"/);
  assert.ok(!brief.includes("claude@wsl:Ubuntu:me"), "the starting session is left out");
  const day = (await markdownFiles(memoryPaths(dir).journal))[0]!;
  assert.match(readFileSync(day, "utf8"), /### \d\d:\d\d · claude@wsl:Ubuntu · Set up Foundry in WSL/);

  // A Stop in WSL updates the same key, never a second unlabelled one.
  await sync(dir, { dirs, envName: "wsl:Ubuntu", force: true });
  assert.deepEqual(await journalKeys(dir), ["claude@wsl:Ubuntu:me", "claude@wsl:Ubuntu:w1"]);
});

function fakeSource(name: string, text: string): Source {
  return {
    name,
    refs: async () => [],
    git: async () => ({}),
    session: async (_root, ref): Promise<Session> => ({
      agent: ref.agent,
      id: ref.id,
      cwd: "/home/u",
      updatedAt: new Date(),
      events: [
        { kind: "user", text },
        { kind: "assistant", text: "ok" },
      ],
    }),
  };
}

async function call(handle: ReturnType<typeof createMcpHandler>, name: string, args: object) {
  const r: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return r.result.content[0].text as string;
}

test("mcp: transcripts of the other environment's sessions come through its source", async () => {
  const { dir, home } = await memSandbox();
  // Journal one WSL session and one host session into the shared store, from their own environments.
  const wsl = sandbox();
  claudeSession(wsl.dirs, wsl.home, "w1", "Set up Foundry in WSL", {}, new Date().toISOString());
  await sync(dir, { dirs: wsl.dirs, envName: "wsl:Ubuntu" });
  const host = sandbox();
  claudeSession(host.dirs, host.home, "h1", "Plan the Osaka trip", {}, new Date().toISOString());
  await sync(dir, { dirs: host.dirs, envName: undefined });

  // On the host: the WSL session is fetched from the "wsl:Ubuntu" source.
  const onHost = createMcpHandler({ dir, dirs: host.dirs, version: "t", sources: [fakeSource("wsl:Ubuntu", "from wsl")] });
  await onHost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } });
  assert.match(await call(onHost, "memory_read", { session: "claude@wsl:Ubuntu:w1", transcript: true }), /\[user\] from wsl/);
  assert.match(await call(onHost, "memory_read", { session: "claude:h1", transcript: true }), /\[user\] Plan the Osaka trip/, "local first");

  // Inside WSL: an unlabelled (host) key is not local, so the "windows" source is asked.
  const inWsl = createMcpHandler({ dir, dirs: wsl.dirs, version: "t", envName: "wsl:Ubuntu", sources: [fakeSource("windows", "from windows")] });
  await inWsl({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } });
  assert.match(await call(inWsl, "memory_read", { session: "claude:h1", transcript: true }), /\[user\] from windows/);
  assert.match(await call(inWsl, "memory_read", { session: "claude@wsl:Ubuntu:w1", transcript: true }), /\[user\] Set up Foundry in WSL/);

  // Items saved inside WSL say where they came from.
  assert.match(await call(inWsl, "memory_remember", { kind: "fact", text: "Works in WSL Ubuntu" }), /Remembered m:/);
  assert.match(readFileSync(memoryPaths(dir).profile, "utf8"), /Works in WSL Ubuntu <!-- m:\w+ [\d-]+ claude@wsl:Ubuntu -->/);

  const none = createMcpHandler({ dir, dirs: host.dirs, version: "t", sources: [] });
  await none({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "x" } } });
  assert.match(await call(none, "memory_read", { session: "claude@wsl:Ubuntu:w1", transcript: true }), /not reachable from here/);
  assert.ok(home);
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("cli: mem init --join uses an existing memory and records it in the machine config", () => {
  const win = sandbox();
  const wsl = sandbox();
  const envOf = (home: string): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, BATON_HOME: home, BATON_ENV_NAME: "" };
    for (const k of ["BATON_MEMORY_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"]) delete e[k];
    return e;
  };
  const run = (home: string, ...a: string[]) => execFileSync(process.execPath, [CLI, "mem", ...a], { env: envOf(home), encoding: "utf8" });
  run(win.home, "init", "--lang", "en");
  const store = path.join(win.home, ".config", "baton", "memory");

  assert.throws(() => run(wsl.home, "init", "--join", path.join(wsl.home, "nothing")), /not a baton memory/);
  claudeSession(wsl.dirs, wsl.home, "w1", "hello from the other side", {}, new Date().toISOString());
  const out = run(wsl.home, "init", "--join", store);
  assert.match(out, /Joined the shared memory at/);
  assert.match(out, /1 written/);
  assert.equal(JSON.parse(readFileSync(path.join(wsl.home, ".config", "baton", "config.json"), "utf8")).memoryDir, store);
  assert.ok(!existsSync(path.join(wsl.home, ".config", "baton", "memory")), "no second store");
  assert.match(run(wsl.home, "status"), new RegExp(`Memory: +${store.replace(/\\/g, "\\\\")}`));
  assert.match(run(win.home, "search", "other side"), /hello from the other side/, "visible from the first environment");
});

test("install inside WSL: copies baton off the Windows drive, without tests", async () => {
  const { home } = sandbox();
  const pkg = path.join(home, "mnt", "c", "baton");
  for (const f of ["dist/cli.js", "dist/memory/mcp.js", "dist/test/x.test.js"]) {
    mkdirSync(path.dirname(path.join(pkg, f)), { recursive: true });
    writeFileSync(path.join(pkg, f), "// " + f);
  }
  writeFileSync(path.join(pkg, "package.json"), '{"type":"module"}');
  const inv = { command: "/usr/bin/node", args: [path.join(pkg, "dist", "cli.js")] };
  const env = { BATON_HOME: home } as NodeJS.ProcessEnv;

  assert.deepEqual(await stableInvocation({ inv, env, wsl: false, onWindowsDrive: true }), inv, "not in WSL: unchanged");
  assert.deepEqual(await stableInvocation({ inv, env, wsl: true, onWindowsDrive: false }), inv, "already local: unchanged");

  const copy = path.join(home, ".local", "share", "baton");
  const got = await stableInvocation({ inv, env, wsl: true, onWindowsDrive: true });
  assert.deepEqual(got, { command: "/usr/bin/node", args: [path.join(copy, "dist", "cli.js")] });
  assert.ok(existsSync(path.join(copy, "dist", "memory", "mcp.js")));
  assert.ok(!existsSync(path.join(copy, "dist", "test")));
  assert.equal(readFileSync(path.join(copy, "package.json"), "utf8"), '{"type":"module"}');

  writeFileSync(path.join(pkg, "dist", "cli.js"), "// v2");
  await stableInvocation({ inv, env, wsl: true, onWindowsDrive: true });
  assert.equal(readFileSync(path.join(copy, "dist", "cli.js"), "utf8"), "// v2", "re-install refreshes the copy");
});
