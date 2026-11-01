// L1 (profile.md) and L2 (topics/<slug>.md): the memory agents write themselves.
//
//   preference / fact          -> profile.md
//   status / decision / next   -> topics/<slug>.md (topic required)
//
// A topic keeps one current status: writing a new one moves the old one to History.
// `replaces: <id>` strikes the old item through and moves it to History of its own file,
// so a reversed decision stays visible instead of being silently overwritten.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  appendLine,
  assignMissingIds,
  cleanText,
  ensureSection,
  formatItem,
  itemIds,
  localDate,
  newId,
  parseDoc,
  parseItem,
  serializeDoc,
  takeItem,
  type Doc,
  type Item,
} from "./doc.js";
import { labels, type Lang, type SectionKey } from "./labels.js";
import { markdownFiles, memoryPaths, readConfig, readText, withLock, writeAtomic } from "./store.js";

export const KINDS = ["preference", "fact", "status", "decision", "next"] as const;
export type Kind = (typeof KINDS)[number];

const PROFILE_ORDER: SectionKey[] = ["preference", "fact", "history"];
const TOPIC_ORDER: SectionKey[] = ["status", "decision", "next", "history"];

export const isProfileKind = (k: Kind) => k === "preference" || k === "fact";

export interface RememberInput {
  kind: Kind;
  text: string;
  topic?: string;
  replaces?: string;
  agent?: string;
  now?: Date;
}

export interface RememberResult {
  id: string;
  file: string;
  topic?: TopicInfo;
  replaced?: Item;
}

export interface TopicInfo {
  slug: string;
  title: string;
  status: string;
  updated?: string;
  file: string;
}

/** File-name-safe slug that keeps CJK characters ("PhD 申请" -> "phd-申请"). */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\\/:*?"<>|#%&{}$!'`@+=~^[\],;]/g, " ")
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return s || "topic";
}

const TOPIC_META_RE = /<!--\s*topic:\s*([^\s·]+)\s*·\s*status:\s*(\w+)(?:\s*·\s*updated:\s*([\d-]+))?\s*-->/;

function topicMeta(slug: string, status: string, updated: string): string {
  return `<!-- topic: ${slug} · status: ${status} · updated: ${updated} -->`;
}

function topicInfo(file: string, doc: Doc): TopicInfo {
  const head = doc.head.join("\n");
  const m = TOPIC_META_RE.exec(head);
  const title = /^#\s+(.+?)\s*$/m.exec(head)?.[1] ?? path.basename(file, ".md");
  return { slug: m?.[1] ?? path.basename(file, ".md"), title, status: m?.[2] ?? "active", updated: m?.[3], file };
}

