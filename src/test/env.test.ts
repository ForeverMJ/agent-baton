import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeProjectDir } from "../adapters/claude.js";
import { captureRef, discoverAll } from "../core/capture.js";
import { normalizeRemoteUrl } from "../core/git.js";
import { matchByRepo } from "../core/match.js";
import { isWithin, normalizePath } from "../core/paths.js";
import { adapterSource, nodeSource, type Source } from "../core/sources.js";
import { initProject } from "../core/workspace.js";
import { distroConfig, nodeOk } from "../env/detect.js";
import { winToWsl, wslToWin } from "../env/pathmap.js";
import { runHook } from "../hooks/handler.js";
import type { SessionRef } from "../model.js";
import { ctxOf, sandbox, writeJsonl } from "./helpers.js";

const M = { distro: "Ubuntu", mountRoot: "/mnt/" };

test("pathmap: Windows <-> WSL", () => {
  assert.equal(winToWsl("C:\\dev\\proj", M), "/mnt/c/dev/proj");
  assert.equal(winToWsl("c:/dev/proj/", M), "/mnt/c/dev/proj");
  assert.equal(winToWsl("D:\\", M), "/mnt/d");
  assert.equal(winToWsl("\\\\wsl.localhost\\Ubuntu\\home\\u\\p", M), "/home/u/p");
  assert.equal(winToWsl("//wsl.localhost/Ubuntu/home/u/p", M), "/home/u/p");
  assert.equal(winToWsl("\\\\wsl$\\ubuntu\\home", M), "/home");
  assert.equal(winToWsl("\\\\wsl.localhost\\Debian\\home", M), undefined); // other distro
  assert.equal(winToWsl("\\\\server\\share\\x", M), undefined);

  assert.equal(wslToWin("/mnt/c/dev/proj", M), "C:\\dev\\proj");
  assert.equal(wslToWin("/mnt/c", M), "C:\\");
  assert.equal(wslToWin("/home/u/p", M), "\\\\wsl.localhost\\Ubuntu\\home\\u\\p");
  assert.equal(wslToWin("/", M), "\\\\wsl.localhost\\Ubuntu");
  assert.equal(wslToWin("/data/x", { distro: "Ubuntu", mountRoot: "/" }), "\\\\wsl.localhost\\Ubuntu\\data\\x");
  assert.equal(wslToWin("/c/dev", { distro: "Ubuntu", mountRoot: "/" }), "C:\\dev");
});

test("paths: foreign-syntax paths compare correctly on any host", () => {
  assert.equal(normalizePath("/home/U/p/"), "/home/U/p"); // POSIX keeps case, never gets a drive letter
  assert.equal(normalizePath("C:\\Dev\\Proj\\"), "c:/dev/proj");
  assert.equal(normalizePath("\\\\wsl.localhost\\Ubuntu\\home"), "//wsl.localhost/ubuntu/home");
  assert.ok(isWithin("/home/u/p/src", "/home/u/p"));
  assert.ok(!isWithin("/home/u/px", "/home/u/p"));
  assert.ok(isWithin("C:\\dev\\p\\x", "c:/DEV/p"));
});

test("detect: node gate and probe parsing", () => {
  assert.ok(nodeOk("v22.5.0") && nodeOk("v24.15.0"));
  assert.ok(!nodeOk("v22.4.1") && !nodeOk("v20.11.0") && !nodeOk(undefined));

  const full = distroConfig("Ubuntu", "node=/n/bin/node\nnodever=v24.1.0\nmount=/mnt/c/\nhome=/home/u\nhas=.codex/sessions\n");
  assert.deepEqual(full.config, { name: "wsl:Ubuntu", kind: "wsl", distro: "Ubuntu", mountRoot: "/mnt/", mode: "node", node: "/n/bin/node" });
  assert.deepEqual(full.agents, [".codex/sessions"]);

  const old = distroConfig("Ubuntu", "node=/usr/bin/node\nnodever=v18.19.0\nmount=/mnt/c/\nhome=/home/u\n");
  assert.equal(old.config?.mode, "direct");
  assert.equal(old.config?.home, "/home/u");
  assert.match(old.problem ?? "", /too old/);

  const none = distroConfig("Ubuntu", "node=\nmount=/c/\nhome=/home/u\n");
  assert.equal(none.config?.mode, "direct");
  assert.equal(none.config?.mountRoot, "/");
});

