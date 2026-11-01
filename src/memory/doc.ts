// Markdown model for profile.md and topics/*.md: a head (title + meta comment) and `## ` sections.
// A memory item is one bullet line; its metadata hides in a trailing comment:
//
//   - Writes emails in polite Japanese, signs as Zion <!-- m:k3f9 2026-10-27 codex -->
//
// Lines that are not items (hand-written notes, blank lines) are kept verbatim.

import { randomBytes } from "node:crypto";
import { redact } from "../core/redact.js";
import { labels, sectionKeyOf, type Lang, type SectionKey } from "./labels.js";

export interface Item {
  text: string;
  id?: string;
  date?: string;
  agent?: string;
}

export interface Section {
  heading: string;
  key?: SectionKey;
  lines: string[];
}

export interface Doc {
  head: string[];
  sections: Section[];
}

const ITEM_RE = /^\s*[-*]\s+(.*?)\s*(?:<!--\s*m:([a-z0-9]+)\s*(.*?)\s*-->)?\s*$/;
export const ID_RE = /\bm:([a-z0-9]{4,8})\b/g;

export function parseDoc(text: string): Doc {
  const doc: Doc = { head: [], sections: [] };
  let cur: Section | undefined;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { heading: h[1]!, key: sectionKeyOf(h[1]!), lines: [] };
      doc.sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else doc.head.push(line);
  }
  return doc;
}

export function serializeDoc(doc: Doc): string {
  const trim = (ls: string[]) => {
    const out = [...ls];
    while (out.length && !out[out.length - 1]!.trim()) out.pop();
    return out;
  };
  const parts = [trim(doc.head).join("\n")];
  for (const s of doc.sections) {
    const lines = trim(s.lines);
    if (s.key && !lines.length) continue; // emptied by moving its items; hand-made sections stay
    parts.push([`## ${s.heading}`, ...lines].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n") + "\n";
}

export function parseItem(line: string): Item | undefined {
  const m = ITEM_RE.exec(line);
  if (!m || !m[1]) return undefined;
  const [date, agent] = (m[3] ?? "").split(/\s+/).filter(Boolean);
  return { text: m[1], id: m[2], date, agent };
}

export function formatItem(it: Item): string {
  const meta = it.id ? ` <!-- m:${[it.id, it.date, it.agent].filter(Boolean).join(" ")} -->` : "";
  return `- ${it.text}${meta}`;
}

/** One line, no comment markers (they would break the metadata), secrets scrubbed. */
export function cleanText(text: string): string {
  return redact(text)
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function newId(taken: Set<string>): string {
  for (;;) {
    const id = BigInt("0x" + randomBytes(4).toString("hex")).toString(36).slice(0, 4).padStart(4, "0");
    if (!taken.has(id) && /[a-z]/.test(id)) return id; // all-digit ids read like numbers in prose
  }
}

export function itemIds(doc: Doc): string[] {
  const ids: string[] = [];
  for (const s of doc.sections) for (const l of s.lines) {
    const id = parseItem(l)?.id;
    if (id) ids.push(id);
  }
  return ids;
}

/** Get the section for `key`, creating it in `order` position (headings in `lang`). */
export function ensureSection(doc: Doc, key: SectionKey, lang: Lang, order: SectionKey[]): Section {
  const found = doc.sections.find((s) => s.key === key);
  if (found) return found;
  const sec: Section = { heading: labels(lang).sections[key], key, lines: [] };
  const rank = (k?: SectionKey) => (k ? order.indexOf(k) : -1);
  const before = doc.sections.findIndex((s) => rank(s.key) > rank(key));
  if (before >= 0) doc.sections.splice(before, 0, sec);
  else doc.sections.push(sec);
  return sec;
}

/** Append after the section's last non-blank line (parsed sections end with the blank separator line). */
export function appendLine(sec: Section, line: string): void {
  while (sec.lines.length && !sec.lines[sec.lines.length - 1]!.trim()) sec.lines.pop();
  sec.lines.push(line);
}

/** Remove the item with this id. Returns it (and the section it was in) if found. */
export function takeItem(doc: Doc, id: string): { item: Item; section: Section } | undefined {
  for (const s of doc.sections) {
    const i = s.lines.findIndex((l) => parseItem(l)?.id === id);
    if (i >= 0) {
      const item = parseItem(s.lines[i]!)!;
      s.lines.splice(i, 1);
      return { item, section: s };
    }
  }
  return undefined;
}

/** Hand-written bullets in known sections get an id on the next write, so agents can refer to them. */
export function assignMissingIds(doc: Doc, taken: Set<string>): void {
  for (const s of doc.sections) {
    if (!s.key) continue;
    s.lines = s.lines.map((l) => {
      const it = parseItem(l);
      if (!it || it.id) return l;
      const id = newId(taken);
      taken.add(id);
      return formatItem({ ...it, id, date: localDate(), agent: "user" });
    });
  }
}
