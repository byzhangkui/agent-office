import type { AgentHookEvent, AgentHookEventName, HookParseResult } from "./types";

const supportedEvents: AgentHookEventName[] = [
  "task_started",
  "task_completed",
  "task_failed",
  "task_blocked",
  "user_input_required",
  "agent_idle",
];

/** Parses and validates a hook event received from the local bridge. */
export function normalizeHookEvent(params: { raw: unknown }): HookParseResult {
  if (!isRecord(params.raw)) {
    return { ok: false, error: "hook payload must be a JSON object" };
  }

  const id = readRequiredString({ source: params.raw, key: "id" });
  if (id === undefined) {
    return { ok: false, error: "hook payload requires string field id" };
  }

  const agentId = readRequiredString({ source: params.raw, key: "agentId" });
  if (agentId === undefined) {
    return { ok: false, error: "hook payload requires string field agentId" };
  }

  const workspace = readRequiredString({ source: params.raw, key: "workspace" });
  if (workspace === undefined) {
    return { ok: false, error: "hook payload requires string field workspace" };
  }

  const event = readEventName({ source: params.raw });
  if (event === undefined) {
    return { ok: false, error: `hook payload event must be one of: ${supportedEvents.join(", ")}` };
  }

  const timestamp = readRequiredString({ source: params.raw, key: "timestamp" });
  if (timestamp === undefined || Number.isNaN(Date.parse(timestamp))) {
    return { ok: false, error: "hook payload requires ISO timestamp field timestamp" };
  }

  const detailsValue = params.raw.details;
  if (detailsValue !== undefined && !isRecord(detailsValue)) {
    return { ok: false, error: "hook payload field details must be an object when present" };
  }

  const eventPayload: AgentHookEvent = {
    id,
    agentId,
    workspace,
    event,
    taskId: readOptionalString({ source: params.raw, key: "taskId" }),
    title: readOptionalString({ source: params.raw, key: "title" }),
    timestamp,
    details: detailsValue === undefined ? {} : detailsValue,
  };

  return { ok: true, event: eventPayload };
}

/** Returns whether a value is a plain JSON-like record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(params: { source: Record<string, unknown>; key: string }): string | undefined {
  const value = params.source[params.key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalString(params: { source: Record<string, unknown>; key: string }): string | undefined {
  const value = params.source[params.key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readEventName(params: { source: Record<string, unknown> }): AgentHookEventName | undefined {
  const value = params.source.event;
  if (typeof value !== "string") {
    return undefined;
  }
  return supportedEvents.includes(value as AgentHookEventName) ? (value as AgentHookEventName) : undefined;
}
