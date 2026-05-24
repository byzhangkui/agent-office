import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeHookEvent } from "./eventSchema";
import type { AgentHookEvent, BridgeLogItem, BridgeLogLevel, HookParseResult } from "./types";

export type BridgeLogsResult =
  | { ok: true; logs: BridgeLogItem[] }
  | { ok: false; error: string };

export type BridgeHistoryResult =
  | { ok: true; events: AgentHookEvent[] }
  | { ok: false; error: string };

export type BridgeLogResult =
  | { ok: true; log: BridgeLogItem }
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

function formatTauriError(params: { error: unknown; action: string }): string {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return `${params.action}失败：${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
