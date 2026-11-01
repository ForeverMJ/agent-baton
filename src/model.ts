// Unified session model (IR). Every adapter converts its agent's native
// transcript into this shape; everything downstream only sees the IR.

export type AgentName = "claude" | "codex" | "opencode";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
}

export type Event =
  | { kind: "user"; text: string; ts?: string }
  | { kind: "assistant"; text: string; ts?: string }
  | {
      kind: "tool_call";
      id?: string;
      name: string;
      /** Short human-readable summary of the input (command, path, query...). */
      input: string;
      /** Files this call created/modified (absolute or as reported). */
      files: string[];
      ts?: string;
    }
  | { kind: "tool_result"; id?: string; ok: boolean | null; output: string; ts?: string }
  | { kind: "todos"; items: Todo[]; ts?: string }
  | { kind: "interrupt"; reason: string; ts?: string }
  | { kind: "compaction"; ts?: string };

export interface QuotaInfo {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

/** Lightweight pointer returned by discovery; cheap to produce. */
export interface SessionRef {
  agent: AgentName;
  id: string;
  cwd: string;
  title?: string;
  updatedAt: Date;
  /** Adapter-private locator (file path, db row id...), in the owning environment's terms. */
  locator: string;
  /** Set when the session lives in another environment (e.g. "wsl:Ubuntu"). */
  env?: string;
  /** Remote URL recorded by the agent itself, if any (Codex does). Saves a git call. */
  repoUrl?: string;
  /** Set when matched as a separate clone of the same repository rather than by path. */
  clone?: { root: string; branch?: string };
  origin?: Origin;
}

/**
 * "headless": started by a program (`claude -p`, `codex exec`, `opencode run`, an app embedding
 * the agent), not a person typing. undefined = unknown, treated as interactive.
 */
export type Origin = "interactive" | "headless";

export interface Session {
  agent: AgentName;
  id: string;
  cwd: string;
  title?: string;
  model?: string;
  startedAt?: string;
  updatedAt: Date;
  events: Event[];
  quota?: QuotaInfo;
  env?: string;
  /** Copied from the ref when the session ran in a separate clone of the repository. */
  clone?: { root: string; branch?: string };
  origin?: Origin;
}
