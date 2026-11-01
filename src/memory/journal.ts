// L3: one entry per session in journal/<local start date>.md, copied from the transcript by
// rules (no LLM). Entries are wrapped in markers so a session that keeps going is updated in place:
//
//   <!-- session codex:019a3f… 2026-10-26T05:05:00.000Z -->
//   ### 14:05 · codex · Compare PhD programs
//   - desktop chat · `C:/Users/me/Documents/Codex/2026-10-26-x` · 12 turns · 10-26 14:05–15:20
//   - First: "…"
//   - Last request: "…"
//   - Last reply: "…"
//   - Remembered: m:b7d1, m:d2a8
//   <!-- /session -->
//
// Never copied: tool output, file contents, command output.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { normalizePath } from "../core/paths.js";
import { redact } from "../core/redact.js";
import { oneLine } from "../core/text.js";
import type { Event, Session } from "../model.js";
import { ID_RE, localDate } from "./doc.js";
import { labels, type Lang } from "./labels.js";
import { markdownFiles, memoryPaths, readText, writeAtomic } from "./store.js";

export type Place = "chat" | "project" | "folder";

export interface JournalEntry {
  key: string;
  day: string;
  start: Date;
  place: Place;
  block: string;
}

export function sessionKey(s: { agent: string; env?: string; id: string }): string {
  return `${s.agent}${s.env ? `@${s.env}` : ""}:${s.id}`;
}

