// Sources for other environments (WSL <-> Windows), built from ~/.config/baton/config.json.
//
// mode "node" (preferred): run the *same* baton cli.js inside the other environment
//   (`baton export ...`), which reads its agents natively and prints JSON. Needed because
//   SQLite cannot open a WAL database across the WSL file bridge and Windows git refuses
//   repositories inside WSL.
// mode "direct" (fallback when the other side has no usable Node): read its files across
//   the boundary with our own adapters, and run its git through wsl.exe / git.exe.
//   From Windows this cannot read opencode inside WSL.

import { execFile } from "node:child_process";
import { commandGit } from "../core/git.js";
import { agentDirs } from "../core/paths.js";
import { adapterSource, nodeSource, type Source } from "../core/sources.js";
import type { EnvConfig } from "./config.js";
import { winToWsl, wslToWin, type WslMount } from "./pathmap.js";

const TIMEOUT_MS = 30_000;

function exec(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: TIMEOUT_MS, windowsHide: true, env: env ?? process.env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${(stderr || err.message).toString().trim().split("\n").slice(-3).join(" | ")}`));
        else resolve(stdout);
      },
    );
  });
}

/** `cliPath` is the local absolute path of baton's dist/cli.js. */
export function makeSource(cfg: EnvConfig, cliPath: string): Source {
  const m: WslMount = { distro: cfg.distro, mountRoot: cfg.mountRoot };
  // "wsl": we are on Windows looking into a distro. "windows": we are in WSL looking at the host.
  const toForeign = cfg.kind === "wsl" ? (p: string) => winToWsl(p, m) : (p: string) => wslToWin(p, m);
  const toLocal = cfg.kind === "wsl" ? (p: string) => wslToWin(p, m) : (p: string) => winToWsl(p, m) ?? p;

  if ((cfg.mode ?? "node") === "node") {
    const run =
      cfg.kind === "wsl"
        ? (args: string[]) => {
            const cli = winToWsl(cliPath, m);
            if (!cli) return Promise.reject(new Error(`baton at ${cliPath} is not reachable from ${cfg.name}`));
            return exec("wsl.exe", ["-d", cfg.distro, "--exec", cfg.node!, cli, ...args], { ...process.env, WSL_UTF8: "1" });
          }
        : (args: string[]) => exec(cfg.node!, [wslToWin(cliPath, m), ...args]);
    return nodeSource({ name: cfg.name, toForeign, toLocal, run });
  }

  // direct mode: the other side's home, as a path we can open from here.
  if (!cfg.home) throw new Error(`${cfg.name}: direct mode needs "home" in the config`);
  const localHome = toLocal(cfg.home);
  const dirs = agentDirs({ BATON_HOME: localHome } as NodeJS.ProcessEnv);
  return adapterSource({
    name: cfg.name,
    dirs,
    toForeign,
    toLocal,
    gitFor: (dir) =>
      cfg.kind === "wsl" ? commandGit(["wsl.exe", "-d", cfg.distro, "--exec", "git"], dir) : commandGit(["git.exe"], dir),
    unsupported:
      cfg.kind === "wsl"
        ? { opencode: `SQLite cannot be opened across the WSL boundary; install Node >= 22.5 in ${cfg.distro} and re-run \`baton env add ${cfg.name}\`` }
        : {},
  });
}

/** Stable display of where an environment's data comes from. */
export function describeSource(cfg: EnvConfig): string {
  return (cfg.mode ?? "node") === "node" ? `node: ${cfg.node}` : `direct: ${cfg.home} (no node there)`;
}

