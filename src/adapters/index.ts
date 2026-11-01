import type { AgentName } from "../model.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import type { Adapter } from "./types.js";

/** Registry. Adding an agent = write an Adapter and list it here. */
export const adapters: readonly Adapter[] = [claudeAdapter, codexAdapter, opencodeAdapter];

export function getAdapter(name: string): Adapter {
  const a = adapters.find((x) => x.name === name);
  if (!a) throw new Error(`unknown agent "${name}" (known: ${adapters.map((x) => x.name).join(", ")})`);
  return a;
}

export const agentNames: readonly AgentName[] = adapters.map((a) => a.name);

export type { Adapter } from "./types.js";
