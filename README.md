# Agent Office

Agent Office is a local desktop app that visualizes Codex activity as virtual employees in an animated office.

## Architecture

```text
Codex hook
  -> packages/hook-adapter
  -> http://127.0.0.1:47391/hook
  -> apps/desktop/src-tauri
  -> Tauri event / command
  -> apps/desktop/src
```

The Tauri backend is the only local hook server. There is no separate Node bridge and no `config/office.json`.

## Workspace

```text
apps/desktop              Tauri desktop app and React/Pixi UI
packages/hook-adapter     Codex hook adapter and hook installer
packages/protocol         Shared hook constants and public protocol defaults
fixtures/codex            Safe sample Codex hook payloads
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
    "codexSourceAgentId": "codex",
    "codexIdentityKey": "codex",
    "codexSessionId": "00000000-0000-4000-8000-000000000001"
  }
}
```

Supported events:

- `task_started`
- `task_completed`
- `task_failed`
- `task_blocked`
- `user_input_required`
- `agent_idle`

The hook server requires `Authorization: Bearer <token>` and rejects invalid Codex session identities.
