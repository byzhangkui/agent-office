# Agent Office

Agent Office is a local desktop app that visualizes coding-agent activity as virtual employees in an animated office. It supports Codex and Claude Code.

## Architecture

```text
Codex hook  / Claude Code hook
  -> packages/hook-adapter
  -> http://127.0.0.1:47391/hook
  -> apps/desktop/src-tauri
  -> Tauri event / command
  -> apps/desktop/src
```

The Tauri backend is the only local hook server. There is no separate Node bridge and no `config/office.json`. Each agent source has its own adapter, but every adapter posts the same office event shape with a neutral identity envelope (`agentSourceId` / `agentSessionId` / `agentIdentityKey`).

## Workspace

```text
apps/desktop              Tauri desktop app and React/Pixi UI
packages/hook-adapter     Codex and Claude hook adapters and installers
packages/protocol         Shared hook constants and public protocol defaults
fixtures/codex            Safe sample Codex hook payloads
fixtures/claude           Safe sample Claude Code hook payloads
```

## Development

Install dependencies:

```bash
pnpm install
```

Build the frontend:

```bash
pnpm build
```

Run the desktop app after Rust is installed:

```bash
pnpm tauri dev
```

The desktop app creates a local hook token at `~/.agent-office/hook-token` and starts the hook server on `127.0.0.1:47391`.

## Codex Hooks

Install Codex hooks:

```bash
pnpm hook:install:codex
```

Preview the hook file without writing it:

```bash
pnpm hook:install:codex:dry-run
```

Codex will ask you to review and trust the hooks on the next interactive startup.

Test the adapter with a safe fixture:

```bash
pnpm hook:codex:test
```

The adapter is fail-open for Codex: if Agent Office is not running, it logs the delivery error under `~/.agent-office/logs/hook-errors.log` and returns success to Codex so the Codex workflow is not blocked.

## Claude Code Hooks

Install Claude Code hooks (writes into `~/.claude/settings.json`):

```bash
pnpm hook:install:claude
```

Preview the merged settings without writing them:

```bash
pnpm hook:install:claude:dry-run
```

Claude Code loads the hooks on its next startup; review them with `/hooks`.

Test the adapter with a safe fixture:

```bash
pnpm hook:claude:test
```

The Claude adapter is fail-open the same way as the Codex adapter, and writes its delivery errors to the same `~/.agent-office/logs/hook-errors.log`. Claude hooks live in `~/.claude/settings.json` under `hooks` (event name -> matcher groups -> command hooks), which is a different format from Codex's `~/.codex/hooks.json`, so it has its own installer.

## Hook Event Contract

The adapter posts JSON to `http://127.0.0.1:47391/hook` with:

```json
{
  "id": "evt-1",
  "agentId": "codex-session-a7d9fb2ca2",
  "workspace": "/path/to/workspace",
  "event": "task_started",
  "taskId": "00000000-0000-4000-8000-000000000001",
  "title": "Implement a sample local feature",
  "timestamp": "2026-05-24T10:00:00.000Z",
  "details": {
    "agentSourceId": "codex",
    "agentSessionId": "00000000-0000-4000-8000-000000000001",
    "agentIdentityKey": "codex"
  }
}
```

`details` carries a neutral identity envelope (`agentSourceId`, `agentSessionId`, `agentIdentityKey`) plus any source-specific extras (for example `codexHookEventName` or `claudeHookEventName`). For a Claude session the envelope reads `"agentSourceId": "claude"`, `"agentIdentityKey": "claude"`, and `agentId` is `claude-session-<hash>`.

Supported events:

- `task_started`
- `task_completed`
- `task_failed`
- `task_blocked`
- `user_input_required`
- `agent_idle`

The hook server requires `Authorization: Bearer <token>` and accepts an event only when its identity envelope matches a known agent source (`codex` or `claude`) and `agentId` equals `<source>-session-<sha256(source\nsession\nidentity)[:10]>`.
