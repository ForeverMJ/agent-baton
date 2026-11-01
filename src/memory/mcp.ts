// `baton mcp`: the shared memory as an MCP server over stdio, usable by Claude Code, Codex and
// opencode alike. Hand-written JSON-RPC 2.0 (newline-delimited, as the stdio transport specifies)
// to stay dependency-free: only initialize, ping, tools/list and tools/call are needed.
//
// stdout carries protocol messages only; diagnostics go to memory.log.

import path from "node:path";
import { createInterface } from "node:readline";
import { adapters } from "../adapters/index.js";
import type { AgentDirs } from "../core/paths.js";
import { redact } from "../core/redact.js";
import type { Source } from "../core/sources.js";
import { loadConfig } from "../env/config.js";
import { makeSource } from "../env/remote.js";
import { currentInvocation } from "../hooks/install.js";
import type { AgentName, Session, SessionRef } from "../model.js";
import { clip } from "../core/text.js";
import { buildBrief, BRIEF_MARK, RULES } from "./brief.js";
import { readBlock, sessionKey } from "./journal.js";
import { findTopic, forgetItem, isProfileKind, KINDS, listTopics, remember, type Kind } from "./notes.js";
import { formatHits, search } from "./search.js";
import { isEnabled, localEnvName, memoryLog, memoryPaths, readText } from "./store.js";
import { forgetSession, listAllSessions, matchSessions, readState, sync } from "./sync.js";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const START_SYNC_WAIT_MS = 2000;
const TRANSCRIPT_MAX = 30_000;

export interface McpContext {
  dir: string;
  dirs: AgentDirs;
  version: string;
  /** This environment's label (default: localEnvName()); appended to the agent name of saved items. */
  envName?: string;
  /** Other environments' sources, for transcripts (default: from `baton env` config). */
  sources?: Source[];
}

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** MCP tool annotations: clients (Codex) use them to decide what needs approval. */
  annotations: object;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const AGENT_ENUM = { type: "string", enum: adapters.map((a) => a.name) };

export const TOOLS: Tool[] = [
  {
    name: "memory_context",
    annotations: READ_ONLY,
    description:
      "Get the user's shared memory summary: their profile, active topics, and recent conversations in any of their " +
      `agents (Claude Code, Codex, opencode). Call once at the start of a conversation unless a "${BRIEF_MARK}" block ` +
      "is already in your context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_search",
    annotations: READ_ONLY,
    description:
      "Search the user's shared memory: profile, topics, and a journal of every past conversation in Claude Code, Codex " +
      "and opencode. Use it when the user refers to something from before (\"last time\", \"we discussed\", \"my plan " +
      "for ...\") or asks about their own plans or preferences. All terms must match; try a few different keywords, " +
      "in the language the user used.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords separated by spaces" },
        agent: { ...AGENT_ENUM, description: "Only results written by / about this agent" },
        since: { type: "string", description: 'Only newer results: "7d", "12h" or a date (2026-10-01)' },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    annotations: READ_ONLY,
    description:
      'Read one topic in full (topic name, or "profile"), or one past conversation by the session key shown in search ' +
      "results (agent:id). With transcript=true you get that conversation's user and assistant messages, not just its summary.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        session: { type: "string", description: "agent:id, or a prefix of it" },
        transcript: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_remember",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Save one thing to the user's shared memory so their other agents know it too. kind: preference or fact (about the " +
      "user; goes to their profile), or status / decision / next (about something they are working on; needs topic). " +
      "One short self-contained sentence, in the user's language. Reuse existing topic names. A new status replaces the " +
      "topic's previous one; pass replaces=m:<id> when this reverses or corrects an earlier item. Do not save secrets, " +
      "small talk, or code details. Returns the new item's id (m:xxxx).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
        text: { type: "string" },
        topic: { type: "string", description: "Required for status, decision, next" },
        replaces: { type: "string", description: "m:<id> of the item this one supersedes" },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      "Delete a memory item (id such as m:k3f9), or drop a past conversation from the journal for good (session key), " +
      "when the user asks you to forget it or an item is wrong.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, session: { type: "string" } },
      additionalProperties: false,
    },
  },
];

export const INSTRUCTIONS =
  `Shared memory about the user across their agents. At the start of a conversation, call memory_context unless a ` +
  `"${BRIEF_MARK}" block is already in your context. ${RULES}`;

/** Which agent is talking to us, from initialize's clientInfo.name ("claude-code", "codex-mcp-client", "opencode"...). */
export function agentOfClient(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  // The Claude app's other clients: "claude-ai" (Chat tab), "local-agent-mode-<server>" (its local agent mode).
  if (n.startsWith("local-agent-mode")) return "claude";
  for (const a of adapters) if (n.includes(a.name)) return a.name;
  return n.replace(/[^a-z0-9_-]/g, "") || "mcp";
}

class ToolError extends Error {}

