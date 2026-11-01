// IR -> Checkpoint: the rule-based "where exactly did the previous agent stop" snapshot.
// No LLM here on purpose: everything in a checkpoint is copied from the transcript,
// so the next agent can trust it; interpretation is left to that agent.

import type { Event, QuotaInfo, Session, Todo } from "../model.js";
import { displayPath } from "./paths.js";

export interface Action {
  name: string;
  input: string;
  ok: boolean | null; // null = unknown / no exit status; undefined result handled via `pending`
  pending: boolean; // call issued but no result recorded
  output: string;
  ts?: string;
}

export interface Checkpoint {
  session: {
    agent: string;
    /** Environment the session came from when not local (e.g. "wsl:Ubuntu"). */
    env?: string;
    /** The session ran in a different clone of this repository. */
    clone?: { root: string; branch?: string };
    id: string;
    title?: string;
    cwd: string;
    model?: string;
    startedAt?: string;
    updatedAt: string;
    userTurns: number;
    toolCalls: number;
    compactions: number;
  };
  goal: string[];
  recentRequests: string[];
  lastAssistant?: string;
  todos?: Todo[];
  recentActions: Action[];
  errors: Action[];
  filesTouched: string[];
  interruption?: string;
  quota?: QuotaInfo;
}

export interface ExtractOptions {
  goalMessages?: number;
  recentRequests?: number;
  recentActions?: number;
  maxErrors?: number;
}

function pairActions(events: Event[]): Action[] {
  const actions: Action[] = [];
  const byId = new Map<string, Action>();
  let lastWithoutId: Action | undefined;
  for (const e of events) {
    if (e.kind === "tool_call") {
      const a: Action = { name: e.name, input: e.input, ok: null, pending: true, output: "", ts: e.ts };
      actions.push(a);
      if (e.id) byId.set(e.id, a);
      else lastWithoutId = a;
    } else if (e.kind === "tool_result") {
      const a = e.id ? byId.get(e.id) : lastWithoutId;
      if (a) {
        a.pending = false;
        a.ok = e.ok;
        a.output = e.output;
      }
    }
  }
  return actions;
}

/** Tool name + first two words of its input: "bash:bun test", "Edit:src/a.ts". */
function actionKey(a: Action): string {
  return `${a.name}:${a.input.trim().split(/\s+/).slice(0, 2).join(" ")}`;
}

/** Why does this transcript end where it does? */
function detectInterruption(events: Event[], actions: Action[]): string | undefined {
  // Look at the tail: an explicit interrupt near the end wins.
  const tail = events.slice(-15);
  const lastInterrupt = [...tail].reverse().find((e) => e.kind === "interrupt");
  const lastMeaningful = [...events].reverse().find((e) => e.kind !== "compaction" && e.kind !== "todos");
  if (lastInterrupt?.kind === "interrupt") {
    const after = events.slice(events.lastIndexOf(lastInterrupt) + 1);
    if (!after.some((e) => e.kind === "user")) return lastInterrupt.reason;
  }
  const lastAction = actions[actions.length - 1];
  if (lastMeaningful?.kind === "tool_call" || (lastAction?.pending && lastMeaningful?.kind !== "assistant")) {
    return `stopped while running a tool: ${lastAction?.name ?? "?"} ${lastAction?.input ?? ""}`.trim();
  }
  if (lastMeaningful?.kind === "user") return "the last user request never got a reply";
  if (lastMeaningful?.kind === "tool_result") return "stopped right after a tool result, before replying";
  return undefined;
}

export function extractCheckpoint(s: Session, root: string, opts: ExtractOptions = {}): Checkpoint {
  const { goalMessages = 2, recentRequests = 5, recentActions = 10, maxErrors = 3 } = opts;
  const events = s.events;
  const users = events.filter((e): e is Extract<Event, { kind: "user" }> => e.kind === "user");
  const assistants = events.filter((e): e is Extract<Event, { kind: "assistant" }> => e.kind === "assistant");
  const actions = pairActions(events);

  // Files: most recently touched first, deduped.
  const files: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "tool_call") continue;
    for (const f of e.files) {
      const d = displayPath(f, s.clone?.root ?? root);
      if (!files.includes(d)) files.push(d);
    }
  }

  // Errors: failed actions not superseded by a later success of the same tool and
  // command prefix (so a failing `bun test foo.ts` is cleared by a passing `bun test`).
  const errors: Action[] = [];
  for (let i = actions.length - 1; i >= 0 && errors.length < maxErrors; i--) {
    const a = actions[i]!;
    if (a.ok !== false) continue;
    const key = actionKey(a);
    const fixedLater = actions.slice(i + 1).some((b) => b.ok === true && actionKey(b) === key);
    if (!fixedLater) errors.push(a);
  }

  const lastTodos = [...events].reverse().find((e) => e.kind === "todos");
  const goal = users.slice(0, goalMessages).map((u) => u.text);
  const recent = users.slice(Math.max(goalMessages, users.length - recentRequests)).map((u) => u.text);

  return {
    session: {
      agent: s.agent,
      env: s.env,
      clone: s.clone,
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      model: s.model,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt.toISOString(),
      userTurns: users.length,
      toolCalls: actions.length,
      compactions: events.filter((e) => e.kind === "compaction").length,
    },
    goal,
    recentRequests: recent,
    lastAssistant: assistants[assistants.length - 1]?.text,
    todos: lastTodos?.kind === "todos" ? lastTodos.items : undefined,
    recentActions: actions.slice(-recentActions),
    errors: errors.reverse(),
    filesTouched: files,
    interruption: detectInterruption(events, actions),
    quota: s.quota,
  };
}
