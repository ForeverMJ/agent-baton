import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { claudeAdapter, encodeProjectDir } from "../adapters/claude.js";
import { extractCheckpoint } from "../core/extract.js";
import { sandbox, writeJsonl } from "./helpers.js";

function fixture() {
  const sb = sandbox();
  const file = path.join(sb.dirs.claudeProjects, encodeProjectDir(sb.project), "sess-1.jsonl");
  const base = { cwd: sb.project, sessionId: "sess-1", isSidechain: false };
  writeJsonl(file, [
    { type: "custom-title", customTitle: "Add login page" },
    { ...base, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: "Build a login page" } },
    { ...base, type: "user", isMeta: true, message: { role: "user", content: "<command-name>/model</command-name>" } },
    {
      ...base,
      type: "assistant",
      message: {
        model: "claude-x",
        content: [
          { type: "text", text: "I'll create the page." },
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: path.join(sb.project, "src", "login.tsx"), content: "x" } },
        ],
      },
    },
    { ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    {
      ...base,
      type: "assistant",
      message: {
        model: "claude-x",
        content: [
          { type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [{ content: "write tests", status: "in_progress" }] } },
        ],
      },
    },
    { ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    { ...base, type: "assistant", message: { model: "claude-x", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }] } },
    { ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "1 failing" }] } },
    { ...base, type: "user", isSidechain: true, message: { content: "subagent noise" } },
    { ...base, type: "assistant", message: { model: "claude-x", content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "npm test -- --watch=false" } }] } },
  ]);
  return sb;
}

test("claude: discover matches by recorded cwd", async () => {
  const sb = fixture();
  const refs = await claudeAdapter.discover(sb.project, sb.dirs);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.id, "sess-1");
  assert.equal((await claudeAdapter.discover(path.join(sb.home, "elsewhere"), sb.dirs)).length, 0);
});

test("claude: load + extract", async () => {
  const sb = fixture();
  const [ref] = await claudeAdapter.discover(sb.project, sb.dirs);
  const s = await claudeAdapter.load(ref!, sb.dirs);
  assert.equal(s.title, "Add login page");
  assert.equal(s.model, "claude-x");
  const users = s.events.filter((e) => e.kind === "user");
  assert.deepEqual(users.map((u) => (u as any).text), ["Build a login page"]); // meta + sidechain dropped

  const cp = extractCheckpoint(s, sb.project);
  assert.deepEqual(cp.filesTouched, ["src/login.tsx"]);
  assert.equal(cp.todos?.[0]?.status, "in_progress");
  assert.equal(cp.errors.length, 1);
  assert.match(cp.interruption ?? "", /stopped while running a tool: Bash npm test/);
});