const str = (v: unknown, name: string, required = false): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${name} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${name} must be a string`);
  return v;
};

function sinceDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d+)([dh])$/.exec(s);
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ToolError(`since: use 7d, 12h or a date, not "${s}"`);
  return d;
}

/** "claude@wsl:Ubuntu:abc" -> { agent: "claude", env: "wsl:Ubuntu", id: "abc" }. Ids never contain ":". */
export function parseSessionKey(key: string): { agent: string; env?: string; id: string } | undefined {
  const m = /^([^@:]+)(?:@(.+))?:([^:]+)$/.exec(key);
  return m ? { agent: m[1]!, env: m[2], id: m[3]! } : undefined;
}

/** Sources for the environments configured with `baton env add` (WSL distros / the Windows host). */
async function envSources(): Promise<Source[]> {
  const cli = currentInvocation().args[0]!;
  return (await loadConfig()).environments.flatMap((e) => {
    try {
      return [makeSource(e, cli)];
    } catch {
      return [];
    }
  });
}

/**
 * Load a journaled session wherever it lives: this environment first, then the environment named in
 * its key (a WSL session read from Windows), or every configured one when the key names none (a host
 * session read from inside WSL). Remote reads go through the same `baton export` bridge as handoffs.
 */
async function loadSession(ctx: McpContext, key: string): Promise<Session | undefined> {
  const k = parseSessionKey(key);
  if (!k) return undefined;
  const here = ctx.envName ?? localEnvName();
  if (k.env === here || !k.env) {
    const ref = (await listAllSessions(ctx.dirs, undefined, undefined, here)).find((r) => sessionKey(r) === key);
    if (ref) return adapters.find((a) => a.name === ref.agent)!.load(ref, ctx.dirs);
  }
  const sources = (ctx.sources ?? (await envSources())).filter((s) => !k.env || s.name === k.env);
  for (const src of sources) {
    const ref: SessionRef = { agent: k.agent as AgentName, id: k.id, cwd: "", updatedAt: new Date(), locator: k.id, env: src.name };
    const s = await src.session("", ref).catch(() => undefined);
    if (s) return s;
  }
  return undefined;
}

/** One session's user/assistant messages, newest kept when too long. */
async function transcript(ctx: McpContext, key: string): Promise<string> {
  const s = await loadSession(ctx, key);
  if (!s) throw new ToolError(`the transcript of ${key} is not reachable from here (deleted, or its environment is not set up with \`baton env add\`)`);
  const msgs = s.events
    .filter((e) => e.kind === "user" || e.kind === "assistant")
    .map((e) => `[${e.kind}] ${clip(redact((e as { text: string }).text), 2000)}`);
  let text = msgs.join("\n\n");
  if (text.length > TRANSCRIPT_MAX) text = "… (earlier messages omitted)\n\n" + text.slice(-TRANSCRIPT_MAX);
  return text;
}

