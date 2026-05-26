export type AgentStatus =
  | "idle"
  | "walking"
  | "working"
  | "chatting"
  | "drinking"
  | "restroom"
  | "blocked"
  | "waiting";

export type AgentHookEventName =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "user_input_required"
  | "agent_idle";

export type ZoneKind = "desk" | "lounge" | "water" | "restroom" | "walkway" | "meeting";

export interface Point {
  x: number;
  y: number;
}

export interface Zone {
  id: string;
  label: string;
  kind: ZoneKind;
  center: Point;
  width: number;
  height: number;
  color: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  avatarColor: string;
  deskId: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  avatarColor: string;
  deskId: string;
  targetZoneId: string;
  position: Point;
  target: Point;
  status: AgentStatus;
  arrivalStatus: AgentStatus | undefined;
  taskId: string | undefined;
  taskTitle: string | undefined;
  lastTaskTitle: string | undefined;
  statusSince: number;
  nextDecisionAt: number;
}

export interface AgentHookEvent {
  id: string;
  agentId: string;
  workspace: string;
  event: AgentHookEventName;
  taskId: string | undefined;
  title: string | undefined;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface EventLogItem {
  id: string;
  agentId: string;
  event: AgentHookEventName;
  title: string;
  description: string;
  timestamp: string;
}

export type BridgeLogLevel = "info" | "warn" | "error";

export interface BridgeLogItem {
  id: string;
  timestamp: string;
  level: BridgeLogLevel;
  source: string;
  message: string;
  statusCode: number | undefined;
  agentId: string | undefined;
  event: string | undefined;
  workspace: string | undefined;
  details: Record<string, unknown>;
}

export interface CodexHookSettings {
  codexHome: string;
  configPath: string;
  hooksPath: string;
  adapterPath: string;
  errorLogPath: string;
  adapterExists: boolean;
  configExists: boolean;
  hooksFileExists: boolean;
  hooksEnabled: boolean;
  pluginHooksEnabled: boolean;
  registeredEvents: string[];
  missingEvents: string[];
  installed: boolean;
  restartRequired: boolean;
  lastErrorLog: string | undefined;
}

export interface CodexHookOperationResult {
  settings: CodexHookSettings;
  message: string;
}

export interface HookParseSuccess {
  ok: true;
  event: AgentHookEvent;
}

export interface HookParseFailure {
  ok: false;
  error: string;
}

export type HookParseResult = HookParseSuccess | HookParseFailure;