test("git: remote URL normalization", () => {
  const same = [
    "https://github.com/Owner/Repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo",
    "https://user:tok@github.com/owner/repo/",
  ].map(normalizeRemoteUrl);
  assert.deepEqual(new Set(same), new Set(["github.com/owner/repo"]));
  assert.notEqual(normalizeRemoteUrl("git@github.com:owner/other"), "github.com/owner/repo");
});

// ------------------------------------------------------------- remote sources

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

/**
 * A nodeSource whose "other environment" is this machine with a different HOME: it runs the
 * real CLI's `export` in a child process, exercising the wire protocol without WSL.
 * Paths get a fake "remote" prefix so the translation is exercised too.
 */
function loopback(name: string, remoteHome: string): Source {
  const P = "remote:";
  const unwrap = (s: string) => (s.startsWith(P) ? s.slice(P.length) : s);
  return nodeSource({
    name,
    toForeign: (p) => P + p,
    toLocal: unwrap,
    run: (args) =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, [CLI, ...args.map(unwrap)], { env: { ...process.env, BATON_HOME: remoteHome } }, (err, out, errOut) =>
          err ? reject(new Error(errOut || err.message)) : resolve(out),
        ),
      ),
  });
}

function remoteCodex(remoteDirs: { codexSessions: string[] }, cwd: string, id = "remote-codex") {
  writeJsonl(path.join(remoteDirs.codexSessions[0]!, "2026", `rollout-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd, thread_source: "user" } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "port the API to Rust" }] } } },
    {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "FileChange", id: "f", status: "completed", changes: { [path.join(cwd, "src", "api.rs")]: {} } } },
    },
  ]);
}

test("node source: refs and sessions come back in local terms", async () => {
  const local = sandbox();
  const remote = sandbox();
  remoteCodex(remote.dirs, local.project);
  const ctx = ctxOf(local.dirs, [loopback("wsl:Test", remote.home)]);

  const all = await discoverAll(local.project, ctx);
  assert.deepEqual(all.map((x) => `${x.agent}@${x.env}`), ["codex@wsl:Test"]);
  assert.equal(path.resolve(all[0]!.cwd), path.resolve(local.project));
  assert.deepEqual(await discoverAll(local.project, ctx, { exclude: "codex" }), []);

  const cap = await captureRef(all[0]!, local.project, ctx, { write: false });
  assert.deepEqual(cap.checkpoint.goal, ["port the API to Rust"]);
  assert.deepEqual(cap.checkpoint.filesTouched, ["src/api.rs"]);
  assert.match(cap.markdown, /session in wsl:Test/);
});

test("node source: a broken environment only warns", async () => {
  const local = sandbox();
  const broken = nodeSource({ name: "wsl:Gone", toForeign: (p) => p, toLocal: (p) => p, run: async () => { throw new Error("distro not found"); } });
  const warnings: string[] = [];
  assert.deepEqual(await discoverAll(local.project, ctxOf(local.dirs, [broken]), { onWarning: (w) => warnings.push(w) }), []);
  assert.match(warnings[0] ?? "", /wsl:Gone: distro not found/);
});

test("direct source: reads another home's files, skips unsupported agents with a warning", async () => {
  const local = sandbox();
  const remote = sandbox();
  remoteCodex(remote.dirs, local.project);
  const direct = adapterSource({ name: "wsl:NoNode", dirs: remote.dirs, unsupported: { opencode: "needs node there" } });
  const warnings: string[] = [];
  const refs = await discoverAll(local.project, ctxOf(local.dirs, [direct]), { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(refs.map((r) => `${r.agent}@${r.env}`), ["codex@wsl:NoNode"]);
  assert.ok(warnings.some((w) => /opencode skipped \(needs node there\)/.test(w)));
});

test("hook start: Claude in another environment counts as another agent", async () => {
  const local = sandbox();
  const remote = sandbox();
  const own = path.join(local.dirs.claudeProjects, encodeProjectDir(local.project), "win.jsonl");
  writeJsonl(own, [{ type: "user", cwd: local.project, message: { content: "old work" } }]);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(own, old, old);
  writeJsonl(path.join(remote.dirs.claudeProjects, encodeProjectDir(local.project), "wsl.jsonl"), [
    { type: "user", cwd: local.project, message: { content: "continue in WSL" } },
  ]);
  await initProject(local.project);
  const ctx = ctxOf(local.dirs, [loopback("wsl:Test", remote.home)]);
  const text = await runHook({ agent: "claude", event: "start", cwd: local.project, sessionId: "new" }, ctx);
  assert.match(text, /claude \(wsl:Test\) worked on this project/);
});

// ------------------------------------------------------------- separate clones

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** sb.project is a repo; a second clone lives elsewhere, on a feature branch. */
function cloneFixture() {
  const sb = sandbox();
  git(sb.project, "init", "-q");
  writeFileSync(path.join(sb.project, "README.md"), "x");
  git(sb.project, "add", ".");
  git(sb.project, "commit", "-qm", "init");
  const other = path.join(sb.home, "elsewhere", "my-app-clone");
  mkdirSync(path.dirname(other), { recursive: true });
  git(path.dirname(other), "clone", "-q", sb.project, other);
  git(other, "checkout", "-qb", "feature/oauth");
  return { ...sb, other };
}

test("repo match: finds a session in another clone and flags it", async () => {
  const sb = cloneFixture();
  remoteCodex(sb.dirs, sb.other, "in-other-clone");

  assert.deepEqual(await discoverAll(sb.project, ctxOf(sb.dirs)), []); // path mode: invisible

  const ctx = ctxOf(sb.dirs, [], "repo");
  const refs = await discoverAll(sb.project, ctx);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.clone?.branch, "feature/oauth");
  assert.equal(normalizePath(refs[0]!.clone!.root), normalizePath(sb.other));

  const cap = await captureRef(refs[0]!, sb.project, ctx, { write: false });
  assert.match(cap.markdown, /Different clone/);
  assert.match(cap.markdown, /feature\/oauth/);
  assert.deepEqual(cap.checkpoint.filesTouched, ["src/api.rs"]); // relative to the clone it ran in
});

test("repo match: an unrelated repository is not matched", async () => {
  const sb = cloneFixture();
  const unrelated = path.join(sb.home, "unrelated");
  mkdirSync(unrelated);
  git(unrelated, "init", "-q");
  writeFileSync(path.join(unrelated, "a"), "a");
  git(unrelated, "add", ".");
  git(unrelated, "commit", "-qm", "other");
  remoteCodex(sb.dirs, unrelated, "unrelated");
  assert.deepEqual(await discoverAll(sb.project, ctxOf(sb.dirs, [], "repo")), []);
});

test("repo match: agent-recorded remote URL is enough when the directory is gone", () => {
  const ref = (id: string, cwd: string, repoUrl?: string): SessionRef => ({
    agent: "codex", id, cwd, updatedAt: new Date(), locator: id, repoUrl,
  });
  const noGit = () => () => undefined;
  const out = matchByRepo(
    [ref("a", "/gone/app", "git@github.com:me/app.git"), ref("b", "/gone/other", "https://github.com/me/other")],
    { urls: ["github.com/me/app"], roots: [] },
    noGit,
  );
  assert.deepEqual(out.map((r) => [r.id, r.clone?.root]), [["a", "/gone/app"]]);
});
