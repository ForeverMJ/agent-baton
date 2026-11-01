#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { adapters, agentNames, getAdapter } from "./adapters/index.js";
import { captureRef, discoverAll } from "./core/capture.js";
import { gitRoot } from "./core/git.js";
import { agentDirs, displayPath, type AgentDirs } from "./core/paths.js";
import { localSource, type Context, type ExportPayload, type MatchMode, type Source } from "./core/sources.js";
import { oneLine } from "./core/text.js";
import { batonPaths, initProject, isInitialized, readProjectConfig } from "./core/workspace.js";
import { configPath, loadConfig, saveConfig, type EnvConfig } from "./env/config.js";
import { isWsl, listDistros, probeDistro, probeWindows, type Probe } from "./env/detect.js";
import { describeSource, makeSource } from "./env/remote.js";
import { normalizeEvent, runHook } from "./hooks/handler.js";
import {
  claudeSettingsPath,
  codexHooksPath,
  currentInvocation,
  installClaude,
  installCodex,
  installOpencode,
  isEphemeral,
  stableInvocation,
  wslCopyDir,
  opencodePluginPath,
  uninstallClaude,
  uninstallCodex,
  uninstallOpencode,
  type Scope,
} from "./hooks/install.js";
import { cmdMem } from "./memory/cli.js";
import { connectAgent, type ConnectAgent } from "./memory/connect.js";
import { serveMcp } from "./memory/mcp.js";
import { isEnabled as isMemoryEnabled, memoryDir } from "./memory/store.js";
import type { AgentName } from "./model.js";

const VERSION = "0.6.0";
const HOOKABLE = ["claude", "codex", "opencode"] as const;
// Install targets: the hookable agents, plus the Claude app's Chat (MCP only: it has no hooks).
const TARGETS = [...HOOKABLE, "claude-desktop"] as const;

const HELP = `baton ${VERSION}: one local memory for all your coding agents, and handoff between them

Usage:
  baton                      capture the latest session for this project and write .baton/RESUME.md
  baton init                 set up .baton/ and the AGENTS.md / CLAUDE.md handoff rules
  baton list                 list sessions of all agents for this project
  baton capture              same as plain \`baton\`, with options below
  baton resume               print .baton/RESUME.md (paste it into an agent if needed)
  baton install [agent]      enable hooks and, after \`baton mem init\`, the shared memory
                             (${TARGETS.join(", ")}; default: all)
  baton uninstall [agent]    remove them again
  baton env [list]           show other environments baton reads (WSL distros / Windows host)
  baton env detect           find WSL distros (or the Windows host) with agent data and add them
  baton env add <name>       add one: wsl:<distro> (from Windows) or windows (from WSL)
  baton env remove <name>    stop reading it
  baton mem <command>        memory shared by all your agents, across projects (\`baton mem help\`)
  baton mcp                  serve that memory to agents as an MCP server (stdio)
  baton hook <agent>         entry point called by the hooks themselves
  baton export               internal: print sessions as JSON for another environment

Options:
  --from <agent>             only consider this agent (${agentNames.join(" | ")})
  --exclude <agent>          ignore this agent (e.g. the one you are switching to)
  --session <id>             pick a specific session (id prefix is enough)
  --root <dir>               project root (default: git root of cwd, else cwd)
  --match <path|repo>        repo: also find sessions in other clones of this repository
                             (default: "match" in .baton/config.json, else path)
  --stdout                   print the checkpoint instead of writing .baton/ (capture)
  --json                     machine-readable output (list)
  --project                  install hooks for this project only (default: global)
  --local                    ignore other environments (WSL / Windows host)
  -h, --help                 show help
  -v, --version              show version
`;

type Values = {
  from?: string;
  exclude?: string;
  session?: string;
  root?: string;
  event?: string;
  match?: string;
  since?: string;
  "repo-urls"?: string;
  "repo-roots"?: string;
  lang?: string;
  topic?: string;
  replaces?: string;
  agent?: string;
  limit?: string;
  all?: boolean;
  join?: string;
  json?: boolean;
  stdout?: boolean;
  project?: boolean;
  local?: boolean;
  git?: boolean;
  help?: boolean;
  version?: boolean;
};

function fail(msg: string): never {
  process.stderr.write(`baton: ${msg}\n`);
  process.exit(1);
}

const warn = (msg: string) => process.stderr.write(`baton: warning: ${msg}\n`);

function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const label = (r: { agent: string; env?: string }) => (r.env ? `${r.agent}@${r.env}` : r.agent);

