# baton: development notes

- TypeScript, Node >= 22.5, ESM, zero runtime dependencies. Source in `src/`, compiled to `dist/`.
- `npm test` builds and runs all tests (`node --test`). Run it before finishing any change.
- Try against real local data without writing into other projects: `node dist/cli.js capture --stdout --root <dir>`.
- Adapters live in `src/adapters/`, one file per agent, each with a fixture test in `src/test/`.
- Agent data must only ever be read, never written. Never commit real transcripts as fixtures.

<!-- baton:start -->
## Multi-agent handoff (baton)

Several coding agents (Claude Code, Codex, opencode, ...) take turns on this project.
Shared progress lives in `.baton/`:

- **At the start of a session**, read `.baton/STATE.md`. If `.baton/RESUME.md` exists and is newer,
  read it too: it is a snapshot of exactly where the previous agent stopped. Verify it against
  `git status` / `git diff` before continuing, then merge what matters into `STATE.md`.
- **Keep `.baton/STATE.md` current**: after each meaningful step and before you stop, update
  status / done / in progress / next steps / decisions / gotchas. Be concise.
- Never write secrets into `.baton/`.
<!-- baton:end -->
