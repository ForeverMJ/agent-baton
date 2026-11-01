// `baton install|uninstall <agent>`: wire the auto-capture hooks into each agent.
//
// Default scope is global: hooks are no-ops outside projects that ran `baton init`,
// so one install covers every baton-enabled project.

import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWsl } from "../env/detect.js";

export type Scope = "global" | "project";
export type InstallOutcome = "installed" | "updated" | "unchanged" | "removed" | "absent";

/** How hooks invoke baton: absolute node + absolute cli.js (exec form, no shell quoting). */
export interface Invocation {
  command: string;
  args: string[];
}

export function currentInvocation(): Invocation {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  return { command: process.execPath, args: [cli] };
}

/** Where `baton install` keeps its own copy inside WSL (see stableInvocation). */
export function wslCopyDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), ".local", "share", "baton");
}

export interface StableOptions {
  env?: NodeJS.ProcessEnv;
  inv?: Invocation;
  /** Running inside WSL (default: detected). */
  wsl?: boolean;
  /** cli.js lives on a Windows drive mounted into WSL (default: path under /mnt/<drive>/). */
  onWindowsDrive?: boolean;
}

/**
 * The invocation hooks and MCP servers should use. Inside WSL, baton run from a Windows drive is
 * loaded through the 9P file bridge on every hook call (~0.35 s instead of ~0.02 s), so dist/
 * (without tests) and package.json (it makes the .js files ES modules) are copied into the distro
 * and the copy is used instead; re-running `baton install` refreshes it. Elsewhere: currentInvocation().
 */
export async function stableInvocation(o: StableOptions = {}): Promise<Invocation> {
  const inv = o.inv ?? currentInvocation();
  const cli = inv.args[0]!;
  const wsl = o.wsl ?? isWsl();
  const onDrive = o.onWindowsDrive ?? /^\/mnt\/[a-z]\//i.test(cli);
  if (!wsl || !onDrive) return inv;
  const distSrc = path.dirname(cli);
  const dest = wslCopyDir(o.env);
  await rm(path.join(dest, "dist"), { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(distSrc, path.join(dest, "dist"), {
    recursive: true,
    filter: (src) => path.relative(distSrc, src).split(path.sep)[0] !== "test",
  });
  await copyFile(path.join(distSrc, "..", "package.json"), path.join(dest, "package.json"));
  return { command: inv.command, args: [path.join(dest, "dist", path.basename(cli)), ...inv.args.slice(1)] };
}

/** npx caches are temporary; hooks pointing there break later. */
export function isEphemeral(inv: Invocation): boolean {
  return inv.args.some((a) => /[\\/]_npx[\\/]/.test(a));
}

export function home(env: NodeJS.ProcessEnv): string {
  return env.BATON_HOME ?? homedir();
}

// ---------------------------------------------------------------- Claude Code

export function claudeSettingsPath(scope: Scope, root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (scope === "project") return path.join(root, ".claude", "settings.local.json"); // machine-specific paths: keep out of git
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home(env), ".claude"), "settings.json");
}

// Claude Code and Codex share the same hooks JSON shape:
//   { "hooks": { "<Event>": [ { "matcher"?: "...", "hooks": [ { "type": "command", ... } ] } ] } }
// (Claude: ~/.claude/settings.json, Codex: ~/.codex/hooks.json.)

interface JsonHook {
  type: string;
  command?: string;
  commandWindows?: string;
  args?: string[];
  [k: string]: unknown;
}
interface JsonGroup {
  matcher?: string;
  hooks?: JsonHook[];
  [k: string]: unknown;
}

function isBatonClaudeHook(h: JsonHook): boolean {
  const a = h.args ?? [];
  return a.length >= 3 && a[a.length - 2] === "hook" && a[a.length - 1] === "claude" && /cli\.js$/.test(a[0] ?? "");
}