export function createMcpHandler(ctx: McpContext) {
  let agent = "mcp";
  let client = "?";
  // Journal new sessions in the background as soon as we start; context/search wait briefly for it.
  let ready: Promise<unknown> = Promise.resolve();
  const startSync = () => {
    if (!isEnabled(ctx.dir)) return;
    ready = sync(ctx.dir, { dirs: ctx.dirs, budgetMs: 10_000, envName: ctx.envName }).catch((e) => memoryLog(ctx.dir, `mcp sync failed: ${(e as Error).message}`));
  };
  // unref: a pending wait must not keep the server alive after the client closes stdin.
  const settled = () => Promise.race([ready, new Promise((r) => setTimeout(r, START_SYNC_WAIT_MS).unref())]);

  async function callTool(name: string, a: Record<string, unknown>): Promise<string> {
    if (!isEnabled(ctx.dir)) {
      throw new ToolError("Shared memory is not set up on this machine yet. Ask the user to run `baton mem init`.");
    }
    switch (name) {
      case "memory_context":
        await settled();
        return buildBrief(ctx.dir);

      case "memory_search": {
        await settled();
        const query = str(a.query, "query", true)!;
        const limit = a.limit === undefined ? 10 : Number(a.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolError("limit must be 1-50");
        const hits = await search(ctx.dir, query, { agent: str(a.agent, "agent"), since: sinceDate(str(a.since, "since")), limit });
        return hits.length ? formatHits(hits) : `Nothing found for "${query}". Try other or fewer keywords.`;
      }

      case "memory_read": {
        const topic = str(a.topic, "topic");
        const session = str(a.session, "session");
        if (!topic === !session) throw new ToolError("pass either topic or session");
        if (topic) {
          if (topic.toLowerCase() === "profile") return (await readText(memoryPaths(ctx.dir).profile)) ?? "(empty profile)";
          const t = await findTopic(ctx.dir, topic);
          if (!t) {
            const all = (await listTopics(ctx.dir)).map((x) => x.title);
            throw new ToolError(`no topic "${topic}"${all.length ? `; topics: ${all.join(", ")}` : ""}`);
          }
          return (await readText(t.file)) ?? "";
        }
        const st = await readState(ctx.dir);
        const keys = matchSessions(st, session!);
        if (!keys.length) throw new ToolError(`no journaled session matching "${session}"`);
        if (keys.length > 1) throw new ToolError(`"${session}" matches ${keys.length} sessions: ${keys.slice(0, 5).join(", ")}`);
        const key = keys[0]!;
        const block = (await readBlock(ctx.dir, key, st.sessions[key]!.day!))?.block ?? "";
        return a.transcript === true ? `${block}\n\n${await transcript(ctx, key)}` : block;
      }

      case "memory_remember": {
        const kind = str(a.kind, "kind", true) as Kind;
        if (!KINDS.includes(kind)) throw new ToolError(`kind must be one of ${KINDS.join(", ")}`);
        const topic = str(a.topic, "topic");
        if (!isProfileKind(kind) && !topic) throw new ToolError(`kind "${kind}" needs a topic`);
        const before = topic ? await findTopic(ctx.dir, topic) : undefined;
        const r = await remember(ctx.dir, { kind, text: str(a.text, "text", true)!, topic, replaces: str(a.replaces, "replaces"), agent }).catch((e) => {
          throw new ToolError((e as Error).message);
        });
        const lines = [`Remembered m:${r.id} in ${path.relative(ctx.dir, r.file).replace(/\\/g, "/")}.`];
        if (r.replaced) lines.push(`It replaces m:${r.replaced.id} ("${r.replaced.text}"), now in History.`);
        if (topic && !before) {
          const others = (await listTopics(ctx.dir)).filter((t) => t.file !== r.file).map((t) => t.title);
          if (others.length) {
            lines.push(
              `Created a new topic "${r.topic?.title}". Existing topics: ${others.join(", ")}. If it belongs to one of ` +
                `them, call memory_forget id=m:${r.id} and save it again under that topic.`,
            );
          }
        }
        return lines.join("\n");
      }

      case "memory_forget": {
        const id = str(a.id, "id");
        const session = str(a.session, "session");
        if (!id === !session) throw new ToolError("pass either id or session");
        if (id) {
          const r = await forgetItem(ctx.dir, id);
          if (!r) throw new ToolError(`no memory item ${id}`);
          return `Deleted m:${r.item.id} ("${r.item.text}").`;
        }
        const keys = matchSessions(await readState(ctx.dir), session!);
        if (keys.length !== 1) throw new ToolError(keys.length ? `"${session}" matches ${keys.length} sessions` : `no journaled session matching "${session}"`);
        await forgetSession(ctx.dir, keys[0]!);
        return `Dropped ${keys[0]} from the journal; it will not be recorded again.`;
      }

      default:
        throw new ToolError(`unknown tool ${name}`);
    }
  }

  /** Handle one JSON-RPC message. Returns the response, or undefined for notifications. */
  return async function handle(msg: any): Promise<object | undefined> {
    const isRequest = msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null;
    const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: isRequest ? msg.id : null, error: { code, message } });
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isRequest || !msg?.method ? error(-32600, "invalid request") : undefined;
    }
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        {
          const env = ctx.envName ?? localEnvName();
          agent = agentOfClient(msg.params?.clientInfo?.name) + (env ? `@${env}` : ""); // "claude@wsl:Ubuntu"
        }
        client = String(msg.params?.clientInfo?.name ?? "?").replace(/[^\w.@-]/g, "").slice(0, 60) || "?";
        void memoryLog(ctx.dir, `mcp: client ${JSON.stringify(msg.params?.clientInfo ?? {})} -> agent ${agent}, protocol ${requested}`);
        startSync();
        return reply({
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "baton-memory", version: ctx.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return isRequest ? reply({}) : undefined;
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return error(-32602, `unknown tool: ${name}`);
        // Which client used which tool, never what with: arguments and results are the user's content.
        const used = (status: string) => memoryLog(ctx.dir, `mcp: ${client} (${agent}) called ${name}: ${status}`);
        try {
          const text = await callTool(name, msg.params?.arguments ?? {});
          await used("ok");
          return reply({ content: [{ type: "text", text }] });
        } catch (e) {
          await used("error");
          if (!(e instanceof ToolError)) void memoryLog(ctx.dir, `mcp ${name} failed: ${(e as Error).stack ?? e}`);
          return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        return isRequest ? error(-32601, `method not found: ${msg.method}`) : undefined;
    }
  };
}

/** Serve on stdin/stdout until stdin closes. */
export async function serveMcp(ctx: McpContext, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const handle = createMcpHandler(ctx);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const p = handle(msg).then((res) => {
      if (res) output.write(JSON.stringify(res) + "\n");
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
