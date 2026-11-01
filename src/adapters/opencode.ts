// opencode: ~/.local/share/opencode/opencode.db (SQLite)
//   session(id, directory, title, parent_id, time_updated, ...)
//   message(id, session_id, data JSON{role, modelID, error, ...})
//   part(id, message_id, session_id, data JSON{type: text|tool|patch|compaction|reasoning ...})
//   todo(session_id, content, status, position)
// SECURITY: the same database holds `credential` / `account` tables with tokens.
// We open it read-only and only ever query the four tables above.

import { stat } from "node:fs/promises";
import { isWithin } from "../core/paths.js";
import { withReadOnly } from "../core/sqlite.js";
import { summarizeInput } from "../core/text.js";
import type { Event, Origin, Session, SessionRef, Todo } from "../model.js";
import type { Adapter } from "./types.js";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);
const LIMIT_RE = /usage limit|rate limit|quota|limit reached|429/i;

function iso(ms: unknown): string | undefined {
  return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
}

function parse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * `opencode run` creates its session with the "question" tool denied (nobody is there to answer);
 * the TUI leaves `permission` empty.
 */
function opencodeOrigin(permission: string | null): Origin | undefined {
  if (!permission) return undefined;
  const rules = parse(permission);
  if (!Array.isArray(rules)) return undefined;
  return rules.some((r: any) => r?.permission === "question" && r?.action === "deny") ? "headless" : "interactive";
}

export const opencodeAdapter: Adapter = {
  name: "opencode",

  async available(dirs) {
    return stat(dirs.opencodeDb).then(
      (s) => s.isFile(),
      () => false,
    );
  },

  async discover(projectRoot, dirs) {
    return (await this.list(dirs)).filter((r) => isWithin(r.cwd, projectRoot));
  },

  async list(dirs, since) {
    if (!(await this.available(dirs))) return [];
    const rows = await withReadOnly(dirs.opencodeDb, (db) => {
      // `permission` only exists in newer schemas.
      const hasPerm = db.all<{ name: string }>("PRAGMA table_info(session)").some((c) => c.name === "permission");
      return db.all<{ id: string; directory: string; title: string; time_updated: number; permission: string | null }>(
        `SELECT id, directory, title, time_updated, ${hasPerm ? "permission" : "NULL AS permission"} FROM session ` +
          "WHERE parent_id IS NULL AND time_archived IS NULL",
      );
    });
    {
      return (rows ?? [])
        .filter((r) => r.directory && (!since || r.time_updated >= since.getTime()))
        .map((r) => ({
          agent: "opencode" as const,
          id: r.id,
          cwd: r.directory,
          title: r.title || undefined,
          updatedAt: new Date(r.time_updated),
          locator: r.id,
          origin: opencodeOrigin(r.permission),
        }));
    }
  },

  async load(ref, dirs) {
    const fetched = await withReadOnly(dirs.opencodeDb, (db) => ({
      sess: db.all<{ title: string; model: string | null; time_created: number }>(
        "SELECT title, model, time_created FROM session WHERE id = ?",
        ref.locator,
      )[0],
      messages: db.all<{ id: string; data: string; time_created: number }>(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id",
        ref.locator,
      ),
      parts: db.all<{ message_id: string; data: string }>(
        "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
        ref.locator,
      ),
      todoRows: db.all<{ content: string; status: string }>(
        "SELECT content, status FROM todo WHERE session_id = ? ORDER BY position",
        ref.locator,
      ),
    }));
    if (!fetched) throw new Error("node:sqlite is not available (requires Node >= 22.5)");
    const { sess, messages, parts, todoRows } = fetched;
    {
      const partsByMsg = new Map<string, any[]>();
      for (const p of parts) {
        const list = partsByMsg.get(p.message_id) ?? [];
        list.push(parse(p.data));
        partsByMsg.set(p.message_id, list);
      }

      const events: Event[] = [];
      let model: string | undefined;
      for (const m of messages) {
        const data = parse(m.data);
        const ts = iso(m.time_created);
        if (data.modelID) model = data.modelID;
        for (const part of partsByMsg.get(m.id) ?? []) {
          pushPart(events, data.role, part, ts);
        }
        if (data.role === "assistant" && data.error) {
          const msg = String(data.error?.data?.message ?? data.error?.name ?? "error");
          events.push({ kind: "interrupt", reason: LIMIT_RE.test(msg) ? `quota/rate limit: ${msg}` : msg, ts });
        }
      }

      // The todo table holds the latest list; prefer it over replaying todowrite calls.
      if (todoRows.length) {
        const items: Todo[] = todoRows.map((t) => ({ content: t.content, status: t.status }));
        events.push({ kind: "todos", items });
      }

      let sessModel: string | undefined;
      if (sess?.model) sessModel = parse(sess.model)?.id;

      return {
        agent: "opencode",
        id: ref.id,
        cwd: ref.cwd,
        title: sess?.title || ref.title,
        model: model ?? sessModel,
        startedAt: iso(sess?.time_created),
        updatedAt: ref.updatedAt,
        events,
        origin: ref.origin,
      } satisfies Session;
    }
  },
};

function pushPart(events: Event[], role: string, part: any, ts?: string): void {
  switch (part.type) {
    case "text": {
      if (part.synthetic || part.ignored || typeof part.text !== "string" || !part.text.trim()) return;
      events.push({ kind: role === "user" ? "user" : "assistant", text: part.text, ts });
      return;
    }
    case "tool": {
      const st = part.state ?? {};
      const input = st.input ?? {};
      const name = String(part.tool);
      const files = EDIT_TOOLS.has(name) && typeof input.filePath === "string" ? [input.filePath] : [];
      events.push({ kind: "tool_call", id: part.callID, name, input: summarizeInput(input), files, ts });
      if (name === "todowrite" && Array.isArray(input.todos)) {
        events.push({
          kind: "todos",
          items: input.todos.map((t: any) => ({ content: String(t.content ?? ""), status: String(t.status ?? "") })),
          ts,
        });
      }
      if (st.status === "completed") {
        const exit = st.metadata?.exit;
        events.push({
          kind: "tool_result",
          id: part.callID,
          ok: typeof exit === "number" ? exit === 0 : true,
          output: String(st.output ?? ""),
          ts,
        });
      } else if (st.status === "error") {
        events.push({ kind: "tool_result", id: part.callID, ok: false, output: String(st.error ?? ""), ts });
      }
      // pending / running: no result -> extractor sees an unfinished call
      return;
    }
    case "patch":
      if (Array.isArray(part.files) && part.files.length) {
        events.push({ kind: "tool_call", name: "patch", input: part.files.join(", "), files: part.files, ts });
        events.push({ kind: "tool_result", ok: true, output: "", ts });
      }
      return;
    case "compaction":
      events.push({ kind: "compaction", ts });
      return;
  }
}
