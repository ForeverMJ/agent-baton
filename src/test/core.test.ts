import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isWithin } from "../core/paths.js";
import { redact } from "../core/redact.js";
import { initProject } from "../core/workspace.js";
import { sandbox } from "./helpers.js";

test("redact: common secret shapes", () => {
  const input = [
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
    "postgres://admin:hunter2@db.local/app",
    "AKIAABCDEFGHIJKLMNOP",
  ].join("\n");
  const out = redact(input);
  for (const leak of ["sk-proj-abc", "ghp_abc", "abcdefghijklmnopqrstuvwxyz.123", "hunter2", "AKIAABCD"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}:\n${out}`);
  }
  assert.equal(redact("nothing secret here"), "nothing secret here");
});

test("paths: isWithin", () => {
  assert.ok(isWithin("/a/b/c", "/a/b"));
  assert.ok(isWithin("/a/b", "/a/b/"));
  assert.ok(!isWithin("/a/bc", "/a/b"));
});

test("init: idempotent, preserves existing AGENTS.md / CLAUDE.md content", async () => {
  const { project } = sandbox();
  writeFileSync(path.join(project, "AGENTS.md"), "# My rules\nUse tabs.\n");
  writeFileSync(path.join(project, "CLAUDE.md"), "# Claude notes\n");

  const first = await initProject(project);
  assert.ok(first.created.includes(".baton/STATE.md"));
  assert.ok(first.updated.includes("AGENTS.md"));
  const agents = readFileSync(path.join(project, "AGENTS.md"), "utf8");
  assert.match(agents, /Use tabs\./);
  assert.match(agents, /baton:start/);
  assert.match(readFileSync(path.join(project, "CLAUDE.md"), "utf8"), /baton:start/);

  const second = await initProject(project);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.updated, []);
  assert.equal(readFileSync(path.join(project, "AGENTS.md"), "utf8"), agents);
});

test("init: fresh project gets CLAUDE.md importing AGENTS.md", async () => {
  const { project } = sandbox();
  await initProject(project);
  assert.equal(readFileSync(path.join(project, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
});