function isBatonCodexHook(h: JsonHook): boolean {
  return [h.command, h.commandWindows].some((c) => typeof c === "string" && /cli\.js['"]? hook codex\b/.test(c));
}

function claudeHookGroups(inv: Invocation): Record<string, JsonGroup> {
  // Exec form (command + args): no shell, so no quoting issues with spaces or non-ASCII paths.
  const base = { type: "command", command: inv.command, args: [...inv.args, "hook", "claude"] };
  return {
    // Receive side: must be synchronous so its stdout lands in the new session's context.
    SessionStart: { matcher: "startup|resume|clear", hooks: [{ ...base, timeout: 30, statusMessage: "baton: checking for a handoff" }] },
    // Send side: run in the background so turns are never slowed down.
    Stop: { hooks: [{ ...base, async: true }] },
    PreCompact: { hooks: [{ ...base, async: true }] },
    // The process is exiting; keep this one synchronous so it is not killed half-way.
    SessionEnd: { hooks: [{ ...base, timeout: 30 }] },
  };
}

/** POSIX sh single-quoting. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell literal string + call operator (Codex runs hook commands through PowerShell on Windows). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function codexCommands(inv: Invocation): { command: string; commandWindows: string } {
  const argv = [inv.command, ...inv.args];
  return {
    command: [...argv.map(shQuote), "hook", "codex"].join(" "),
    commandWindows: ["&", ...argv.map(psQuote), "hook", "codex"].join(" "),
  };
}

function codexHookGroups(inv: Invocation): Record<string, JsonGroup> {
  const base = { type: "command", ...codexCommands(inv) };
  return {
    SessionStart: { matcher: "startup|resume|clear", hooks: [{ ...base, timeout: 30, statusMessage: "baton: checking for a handoff" }] },
    Stop: { hooks: [{ ...base, async: true }] },
    PreCompact: { hooks: [{ ...base, async: true }] },
    // Codex caps SessionEnd at 3 seconds and always runs it synchronously.
    SessionEnd: { hooks: [{ ...base, timeout: 3 }] },
  };
}

/** Remove baton's hooks from a settings object (in place). Returns true if anything was removed. */
function stripBaton(settings: any, isOurs: (h: JsonHook) => boolean): boolean {
  let removed = false;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  for (const event of Object.keys(hooks)) {
    const groups: JsonGroup[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept: JsonGroup[] = [];
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      const hs = (g.hooks ?? []).filter((h) => !isOurs(h));
      if (hs.length !== before) removed = true;
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return removed;
}

export async function readSettings(file: string): Promise<{ settings: any; raw?: string }> {
  if (!existsSync(file)) return { settings: {} };
  const raw = await readFile(file, "utf8");
  if (!raw.trim()) return { settings: {}, raw };
  try {
    return { settings: JSON.parse(raw), raw };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix it or edit hooks by hand`);
  }
}

async function writeSettings(file: string, settings: any, raw?: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const backup = file + ".baton-backup";
  if (raw !== undefined && !existsSync(backup)) await copyFile(file, backup);
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function installJsonHooks(
  file: string,
  groups: Record<string, JsonGroup>,
  isOurs: (h: JsonHook) => boolean,
): Promise<InstallOutcome> {
  const { settings, raw } = await readSettings(file);
  const before = JSON.stringify(settings);
  const hadBaton = stripBaton(settings, isOurs);
  settings.hooks ??= {};
  for (const [event, group] of Object.entries(groups)) {
    settings.hooks[event] = [...(settings.hooks[event] ?? []), group];
  }
  if (JSON.stringify(settings) === before) return "unchanged";
  await writeSettings(file, settings, raw);
  return hadBaton ? "updated" : "installed";
}

async function uninstallJsonHooks(file: string, isOurs: (h: JsonHook) => boolean): Promise<InstallOutcome> {
  const { settings, raw } = await readSettings(file);
  if (!stripBaton(settings, isOurs)) return "absent";
  await writeSettings(file, settings, raw);
  return "removed";
}

export const installClaude = (file: string, inv: Invocation) => installJsonHooks(file, claudeHookGroups(inv), isBatonClaudeHook);
export const uninstallClaude = (file: string) => uninstallJsonHooks(file, isBatonClaudeHook);

// ---------------------------------------------------------------- Codex

export function codexHooksPath(scope: Scope, root: string, env: NodeJS.ProcessEnv = process.env): string {
  // Project hooks only run once the project's .codex/ layer is trusted, and they contain
  // machine-specific paths: prefer the global file.
  if (scope === "project") return path.join(root, ".codex", "hooks.json");
  return path.join(env.CODEX_HOME ?? path.join(home(env), ".codex"), "hooks.json");
}

export const installCodex = (file: string, inv: Invocation) => installJsonHooks(file, codexHookGroups(inv), isBatonCodexHook);
export const uninstallCodex = (file: string) => uninstallJsonHooks(file, isBatonCodexHook);

// ---------------------------------------------------------------- opencode

const PLUGIN_MARK = "Generated by baton";

export function opencodePluginPath(scope: Scope, root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (scope === "project") return path.join(root, ".opencode", "plugins", "baton.js");
  const config = env.XDG_CONFIG_HOME ?? path.join(home(env), ".config");
  return path.join(config, "opencode", "plugins", "baton.js");
}

export function opencodePluginSource(inv: Invocation): string {
  return `// ${PLUGIN_MARK}: auto-capture for opencode. Regenerate with \`baton install opencode\`.
// Send side:    session.idle / session.compacted / session.error -> checkpoint this session.
// Receive side: before the first LLM call of a session, ask baton whether another agent
//               worked here more recently; if so, append its handoff note to the system prompt.
import { spawn } from "node:child_process";

const BATON = ${JSON.stringify([inv.command, ...inv.args])};
const STOP_EVENTS = new Set(["session.idle", "session.compacted", "session.error"]);

export const BatonPlugin = async ({ $, directory }) => {
  const run = (args) =>
    $\`\${BATON} hook opencode \${args} --root \${directory}\`.quiet().nothrow();
  const handoff = new Map(); // sessionID -> Promise<string>

  return {
    event: async ({ event }) => {
      if (!STOP_EVENTS.has(event.type)) return;
      const id = event.properties?.sessionID;
      if (!id) return;
      // Detached: \`opencode run\` exits right after session.idle and would kill an awaited child.
      try {
        const [cmd, ...pre] = BATON;
        spawn(cmd, [...pre, "hook", "opencode", "--event", event.type, "--session", id, "--root", directory], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } catch {}
    },
    "experimental.chat.system.transform": async (input, output) => {
      const id = input?.sessionID;
      if (!id) return;
      if (!handoff.has(id)) {
        const check = run(["--event", "start", "--session", id])
          .then((r) => (r.exitCode === 0 ? r.stdout.toString().trim() : ""))
          .catch(() => "");
        const timeout = new Promise((resolve) => setTimeout(() => resolve(""), 20000));
        handoff.set(id, Promise.race([check, timeout]));
      }
      const text = await handoff.get(id);
      if (text) output.system.push(text);
    },
  };
};
`;
}

export async function installOpencode(file: string, inv: Invocation): Promise<InstallOutcome> {
  const src = opencodePluginSource(inv);
  let existed = false;
  if (existsSync(file)) {
    const cur = await readFile(file, "utf8");
    if (!cur.includes(PLUGIN_MARK)) throw new Error(`${file} exists and was not generated by baton; refusing to overwrite`);
    if (cur === src) return "unchanged";
    existed = true;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, src, "utf8");
  return existed ? "updated" : "installed";
}

export async function uninstallOpencode(file: string): Promise<InstallOutcome> {
  if (!existsSync(file)) return "absent";
  if (!(await readFile(file, "utf8")).includes(PLUGIN_MARK)) return "absent";
  await rm(file);
  return "removed";
}
