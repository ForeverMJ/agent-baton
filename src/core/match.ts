// Matching sessions from *separate clones* of the same repository.
// Path matching cannot see them (C:\work\app vs /home/u/app), so we compare repository
// identity: remote URLs, falling back to root commits.

import type { SessionRef } from "../model.js";
import { normalizeRemoteUrl, repoIdentity, sameRepo, type GitRunner, type RepoId } from "./git.js";
import { normalizePath } from "./paths.js";

export interface MatchOptions {
  /** Upper bound on distinct directories we run git in (each costs a process, or a WSL round trip). */
  maxDirs?: number;
}

/**
 * From `listed` (sessions in arbitrary directories, in the source environment's path syntax),
 * return those whose working directory is a clone of `repo`. `gitFor(dir)` runs git in that
 * environment. Matches get `clone = { root, branch }`.
 */
export function matchByRepo(
  listed: SessionRef[],
  repo: RepoId,
  gitFor: (dir: string) => GitRunner,
  opts: MatchOptions = {},
): SessionRef[] {
  const { maxDirs = 20 } = opts;
  // Most recently active directories first, so the cap drops stale ones.
  const byDir = new Map<string, SessionRef[]>();
  for (const r of [...listed].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    const k = normalizePath(r.cwd);
    byDir.set(k, [...(byDir.get(k) ?? []), r]);
  }

  const out: SessionRef[] = [];
  let probed = 0;
  for (const refs of byDir.values()) {
    const dir = refs[0]!.cwd;
    // Cheap path first: the agent recorded the remote URL itself (Codex does).
    const hinted = refs.some((r) => r.repoUrl && repo.urls.includes(normalizeRemoteUrl(r.repoUrl)));
    let clone: SessionRef["clone"];
    if (probed < maxDirs) {
      probed++;
      const git = gitFor(dir);
      const id = repoIdentity(git);
      if (id && sameRepo(id, repo)) {
        clone = { root: git(["rev-parse", "--show-toplevel"]) || dir, branch: git(["branch", "--show-current"]) || undefined };
      } else if (!id && hinted) {
        clone = { root: dir }; // directory gone or unreadable, but the agent's own record matches
      }
    } else if (hinted) {
      clone = { root: dir };
    }
    if (clone) for (const r of refs) out.push({ ...r, clone });
  }
  return out;
}