export async function listTopics(dir: string): Promise<TopicInfo[]> {
  const out: TopicInfo[] = [];
  for (const f of await markdownFiles(memoryPaths(dir).topics)) {
    const text = await readText(f);
    if (text !== undefined) out.push(topicInfo(f, parseDoc(text)));
  }
  return out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

/** Spacing and case don't distinguish topics: "PhD申请" = "phd 申请" = "PhD-申请". */
const topicKey = (s: string) => slugify(s).replace(/-/g, "");

/** Existing topic by slug or title, so agents reuse topics instead of forking them. */
export async function findTopic(dir: string, name: string): Promise<TopicInfo | undefined> {
  const k = topicKey(name);
  return (await listTopics(dir)).find((t) => topicKey(t.slug) === k || topicKey(t.title) === k);
}

export function profileTemplate(lang: Lang): string {
  return `# ${labels(lang).profileTitle}\n`;
}

/** Every memory doc: profile + topics, parsed. */
async function loadAll(dir: string): Promise<Map<string, Doc>> {
  const p = memoryPaths(dir);
  const docs = new Map<string, Doc>();
  for (const f of [p.profile, ...(await markdownFiles(p.topics))]) {
    const text = await readText(f);
    if (text !== undefined) docs.set(f, parseDoc(text));
  }
  return docs;
}

function takenIds(docs: Map<string, Doc>): Set<string> {
  return new Set([...docs.values()].flatMap(itemIds));
}

function touchTopic(doc: Doc, info: TopicInfo, date: string): void {
  const line = topicMeta(info.slug, info.status, date);
  const i = doc.head.findIndex((l) => TOPIC_META_RE.test(l));
  if (i >= 0) doc.head[i] = line;
  else doc.head.push(line);
}

export async function remember(dir: string, input: RememberInput): Promise<RememberResult> {
  const text = cleanText(input.text);
  if (!text) throw new Error("text is empty");
  if (!KINDS.includes(input.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const profileKind = isProfileKind(input.kind);
  if (!profileKind && !input.topic?.trim()) throw new Error(`kind "${input.kind}" needs a topic`);
  const { lang } = await readConfig(dir);
  const L = labels(lang);
  const now = input.now ?? new Date();
  const date = localDate(now);
  const agent = input.agent ?? "user";

  return withLock(dir, async () => {
    const p = memoryPaths(dir);
    const docs = await loadAll(dir);
    const taken = takenIds(docs);
    const id = newId(taken);
    taken.add(id);

    // Target file.
    let file: string;
    let topic: TopicInfo | undefined;
    if (profileKind) {
      file = p.profile;
      if (!docs.has(file)) docs.set(file, parseDoc(profileTemplate(lang)));
    } else {
      const name = input.topic!.trim();
      const existing = await findTopic(dir, name);
      if (existing) {
        file = existing.file;
        topic = existing;
      } else {
        const slug = slugify(name);
        file = path.join(p.topics, `${slug}.md`);
        for (let n = 2; existsSync(file); n++) file = path.join(p.topics, `${slug}-${n}.md`);
        topic = { slug: path.basename(file, ".md"), title: name, status: "active", file };
        docs.set(file, parseDoc(`# ${name}\n${topicMeta(topic.slug, "active", date)}\n`));
      }
    }
    const doc = docs.get(file)!;
    const order = profileKind ? PROFILE_ORDER : TOPIC_ORDER;
    const changed = new Set([file]);

    const retire = (old: Item, d: Doc, f: string) => {
      const hist = ensureSection(d, "history", lang, f === p.profile ? PROFILE_ORDER : TOPIC_ORDER);
      hist.lines.unshift(formatItem({ ...old, text: `~~${old.text}~~ (${L.supersededBy(`m:${id}`)})` }));
      changed.add(f);
    };

    let replaced: Item | undefined;
    if (input.replaces) {
      const rid = input.replaces.replace(/^m:/, "");
      for (const [f, d] of docs) {
        const hit = takeItem(d, rid);
        if (hit) {
          replaced = hit.item;
          retire(hit.item, d, f);
          break;
        }
      }
      if (!replaced) throw new Error(`no memory item m:${rid}`);
    }

    const sec = ensureSection(doc, input.kind, lang, order);
    if (input.kind === "status") {
      // One current status per topic.
      for (const l of sec.lines.splice(0)) {
        const old = parseItem(l);
        if (old) retire(old, doc, file);
        else if (l.trim()) sec.lines.push(l);
      }
    }
    appendLine(sec, formatItem({ text, id, date, agent }));
    if (topic) {
      touchTopic(doc, topic, date);
      topic = { ...topic, updated: date };
    }

    for (const f of changed) {
      const d = docs.get(f)!;
      assignMissingIds(d, taken);
      await writeAtomic(f, serializeDoc(d));
    }
    return { id, file, topic, replaced };
  });
}

/** Delete a memory item for good. Returns the file it was in. */
export async function forgetItem(dir: string, id: string): Promise<{ file: string; item: Item } | undefined> {
  const rid = id.replace(/^m:/, "");
  return withLock(dir, async () => {
    for (const [f, d] of await loadAll(dir)) {
      const hit = takeItem(d, rid);
      if (hit) {
        await writeAtomic(f, serializeDoc(d));
        return { file: f, item: hit.item };
      }
    }
    return undefined;
  });
}

/** Set a topic's status (active / paused / done). */
export async function setTopicStatus(dir: string, name: string, status: string): Promise<TopicInfo | undefined> {
  return withLock(dir, async () => {
    const t = await findTopic(dir, name);
    if (!t) return undefined;
    const doc = parseDoc((await readText(t.file)) ?? "");
    const info = { ...t, status };
    touchTopic(doc, info, localDate());
    await writeAtomic(t.file, serializeDoc(doc));
    return info;
  });
}
