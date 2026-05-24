import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeHookEvent } from "./eventSchema";
import type {
  AgentHookEvent,
  BridgeLogItem,
  BridgeLogLevel,
  CodexHookOperationResult,
  CodexHookSettings,
  HookParseResult,
} from "./types";

export type BridgeLogsResult =
  | { ok: true; logs: BridgeLogItem[] }
  | { ok: false; error: string };

export type BridgeHistoryResult =
  | { ok: true; events: AgentHookEvent[] }
  | { ok: false; error: string };

export type BridgeLogResult =
  | { ok: true; log: BridgeLogItem }
  | { ok: false; error: string };

export type CodexHookSettingsResult =
  | { ok: true; settings: CodexHookSettings }
  | { ok: false; error: string };

export type CodexHookOperationBridgeResult =
  | { ok: true; result: CodexHookOperationResult }
  | { ok: false; error: string };

/** Reads accepted hook event history from the Tauri backend. */
export async function fetchBridgeHistory(): Promise<BridgeHistoryResult> {
  let raw: unknown;
  try {
    raw = await invoke("get_history");
  } catch (error) {
    return { ok: false, error: formatTauriError({ error, action: "读取 hook 历史" }) };
  }

  return normalizeBridgeHistory({ raw });
}

/** Reads recent hook logs from the Tauri backend. */
export async function fetchBridgeLogs(): Promise<BridgeLogsResult> {
  let raw: unknown;
  try {
    raw = await invoke("get_logs");
  } catch (error) {
    return { ok: false, error: formatTauriError({ error, action: "读取 hook 日志" }) };
  }

  return normalizeBridgeLogs({ raw });
}

/** Reads Codex hook registration status from the Tauri backend. */
export async function fetchCodexHookSettings(): Promise<CodexHookSettingsResult> {
  let raw: unknown;
  try {
    raw = await invoke("get_codex_hook_settings");
  } catch (error) {
    return { ok: false, error: formatTauriError({ error, action: "读取 Codex hook 设置" }) };
  }

  return normalizeCodexHookSettings({ raw });
}

/** Registers Agent Office Codex hooks. */
export async function registerCodexHooks(): Promise<CodexHookOperationBridgeResult> {
  return runCodexHookOperation({ command: "register_codex_hooks", action: "注册 Codex hooks" });
}

/** Removes Agent Office Codex hooks. */
export async function unregisterCodexHooks(): Promise<CodexHookOperationBridgeResult> {
  return runCodexHookOperation({ command: "unregister_codex_hooks", action: "取消注册 Codex hooks" });
}

/** Subscribes to hook events emitted by the Tauri backend. */
export async function listenForHookEvents(params: { onEvent: (params: { event: AgentHookEvent }) => void; onError: (params: { error: string }) => void }): Promise<() => void> {
  return listen("hook-event", (payload) => {
    const parsed = normalizeEventPayload({ payload: payload.payload });
    if (!parsed.ok) {
      params.onError({ error: parsed.error });
      return;
    }
    params.onEvent({ event: parsed.event });
  });
}

/** Subscribes to structured hook logs emitted by the Tauri backend. */
export async function listenForHookLogs(params: { onLog: (params: { log: BridgeLogItem }) => void; onError: (params: { error: string }) => void }): Promise<() => void> {
  return listen("hook-log", (payload) => {
    const parsed = normalizeBridgeLog({ raw: payload.payload });
    if (!parsed.ok) {
      params.onError({ error: parsed.error });
      return;
    }
    params.onLog({ log: parsed.log });
  });
}

/** Subscribes to tray requests to open settings. */
export async function listenForOpenSettings(params: { onOpen: () => void }): Promise<() => void> {
  return listen("open-settings", () => params.onOpen());
}

async function runCodexHookOperation(params: { command: "register_codex_hooks" | "unregister_codex_hooks"; action: string }): Promise<CodexHookOperationBridgeResult> {
  let raw: unknown;
  try {
    raw = await invoke(params.command);
  } catch (error) {
    return { ok: false, error: formatTauriError({ error, action: params.action }) };
  }

  return normalizeCodexHookOperation({ raw });
}

function normalizeEventPayload(params: { payload: unknown }): HookParseResult {
  return normalizeHookEvent({ raw: params.payload });
}

function normalizeBridgeHistory(params: { raw: unknown }): BridgeHistoryResult {
  if (!Array.isArray(params.raw)) {
    return { ok: false, error: "hook 历史响应必须是数组" };
  }

  const events: AgentHookEvent[] = [];
  for (const item of params.raw) {
    const parsed = normalizeHookEvent({ raw: item });
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    events.push(parsed.event);
  }

  return { ok: true, events };
}

function normalizeBridgeLogs(params: { raw: unknown }): BridgeLogsResult {
  if (!Array.isArray(params.raw)) {
    return { ok: false, error: "hook 日志响应必须是数组" };
  }

  const logs: BridgeLogItem[] = [];
  for (const item of params.raw) {
    const log = normalizeBridgeLogItem({ raw: item });
    if (log === undefined) {
      return { ok: false, error: "hook 日志响应包含非法日志项" };
    }
    logs.push(log);
  }

  return { ok: true, logs };
}