/** Everything a command needs to see sessions: local agents + configured environments + match mode. */
async function buildContext(root: string, dirs: AgentDirs, v: Values, onWarning: (m: string) => void = warn): Promise<Context> {
  const sources: Source[] = [localSource(dirs)];
  if (!v.local) {
    const cli = currentInvocation().args[0]!;
    try {
      for (const e of (await loadConfig()).environments) {
        try {
          sources.push(makeSource(e, cli));
        } catch (err) {
          onWarning((err as Error).message);
        }
      }
    } catch (err) {
      onWarning((err as Error).message);
    }
  }
  const match = (v.match ?? (await readProjectConfig(root)).match ?? "path") as MatchMode;
  if (match !== "path" && match !== "repo") fail(`--match must be "path" or "repo"`);
  return { dirs, sources, match };
}

async function cmdList(root: string, ctx: Context, v: Values): Promise<void> {
  const refs = await discoverAll(root, ctx, { only: v.from, exclude: v.exclude, onWarning: warn });
  if (v.json) {
    process.stdout.write(JSON.stringify(refs, null, 2) + "\n");
    return;
  }
  if (!refs.length) {
    process.stdout.write(`No sessions found for ${root}\n`);
    return;
  }
  for (const r of refs) {
    const where = r.clone ? `[clone ${r.clone.root}${r.clone.branch ? ` @${r.clone.branch}` : ""}]  ` : displayPath(r.cwd, root);
    process.stdout.write(
      `${label(r).padEnd(18)} ${ago(r.updatedAt).padEnd(9)} ${r.id.padEnd(38)} ${where === "." ? "" : where + "  "}${oneLine(r.title ?? "", 60)}\n`,
    );
  }
}

async function cmdCapture(root: string, ctx: Context, v: Values): Promise<void> {
  const refs = await discoverAll(root, ctx, { only: v.from, exclude: v.exclude, onWarning: warn });
  if (!refs.length) fail(`no ${v.from ?? "agent"} sessions found for ${root}`);
  let ref = refs[0]!;
  if (v.session) {
    const hit = refs.filter((r) => r.id.startsWith(v.session!));
    if (hit.length === 0) fail(`no session matching "${v.session}"; run \`baton list\``);
    if (hit.length > 1) fail(`"${v.session}" is ambiguous (${hit.length} matches)`);
    ref = hit[0]!;
  }

  const firstRun = !isInitialized(root);
  const { checkpoint: cp, markdown, file } = await captureRef(ref, root, ctx, { write: !v.stdout });
  if (v.stdout) return void process.stdout.write(markdown);

  const rel = (f: string) => path.relative(root, f).replace(/\\/g, "/");
  const out = process.stdout;
  out.write(`Captured ${label(ref)} session ${ref.id} (last active ${ago(ref.updatedAt)})\n`);
  if (ref.clone) out.write(`  ⚠ clone: ran in another clone (${ref.clone.root}${ref.clone.branch ? `, branch ${ref.clone.branch}` : ""})\n`);
  if (cp.session.title) out.write(`  title:   ${oneLine(cp.session.title, 80)}\n`);
  out.write(`  stopped: ${cp.interruption ?? "normally"}\n`);
  if (cp.quota) out.write(`  quota:   ${cp.quota.usedPercent}% used${cp.quota.resetsAt ? `, resets ${cp.quota.resetsAt}` : ""}\n`);
  if (cp.todos?.length) {
    const done = cp.todos.filter((t) => t.status === "completed").length;
    out.write(`  todos:   ${done}/${cp.todos.length} done\n`);
  }
  out.write(`  files:   ${cp.filesTouched.length} touched, ${cp.errors.length} recent failure(s)\n`);
  out.write(`\nWrote ${rel(batonPaths(root).resume)} (history: ${rel(file!)})\n`);
  const others = refs.filter((r) => r !== ref).slice(0, 3);
  if (!v.session && others.length) {
    out.write(`Other recent sessions: ${others.map((r) => `${label(r)}:${r.id.slice(0, 12)} (${ago(r.updatedAt)})`).join(", ")}\n`);
  }
  out.write(
    firstRun || !existsSync(path.join(root, "AGENTS.md"))
      ? "\nTip: run `baton init` once so every agent reads .baton/ automatically.\n"
      : "\nNow open the next agent in this project and say: \"continue\".\n",
  );
}

async function cmdResume(root: string): Promise<void> {
  const p = batonPaths(root);
  if (!existsSync(p.resume)) fail("no .baton/RESUME.md yet; run `baton capture` first");
  process.stdout.write(await readFile(p.resume, "utf8"));
}

