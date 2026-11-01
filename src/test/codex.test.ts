import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { codexAdapter } from "../adapters/codex.js";
import { extractCheckpoint } from "../core/extract.js";
import { zstdSupported } from "../core/jsonl.js";
import { sandbox, writeJsonl } from "./helpers.js";

const meta = (cwd: string, extra: object = {}) => ({
  timestamp: "2026-10-01T00:00:00Z",
  type: "session_meta",
  payload: { id: "c-1", cwd, thread_source: "user", source: "cli", ...extra },
});
const ev = (payload: object) => ({ timestamp: "2026-10-01T00:00:01Z", type: "event_msg", payload });
const ri = (payload: object) => ({ timestamp: "2026-10-01T00:00:01Z", type: "response_item", payload });

test("codex: new item stream, quota, unfinished turn", async () => {
  const sb = sandbox();
  const day = path.join(sb.dirs.codexSessions[0]!, "2026", "10", "01");
  writeJsonl(path.join(day, "rollout-a.jsonl"), [
    meta(sb.project),
    ev({ type: "task_started" }),
    ri({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] }),
    ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Fix the parser bug" }] } }),
    ev({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Looking at parser.ts" }] } }),
    ri({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "repro", status: "completed" }, { step: "fix", status: "in_progress" }] }) }),
    ev({ type: "item_completed", item: { type: "FileChange", id: "f1", status: "completed", changes: { [path.join(sb.project, "parser.ts")]: { type: "update" } } } }),
    ev({ type: "item_completed", item: { type: "CommandExecution", id: "x1", command: ["bash", "-lc", "npm test"], exit_code: "1", aggregated_output: "FAIL parser" } }),
    ev({ type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 1791476749 } } }),
  ]);
  // reviewer thread in same cwd must be ignored
  writeJsonl(path.join(day, "rollout-b.jsonl"), [meta(sb.project, { id: "c-2", thread_source: "guardian_review" })]);

  const refs = await codexAdapter.discover(sb.project, sb.dirs);
  assert.deepEqual(refs.map((r) => r.id), ["c-1"]);
  const s = await codexAdapter.load(refs[0]!, sb.dirs);
  const cp = extractCheckpoint(s, sb.project);
  assert.deepEqual(cp.goal, ["Fix the parser bug"]);
  assert.deepEqual(cp.filesTouched, ["parser.ts"]);
  assert.equal(cp.todos?.length, 2);
  assert.equal(cp.errors[0]?.input, "npm test");
  assert.equal(cp.quota?.usedPercent, 100);
  assert.match(cp.interruption ?? "", /never completed/);
});

test("codex: legacy response_item stream", async () => {
  const sb = sandbox();
  writeJsonl(path.join(sb.dirs.codexSessions[0]!, "2025", "rollout-old.jsonl"), [
    meta(sb.project),
    ri({ type: "message", role: "user", content: [{ type: "input_text", text: "Add a CLI flag" }] }),
    ri({ type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/cli.ts\n@@\n*** End Patch" }),
    ri({ type: "custom_tool_call_output", call_id: "p1", output: "Success" }),
    ri({ type: "function_call", call_id: "s1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "make"] }) }),
    ri({ type: "function_call_output", call_id: "s1", output: JSON.stringify({ output: "ok", metadata: { exit_code: 0 } }) }),
    ri({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
  ]);
  const [ref] = await codexAdapter.discover(sb.project, sb.dirs);
  const cp = extractCheckpoint(await codexAdapter.load(ref!, sb.dirs), sb.project);
  assert.deepEqual(cp.filesTouched, ["src/cli.ts"]);
  assert.equal(cp.recentActions[1]?.ok, true);
  assert.equal(cp.lastAssistant, "Done.");
  assert.equal(cp.interruption, undefined);
});

test("codex: compressed rollouts, thread titles, headless origin", { skip: !zstdSupported && "no zstd in this Node" }, async () => {
  const sb = sandbox();
  const day = path.join(sb.dirs.codexSessions[0]!, "2026", "10", "02");
  const lines = (id: string, extra: object, text: string) =>
    [meta(sb.project, { id, ...extra }), ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }] } })]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(day, "rollout-z.jsonl.zst"), (zlib as any).zstdCompressSync(Buffer.from(lines("z-1", { originator: "Codex Desktop", source: "vscode" }, "Plan my week"))));
  writeFileSync(path.join(day, "rollout-e.jsonl"), lines("e-1", { originator: "codex_exec", source: "exec" }, "scripted"));
  writeFileSync(path.join(day, "rollout-o.jsonl"), lines("o-1", { originator: "some_app", source: "vscode" }, "embedded"));
  writeFileSync(
    path.join(path.dirname(sb.dirs.codexSessions[0]!), "session_index.jsonl"),
    [{ id: "z-1", thread_name: "Old name" }, { id: "z-1", thread_name: "Weekly plan" }].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const refs = await codexAdapter.list(sb.dirs);
  const byId = Object.fromEntries(refs.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["e-1", "o-1", "z-1"]);
  assert.equal(byId["z-1"]!.title, "Weekly plan");
  assert.deepEqual([byId["z-1"]!.origin, byId["e-1"]!.origin, byId["o-1"]!.origin], ["interactive", "headless", "headless"]);
  const s = await codexAdapter.load(byId["z-1"]!, sb.dirs);
  assert.deepEqual(s.events.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text), ["Plan my week"]);
  assert.equal(s.title, "Weekly plan");
});

test("codex: a rollout compressed after listing is still loaded", { skip: !zstdSupported && "no zstd in this Node" }, async () => {
  const sb = sandbox();
  const file = path.join(sb.dirs.codexSessions[0]!, "2026", "10", "03", "rollout-m.jsonl");
  writeJsonl(file, [meta(sb.project, { id: "m-1" }), ev({ type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "hi" }] } })]);
  const [ref] = await codexAdapter.list(sb.dirs);
  writeFileSync(file + ".zst", (zlib as any).zstdCompressSync(readFileSync(file)));
  rmSync(file);
  const s = await codexAdapter.load(ref!, sb.dirs);
  assert.equal(s.events.filter((e) => e.kind === "user").length, 1);
});
