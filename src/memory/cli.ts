// `baton mem <command>`: the human side of the shared memory, and the fallback for agents
// without MCP (they can run `baton mem add ...` / `baton mem search ...` in a shell).

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentDirs } from "../core/paths.js";
import { oneLine } from "../core/text.js";
import { loadConfig, saveConfig } from "../env/config.js";
import { isWsl, probeDistro } from "../env/detect.js";
import { winToWsl } from "../env/pathmap.js";
import { currentInvocation } from "../hooks/install.js";
import { buildBrief } from "./brief.js";
import { readBlock } from "./journal.js";
import { defaultLang, type Lang } from "./labels.js";
import { findTopic, forgetItem, isProfileKind, KINDS, listTopics, profileTemplate, remember, type Kind } from "./notes.js";
import { formatHits, search } from "./search.js";
import { isEnabled, localEnvName, memoryDir, memoryPaths, readConfig, readText, writeAtomic, writeConfig } from "./store.js";
import { forgetSession, matchSessions, readState, sync, writeState, type SyncResult } from "./sync.js";

export interface MemValues {
  since?: string;
  lang?: string;
  topic?: string;
  replaces?: string;
  agent?: string;
  session?: string;
  limit?: string;
  all?: boolean;
  join?: string;
  json?: boolean;
}

export const MEM_HELP = `baton mem: memory shared by all your agents (~/.config/baton/memory/)

  baton mem init [--lang en|zh] [--since 30d|all|<date>]   create it, backfill the journal
  baton mem init --join <dir>            use an existing memory (e.g. WSL using the Windows one)
  baton mem share wsl:<distro>           (on Windows) connect that distro's agents to this memory
  baton mem sync [--all]                 journal new/updated sessions of every agent (--all: rebuild)
  baton mem status                       where it is, what is in it
  baton mem search <words...>            [--agent <a>] [--since <date>] [--limit n] [--json]
  baton mem show [topic | agent:session] profile + topics, one topic, or a journal entry
  baton mem brief                        the summary an agent gets at session start (also MCP memory_context)
  baton mem add <kind> <text...>         kind: ${KINDS.join(" | ")}
                                         [--topic <name>] (required for status/decision/next)
                                         [--replaces m:<id>] [--agent <name>]
  baton mem forget m:<id>                delete one item
  baton mem forget --session <agent:id>  drop a session from the journal for good

Agents use it through the MCP server \`baton mcp\` (memory_context, memory_search, memory_read,
memory_remember, memory_forget). The location is BATON_MEMORY_DIR, else "memoryDir" in
~/.config/baton/config.json (set by --join), else the default.
`;

const out = (s: string) => process.stdout.write(s);

/** Run baton inside a WSL distro with its own node; resolves to stdout. */
function inDistro(distro: string, node: string, cli: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "wsl.exe",
      ["-d", distro, "--exec", node, cli, ...args],
      { encoding: "utf8", timeout: 180_000, windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" | "))) : resolve(stdout)),
    ),
  );
}

function fail(msg: string): never {
  process.stderr.write(`baton: ${msg}\n`);
  process.exit(1);
}

/** "30d", "12h", "all", or a date. undefined = no limit. */
export function parseSince(s: string | undefined, fallback?: Date): Date | undefined {
  if (s === undefined) return fallback;
  if (s === "all") return undefined;
  const m = /^(\d+)([dh])$/.exec(s);
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) fail(`invalid --since "${s}" (use 30d, 12h, all or a date)`);
  return d;
}

/** Which agent is running us (for `mem add` attribution). */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDECODE) return "claude";
  if (env.OPENCODE) return "opencode";
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return "codex";
  return "user";
}

function summary(r: SyncResult): string {
  const parts = [`${r.written} written`, `${r.unchanged} unchanged`];
  if (r.headless) parts.push(`${r.headless} headless skipped`);
  if (r.empty) parts.push(`${r.empty} empty`);
  if (r.pending) parts.push(`${r.pending} pending`);
  if (r.failed) parts.push(`${r.failed} failed`);
  return `${parts.join(", ")} in ${(r.ms / 1000).toFixed(1)}s`;
}

const warn = (m: string) => process.stderr.write(`baton: warning: ${m}\n`);

function requireEnabled(dir: string): void {
  if (!isEnabled(dir)) fail(`no memory at ${dir} yet; run \`baton mem init\``);
}