async function cmdInit(root: string): Promise<void> {
  const r = await initProject(root);
  for (const f of r.created) process.stdout.write(`  created   ${f}\n`);
  for (const f of r.updated) process.stdout.write(`  updated   ${f}\n`);
  for (const f of r.unchanged) process.stdout.write(`  unchanged ${f}\n`);
  process.stdout.write("\nbaton is set up. Commit .baton/STATE.md, AGENTS.md and CLAUDE.md so every agent shares them.\n");
  process.stdout.write("For automatic capture, run `baton install` once (Claude Code hooks + opencode plugin).\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Called by hooks. Must never fail loudly or print anything but context. */
async function cmdHook(agent: string | undefined, dirs: AgentDirs, v: Values): Promise<void> {
  try {
    // Warnings must not reach the agent; runHook logs to .baton/hook.log.
    const ctx = (root: string) => buildContext(root, dirs, v, () => {});
    const memory = { dir: memoryDir(), dirs };
    let text = "";
    if (agent === "claude" || agent === "codex") {
      // Claude Code and Codex send the same stdin payload (session_id, transcript_path, cwd, hook_event_name).
      const payload = JSON.parse((await readStdin()) || "{}");
      const event = normalizeEvent(payload.hook_event_name);
      if (!event) return;
      // Stop fires as the turn ends; give the transcript writer a moment to flush.
      if (event === "stop") await new Promise((r) => setTimeout(r, 400));
      text = await runHook(
        {
          agent,
          event,
          cwd: (agent === "claude" ? process.env.CLAUDE_PROJECT_DIR : undefined) ?? payload.cwd ?? process.cwd(),
          sessionId: payload.session_id,
          transcriptPath: payload.transcript_path,
        },
        ctx,
        memory,
      );
    } else if (agent === "opencode") {
      const event = normalizeEvent(v.event);
      if (!event) return;
      text = await runHook({ agent: "opencode", event, cwd: v.root ?? process.cwd(), sessionId: v.session }, ctx, memory);
    }
    if (!text) return;
    if (agent === "codex") {
      // Codex rejects plain stdout that looks like JSON (ours starts with "[baton]"): use the
      // documented structured form instead.
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) + "\n",
      );
    } else {
      process.stdout.write(text + "\n");
    }
  } catch (e) {
    // Exit 0 regardless: agents ignore stderr of successful hooks but keep it in their debug logs.
    process.stderr.write(`baton hook ${agent}: ${(e as Error).message}\n`);
  }
}

/** Runs in the *other* environment on behalf of a nodeSource: local agents only, JSON out. */
async function cmdExport(root: string, dirs: AgentDirs, v: Values): Promise<void> {
  const local = localSource(dirs);
  let payload: ExportPayload;
  if (v.git) {
    const view = await local.git(root);
    payload = { version: 1, git: view.info ?? null, repo: view.repo ?? null };
  } else if (v.session) {
    // Look the id up across all sessions: in repo mode it may live outside `root`.
    const chosen = adapters.filter((a) => !v.from || a.name === v.from);
    let found;
    for (const a of chosen) {
      if (!(await a.available(dirs))) continue;
      found = (await a.list(dirs)).find((r) => r.id === v.session);
      if (found) break;
    }
    if (!found) fail(`no session ${v.session}`);
    payload = { version: 1, session: await getAdapter(found.agent).load(found, dirs) };
  } else {
    const list = (s?: string) => (s && s !== "-" ? s.split(",").filter(Boolean) : []);
    const repo = v["repo-urls"] || v["repo-roots"] ? { urls: list(v["repo-urls"]), roots: list(v["repo-roots"]) } : undefined;
    const refs = await local.refs(root, {
      only: v.from,
      exclude: v.exclude,
      repo,
      since: v.since ? new Date(v.since) : undefined,
    });
    payload = { version: 1, refs };
  }
  process.stdout.write(JSON.stringify(payload));
}

