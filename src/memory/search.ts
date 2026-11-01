// Keyword search over profile, topics and journal. No embeddings (zero dependencies, offline):
// whitespace-separated terms must appear; Chinese/Japanese terms without spaces also match
// by character bigrams, so "选校比较" finds "比较了几所学校的选校标准". Newer units rank higher.

import path from "node:path";
import { oneLine } from "../core/text.js";
import { parseDoc, parseItem } from "./doc.js";
import { parseDay } from "./journal.js";
import { listTopics } from "./notes.js";
import { markdownFiles, memoryPaths, readText } from "./store.js";

export interface Hit {
  score: number;
  kind: "profile" | "topic" | "journal";
  file: string;
  /** Topic title, journal heading, or profile section. */
  where: string;
  text: string;
  id?: string;
  date?: string;
  agent?: string;
  /** Journal hits: the session key (agent:id). */
  session?: string;
}

export interface SearchOptions {
  limit?: number;
  agent?: string;
  since?: Date;
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 0 when some term is missing entirely. */
export function scoreText(text: string, terms: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (t.includes(term)) {
      score += 3;
      continue;
    }
    if (CJK.test(term) && term.length >= 3) {
      const bg = bigrams(term);
      const ratio = bg.filter((b) => t.includes(b)).length / bg.length;
      if (ratio >= 0.5) {
        score += 2 * ratio;
        continue;
      }
    }
    return 0;
  }
  return score;
}

function recency(date: string | undefined, now: number): number {
  if (!date) return 0;
  const age = (now - new Date(date).getTime()) / 86_400_000;
  return Number.isFinite(age) ? 1 / (1 + Math.max(0, age) / 30) : 0;
}

/** Everything searchable, as units. */
async function units(dir: string): Promise<Omit<Hit, "score">[]> {
  const p = memoryPaths(dir);
  const out: Omit<Hit, "score">[] = [];
  const docItems = (file: string, text: string, kind: "profile" | "topic", title: string) => {
    for (const s of parseDoc(text).sections) {
      for (const l of s.lines) {
        const it = parseItem(l);
        if (it) out.push({ kind, file, where: kind === "topic" ? `${title} / ${s.heading}` : s.heading, text: it.text, id: it.id, date: it.date, agent: it.agent });
      }
    }
  };
  const profile = await readText(p.profile);
  if (profile) docItems(p.profile, profile, "profile", "");
  for (const t of await listTopics(dir)) {
    const text = await readText(t.file);
    if (text) docItems(t.file, text, "topic", t.title);
  }
  for (const f of await markdownFiles(p.journal)) {
    for (const b of parseDay((await readText(f)) ?? "")) {
      const body = b.block.split("\n").slice(1, -1);
      out.push({
        kind: "journal",
        file: f,
        where: (body[0] ?? "").replace(/^###\s*/, `${path.basename(f, ".md")} `),
        text: body.slice(1).join("\n"),
        date: b.start,
        agent: b.key.slice(0, b.key.indexOf(":")),
        session: b.key,
      });
    }
  }
  return out;
}

/** Plain-text rendering shared by `baton mem search` and the memory_search tool. */
export function formatHits(hits: Hit[]): string {
  const out: string[] = [];
  for (const h of hits) {
    if (h.kind === "journal") {
      out.push(`[journal] ${h.where}  (${h.session})`);
      for (const l of h.text.split("\n").slice(0, 3)) out.push(`    ${oneLine(l, 150)}`);
    } else {
      const meta = [h.id && `m:${h.id}`, h.date, h.agent].filter(Boolean).join(" ");
      out.push(`[${h.kind}] ${h.where}: ${h.text}${meta ? `  (${meta})` : ""}`);
    }
  }
  return out.join("\n");
}

export async function search(dir: string, query: string, o: SearchOptions = {}): Promise<Hit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const now = Date.now();
  const hits: Hit[] = [];
  for (const u of await units(dir)) {
    if (o.agent && !(u.agent ?? "").startsWith(o.agent)) continue;
    if (o.since && (!u.date || new Date(u.date) < o.since)) continue;
    // Topic titles count as part of each item, so "PhD" finds every item of the PhD topic.
    const s = scoreText(`${u.where}\n${u.text}`, terms);
    if (s <= 0) continue;
    const superseded = u.text.startsWith("~~"); // History: still findable, but current items first
    hits.push({ ...u, score: (s + recency(u.date, now)) * (superseded ? 0.5 : 1) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, o.limit ?? 10);
}