// Per-conversation scratch folders of the desktop apps: every new chat gets a fresh one.
const CHAT_DIRS = [/\/documents\/codex\/\d{4}-\d{2}-\d{2}/, /\/scratch-workspaces\//, /\/appdata\/(?:local|roaming)\/claude\//];

function hasGit(dir: string): boolean {
  for (let d = dir, i = 0; i < 40; i++) {
    if (existsSync(path.join(d, ".git"))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

/** Where did the session run: a desktop chat, a project (git repo), or some folder. */
export function classifyCwd(cwd: string, home = homedir()): Place {
  const n = normalizePath(cwd).toLowerCase();
  if (CHAT_DIRS.some((re) => re.test(n + "/"))) return "chat";
  if (n === normalizePath(home).toLowerCase()) return "chat";
  return hasGit(cwd) ? "project" : "folder";
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const mmdd = (d: Date) => localDate(d).slice(5);

/** Markup that agents and their hosts wrap around user text (`<pasted_content id=…>`, `<ide_selection>`). */
const TAG_RE = /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>/g;

function preview(text: string, max: number): string {
  return oneLine(redact(text).replace(/<!--|-->/g, "").replace(TAG_RE, " "), max);
}

const quote = (text: string, max: number) => `"${preview(text, max)}"`;

/** Memory ids this session wrote (memory_remember MCP calls or `baton mem add`). */
function rememberedIds(events: Event[]): string[] {
  const calls = new Set<string>();
  let pendingNoId = false;
  const ids: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_call") {
      const hit = /memory_remember|\bmem add\b/.test(`${e.name} ${e.input}`);
      if (e.id && hit) calls.add(e.id);
      pendingNoId = !e.id && hit;
    } else if (e.kind === "tool_result" && ((e.id && calls.has(e.id)) || (!e.id && pendingNoId))) {
      for (const m of e.output.matchAll(ID_RE)) if (!ids.includes(m[1]!)) ids.push(m[1]!);
      pendingNoId = false;
    }
  }
  return ids;
}

export function journalEntry(s: Session, lang: Lang, home?: string): JournalEntry | undefined {
  const L = labels(lang);
  const users = s.events.filter((e): e is Extract<Event, { kind: "user" }> => e.kind === "user" && !!e.text.trim());
  if (!users.length) return undefined;
  const assistants = s.events.filter((e): e is Extract<Event, { kind: "assistant" }> => e.kind === "assistant");
  // Never answered (failed login, quota error on the first prompt): nothing happened worth recalling,
  // and the user usually repeats the request in another agent anyway.
  if (!assistants.length && !s.events.some((e) => e.kind === "tool_call")) return undefined;
  const stamps = s.events.map((e) => e.ts).filter((t): t is string => !!t).sort();
  const start = new Date(s.startedAt ?? stamps[0] ?? s.updatedAt);
  const end = new Date(stamps[stamps.length - 1] ?? s.updatedAt);
  const place = classifyCwd(s.cwd, home);
  const key = sessionKey(s);
  const agent = s.env ? `${s.agent}@${s.env}` : s.agent;
  const title = preview(s.title ?? users[0]!.text, 60);

  const span = mmdd(start) === mmdd(end) ? `${mmdd(start)} ${hhmm(start)}–${hhmm(end)}` : `${mmdd(start)} ${hhmm(start)} – ${mmdd(end)} ${hhmm(end)}`;
  // A desktop chat's folder is a throwaway scratch dir: not worth showing.
  const where = place === "chat" ? L.chat : `${L[place]} \`${s.cwd.replace(/\\/g, "/")}\``;
  const lines = [
    `<!-- session ${key} ${start.toISOString()} -->`,
    `### ${hhmm(start)} · ${agent} · ${title}`,
    `- ${where} · ${users.length} ${L.turns} · ${span}`,
    `- ${L.first}: ${quote(users[0]!.text, 200)}`,
  ];
  if (users.length > 1) lines.push(`- ${L.lastRequest}: ${quote(users[users.length - 1]!.text, 200)}`);
  const reply = assistants[assistants.length - 1];
  if (reply) lines.push(`- ${L.lastReply}: ${quote(reply.text, 400)}`);
  const ids = rememberedIds(s.events);
  if (ids.length) lines.push(`- ${L.remembered}: ${ids.map((i) => `m:${i}`).join(", ")}`);
  lines.push("<!-- /session -->");
  return { key, day: localDate(start), start, place, block: lines.join("\n") };
}

// ------------------------------------------------------------------ day files

const BLOCK_RE = /<!-- session (\S+) (\S+) -->[\s\S]*?<!-- \/session -->/g;

export interface DayBlock {
  key: string;
  start: string;
  block: string;
}

export function parseDay(text: string): DayBlock[] {
  return [...text.matchAll(BLOCK_RE)].map((m) => ({ key: m[1]!, start: m[2]!, block: m[0] }));
}

export interface EntryView {
  key: string;
  start: string;
  agent: string;
  title: string;
  place?: Place;
  first?: string;
  lastRequest?: string;
  lastReply?: string;
}

/** Read the fields back out of a block (written in either language). */
export function readEntry(b: DayBlock): EntryView {
  const lines = b.block.split("\n");
  const head = /^###\s+\S+\s+·\s+(\S+)\s+·\s+(.*)$/.exec(lines[1] ?? "");
  const v: EntryView = { key: b.key, start: b.start, agent: head?.[1] ?? b.key.split(":")[0]!, title: head?.[2] ?? "" };
  const field = (name: "first" | "lastRequest" | "lastReply") => {
    for (const lang of ["en", "zh"] as const) {
      const prefix = `- ${labels(lang)[name]}: `;
      const l = lines.find((x) => x.startsWith(prefix));
      if (l) return l.slice(prefix.length).replace(/^"|"$/g, "");
    }
    return undefined;
  };
  v.first = field("first");
  v.lastRequest = field("lastRequest");
  v.lastReply = field("lastReply");
  const where = lines[2] ?? "";
  for (const lang of ["en", "zh"] as const) {
    for (const p of ["chat", "project", "folder"] as const) if (where.startsWith(`- ${labels(lang)[p]}`)) v.place ??= p;
  }
  return v;
}

export async function readBlock(dir: string, key: string, day: string): Promise<DayBlock | undefined> {
  return parseDay((await readText(dayFile(dir, day))) ?? "").find((b) => b.key === key);
}

/** Entries of the last `days` day files, newest first. */
export async function recentEntries(dir: string, days: number): Promise<EntryView[]> {
  const files = (await markdownFiles(memoryPaths(dir).journal)).slice(-days);
  const out: EntryView[] = [];
  for (const f of files) for (const b of parseDay((await readText(f)) ?? "")) out.push(readEntry(b));
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

function renderDay(day: string, blocks: DayBlock[]): string {
  const sorted = [...blocks].sort((a, b) => a.start.localeCompare(b.start));
  return `# ${day}\n\n${sorted.map((b) => b.block).join("\n\n")}\n`;
}

export const dayFile = (dir: string, day: string) => path.join(memoryPaths(dir).journal, `${day}.md`);

/** Insert/replace entries and drop `remove` keys, one write per touched day. Caller holds the lock. */
export async function writeDays(
  dir: string,
  upserts: JournalEntry[],
  remove: { key: string; day: string }[] = [],
): Promise<void> {
  const days = new Set([...upserts.map((e) => e.day), ...remove.map((r) => r.day)]);
  for (const day of days) {
    const file = dayFile(dir, day);
    const blocks = parseDay((await readText(file)) ?? "");
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    for (const r of remove) if (r.day === day) byKey.delete(r.key);
    for (const e of upserts) if (e.day === day) byKey.set(e.key, { key: e.key, start: e.start.toISOString(), block: e.block });
    if (byKey.size) await writeAtomic(file, renderDay(day, [...byKey.values()]));
    else if (existsSync(file)) await writeAtomic(file, `# ${day}\n`);
  }
}
