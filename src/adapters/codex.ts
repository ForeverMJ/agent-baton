// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (older ones compressed to .jsonl.zst)
// Line 1 is `session_meta` (cwd, git, source). Then:
//   - `response_item`: raw model I/O (message / function_call / *_output ...), present in all versions
//   - `event_msg` item_completed: a cleaner semantic stream (UserMessage, AgentMessage,
//     FileChange, CommandExecution ...) in newer versions. Preferred when present.
//   - `event_msg` token_count: carries `rate_limits` (the 5h quota!), turn_aborted, task_* ...

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonl, zstdSupported } from "../core/jsonl.js";
import { isWithin } from "../core/paths.js";
import { filesFromPatch, summarizeInput, tryJson } from "../core/text.js";
import type { Event, Origin, QuotaInfo, Session, SessionRef, Todo } from "../model.js";
import type { Adapter } from "./types.js";

/** Sessions spawned by Codex itself (reviewers, subagents) are not user work threads. */
const SKIP_THREAD_SOURCES = new Set(["guardian_review", "subagent"]);
const IDE_REQUEST_MARK = "## My request for Codex:";

function cleanUserText(text: string): string | undefined {
  let t = text;
  const i = t.indexOf(IDE_REQUEST_MARK);
  if (i >= 0) t = t.slice(i + IDE_REQUEST_MARK.length);
  t = t.trim();
  if (!t) return undefined;
  if (t.startsWith("<") || t.startsWith("# AGENTS.md") || t.startsWith("# Context from my IDE")) return undefined;
  return t;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Codex tool outputs are strings, JSON strings, or lists of text parts. */
function parseOutput(raw: unknown): { text: string; ok: boolean | null } {
  let text = "";
  let code: number | undefined;
  const asJson = tryJson(raw);
  if (asJson && typeof asJson === "object" && !Array.isArray(asJson) && "output" in asJson) {
    text = String(asJson.output ?? "");
    const c = asJson.metadata?.exit_code;
    if (c != null) code = Number(c);
  } else {
    text = textOf(raw);
  }
  if (code === undefined) {
    const m = text.match(/(?:Exit code|exit_code|Process exited with code)\W{0,4}(-?\d+)/);
    if (m) code = Number(m[1]);
  }
  if (code !== undefined && !Number.isNaN(code)) return { text, ok: code === 0 };
  if (/^Script (?:failed|error)/m.test(text)) return { text, ok: false };
  return { text, ok: null };
}

function commandString(cmd: unknown): string {
  if (Array.isArray(cmd)) {
    // ["pwsh.exe", "-Command", "<script>"] / ["bash", "-lc", "<script>"] -> the script
    const flagIdx = cmd.findIndex((c) => /^-(?:Command|c|lc)$/i.test(String(c)));
    if (flagIdx >= 0 && flagIdx < cmd.length - 1) return String(cmd[cmd.length - 1]);
    return cmd.map(String).join(" ");
  }
  return String(cmd ?? "");
}

function planTodos(args: any): Todo[] | undefined {
  if (!Array.isArray(args?.plan)) return undefined;
  return args.plan.map((p: any) => ({ content: String(p.step ?? ""), status: String(p.status ?? "") }));
}

async function readMeta(file: string): Promise<any> {
  for await (const rec of readJsonl(file, 1)) {
    if (rec?.type === "session_meta") return rec.payload;
  }
  return undefined;
}

// Codex compresses finished rollouts in place; reading .zst needs zstd in node:zlib.
const ROLLOUT_RE = zstdSupported ? /^rollout-.*\.jsonl(?:\.zst)?$/ : /^rollout-.*\.jsonl$/;

/** The rollout may have been compressed since it was listed. */
function currentLocator(file: string): string {
  if (existsSync(file) || file.endsWith(".zst")) return file;
  return existsSync(file + ".zst") ? file + ".zst" : file;
}

/**
 * `originator` names the client: "Codex Desktop", "codex_vscode", "codex_cli_rs" (TUI) are people;
 * "codex_exec" (`codex exec`) and third-party apps embedding Codex (any other name) are programs.
 */
function codexOrigin(meta: any): Origin | undefined {
  if (meta.source === "exec") return "headless";
  const o = meta.originator;
  if (typeof o !== "string") return undefined;
  return /^codex(?!_exec)/i.test(o) ? "interactive" : "headless";
}

/** Thread names from <CODEX_HOME>/session_index.jsonl ({id, thread_name, updated_at}; later lines win). */
async function readTitles(dirs: { codexSessions: string[] }): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const base = dirs.codexSessions[0];
  if (!base) return titles;
  const index = path.join(path.dirname(base), "session_index.jsonl");
  if (!existsSync(index)) return titles;
  for await (const rec of readJsonl(index)) {
    if (typeof rec?.id === "string" && typeof rec.thread_name === "string" && rec.thread_name.trim()) {
      titles.set(rec.id, rec.thread_name.trim());
    }
  }
  return titles;
}

