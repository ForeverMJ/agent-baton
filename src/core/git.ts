import { execFileSync } from "node:child_process";

export interface GitInfo {
  branch?: string;
  head?: string;
  /** `git status --porcelain` lines */
  status: string[];
  diffStat?: string;
  recentCommits: string[];
}

/** Runs `git <args>` against some repository and returns stdout, or undefined on failure. */
export type GitRunner = (args: string[]) => string | undefined;

function exec(file: string, args: string[], cwd?: string): string | undefined {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }).trimEnd();
  } catch {
    return undefined;
  }
}

/** git on this machine, in `dir`. */
export function localGit(dir: string): GitRunner {
  return (args) => exec("git", args, dir);
}

/** Any git binary (e.g. `wsl.exe --exec git`, `git.exe`) given as argv prefix, run with `-C dir`. */
export function commandGit(prefix: string[], dir: string): GitRunner {
  return (args) => exec(prefix[0]!, [...prefix.slice(1), "-C", dir, ...args]);
}

/** Repository root of `dir`, or undefined when not in a git repo. */
export function gitRoot(dir: string): string | undefined {
  return localGit(dir)(["rev-parse", "--show-toplevel"]) || undefined;
}

export function gitInfoWith(git: GitRunner): GitInfo | undefined {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  const status = (git(["-c", "core.quotepath=off", "status", "--porcelain=v1"]) ?? "")
    .split("\n")
    .filter((l) => l.trim() && !/\.baton\//.test(l));
  return {
    branch: git(["branch", "--show-current"]) || undefined,
    head: git(["log", "-1", "--format=%h %s"]) || undefined,
    status,
    diffStat: git(["-c", "core.quotepath=off", "diff", "HEAD", "--stat", "--", ".", ":(exclude).baton"]) || undefined,
    recentCommits: (git(["log", "-8", "--format=%h %ad %s", "--date=short"]) ?? "").split("\n").filter(Boolean),
  };
}

export function gitInfo(root: string): GitInfo | undefined {
  return gitInfoWith(localGit(root));
}

// ------------------------------------------------------------- repository identity
// Used to recognise *separate clones* of the same repository (e.g. one checkout on
// Windows, another inside WSL), whose paths have nothing in common.

export interface RepoId {
  /** Normalized remote URLs ("github.com/owner/repo"). */
  urls: string[];
  /** Root commit hashes (stable across clones, works without remotes). */
  roots: string[];
}

/** https://github.com/O/R.git, git@github.com:O/R, ssh://git@github.com/O/R -> github.com/o/r */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/); // git@host:owner/repo
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  u = u.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return u.toLowerCase();
}

export function repoIdentity(git: GitRunner): RepoId | undefined {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  const urls = (git(["remote", "-v"]) ?? "")
    .split("\n")
    .map((l) => l.split(/\s+/)[1])
    .filter((u): u is string => !!u)
    .map(normalizeRemoteUrl);
  const roots = (git(["rev-list", "--max-parents=0", "HEAD"]) ?? "").split("\n").filter(Boolean);
  return { urls: [...new Set(urls)], roots };
}

export function sameRepo(a: RepoId, b: RepoId): boolean {
  if (a.urls.some((u) => b.urls.includes(u))) return true;
  return a.roots.some((r) => b.roots.includes(r));
}
