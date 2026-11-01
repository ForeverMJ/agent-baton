import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

const WIN_ABS = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\)/;

/**
 * Make a path absolute without reinterpreting paths that are absolute in the *other*
 * OS's syntax: we compare WSL paths on Windows and Windows paths inside WSL.
 */
export function absolutize(p: string): string {
  if (WIN_ABS.test(p) || p.startsWith("/")) return p;
  return path.resolve(p);
}

/**
 * Normalize a path for comparison: absolute, forward slashes, no trailing slash.
 * Windows-style paths are case-folded (on any host); POSIX paths keep their case.
 */
export function normalizePath(p: string): string {
  let s = p.trim();
  if (s.startsWith("file://")) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* keep as-is */
    }
  }
  s = absolutize(s);
  const winStyle = WIN_ABS.test(s) || (isWindows && s.startsWith("//"));
  s = s.replace(/\\/g, "/");
  if (winStyle) s = s.replace(/(?<!^)\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return winStyle ? s.toLowerCase() : s;
}

/** True when `child` is `parent` itself or lives below it. */
export function isWithin(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

/** Display a path relative to root when it is inside root, else as given. */
export function displayPath(file: string, root: string): string {
  let f = file;
  if (f.startsWith("file://")) {
    try {
      f = fileURLToPath(f);
    } catch {
      /* ignore */
    }
  }
  const slashed = f.replace(/\\/g, "/");
  if (!WIN_ABS.test(f) && !f.startsWith("/")) return slashed;
  if (isWithin(f, root)) {
    // Same length as the normalized root prefix (normalization only folds case / trailing slash).
    const rel = slashed.slice(normalizePath(root).length).replace(/^\/+/, "");
    return rel || ".";
  }
  return slashed;
}

/** Where each agent keeps its data. Overridable via env for tests and non-default installs. */
export interface AgentDirs {
  claudeProjects: string;
  codexSessions: string[];
  opencodeDb: string;
}

export function agentDirs(env: NodeJS.ProcessEnv = process.env): AgentDirs {
  const home = env.BATON_HOME ?? homedir();
  const claudeBase = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const codexBase = env.CODEX_HOME ?? path.join(home, ".codex");
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return {
    claudeProjects: path.join(claudeBase, "projects"),
    codexSessions: [path.join(codexBase, "sessions"), path.join(codexBase, "archived_sessions")],
    opencodeDb: env.BATON_OPENCODE_DB ?? path.join(dataHome, "opencode", "opencode.db"),
  };
}
