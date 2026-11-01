// Discover other environments on this machine (`baton env detect` / `baton env add`).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import type { EnvConfig } from "./config.js";

export interface Probe {
  config?: EnvConfig;
  /** Agent data found in that environment (".codex/sessions", ...). */
  agents: string[];
  nodeVersion?: string;
  /** Why full ("node") mode is not possible; config may still be a "direct" fallback. */
  problem?: string;
}

const MIN_NODE: [number, number] = [22, 5];

export function nodeOk(version: string | undefined): boolean {
  const m = version?.match(/^v?(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

export function isWsl(): boolean {
  return process.platform === "linux" && /microsoft/i.test(release());
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { encoding: "utf8", timeout, windowsHide: true, env: env ?? process.env }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
}

const WSL_ENV = { ...process.env, WSL_UTF8: "1" };

/** Distros installed on this Windows machine (docker-desktop's internal distros excluded). */
export async function listDistros(): Promise<string[]> {
  const out = await run("wsl.exe", ["-l", "-q"], WSL_ENV);
  return out
    .replace(/\0/g, "") // older wsl.exe ignores WSL_UTF8 and prints UTF-16
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^docker-desktop/i.test(s));
}

// Runs inside the distro. `--exec` gets a bare PATH, so look node up through the user's
// login shell, then the interactive one (nvm usually lives in .bashrc).
const PROBE_SCRIPT = `
n=$(command -v node)
[ -z "$n" ] && n=$(bash -ic 'command -v node' 2>/dev/null | tail -n1)
echo "node=$n"
[ -n "$n" ] && echo "nodever=$("$n" -p process.version 2>/dev/null)"
echo "mount=$(wslpath -u 'C:\\' 2>/dev/null)"
echo "home=$HOME"
for d in .codex/sessions .claude/projects .local/share/opencode/opencode.db; do
  [ -e "$HOME/$d" ] && echo "has=$d"
done
`;

export function parseProbe(out: string): { kv: Record<string, string>; has: string[] } {
  const kv: Record<string, string> = {};
  const has: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (k === "has") has.push(v);
    else kv[k] = v;
  }
  return { kv, has };
}

/** Turn probe output for a distro into a config: "node" mode if possible, else "direct". */
export function distroConfig(distro: string, out: string): Probe {
  const { kv, has } = parseProbe(out);
  const mountRoot = (kv.mount ?? "/mnt/c/").replace(/c\/?$/, "") || "/mnt/";
  const probe: Probe = { agents: has, nodeVersion: kv.nodever || undefined };
  const base = { name: `wsl:${distro}`, kind: "wsl" as const, distro, mountRoot };
  if (kv.node && nodeOk(kv.nodever)) {
    probe.config = { ...base, mode: "node", node: kv.node };
    return probe;
  }
  probe.problem = kv.node ? `node ${kv.nodever || "?"} at ${kv.node} is too old (need >= 22.5)` : "no node found in the distro";
  if (kv.home) probe.config = { ...base, mode: "direct", home: kv.home };
  return probe;
}

/** From Windows: inspect one WSL distro. */
export async function probeDistro(distro: string): Promise<Probe> {
  try {
    return distroConfig(distro, await run("wsl.exe", ["-d", distro, "--exec", "bash", "-lc", PROBE_SCRIPT], WSL_ENV));
  } catch (e) {
    return { agents: [], problem: `could not start ${distro}: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** From inside WSL: inspect the Windows host. */
export async function probeWindows(): Promise<Probe> {
  const distro = process.env.WSL_DISTRO_NAME ?? "";
  let mount = "/mnt/c/";
  try {
    mount = (await run("wslpath", ["-u", "C:\\"])).trim();
  } catch {
    /* default */
  }
  const mountRoot = mount.replace(/c\/?$/, "") || "/mnt/";
  const base = { name: "windows", kind: "windows" as const, distro, mountRoot };

  // The Windows home, for direct mode (through /mnt/c even SQLite works).
  let home: string | undefined;
  try {
    const win = (await run("cmd.exe", ["/c", "echo %USERPROFILE%"])).trim();
    if (win && !win.includes("%")) home = win;
  } catch {
    /* interop disabled */
  }

  let node: string | undefined = `${mountRoot}c/Program Files/nodejs/node.exe`;
  if (!existsSync(node)) {
    node = undefined;
    try {
      const where = (await run("cmd.exe", ["/c", "where", "node"])).split(/\r?\n/)[0]?.trim();
      if (where) node = (await run("wslpath", ["-u", where])).trim();
    } catch {
      /* not installed */
    }
  }
  const ver = node ? (await run(node, ["-p", "process.version"]).catch(() => "")).trim() || undefined : undefined;
  if (node && nodeOk(ver)) return { agents: [], nodeVersion: ver, config: { ...base, mode: "node", node } };

  const problem = node ? `Windows node ${ver ?? "?"} is unusable (need >= 22.5)` : "node.exe not found on the Windows side";
  return { agents: [], nodeVersion: ver, problem, config: home ? { ...base, mode: "direct", home } : undefined };
}
