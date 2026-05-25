# Agent Office Progress

## Current Target

- Package manager: pnpm workspace.
- Repository shape: monorepo.
- Desktop app: `apps/desktop`.
- Codex hook adapter: `packages/hook-adapter`.
- Shared protocol defaults: `packages/protocol`.
- Runtime config file: none. `config/office.json` has been removed.
- Agent source ids: `codex`, `claude`.
- Hook ingress: Tauri Rust backend at `127.0.0.1:47391`.
- Frontend/backend link: Tauri commands and events.

## Final Architecture

```text
Codex hook
  -> packages/hook-adapter
  -> POST http://127.0.0.1:47391/hook
  -> apps/desktop/src-tauri
  -> Tauri event / command
  -> apps/desktop/src
```

The Node SSE bridge has been removed from the runtime design.

## Completed In This Migration

- Moved the React/Pixi UI into `apps/desktop/src`.
- Moved the Tauri app into `apps/desktop/src-tauri`.
- Moved Codex hook scripts into `packages/hook-adapter/src`.
- Added `packages/protocol` for shared `codex` source id, hook server address, and protocol defaults.
- Added `pnpm-workspace.yaml`.
- Replaced root npm scripts with pnpm workspace scripts.
- Removed the npm lockfile and generated `pnpm-lock.yaml`.
- Removed `config/office.json` and the old `scripts/` Node bridge utilities.
- Replaced the legacy numeric Codex source identity with `codex`.
- Changed the frontend from SSE bridge reads to Tauri commands/events:
  - `get_history`
  - `get_logs`
  - `hook-event`
  - `hook-log`
- Added the Tauri Rust hook server:
  - creates or reads `~/.agent-office/hook-token`
  - binds `127.0.0.1:47391`
  - accepts `POST /hook`
  - requires `Authorization: Bearer <token>`
  - validates Codex session agent ids
  - stores accepted events and logs in memory
  - emits events/logs to the frontend
- Updated fixtures to safe sample paths and sample task text.
- Rewrote README for the monorepo/Tauri-first architecture.

## Claude Code Support

- Generalized the identity envelope in event `details` to neutral keys: `agentSourceId`, `agentSessionId`, `agentIdentityKey` (was `codex*`). Both adapters write them; the Rust backend and frontend read them.
- Added `packages/protocol` exports: `claudeSourceAgentId`, `claudeIdentityKey`, `defaultClaudeProfile`, the neutral detail-key constants, and `officeAgentSources`.
- Added `packages/hook-adapter/src/claude-hook-adapter.mjs` mapping Claude hook events (`UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`) to office events.
- Added `packages/hook-adapter/src/install-claude-hooks.mjs` that merges hooks into `~/.claude/settings.json` (Claude's `hooks` shape, distinct from Codex's `hooks.json`).
- Rust validation is now source-agnostic: `KNOWN_AGENT_SOURCES` accepts `codex` and `claude`.
- Frontend renders `defaultClaudeProfile` (desk-2, color `#c96442`) and resolves session agents for any known source.
- Added `fixtures/claude/*.json` and `hook:claude:test` / `hook:install:claude(:dry-run)` scripts.

## Launch Fixes

- `apps/desktop/src-tauri/src/lib.rs`: imported `tauri::Manager` so `app.manage(state)` resolves.
- Generated `apps/desktop/src-tauri/icons/*` (was missing) and populated `bundle.icon` in `tauri.conf.json`; `generate_context!` requires an icon.

## Verification

- `pnpm install`: completed and generated `pnpm-lock.yaml`.
- `pnpm build`: completed successfully for `@agent-office/desktop`.
- `pnpm hook:codex:test`: completed and returned Codex hook success JSON.
- Adapter HTTP verification with a temporary token/server:
  - posted to `/hook`
  - sent an expected Bearer token header
  - generated `agentId` in the `codex-session-*` format
  - generated `task_started` from the safe Codex fixture
- `pnpm hook:install:codex:dry-run`: generated hook entries pointing to `packages/hook-adapter/src/codex-hook-adapter.mjs`.
- `pnpm --filter @agent-office/desktop exec tauri --version`: returned `tauri-cli 2.11.2`.

## Not Verified

- `pnpm tauri dev` and Rust compilation were not run because `cargo` is not available in the current shell.

## Manual Acceptance Steps

1. Install Rust so `cargo` is available.
2. Run `pnpm install`.
3. Run `pnpm tauri dev`.
4. Confirm the desktop window opens and shows `已连接`.
5. Run `pnpm hook:install:codex:dry-run` and inspect the generated hook command.
6. Run `pnpm hook:install:codex`.
7. Restart Codex and trust the hook prompt.
8. Start a Codex task and confirm one `codex-session-*` employee appears in the office.
9. Complete the Codex task and confirm the employee leaves the desk but remains visible.
10. Click `打卡下班` on an away employee desk and confirm that employee disappears and the desk is released.
