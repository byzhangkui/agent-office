# Agent Office Progress

## Current Target

- Package manager: pnpm workspace.
- Repository shape: monorepo.
- Desktop app: `apps/desktop`.
- Codex hook adapter: `packages/hook-adapter`.
- Shared protocol defaults: `packages/protocol`.
- Runtime config file: none. `config/office.json` has been removed.
- Agent source id: `codex`.
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

## 2026-05-24 Tauri Startup Fix

- Commit: `a39bf47` (`Fix Tauri desktop startup`).
- Problem: `pnpm tauri dev` failed during Rust compilation. `tauri::generate_context!()` could not find `apps/desktop/src-tauri/icons/icon.png`, and `app.manage(state)` failed because the `tauri::Manager` trait was not imported.
- Solution: added the missing `Manager` import, added a deterministic app icon source at `apps/desktop/src-tauri/icons/icon.svg`, generated the required `icon.png`, and committed the generated `Cargo.lock` so Rust dependency resolution is reproducible.
- Verification: `pnpm build` completed successfully, `pnpm tauri dev` compiled and launched `target/debug/agent-office`, and `curl http://127.0.0.1:47391/health` returned `{"ok":true}`.
- Avoid next time: keep a Tauri icon asset in `src-tauri/icons/`, commit `Cargo.lock` for desktop apps, and run `pnpm tauri dev` before handing off Tauri changes.

## 2026-05-25 Tray Hook Settings

- Commit: `6272843` (`Add tray settings for Codex hooks`).
- Problem: Agent Office had no macOS status bar entry and no in-app place to inspect or change Codex hook registration. The local Codex config also had hook features disabled earlier, which can make valid `hooks.json` entries appear to do nothing.
- Solution: added a Tauri tray icon with menu items for opening Agent Office, opening Settings, and quitting. Added a Settings panel that reads Codex hook status, registers Agent Office hooks for the supported Codex lifecycle events, unregisters only Agent Office hook entries, and enables the required Codex hook feature flags when registering.
- Verification: `pnpm build` passed, `cargo check` passed, `pnpm tauri dev` launched the app, `curl http://127.0.0.1:47391/health` returned `{"ok":true}`, and `pnpm hook:codex:test` completed without adapter errors.
- Avoid next time: hook-related UI should expose both `hooks.json` registration state and Codex feature flags, because either side can prevent events from being delivered.

## 2026-05-25 Menu Bar Packaging Fixes

- Commit: `84dd8bb` (`Add menu bar popover packaging fixes`).
- Problem: the packaged `.dmg` showed the default macOS app placeholder icon because `bundle.icon` was empty. The menu bar item reused the full app icon, so it appeared as a black rounded-square status item. Adapter error logs also displayed UTC ISO timestamps such as `2026-05-24T16:16:32.135Z`, which was not the desired Beijing time display.
- Solution: generated and configured the Tauri bundle icon set, added a separate transparent macOS template icon for the menu bar, changed left-click on the menu bar item to toggle a hidden floating Agent Office window, made the app use accessory activation on macOS, and formatted adapter errors/settings logs in `Asia/Shanghai`.
- Verification: `pnpm build` passed, `cargo check` passed, `pnpm tauri build` generated `Agent Office.app` and `Agent Office_0.1.0_aarch64.dmg`, `Info.plist` includes `CFBundleIconFile = icon.icns`, the app bundle contains `Contents/Resources/icon.icns`, and a temporary hook-adapter error log wrote `2026-05-25 00:23:54.888 Asia/Shanghai ...`.
- Avoid next time: keep Tauri `bundle.icon` wired to committed generated icon assets, use a dedicated template icon for status bar/menu bar UI instead of the app icon, and localize human-facing log timestamps at the point they are displayed or written.

## 2026-05-25 Popover Window Polish

- Commit: `381450b` (`Polish menu bar popover window`).
- Problem: the floating Agent Office window still behaved too much like a wide app window. The `记录` control was isolated in a right-side rail, the closed activity rail reserved horizontal space, the default popover height left too much empty space below the office scene, clicking outside the popover did not dismiss it, and the menu bar template icon was drawn with too much transparent padding so it looked too small.
- Solution: moved `记录` into the top toolbar immediately to the right of the Settings button, removed the closed rail from layout flow, reduced the popover height to 620px with a smaller minimum height, added delayed focus-loss auto-hide for the Tauri window, and enlarged the generated transparent template icon artwork within its 32px canvas.
- Verification: `pnpm build` passed, `cargo check` passed, Playwright at 1040x620 showed `记录` beside Settings and only an 18px bottom canvas gap, `pnpm tauri build` generated the release app and `.dmg`, the rebuilt app was installed to `/Applications/Agent Office.app`, and `curl http://127.0.0.1:47391/health` returned `{"ok":true}`.
- Avoid next time: popover-style menu bar windows should be sized around content, hide on blur, and keep all primary controls in the header instead of reserving persistent side rails for collapsed actions.

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