export async function cmdMem(sub: string | undefined, args: string[], v: MemValues, dirs: AgentDirs): Promise<void> {
  const dir = memoryDir();
  const p = memoryPaths(dir);
  switch (sub) {
    case undefined:
    case "help":
      return void out(MEM_HELP);

    case "init": {
      if (v.join) {
        // Use a memory that already exists (another environment's), never create one here.
        const target = path.resolve(v.join);
        if (!isEnabled(target)) fail(`${target} is not a baton memory (no config.json); run \`baton mem init\` where it lives`);
        const c = await loadConfig();
        c.memoryDir = target;
        const file = await saveConfig(c);
        out(`Joined the shared memory at ${target} (recorded in ${file})\n`);
        const env = localEnvName();
        const r = await sync(target, { dirs, onWarning: warn });
        out(`Journal, sessions of this environment${env ? ` (${env})` : ""}: ${summary(r)}\n`);
        return;
      }
      const fresh = !isEnabled(dir);
      if (v.lang && v.lang !== "en" && v.lang !== "zh") fail(`--lang must be en or zh`);
      const cfg = fresh ? { lang: (v.lang as Lang) ?? defaultLang(), exclude: [], includeHeadless: false } : await readConfig(dir);
      if (v.lang) cfg.lang = v.lang as Lang;
      await mkdir(p.topics, { recursive: true });
      await mkdir(p.journal, { recursive: true });
      await writeConfig(dir, cfg);
      if ((await readText(p.profile)) === undefined) await writeAtomic(p.profile, profileTemplate(cfg.lang));
      const st = await readState(dir);
      if (fresh || v.since) {
        st.floor = parseSince(v.since, new Date(Date.now() - 30 * 86_400_000))?.toISOString();
        await writeState(dir, st);
      }
      out(`${fresh ? "Created" : "Updated"} ${dir} (lang: ${cfg.lang}, journal from ${st.floor ? st.floor.slice(0, 10) : "the beginning"})\n`);
      const r = await sync(dir, { dirs, onWarning: warn });
      out(`Journal: ${summary(r)}\n`);
      if (fresh) out("\nNext: `baton install` connects Claude Code, Codex and opencode (MCP server, rules, hooks).\n");
      return;
    }

    case "share": {
      // From Windows: run this same baton inside the distro (its node, our cli.js through /mnt/c) to
      // register the host for transcripts, join this memory, and install for that distro's agents.
      requireEnabled(dir);
      const name = args[0];
      if (!name?.startsWith("wsl:")) fail("usage: baton mem share wsl:<distro>   (run on Windows)");
      if (isWsl()) fail("run `baton mem share` on Windows; inside WSL use `baton mem init --join <dir>`");
      const cfg = await loadConfig();
      let e = cfg.environments.find((x) => x.name === name);
      if (!e) {
        const p = await probeDistro(name.slice(4));
        if (!p.config) fail(`cannot reach ${name}: ${p.problem ?? "unknown problem"}`);
        cfg.environments.push(p.config);
        await saveConfig(cfg);
        e = p.config;
        out(`Added environment ${name} (so its session transcripts can be read from here)\n`);
      }
      if ((e.mode ?? "node") !== "node" || !e.node) {
        fail(`${name} has no Node >= 22.5; install one there, then \`baton env add ${name}\` and retry`);
      }
      const m = { distro: e.distro, mountRoot: e.mountRoot };
      const cli = winToWsl(currentInvocation().args[0]!, m);
      const memW = winToWsl(dir, m);
      if (!cli || !memW) fail(`baton and the memory must be on a Windows drive to be shared with ${name}`);
      const steps: [string[], boolean][] = [
        [["env", "add", "windows"], false], // optional: only transcripts of host sessions depend on it
        [["mem", "init", "--join", memW], true],
        [["install"], true],
      ];
      for (const [step, required] of steps) {
        out(`\n$ baton ${step.join(" ")}   (in ${name})\n`);
        try {
          out(await inDistro(e.distro, e.node, cli, step));
        } catch (err) {
          if (required) fail(`${name}: ${(err as Error).message}`);
          warn(`${name}: ${(err as Error).message}`);
        }
      }
      out(`\n${name} now shares this memory. Restart agents running there; in its Codex, run /hooks and trust the baton hooks.\n`);
      return;
    }

    case "sync": {
      requireEnabled(dir);
      if (v.all) {
        const st = await readState(dir);
        delete st.floor;
        await writeState(dir, st);
      }
      const r = await sync(dir, { dirs, force: v.all, onWarning: warn });
      out(`Journal: ${summary(r)}\n`);
      return;
    }

    case "status": {
      requireEnabled(dir);
      const cfg = await readConfig(dir);
      const st = await readState(dir);
      const profile = (await readText(p.profile)) ?? "";
      const items = profile.split("\n").filter((l) => /^\s*[-*]\s/.test(l) && !l.includes("~~")).length;
      const topics = await listTopics(dir);
      const byAgent: Record<string, number> = {};
      for (const [k, s] of Object.entries(st.sessions)) if (s.day) byAgent[k.slice(0, k.indexOf(":"))] = (byAgent[k.slice(0, k.indexOf(":"))] ?? 0) + 1;
      out(`Memory:   ${dir} (lang: ${cfg.lang})\n`);
      out(`Profile:  ${items} item(s)\n`);
      out(`Topics:   ${topics.length} (${topics.filter((t) => t.status === "active").length} active)\n`);
      out(`Journal:  ${Object.entries(byAgent).map(([a, n]) => `${a} ${n}`).join(", ") || "empty"}` +
        `${st.floor ? ` (since ${st.floor.slice(0, 10)})` : ""}\n`);
      out(`Synced:   ${st.lastSync ?? "never"}${st.ignored.length ? `, ${st.ignored.length} session(s) forgotten` : ""}\n`);
      if (cfg.exclude.length) out(`Excluded: ${cfg.exclude.join(", ")}\n`);
      return;
    }

    case "search": {
      requireEnabled(dir);
      const q = args.join(" ").trim();
      if (!q) fail("usage: baton mem search <words...>");
      const hits = await search(dir, q, { agent: v.agent, since: parseSince(v.since), limit: v.limit ? Number(v.limit) : 10 });
      if (v.json) return void out(JSON.stringify(hits, null, 2) + "\n");
      return void out(hits.length ? formatHits(hits) + "\n" : `Nothing found for "${q}"\n`);
    }

    case "brief": {
      requireEnabled(dir);
      return void out((await buildBrief(dir)) + "\n");
    }

    case "show": {
      requireEnabled(dir);
      const what = args.join(" ").trim();
      if (!what) {
        out((await readText(p.profile)) ?? "");
        const topics = await listTopics(dir);
        if (topics.length) {
          out(`\nTopics:\n`);
          for (const t of topics) out(`  ${t.title.padEnd(30)} ${t.status.padEnd(7)} ${t.updated ?? ""}  (${path.basename(t.file)})\n`);
        }
        return;
      }
      const topic = await findTopic(dir, what);
      if (topic) return void out((await readText(topic.file)) ?? "");
      const st = await readState(dir);
      const keys = matchSessions(st, what);
      if (!keys.length) fail(`no topic or journaled session matching "${what}"`);
      for (const k of keys.slice(0, 5)) {
        const b = await readBlock(dir, k, st.sessions[k]!.day!);
        if (b) out(`${b.block}\n\n`);
      }
      return;
    }

    case "add": {
      requireEnabled(dir);
      const [kind, ...words] = args;
      if (!kind || !KINDS.includes(kind as Kind)) fail(`usage: baton mem add <${KINDS.join("|")}> <text...>`);
      if (!isProfileKind(kind as Kind) && !v.topic) fail(`"${kind}" needs --topic <name>`);
      const r = await remember(dir, {
        kind: kind as Kind,
        text: words.join(" "),
        topic: v.topic,
        replaces: v.replaces,
        agent: v.agent ?? detectAgent(),
      });
      out(`Remembered m:${r.id} in ${path.relative(dir, r.file).replace(/\\/g, "/")}` +
        `${r.replaced ? ` (replaces m:${r.replaced.id}: ${oneLine(r.replaced.text, 60)})` : ""}\n`);
      return;
    }

    case "forget": {
      requireEnabled(dir);
      if (v.session) {
        const st = await readState(dir);
        const keys = matchSessions(st, v.session);
        if (keys.length > 1) fail(`"${v.session}" matches ${keys.length} sessions; be more specific`);
        const key = keys[0] ?? v.session;
        await forgetSession(dir, key);
        return void out(`Forgot session ${key}; it will not be journaled again\n`);
      }
      const id = args[0];
      if (!id) fail("usage: baton mem forget m:<id> | --session <agent:id>");
      const r = await forgetItem(dir, id);
      if (!r) fail(`no memory item ${id}`);
      return void out(`Deleted ${id.startsWith("m:") ? id : `m:${id}`} from ${path.relative(dir, r.file).replace(/\\/g, "/")}: ${oneLine(r.item.text, 80)}\n`);
    }

    default:
      fail(`unknown mem command "${sub}"\n\n${MEM_HELP}`);
  }
}
