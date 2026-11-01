// Machine-level configuration: other environments on this machine whose agents baton
// should also read (e.g. a WSL distro seen from Windows, or Windows seen from WSL).
// Lives in ~/.config/baton/config.json (machine-specific, never in the project).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface EnvConfig {
  /** Display / CLI name: "wsl:<distro>" or "windows". */
  name: string;
  /** "wsl": a WSL distro reached from Windows. "windows": the Windows host reached from WSL. */
  kind: "wsl" | "windows";
  /** The WSL distro involved (target for "wsl", the distro we run in for "windows"). */
  distro: string;
  /**
   * "node": run baton inside the target environment (full support).
   * "direct": no usable Node there; read its files across the boundary (no opencode from Windows into WSL).
   */
  mode?: "node" | "direct";
  /** Absolute path of a Node >= 22.5 inside the target environment, in that environment's path syntax. */
  node?: string;
  /** The target environment's home directory, in its own path syntax (direct mode). */
  home?: string;
  /** WSL automount root, usually "/mnt/". */
  mountRoot: string;
}

export interface BatonConfig {
  environments: EnvConfig[];
  /**
   * Shared memory location when it is not the default, e.g. WSL using the Windows store through
   * /mnt/c. Lives here rather than in BATON_MEMORY_DIR because hooks and MCP servers are started by
   * the agents, without the user's shell environment.
   */
  memoryDir?: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? path.join(env.BATON_HOME ?? homedir(), ".config");
  return path.join(base, "baton", "config.json");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<BatonConfig> {
  const file = configPath(env);
  if (!existsSync(file)) return { environments: [] };
  try {
    const c = JSON.parse(await readFile(file, "utf8"));
    return {
      environments: Array.isArray(c.environments) ? c.environments : [],
      ...(typeof c.memoryDir === "string" && c.memoryDir ? { memoryDir: c.memoryDir } : {}),
    };
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function saveConfig(c: BatonConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(c, null, 2) + "\n", "utf8");
  return file;
}
