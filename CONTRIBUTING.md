# Contributing

Thanks for helping. Bug reports, new agent adapters and documentation fixes are all welcome.

## Development

Requires Node.js 22.15 or newer.

```bash
git clone https://github.com/ForeverMJ/agent-baton.git
cd agent-baton
npm install
npm test            # build + all tests (node --test)
node dist/cli.js mem status
```

TypeScript, ES modules, **no runtime dependencies**. Source in `src/`, compiled to `dist/`.

To try changes against your real agent data without touching your real memory, point baton at a
scratch folder: `BATON_MEMORY_DIR=/tmp/mem node dist/cli.js mem init`.

## Principles

- **Agents' data is only ever read.** Never write to a transcript, database or session folder.
- **Never commit real transcripts.** Tests use small synthetic fixtures (`src/test/helpers.ts`).
- **No model calls.** Everything baton records is copied from transcripts by rules, so it can be
  trusted and costs nothing. Interpretation is left to the agents.
- **Never fail the agent.** Hooks and the MCP server log problems and return nothing.
- **Touch only what is ours** in other programs' files: one entry or one marked block, backed up first.

## Adding an agent

Each agent is an adapter in `src/adapters/`, implementing `Adapter` from `src/adapters/types.ts`:

```ts
interface Adapter {
  name: AgentName;
  available(dirs): Promise<boolean>;                  // is the agent's data on this machine?
  discover(projectRoot, dirs): Promise<SessionRef[]>; // sessions whose folder is inside the project
  list(dirs, since?): Promise<SessionRef[]>;          // all sessions (shared memory)
  load(ref, dirs): Promise<Session>;                  // parse into the common model (src/model.ts)
}
```

Register it in `src/adapters/index.ts` and add a fixture test in `src/test/`. If the agent marks
sessions started by programs, set `origin: "headless"` on them. To connect the agent to the memory,
add its MCP and rules locations to `src/memory/connect.ts` and its hooks to `src/hooks/install.ts`.

Transcript formats are undocumented and change between versions; keep adapters small and tolerant.

## Design notes

The design of the shared memory, with the reasoning behind it, is in
[docs/design/](docs/design/) (Chinese).

## Pull requests

- Run `npm test` before opening one.
- Describe what you tested against (OS, agent versions).
- Keep changes focused; update the docs (English is enough, translations can follow).