async function listRollouts(dir: string): Promise<string[]> {
  try {
    const all = await readdir(dir, { recursive: true });
    return all
      .filter((f) => ROLLOUT_RE.test(path.basename(f)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export const codexAdapter: Adapter = {
  name: "codex",

  async available(dirs) {
    for (const d of dirs.codexSessions) {
      const ok = await stat(d).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (ok) return true;
    }
    return false;
  },

  async discover(projectRoot, dirs) {
    return (await this.list(dirs)).filter((r) => isWithin(r.cwd, projectRoot));
  },

  async list(dirs, since) {
    const refs: SessionRef[] = [];
    const titles = await readTitles(dirs);
    for (const dir of dirs.codexSessions) {
      for (const file of await listRollouts(dir)) {
        const st = await stat(file).catch(() => undefined);
        if (!st || (since && st.mtime < since)) continue;
        const meta = await readMeta(file);
        if (!meta || typeof meta.cwd !== "string") continue;
        if (SKIP_THREAD_SOURCES.has(meta.thread_source)) continue;
        if (meta.source && typeof meta.source === "object") continue; // subagent-style sources
        const id = String(meta.id ?? meta.session_id ?? path.basename(file));
        refs.push({
          agent: "codex",
          id,
          cwd: meta.cwd,
          title: titles.get(id),
          origin: codexOrigin(meta),
          updatedAt: st.mtime,
          locator: file,
          repoUrl: typeof meta.git?.repository_url === "string" ? meta.git.repository_url : undefined,
        });
      }
    }
    return refs;
  },

  async load(ref) {
    const records: any[] = [];
    for await (const rec of readJsonl(currentLocator(ref.locator))) records.push(rec);

    const hasItems = records.some((r) => r.type === "event_msg" && r.payload?.type === "item_completed");
    const events: Event[] = [];
    let model: string | undefined;
    let quota: QuotaInfo | undefined;
    let startedAt: string | undefined;
    let openTurn = false;

    for (const rec of records) {
      const ts: string | undefined = rec.timestamp;
      const p = rec.payload ?? {};

      if (rec.type === "session_meta") {
        startedAt = p.timestamp ?? ts;
        continue;
      }
      if (rec.type === "turn_context" && p.model) model = p.model;
      if (rec.type === "compacted") {
        events.push({ kind: "compaction", ts });
        continue;
      }

      if (rec.type === "event_msg") {
        switch (p.type) {
          case "task_started":
            openTurn = true;
            break;
          case "task_complete":
            openTurn = false;
            break;
          case "turn_aborted":
            openTurn = false;
            events.push({ kind: "interrupt", reason: `turn aborted (${p.reason ?? "unknown"})`, ts });
            break;
          case "error":
          case "stream_error":
            events.push({ kind: "interrupt", reason: String(p.message ?? p.type), ts });
            break;
          case "token_count": {
            const prim = p.rate_limits?.primary;
            if (prim && typeof prim.used_percent === "number") {
              quota = {
                usedPercent: prim.used_percent,
                windowMinutes: prim.window_minutes,
                resetsAt: prim.resets_at ? new Date(prim.resets_at * 1000).toISOString() : undefined,
              };
            }
            break;
          }
          case "item_completed":
            if (hasItems) pushItem(events, p.item, ts);
            break;
        }
        continue;
      }

      if (rec.type !== "response_item") continue;

      // update_plan only shows up as a raw function call, in both modes.
      if (p.type === "function_call" && p.name === "update_plan") {
        const todos = planTodos(tryJson(p.arguments));
        if (todos) events.push({ kind: "todos", items: todos, ts });
        continue;
      }
      if (!hasItems) pushResponseItem(events, p, ts);
    }

    if (openTurn) {
      events.push({ kind: "interrupt", reason: "last turn never completed (agent stopped mid-task)" });
    }

    return {
      agent: "codex",
      id: ref.id,
      cwd: ref.cwd,
      title: ref.title,
      origin: ref.origin,
      model,
      startedAt,
      updatedAt: ref.updatedAt,
      events,
      quota,
    };
  },
};

/** New-style semantic items. */
function pushItem(events: Event[], item: any, ts?: string): void {
  if (!item) return;
  switch (item.type) {
    case "UserMessage": {
      const t = cleanUserText(textOf(item.content));
      if (t) events.push({ kind: "user", text: t, ts });
      break;
    }
    case "AgentMessage": {
      const t = textOf(item.content).trim();
      if (t) events.push({ kind: "assistant", text: t, ts });
      break;
    }
    case "Plan":
      if (item.text) events.push({ kind: "assistant", text: `[Plan]\n${item.text}`, ts });
      break;
    case "FileChange": {
      const files = Object.keys(item.changes ?? {});
      events.push({ kind: "tool_call", id: item.id, name: "apply_patch", input: files.join(", "), files, ts });
      events.push({
        kind: "tool_result",
        id: item.id,
        ok: item.status ? item.status === "completed" : null,
        output: String(item.stderr || item.stdout || ""),
        ts,
      });
      break;
    }
    case "CommandExecution": {
      const code = item.exit_code == null ? undefined : Number(item.exit_code);
      events.push({ kind: "tool_call", id: item.id, name: "shell", input: summarizeInput(commandString(item.command)), files: [], ts });
      events.push({
        kind: "tool_result",
        id: item.id,
        ok: code === undefined || Number.isNaN(code) ? null : code === 0,
        output: String(item.aggregated_output ?? item.formatted_output ?? item.stdout ?? ""),
        ts,
      });
      break;
    }
    case "McpToolCall": {
      events.push({
        kind: "tool_call",
        id: item.id,
        name: `${item.server ?? "mcp"}.${item.tool ?? "?"}`,
        input: summarizeInput(tryJson(item.arguments) ?? item.arguments),
        files: [],
        ts,
      });
      events.push({
        kind: "tool_result",
        id: item.id,
        ok: item.error ? false : item.status ? item.status === "completed" : null,
        output: item.error ? String(item.error?.message ?? JSON.stringify(item.error)) : textOf(item.result?.content ?? ""),
        ts,
      });
      break;
    }
    case "WebSearch":
      events.push({ kind: "tool_call", id: item.id, name: "web_search", input: String(item.query ?? ""), files: [], ts });
      events.push({ kind: "tool_result", id: item.id, ok: true, output: "", ts });
      break;
    case "ContextCompaction":
      events.push({ kind: "compaction", ts });
      break;
  }
}

/** Old-style raw response items (fallback for older Codex versions). */
function pushResponseItem(events: Event[], p: any, ts?: string): void {
  switch (p.type) {
    case "message": {
      const text = textOf(p.content);
      if (p.role === "user") {
        const t = cleanUserText(text);
        if (t) events.push({ kind: "user", text: t, ts });
      } else if (p.role === "assistant" && text.trim()) {
        events.push({ kind: "assistant", text: text.trim(), ts });
      }
      break;
    }
    case "function_call": {
      const args = tryJson(p.arguments) ?? p.arguments;
      const name = p.namespace ? `${p.namespace}.${p.name}` : String(p.name);
      const input = args && typeof args === "object" && ("command" in args || "cmd" in args)
        ? summarizeInput(commandString(args.command ?? args.cmd))
        : summarizeInput(args);
      events.push({ kind: "tool_call", id: p.call_id, name, input, files: [], ts });
      break;
    }
    case "custom_tool_call": {
      const input = String(p.input ?? "");
      const files = p.name === "apply_patch" ? filesFromPatch(input) : [];
      events.push({
        kind: "tool_call",
        id: p.call_id,
        name: String(p.name),
        input: files.length ? files.join(", ") : summarizeInput(input),
        files,
        ts,
      });
      break;
    }
    case "local_shell_call":
      events.push({
        kind: "tool_call",
        id: p.call_id,
        name: "shell",
        input: summarizeInput(commandString(p.action?.command)),
        files: [],
        ts,
      });
      break;
    case "function_call_output":
    case "custom_tool_call_output": {
      const { text, ok } = parseOutput(p.output);
      events.push({ kind: "tool_result", id: p.call_id, ok, output: text, ts });
      break;
    }
  }
}
