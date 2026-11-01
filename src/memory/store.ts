// Person-scoped memory shared by every agent: ~/.config/baton/memory/ (BATON_MEMORY_DIR overrides).
//
//   profile.md            L1  preferences / facts            (written by agents, editable by hand)
//   topics/<slug>.md      L2  status / decisions / next steps per topic
//   journal/<date>.md     L3  one rule-extracted entry per session (written by sync)
//   config.json           { lang, exclude }
//   state.json            sync progress
//
// Not ~/.baton/: hooks treat `<cwd>/.baton/` as a baton project, and sessions do run in $HOME.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configPath } from "../env/config.js";
import { isWsl } from "../env/detect.js";
import type { Lang } from "./labels.js";

/** BATON_MEMORY_DIR, else `memoryDir` in the machine config (~/.config/baton/config.json), else the default. */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BATON_MEMORY_DIR) return path.resolve(env.BATON_MEMORY_DIR);
  try {
    const c = JSON.parse(readFileSync(configPath(env), "utf8"));
    if (typeof c.memoryDir === "string" && c.memoryDir) return path.resolve(c.memoryDir);
  } catch {
    /* no machine config, or unreadable: default */
  }
  return path.join(env.BATON_HOME ?? homedir(), ".config", "baton", "memory");
}

/**
 * The environment this process runs in, as other environments name it: "wsl:<distro>" inside WSL
 * (the name `baton env add` gives that distro on Windows), undefined on the host.
 */
export function localEnvName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BATON_ENV_NAME !== undefined) return env.BATON_ENV_NAME || undefined; // tests, unusual setups
  return isWsl() && env.WSL_DISTRO_NAME ? `wsl:${env.WSL_DISTRO_NAME}` : undefined;
}

export function memoryPaths(dir: string) {
  return {
    dir,
    profile: path.join(dir, "profile.md"),
    topics: path.join(dir, "topics"),
    journal: path.join(dir, "journal"),
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    lock: path.join(dir, ".lock"),
    log: path.join(dir, "memory.log"),
  };
}

export function isEnabled(dir: string): boolean {
  return existsSync(memoryPaths(dir).config);
}

export interface MemoryConfig {
  lang: Lang;
  /** Sessions whose cwd is inside one of these folders never enter the journal. */
  exclude: string[];
  /** Also journal sessions started by programs (`codex exec`, `claude -p`, `opencode run`...). */
  includeHeadless: boolean;
}

export async function readConfig(dir: string): Promise<MemoryConfig> {
  const raw = await readJson<Partial<MemoryConfig>>(memoryPaths(dir).config, {});
  return {
    lang: raw.lang === "zh" ? "zh" : "en",
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
    includeHeadless: raw.includeHeadless === true,
  };
}

export async function writeConfig(dir: string, cfg: MemoryConfig): Promise<void> {
  await writeAtomic(memoryPaths(dir).config, JSON.stringify(cfg, null, 2) + "\n");
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function readText(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

/** Write to a temp file, then rename: readers never see a half-written file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      // Windows: the target may be open by a reader for a moment.
      const transient = ["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? "");
      if (!transient || attempt >= 20) {
        await rm(tmp, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;

/**
 * Run `fn` holding the memory dir's exclusive lock. Several agents (and their hooks) may write
 * at the same moment; every read-modify-write of a memory file goes through here.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = memoryPaths(dir).lock;
  await mkdir(dir, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await open(lock, "wx");
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      // Windows reports EPERM while the previous holder's lock file is still being deleted.
      if (!["EEXIST", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      const st = await stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true }); // left behind by a killed process
        continue;
      }
      if (Date.now() > deadline) throw new Error(`memory is locked (${lock}); delete it if no baton process is running`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Markdown files directly inside `dir`, sorted by name. */
export async function markdownFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".md")).sort().map((n) => path.join(dir, n));
}

/** Diagnostics; never creates the memory dir (that is `baton mem init`'s job). */
export async function memoryLog(dir: string, line: string): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    await appendFile(memoryPaths(dir).log, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* logging must never fail the caller */
  }
}
