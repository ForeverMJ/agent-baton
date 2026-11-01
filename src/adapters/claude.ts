// Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Each line is one record; `message.content` is a string or a list of
// text / tool_use / tool_result / thinking blocks.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "../core/jsonl.js";
import { absolutize, isWithin } from "../core/paths.js";
import { summarizeInput } from "../core/text.js";
import type { Event, Origin, Session, SessionRef } from "../model.js";
import type { Adapter } from "./types.js";

/** Claude Code encodes the cwd by replacing every non-alphanumeric char with "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const FILE_KEYS = ["file_path", "notebook_path", "filePath"];
const INTERRUPT_RE = /^\[Request interrupted by user/;
const LIMIT_RE = /usage limit|rate limit|limit reached|limit will reset|out of (?:extra )?usage/i;

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("Caveat:");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** cwd and origin from the first records (`entrypoint`: "cli", "claude-desktop", "sdk-cli" for `claude -p`...). */
async function sniff(file: string): Promise<{ cwd?: string; origin?: Origin }> {
  let cwd: string | undefined;
  let origin: Origin | undefined;
  for await (const rec of readJsonl(file, 50)) {
    if (!cwd && typeof rec?.cwd === "string") cwd = rec.cwd;
    if (!origin && typeof rec?.entrypoint === "string") origin = rec.entrypoint.startsWith("sdk") ? "headless" : "interactive";
    if (cwd && origin) break;
  }
  return { cwd, origin };
}

async function scan(
  base: string,
  dirFilter: (name: string) => boolean,
  cwdFilter: (cwd: string) => boolean,
  since?: Date,
): Promise<SessionRef[]> {
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const refs: SessionRef[] = [];
  for (const dir of entries.filter(dirFilter)) {
    const full = path.join(base, dir);
    let files: string[];
    try {
      files = (await readdir(full)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      const st = await stat(file).catch(() => undefined);
      if (!st || (since && st.mtime < since)) continue;
      const { cwd, origin } = await sniff(file);
      if (!cwd || !cwdFilter(cwd)) continue;
      refs.push({ agent: "claude", id: path.basename(f, ".jsonl"), cwd, updatedAt: st.mtime, locator: file, origin });
    }
  }
  return refs;
}

export const claudeAdapter: Adapter = {
  name: "claude",

  async available(dirs) {
    return stat(dirs.claudeProjects).then(
      (s) => s.isDirectory(),
      () => false,
    );
  },

  async discover(projectRoot, dirs) {
    // The encoding is lossy (e.g. CJK chars all become "-"), so use it only as a
    // prefilter and confirm with the real cwd recorded inside the transcript.
    const enc = encodeProjectDir(absolutize(projectRoot)).toLowerCase();
    return scan(
      dirs.claudeProjects,
      (d) => d.toLowerCase() === enc || d.toLowerCase().startsWith(enc + "-"),
      (cwd) => isWithin(cwd, projectRoot),
    );
  },

  async list(dirs, since) {
    return scan(dirs.claudeProjects, () => true, () => true, since);
  },

  async load(ref) {
    const events: Event[] = [];
    let title: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let cwd = ref.cwd;

    for await (const rec of readJsonl(ref.locator)) {
      const ts: string | undefined = rec.timestamp;
      if (rec.type === "custom-title" && rec.customTitle) title = rec.customTitle;
      if (rec.type === "summary" && rec.summary && !title) title = rec.summary;
      if (rec.isSidechain) continue; // subagent traffic
      if (typeof rec.cwd === "string") cwd = rec.cwd;
      if (ts && !startedAt && (rec.type === "user" || rec.type === "assistant")) startedAt = ts;

      if (rec.type === "system" && rec.subtype === "compact_boundary") {
        events.push({ kind: "compaction", ts });
        continue;
      }

      if (rec.type === "user" && !rec.isMeta && rec.message) {
        if (rec.isCompactSummary) continue;
        const content = rec.message.content;
        if (typeof content === "string") {
          if (INTERRUPT_RE.test(content)) events.push({ kind: "interrupt", reason: "interrupted by user", ts });
          else if (!isInjected(content)) events.push({ kind: "user", text: content, ts });
          continue;
        }
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "text" && typeof b.text === "string") {
              if (INTERRUPT_RE.test(b.text)) events.push({ kind: "interrupt", reason: "interrupted by user", ts });
              else if (!isInjected(b.text)) events.push({ kind: "user", text: b.text, ts });
            } else if (b?.type === "tool_result") {
              events.push({
                kind: "tool_result",
                id: b.tool_use_id,
                ok: b.is_error ? false : true,
                output: resultText(b.content),
                ts,
              });
            }
          }
        }
        continue;
      }

      if (rec.type === "assistant" && rec.message) {
        const msg = rec.message;
        if (msg.model && msg.model !== "<synthetic>") model = msg.model;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const b of blocks) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            if (rec.isApiErrorMessage || (msg.model === "<synthetic>" && LIMIT_RE.test(b.text))) {
              events.push({ kind: "interrupt", reason: b.text.trim(), ts });
            } else {
              events.push({ kind: "assistant", text: b.text, ts });
            }
          } else if (b?.type === "tool_use") {
            const input = b.input ?? {};
            const files: string[] = [];
            for (const k of FILE_KEYS) if (typeof input[k] === "string") files.push(input[k]);
            events.push({
              kind: "tool_call",
              id: b.id,
              name: b.name,
              input: summarizeInput(input),
              files: /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(b.name) ? files : [],
              ts,
            });
            if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
              events.push({
                kind: "todos",
                items: input.todos.map((t: any) => ({ content: String(t.content ?? ""), status: String(t.status ?? "") })),
                ts,
              });
            }
          }
        }
      }
    }

    return {
      agent: "claude",
      id: ref.id,
      cwd,
      title,
      model,
      startedAt,
      updatedAt: ref.updatedAt,
      events,
      origin: ref.origin,
    };
  },
};
