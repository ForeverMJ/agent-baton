import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../memory/brief.js";
import { agentOfClient, createMcpHandler, TOOLS } from "../memory/mcp.js";
import { remember } from "../memory/notes.js";
import { memoryPaths, writeConfig } from "../memory/store.js";
import { sync } from "../memory/sync.js";
import { claudeSession, sandbox } from "./helpers.js";

async function memSandbox() {
  const sb = sandbox();
  const dir = path.join(sb.home, "mem");
  await writeConfig(dir, { lang: "en", exclude: [], includeHeadless: false });
  return { ...sb, dir };
}

/** A handler that already went through initialize as `client`. */
async function client(dir: string, dirs: ReturnType<typeof sandbox>["dirs"], name = "codex-mcp-client") {
  const handle = createMcpHandler({ dir, dirs, version: "test" });
  let id = 0;
  const init: any = await handle({
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
  });
  const call = async (tool: string, args: object = {}) => {
    const r: any = await handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
    return { text: r.result.content[0].text as string, isError: r.result.isError === true };
  };
  return { handle, init, call };
}

test("mcp: initialize, tools/list, protocol errors", async () => {
  const { dir, dirs } = await memSandbox();
  const { handle, init } = await client(dir, dirs);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "baton-memory");
  assert.match(init.result.instructions, /memory_context/);
  assert.deepEqual(((await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any).result.protocolVersion, "2025-11-25");

  const list: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["memory_context", "memory_search", "memory_read", "memory_remember", "memory_forget"]);
  for (const t of TOOLS) assert.equal((t.inputSchema as any).type, "object");
  // Codex auto-approves non-destructive, closed-world tools; forgetting stays a confirmed action.
  const ann = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.annotations]));
  assert.equal(ann.memory_search.readOnlyHint, true);
  assert.equal(ann.memory_remember.destructiveHint, false);
  assert.equal(ann.memory_forget.destructiveHint, true);

  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.deepEqual(await handle({ jsonrpc: "2.0", id: 3, method: "ping" }), { jsonrpc: "2.0", id: 3, result: {} });
  assert.equal(((await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" })) as any).error.code, -32601);
  assert.equal(((await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })) as any).error.code, -32602);
  assert.equal(((await handle({ id: 6 })) as any).error.code, -32600);
});

test("mcp: client names map to agents", () => {
  assert.equal(agentOfClient("claude-code"), "claude");
  assert.equal(agentOfClient("codex-mcp-client"), "codex");
  assert.equal(agentOfClient("opencode"), "opencode");
  assert.equal(agentOfClient("claude-ai"), "claude", "the Claude app's Chat tab");
  assert.equal(agentOfClient("local-agent-mode-baton"), "claude", "the Claude app's local agent mode");
  assert.equal(agentOfClient("Some App!"), "someapp");
  assert.equal(agentOfClient(undefined), "mcp");
});