function normalizeBridgeLog(params: { raw: unknown }): BridgeLogResult {
  const log = normalizeBridgeLogItem({ raw: params.raw });
  if (log === undefined) {
    return { ok: false, error: "hook 日志事件格式非法" };
  }
  return { ok: true, log };
}

function normalizeCodexHookOperation(params: { raw: unknown }): CodexHookOperationBridgeResult {
  if (!isRecord(params.raw)) {
    return { ok: false, error: "Codex hook 操作响应必须是对象" };
  }
  const message = readString({ source: params.raw, key: "message" });
  const settingsResult = normalizeCodexHookSettings({ raw: params.raw.settings });
  if (message === undefined || !settingsResult.ok) {
    return { ok: false, error: settingsResult.ok ? "Codex hook 操作响应缺少消息" : settingsResult.error };
  }
  return {
    ok: true,
    result: {
      settings: settingsResult.settings,
      message,
    },
  };
}

function normalizeCodexHookSettings(params: { raw: unknown }): CodexHookSettingsResult {
  if (!isRecord(params.raw)) {
    return { ok: false, error: "Codex hook 设置响应必须是对象" };
  }

  const codexHome = readString({ source: params.raw, key: "codexHome" });
  const configPath = readString({ source: params.raw, key: "configPath" });
  const hooksPath = readString({ source: params.raw, key: "hooksPath" });
  const adapterPath = readString({ source: params.raw, key: "adapterPath" });
  const errorLogPath = readString({ source: params.raw, key: "errorLogPath" });
  if (codexHome === undefined || configPath === undefined || hooksPath === undefined || adapterPath === undefined || errorLogPath === undefined) {
    return { ok: false, error: "Codex hook 设置响应缺少路径字段" };
  }

  const registeredEvents = readStringArray({ source: params.raw, key: "registeredEvents" });
  const missingEvents = readStringArray({ source: params.raw, key: "missingEvents" });
  if (registeredEvents === undefined || missingEvents === undefined) {
    return { ok: false, error: "Codex hook 设置响应缺少事件列表" };
  }

  return {
    ok: true,
    settings: {
      codexHome,
      configPath,
      hooksPath,
      adapterPath,
      errorLogPath,
      adapterExists: readBoolean({ source: params.raw, key: "adapterExists" }),
      configExists: readBoolean({ source: params.raw, key: "configExists" }),
      hooksFileExists: readBoolean({ source: params.raw, key: "hooksFileExists" }),
      hooksEnabled: readBoolean({ source: params.raw, key: "hooksEnabled" }),
      pluginHooksEnabled: readBoolean({ source: params.raw, key: "pluginHooksEnabled" }),
      registeredEvents,
      missingEvents,
      installed: readBoolean({ source: params.raw, key: "installed" }),
      restartRequired: readBoolean({ source: params.raw, key: "restartRequired" }),
      lastErrorLog: readString({ source: params.raw, key: "lastErrorLog" }),
    },
  };
}

function normalizeBridgeLogItem(params: { raw: unknown }): BridgeLogItem | undefined {
  if (!isRecord(params.raw)) {
    return undefined;
  }

  const id = readString({ source: params.raw, key: "id" });
  const timestamp = readString({ source: params.raw, key: "timestamp" });
  const level = readLogLevel({ source: params.raw });
  const source = readString({ source: params.raw, key: "source" });
  const message = readString({ source: params.raw, key: "message" });
  if (id === undefined || timestamp === undefined || level === undefined || source === undefined || message === undefined) {
    return undefined;
  }

  const details = params.raw.details;
  if (details !== undefined && !isRecord(details)) {
    return undefined;
  }

  return {
    id,
    timestamp,
    level,
    source,
    message,
    statusCode: readNumber({ source: params.raw, key: "statusCode" }),
    agentId: readString({ source: params.raw, key: "agentId" }),
    event: readString({ source: params.raw, key: "event" }),
    workspace: readString({ source: params.raw, key: "workspace" }),
    details: details ?? {},
  };
}

function readLogLevel(params: { source: Record<string, unknown> }): BridgeLogLevel | undefined {
  const value = params.source.level;
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return undefined;
}

function readString(params: { source: Record<string, unknown>; key: string }): string | undefined {
  const value = params.source[params.key];
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length === 0 ? undefined : value;
}

function readNumber(params: { source: Record<string, unknown>; key: string }): number | undefined {
  const value = params.source[params.key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(params: { source: Record<string, unknown>; key: string }): boolean {
  const value = params.source[params.key];
  return value === true;
}

function readStringArray(params: { source: Record<string, unknown>; key: string }): string[] | undefined {
  const value = params.source[params.key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function formatTauriError(params: { error: unknown; action: string }): string {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return `${params.action}失败：${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