async function cmdInstall(which: string | undefined, root: string, v: Values, remove: boolean): Promise<void> {
  const targets = which ? [which] : [...TARGETS];
  for (const t of targets) if (!(TARGETS as readonly string[]).includes(t)) fail(`cannot install for "${t}" (supported: ${TARGETS.join(", ")})`);
  const scope: Scope = v.project ? "project" : "global";
  // Inside WSL, a baton on a Windows drive installs a local copy of itself (see stableInvocation).
  const inv = remove ? currentInvocation() : await stableInvocation();
  if (!remove && isEphemeral(inv)) {
    warn("baton is running from a temporary npx cache; hooks would break later. Install it first: npm i -g baton-cli");
  }
  // The shared memory is per person, so its MCP server and rules always go to the global files.
  const memory = scope === "global" && (remove || isMemoryEnabled(memoryDir()));
  const row = (t: string, part: string, outcome: string, file: string) =>
    process.stdout.write(`  ${t.padEnd(14)} ${part.padEnd(6)} ${outcome.padEnd(10)} ${file}\n`);
  let codexHooksChanged = false;
  for (const t of targets) {
    if (t !== "claude-desktop") {
      const [file, install, uninstall] =
        t === "claude"
          ? [claudeSettingsPath(scope, root), installClaude, uninstallClaude]
          : t === "codex"
            ? [codexHooksPath(scope, root), installCodex, uninstallCodex]
            : [opencodePluginPath(scope, root), installOpencode, uninstallOpencode];
      const outcome = remove ? await uninstall(file) : await install(file, inv);
      if (t === "codex" && (outcome === "installed" || outcome === "updated")) codexHooksChanged = true;
      row(t, "hooks", outcome, file);
    }
    if (!memory) continue;
    try {
      for (const r of await connectAgent(t as ConnectAgent, inv, remove)) row(t, r.part, r.outcome, r.file);
    } catch (e) {
      warn(`${t}: ${(e as Error).message}`);
    }
  }
  if (!remove && scope === "global" && !memory) {
    process.stdout.write("\nShared memory is not set up; run `baton mem init`, then `baton install` again to connect the agents.\n");
  }
  if (!remove && memory) {
    process.stdout.write("\nShared memory connected: restart running agents so they load the baton MCP server and rules.\n");
  }
  if (remove && !which && isWsl() && existsSync(wslCopyDir())) {
    await rm(wslCopyDir(), { recursive: true, force: true });
    process.stdout.write(`  removed baton's local copy ${wslCopyDir()}\n`);
  }
  if (!remove && memory && targets.includes("claude-desktop")) {
    process.stdout.write("In the Claude app's Chat, allow the baton tools the first time they are used.\n");
  }
  if (!remove && codexHooksChanged) {
    process.stdout.write(
      "\nCodex runs a new or changed hook only after you trust it: open Codex, run /hooks and trust the\n" +
        "baton entries (once, and again after `baton install` changes them).\n",
    );
  }
  if (!remove && targets.some((t) => t !== "claude-desktop")) {
    process.stdout.write(
      `\nAuto-capture is active in projects that ran \`baton init\`.\n` +
        `Hooks call: ${[inv.command, ...inv.args].join(" ")}\n` +
        `(re-run \`baton install\` if you move baton or change your Node installation)\n`,
    );
  }
}

// ------------------------------------------------------------- environments

const AGENT_DIR_NAMES: Record<string, string> = {
  ".codex/sessions": "codex",
  ".claude/projects": "claude",
  ".local/share/opencode/opencode.db": "opencode",
};

function describeProbe(name: string, p: Probe): string {
  if (!p.config) return `${name}: ${p.problem ?? "unusable"}`;
  const agents =
    p.config.kind === "windows"
      ? "agent data is looked up on use"
      : p.agents.length ? "agents: " + p.agents.map((a) => AGENT_DIR_NAMES[a] ?? a).join(", ") : "no agent data";
  const mode =
    p.config.mode === "direct"
      ? `direct mode, ${p.problem}: reading files across the boundary` +
        (p.config.kind === "wsl" ? " (opencode there cannot be read; install Node >= 22.5 for full support)" : "")
      : `node ${p.nodeVersion} at ${p.config.node}`;
  return `${name}: ${mode}; ${agents}`;
}

async function probe(name: string): Promise<Probe> {
  if (name === "windows") {
    if (!isWsl()) fail("`windows` can only be added from inside WSL");
    return probeWindows();
  }
  const m = name.match(/^wsl:(.+)$/);
  if (!m) fail(`unknown environment "${name}" (use wsl:<distro> or windows)`);
  if (process.platform !== "win32") fail("wsl:<distro> environments can only be added from Windows");
  return probeDistro(m[1]!);
}