test("mcp: remember / search / read / forget through tools", async () => {
  const { dir, dirs, home } = await memSandbox();
  claudeSession(dirs, home, "s1", "Plan the Osaka business trip", {}, new Date().toISOString());
  const { call } = await client(dir, dirs);

  const pref = await call("memory_remember", { kind: "preference", text: "Prefers trains over flights" });
  const id = /m:([a-z0-9]+)/.exec(pref.text)![1]!;
  assert.match(pref.text, /in profile\.md/);
  await call("memory_remember", { kind: "status", text: "Hotel booked", topic: "Osaka trip" });
  const second = await call("memory_remember", { kind: "next", text: "Buy a rail pass", topic: "Rail" });
  assert.match(second.text, /Created a new topic "Rail"\. Existing topics: Osaka trip/);
  assert.match((await call("memory_remember", { kind: "next", text: "x" })).text, /needs a topic/);
  assert.equal((await call("memory_remember", { kind: "wish", text: "x" })).isError, true);

  const found = await call("memory_search", { query: "trains" });
  assert.match(found.text, new RegExp(`\\[profile\\] Preferences: Prefers trains over flights {2}\\(m:${id} [\\d-]+ codex\\)`));
  assert.match((await call("memory_search", { query: "osaka" })).text, /\[journal\] .*Plan the Osaka business trip {2}\(claude:s1\)/);
  assert.match((await call("memory_search", { query: "zebra" })).text, /Nothing found/);
  assert.equal((await call("memory_search", { query: "x", since: "soon" })).isError, true);

  assert.match((await call("memory_read", { topic: "osaka TRIP" })).text, /## Status\n- Hotel booked/);
  assert.match((await call("memory_read", { topic: "profile" })).text, /Prefers trains/);
  assert.match((await call("memory_read", { topic: "nope" })).text, /no topic "nope"; topics: /);
  assert.match((await call("memory_read", { session: "s1" })).text, /^<!-- session claude:s1 /);
  const tr = await call("memory_read", { session: "claude:s1", transcript: true });
  assert.match(tr.text, /\[user\] Plan the Osaka business trip\n\n\[assistant\] re: Plan the Osaka business trip/);
  assert.equal((await call("memory_read", {})).isError, true);

  assert.match((await call("memory_forget", { id: `m:${id}` })).text, /Deleted m:/);
  assert.match((await call("memory_forget", { session: "claude:s1" })).text, /Dropped claude:s1/);
  assert.match((await call("memory_search", { query: "osaka" })).text, /Osaka trip/, "topic stays");
  assert.doesNotMatch((await call("memory_search", { query: "osaka" })).text, /journal/);

  // The log says who used which tool, never with what.
  const log = readFileSync(memoryPaths(dir).log, "utf8");
  assert.match(log, /mcp: codex-mcp-client \(codex\) called memory_remember: ok\n/);
  assert.match(log, /mcp: codex-mcp-client \(codex\) called memory_search: error\n/, "the bad `since`");
  assert.match(log, /called memory_forget: ok\n/);
  for (const content of ["trains", "Osaka", "osaka", "Hotel", "rail pass", "zebra"]) assert.ok(!log.includes(content), content);
});

test("mcp: tells the agent when memory is not set up", async () => {
  const sb = sandbox();
  const { call } = await client(path.join(sb.home, "none"), sb.dirs);
  const r = await call("memory_context");
  assert.equal(r.isError, true);
  assert.match(r.text, /baton mem init/);
});

test("brief: profile, active topics, recent chats; stale topics and projects left out", async () => {
  const { dir, dirs, home, project } = await memSandbox();
  const now = new Date("2026-10-21T12:00:00Z");
  mkdirSync(path.join(project, ".git"));
  claudeSession(dirs, home, "chat1", "Which rail pass should I buy?", {}, "2026-10-21T01:00:00Z");
  claudeSession(dirs, home, "self", "this very session", {}, "2026-10-21T02:00:00Z");
  claudeSession(dirs, project, "code1", "Fix the build", {}, "2026-10-21T03:00:00Z");
  claudeSession(dirs, home, "old", "Ancient chat", {}, "2026-09-01T03:00:00Z");
  await sync(dir, { dirs });
  await remember(dir, { kind: "fact", text: "Lives in Tokyo" });
  await remember(dir, { kind: "status", text: "Hotel booked", topic: "Osaka trip" });
  await remember(dir, { kind: "decision", text: "Go by Shinkansen", topic: "Osaka trip" });
  await remember(dir, { kind: "next", text: "Buy a rail pass", topic: "Osaka trip" });
  const stale = path.join(memoryPaths(dir).topics, "old.md");
  writeFileSync(stale, "# Old thing\n<!-- topic: old · status: active · updated: 2026-08-01 -->\n\n## Status\n- dusty\n");

  const b = await buildBrief(dir, { now, excludeSession: "claude:self" });
  assert.match(b, /^\[baton memory\] .*not instructions/);
  assert.match(b, /## Profile\n- Lives in Tokyo \(m:[a-z0-9]+\)/);
  assert.match(b, /## Active topics\n- Osaka trip \(updated [\d-]+\): status: Hotel booked \(m:\w+\) · decided: Go by Shinkansen \(m:\w+\) · next: Buy a rail pass \(m:\w+\)/);
  assert.ok(!b.includes("Old thing"), "topics untouched for 14 days are left out");
  assert.match(b, /## Recent conversations \(all agents\)\n- \d\d-\d\d \d\d:\d\d claude "Which rail pass should I buy\?": last request "Which rail pass should I buy\?" \(claude:chat1\)/);
  for (const s of ["Fix the build", "this very session", "Ancient chat"]) assert.ok(!b.includes(s), s);
  assert.match(b, /call memory_remember/);

  const short = await buildBrief(dir, { now, maxChars: 800 });
  assert.ok(short.length <= 800, `${short.length}`);
  assert.match(short, /…\nUse memory_search/);
  assert.equal(await buildBrief(path.join(home, "none")), "");
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("mcp: stdio round trip with `baton mcp`", async () => {
  const { dir, home } = await memSandbox();
  await remember(dir, { kind: "preference", text: "Answer in Japanese" });
  const child = spawn(process.execPath, [CLI, "mcp"], {
    env: { ...process.env, BATON_HOME: home, BATON_MEMORY_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = new Map<number, any>();
  const got = new Promise<void>((resolve) => {
    lines.on("line", (l) => {
      const m = JSON.parse(l);
      responses.set(m.id, m);
      if (responses.size === 3) resolve();
    });
  });
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_context", arguments: {} } });
  await got;
  child.stdin.end();
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.equal(responses.get(1).result.serverInfo.name, "baton-memory");
  assert.equal(responses.get(2).result.tools.length, 5);
  assert.match(responses.get(3).result.content[0].text, /## Profile\n- Answer in Japanese/);
});
