import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { opencodeAdapter } from "../adapters/opencode.js";
import { extractCheckpoint } from "../core/extract.js";
import { sandbox } from "./helpers.js";

test("opencode: discover + load from sqlite", async () => {
  const sb = sandbox();
  mkdirSync(path.dirname(sb.dirs.opencodeDb), { recursive: true });
  const db = new DatabaseSync(sb.dirs.opencodeDb);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
      model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
    CREATE TABLE credential (id TEXT, value TEXT);`);
  const dir = sb.project.replace(/\\/g, "/");
  const ins = (sql: string, ...v: any[]) => db.prepare(sql).run(...v);
  ins("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)", "ses_1", "p", null, dir, "Refactor db", null, 1, 5, null);
  ins("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)", "ses_child", "p", "ses_1", dir, "subagent", null, 1, 6, null);
  ins("INSERT INTO message VALUES (?,?,?,?)", "m1", "ses_1", 1, JSON.stringify({ role: "user" }));
  ins("INSERT INTO message VALUES (?,?,?,?)", "m2", "ses_1", 2, JSON.stringify({ role: "assistant", modelID: "m-x" }));
  ins("INSERT INTO part VALUES (?,?,?,?,?)", "p1", "m1", "ses_1", 1, JSON.stringify({ type: "text", text: "Refactor the db layer" }));
  ins("INSERT INTO part VALUES (?,?,?,?,?)", "p2", "m2", "ses_1", 2, JSON.stringify({
    type: "tool", tool: "edit", callID: "c1",
    state: { status: "completed", input: { filePath: path.join(sb.project, "db.ts") }, output: "ok" },
  }));
  ins("INSERT INTO part VALUES (?,?,?,?,?)", "p3", "m2", "ses_1", 3, JSON.stringify({
    type: "tool", tool: "bash", callID: "c2", state: { status: "running", input: { command: "bun test" } },
  }));
  ins("INSERT INTO todo VALUES (?,?,?,?,?)", "ses_1", "migrate queries", "in_progress", "high", 0);
  db.close();

  const refs = await opencodeAdapter.discover(sb.project, sb.dirs);
  assert.deepEqual(refs.map((r) => r.id), ["ses_1"]); // child session excluded
  const s = await opencodeAdapter.load(refs[0]!, sb.dirs);
  assert.equal(s.model, "m-x");
  const cp = extractCheckpoint(s, sb.project);
  assert.deepEqual(cp.goal, ["Refactor the db layer"]);
  assert.deepEqual(cp.filesTouched, ["db.ts"]);
  assert.equal(cp.todos?.[0]?.content, "migrate queries");
  assert.match(cp.interruption ?? "", /bash bun test/);
});