async function cmdEnv(sub: string | undefined, name: string | undefined): Promise<void> {
  const cfg = await loadConfig();
  const out = process.stdout;
  const upsert = (e: EnvConfig) => {
    cfg.environments = [...cfg.environments.filter((x) => x.name !== e.name), e];
  };
  switch (sub ?? "list") {
    case "list": {
      if (!cfg.environments.length) out.write("No other environments configured. Try `baton env detect`.\n");
      for (const e of cfg.environments) out.write(`${e.name.padEnd(20)} ${describeSource(e)}\n`);
      return;
    }
    case "detect": {
      const names = isWsl() ? ["windows"] : process.platform === "win32" ? (await listDistros()).map((d) => `wsl:${d}`) : [];
      if (!names.length) return void out.write("Nothing to detect here (no WSL distros, and not inside WSL).\n");
      let added = 0;
      for (const n of names) {
        out.write(`probing ${n} ...\n`);
        const p = await probe(n);
        out.write(`  ${describeProbe(n, p)}\n`);
        // From WSL we cannot cheaply tell whether Windows has agent data; add it whenever it is usable.
        if (p.config && (p.agents.length || n === "windows")) {
          upsert(p.config);
          added++;
        }
      }
      if (added) out.write(`\nSaved ${added} environment(s) to ${await saveConfig(cfg)}\n`);
      else out.write("\nNothing added.\n");
      return;
    }
    case "add": {
      if (!name) fail("usage: baton env add <wsl:distro|windows>");
      const p = await probe(name);
      out.write(`${describeProbe(name, p)}\n`);
      if (!p.config) fail(`cannot add ${name}`);
      upsert(p.config);
      out.write(`Saved to ${await saveConfig(cfg)}\n`);
      return;
    }
    case "remove":
    case "rm": {
      if (!name) fail("usage: baton env remove <name>");
      const before = cfg.environments.length;
      cfg.environments = cfg.environments.filter((x) => x.name !== name);
      if (cfg.environments.length === before) fail(`${name} is not configured (see ${configPath()})`);
      await saveConfig(cfg);
      out.write(`Removed ${name}\n`);
      return;
    }
    default:
      fail(`unknown env command "${sub}"`);
  }
}

// ------------------------------------------------------------- main

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        from: { type: "string" },
        exclude: { type: "string" },
        session: { type: "string" },
        root: { type: "string" },
        event: { type: "string" },
        match: { type: "string" },
        since: { type: "string" },
        "repo-urls": { type: "string" },
        "repo-roots": { type: "string" },
        lang: { type: "string" },
        topic: { type: "string" },
        replaces: { type: "string" },
        agent: { type: "string" },
        limit: { type: "string" },
        all: { type: "boolean" },
        join: { type: "string" },
        json: { type: "boolean" },
        stdout: { type: "boolean" },
        project: { type: "boolean" },
        local: { type: "boolean" },
        git: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const v = parsed.values as Values;
  const [cmd = "capture", arg, ...rest] = parsed.positionals;
  if (v.help || cmd === "help") return void process.stdout.write(HELP);
  if (v.version) return void process.stdout.write(VERSION + "\n");
  const dirs = agentDirs();

  if (cmd === "hook") return cmdHook(arg, dirs, v);
  if (cmd === "mem") return cmdMem(arg, rest, v, dirs);
  if (cmd === "mcp") return serveMcp({ dir: memoryDir(), dirs, version: VERSION });
  if (cmd === "env") {
    if (rest.length > 1) fail(`unexpected argument "${rest[1]}"`);
    return cmdEnv(arg, rest[0]);
  }

  const takesArg = cmd === "install" || cmd === "uninstall";
  const extra = takesArg ? rest : [arg, ...rest].filter((x) => x !== undefined);
  if (extra.length) fail(`unexpected argument "${extra[0]}"`);
  for (const a of [v.from, v.exclude]) if (a && !agentNames.includes(a as AgentName)) fail(`unknown agent "${a}"`);

  const root = path.resolve(v.root ?? gitRoot(process.cwd()) ?? process.cwd());
  if (cmd === "export") return cmdExport(v.root ?? root, dirs, v); // keep the caller's path syntax verbatim

  switch (cmd) {
    case "init":
      return cmdInit(root);
    case "list":
    case "ls":
      return cmdList(root, await buildContext(root, dirs, v), v);
    case "capture":
      return cmdCapture(root, await buildContext(root, dirs, v), v);
    case "resume":
      return cmdResume(root);
    case "install":
      return cmdInstall(arg, root, v, false);
    case "uninstall":
      return cmdInstall(arg, root, v, true);
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => fail(e instanceof Error ? (process.env.BATON_DEBUG ? (e.stack ?? e.message) : e.message) : String(e)));
