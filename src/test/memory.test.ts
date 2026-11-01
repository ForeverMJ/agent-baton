import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "../model.js";
import { parseDoc, serializeDoc } from "../memory/doc.js";
import { classifyCwd, journalEntry, parseDay } from "../memory/journal.js";
import { findTopic, forgetItem, listTopics, remember, slugify } from "../memory/notes.js";
import { search } from "../memory/search.js";
import { memoryPaths, writeConfig } from "../memory/store.js";
import { forgetSession, readState, sync } from "../memory/sync.js";
import { claudeSession, sandbox, writeJsonl } from "./helpers.js";

async function memSandbox(lang: "en" | "zh" = "en") {
  const sb = sandbox();
  const dir = path.join(sb.home, "mem");
  await writeConfig(dir, { lang, exclude: [], includeHeadless: false });
  return { ...sb, dir };
}

const read = (f: string) => readFileSync(f, "utf8");

test("memory doc: hand-written lines survive a round trip", () => {
  const text = "# Profile\nsome note\n\n## Preferences\n- tea, not coffee\n\nfree text\n\n## My own section\n- keep me\n";
  assert.equal(serializeDoc(parseDoc(text)), text);
});

test("memory: preferences go to the profile, hand-written items get ids", async () => {
  const { dir } = await memSandbox();
  const p = memoryPaths(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p.profile, "# Profile\n\n## Facts\n- lives in Tokyo\n");
  const r = await remember(dir, { kind: "preference", text: "Emails in polite Japanese\n<!-- x -->, sign as Zion", agent: "codex" });
  const text = read(p.profile);
  assert.match(text, new RegExp(`- Emails in polite Japanese x , sign as Zion <!-- m:${r.id} \\d{4}-\\d{2}-\\d{2} codex -->`));
  assert.match(text, /- lives in Tokyo <!-- m:[a-z0-9]{4} [\d-]+ user -->/);
  assert.ok(text.indexOf("## Preferences") < text.indexOf("## Facts"), "sections keep their canonical order");

  // A second item lands right below the first, not after the blank separator line.
  await remember(dir, { kind: "preference", text: "Short answers" });
  assert.match(read(p.profile), /sign as Zion <!--[^\n]*-->\n- Short answers <!--[^\n]*-->\n\n## Facts/);
});

test("memory: one current status per topic, replaced decisions move to history", async () => {
  const { dir } = await memSandbox();
  const d1 = await remember(dir, { kind: "decision", text: "US programs only", topic: "PhD 申请", agent: "opencode" });
  await remember(dir, { kind: "status", text: "3 candidates picked", topic: "PhD申请", agent: "claude" });
  const s2 = await remember(dir, { kind: "status", text: "Writing the SOP", topic: "phd-申请", agent: "codex" });
  const d2 = await remember(dir, { kind: "decision", text: "US and Canada", topic: "PhD 申请", replaces: `m:${d1.id}` });

  const topics = await listTopics(dir);
  assert.equal(topics.length, 1, "spacing/case variants are the same topic");
  assert.equal(topics[0]!.slug, slugify("PhD 申请"));
  const doc = parseDoc(read(topics[0]!.file));
  const sec = (k: string) => doc.sections.find((s) => s.key === k)!.lines.filter((l) => l.startsWith("- "));
  assert.deepEqual(sec("status").length, 1);
  assert.match(sec("status")[0]!, new RegExp(`Writing the SOP <!-- m:${s2.id}`));
  assert.match(sec("decision")[0]!, new RegExp(`US and Canada <!-- m:${d2.id}`));
  assert.ok(sec("history").some((l) => l.includes(`~~US programs only~~ (superseded by m:${d2.id})`)));
  assert.ok(sec("history").some((l) => l.includes("~~3 candidates picked~~")));
  assert.equal(d2.replaced?.text, "US programs only");

  await assert.rejects(remember(dir, { kind: "next", text: "x" }), /needs a topic/);
  await assert.rejects(remember(dir, { kind: "fact", text: "x", replaces: "m:zzzz" }), /no memory item/);
  assert.equal((await forgetItem(dir, s2.id))?.item.text, "Writing the SOP");
  assert.equal(await forgetItem(dir, s2.id), undefined);
  assert.ok(await findTopic(dir, "PHD申请"));
});

test("memory: concurrent writers don't lose items", async () => {
  const { dir } = await memSandbox();
  const rs = await Promise.all(
    Array.from({ length: 12 }, (_, i) => remember(dir, { kind: "fact", text: `fact ${i}`, agent: i % 2 ? "claude" : "codex" })),
  );
  assert.equal(new Set(rs.map((r) => r.id)).size, 12);
  const text = read(memoryPaths(dir).profile);
  for (let i = 0; i < 12; i++) assert.ok(text.includes(`fact ${i} <!--`), `fact ${i}`);
  assert.ok(!existsSync(memoryPaths(dir).lock));
});

function session(over: Partial<Session> = {}): Session {
  return {
    agent: "codex",
    id: "s-1",
    cwd: "C:\\Users\\me\\Documents\\Codex\\2026-10-26\\compare",
    title: "Compare <b>programs</b>",
    startedAt: "2026-10-26T05:05:00.000Z",
    updatedAt: new Date("2026-10-26T06:20:00.000Z"),
    events: [
      { kind: "user", text: '<pasted_content id="x">Compare A and B</pasted_content> token=sk-ant-abcdefghijklmnopqrstuvwxyz', ts: "2026-10-26T05:05:00.000Z" },
      { kind: "assistant", text: "A is stronger in ML." },
      { kind: "tool_call", id: "c1", name: "baton.memory_remember", input: "decision", files: [] },
      { kind: "tool_result", id: "c1", ok: true, output: "Remembered m:b7d1 in topics/phd.md", ts: "2026-10-26T06:00:00.000Z" },
      { kind: "tool_call", id: "c2", name: "shell", input: "cat notes.txt", files: [] },
      { kind: "tool_result", id: "c2", ok: true, output: "SECRET FILE CONTENT m:zzzz" },
      { kind: "user", text: "Rank them" },
      { kind: "assistant", text: "1. A  2. B", ts: "2026-10-26T06:20:00.000Z" },
    ],
    ...over,
  };
}

test("journal: entry copies requests and the last reply, never tool output", () => {
  const e = journalEntry(session(), "en", "C:\\Users\\me")!;
  assert.equal(e.key, "codex:s-1");
  assert.equal(e.place, "chat");
  const b = e.block;
  assert.match(b, /^<!-- session codex:s-1 2026-10-26T05:05:00.000Z -->\n### \d\d:\d\d · codex · Compare programs\n/);
  assert.match(b, /- desktop chat · 2 turns · /);
  assert.ok(!b.includes("Documents/Codex"), "scratch path of a chat is not shown");
  assert.match(b, /- First: "Compare A and B token=\[REDACTED\]"/);
  assert.match(b, /- Last request: "Rank them"/);
  assert.match(b, /- Last reply: "1\. A 2\. B"/);
  assert.match(b, /- Remembered: m:b7d1\n/);
  assert.ok(!b.includes("SECRET") && !b.includes("zzzz"));
  assert.equal(journalEntry(session({ events: [{ kind: "assistant", text: "hi" }] }), "en"), undefined);
  const unanswered: Session["events"] = [{ kind: "user", text: "Plan my week" }, { kind: "interrupt", reason: "OAuth session expired" }];
  assert.equal(journalEntry(session({ events: unanswered }), "en"), undefined, "a session the agent never answered");
  assert.match(journalEntry(session({ env: "wsl:Ubuntu" }), "zh")!.block, /### .* · codex@wsl:Ubuntu · .*\n- 桌面对话 · 2 轮/);
});

test("journal: cwd classification", () => {
  const sb = sandbox();
  mkdirSync(path.join(sb.project, ".git"));
  assert.equal(classifyCwd(path.join(sb.project, "src"), sb.home), "project");
  assert.equal(classifyCwd(sb.home, sb.home), "chat");
  assert.equal(classifyCwd(path.join(sb.home, "work"), sb.home), "folder");
  assert.equal(classifyCwd("C:/Users/me/AppData/Roaming/Claude/scratch-workspaces/a/b/scratch-2026-10-21-82e019", sb.home), "chat");
});

test("sync: journals every session once, skips headless, updates and forgets", async () => {
  const { dir, dirs, home, project } = await memSandbox();
  const chat = path.join(home, "Documents", "Codex", "2026-10-20", "trip");
  claudeSession(dirs, chat, "a1", "Plan a trip to Osaka", { entrypoint: "claude-desktop" });
  const f2 = claudeSession(dirs, project, "a2", "Fix the build", { entrypoint: "cli" });
  claudeSession(dirs, project, "a3", "scripted call", { entrypoint: "sdk-cli" });

  const r1 = await sync(dir, { dirs });
  assert.deepEqual([r1.written, r1.headless, r1.unchanged], [2, 1, 0]);
  const day = path.join(memoryPaths(dir).journal, `${journalEntry(session({ startedAt: "2026-10-20T01:00:00Z" }), "en")!.day}.md`);
  const blocks = parseDay(read(day));
  assert.deepEqual(blocks.map((b) => b.key).sort(), ["claude:a1", "claude:a2"]);

  const r2 = await sync(dir, { dirs });
  assert.deepEqual([r2.written, r2.unchanged], [0, 3]);

  // The session continues: its entry is replaced in place, not duplicated.
  writeJsonl(f2, [
    { cwd: project, sessionId: "a2", type: "user", timestamp: "2026-10-20T01:00:00Z", message: { content: "Fix the build" } },
    { cwd: project, sessionId: "a2", type: "user", timestamp: "2026-10-20T02:00:00Z", message: { content: "Now add a test" } },
    { cwd: project, sessionId: "a2", type: "assistant", timestamp: "2026-10-20T02:01:00Z", message: { model: "m", content: [{ type: "text", text: "Added." }] } },
  ]);
  utimesSync(f2, new Date(), new Date(Date.now() + 5000));
  const r3 = await sync(dir, { dirs });
  assert.equal(r3.written, 1);
  const after = parseDay(read(day));
  assert.equal(after.length, 2);
  assert.match(after.find((b) => b.key === "claude:a2")!.block, /Last request: "Now add a test"/);

  assert.ok(await forgetSession(dir, "claude:a1"));
  assert.deepEqual(parseDay(read(day)).map((b) => b.key), ["claude:a2"]);
  const r4 = await sync(dir, { dirs, force: true });
  assert.equal(r4.written, 1, "a forgotten session is not journaled again");
  assert.ok((await readState(dir)).ignored.includes("claude:a1"));
});

test("sync: time budget leaves the rest pending", async () => {
  const { dir, dirs, home } = await memSandbox();
  for (let i = 0; i < 3; i++) claudeSession(dirs, path.join(home, `f${i}`), `b${i}`, `hello ${i}`);
  const r = await sync(dir, { dirs, budgetMs: -1 });
  assert.deepEqual([r.written, r.pending], [0, 3]);
  assert.equal((await sync(dir, { dirs })).written, 3);
});

test("search: CJK bigrams, recency, superseded items rank last", async () => {
  const { dir } = await memSandbox("zh");
  const old = await remember(dir, { kind: "decision", text: "只考虑美国的学校", topic: "选校" });
  await remember(dir, { kind: "decision", text: "美国和加拿大的学校都考虑", topic: "选校", replaces: old.id });
  await remember(dir, { kind: "preference", text: "回复尽量简短" });

  const hits = await search(dir, "学校");
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.text, /^美国和加拿大/);
  assert.match(hits[1]!.text, /^~~只考虑美国/);
  assert.equal((await search(dir, "简短的回复"))[0]?.text, "回复尽量简短", "bigram match without exact substring");
  assert.equal((await search(dir, "选校")).length, 2, "topic title matches its items");
  assert.deepEqual(await search(dir, "学校 不存在的词"), [], "every term must match");
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("cli: baton mem init / add / search / show / forget", () => {
  const sb = sandbox();
  const env = { ...process.env, BATON_HOME: sb.home, BATON_MEMORY_DIR: path.join(sb.home, "m"), CLAUDECODE: "" };
  const run = (...args: string[]) => execFileSync(process.execPath, [CLI, "mem", ...args], { env, encoding: "utf8" });
  claudeSession(sb.dirs, sb.home, "c1", "Book a dentist appointment");

  assert.match(run("init", "--lang", "en"), /Journal: 1 written/);
  const added = run("add", "next", "Call", "the", "dentist", "--topic", "Health", "--agent", "opencode");
  const id = /m:([a-z0-9]+)/.exec(added)![1]!;
  assert.match(added, /in topics\/health\.md/);
  assert.match(run("search", "dentist"), new RegExp(`\\[topic\\] Health / Next: Call the dentist  \\(m:${id} [\\d-]+ opencode\\)`));
  assert.match(run("search", "dentist"), /\[journal\] .* claude · Book a dentist appointment/);
  assert.match(run("show", "health"), /## Next\n- Call the dentist/);
  assert.match(run("show", "c1"), /First: "Book a dentist appointment"/);
  assert.match(run("status"), /Journal: {2}claude 1/);
  assert.match(run("forget", `m:${id}`), /Deleted/);
  assert.match(run("forget", "--session", "claude:c1"), /Forgot session claude:c1/);
  assert.match(run("search", "dentist"), /Nothing found/);
});
