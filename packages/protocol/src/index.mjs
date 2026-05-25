export const codexSourceAgentId = "codex";
export const codexIdentityKey = "codex";
export const claudeSourceAgentId = "claude";
export const claudeIdentityKey = "claude";
export const hookServerHost = "127.0.0.1";
export const hookServerPort = 47391;
export const hookServerUrl = `http://${hookServerHost}:${hookServerPort}`;
export const maxHookBodyBytes = 65536;
export const maxLogItems = 200;

// Neutral identity envelope written into every office event's details by each
// hook adapter, and read back by the desktop backend (validation) and frontend
// (rendering). Source-agnostic so new agent sources need no reader changes.
export const agentSourceIdDetailKey = "agentSourceId";
export const agentSessionIdDetailKey = "agentSessionId";
export const agentIdentityDetailKey = "agentIdentityKey";

export const defaultCodexProfile = {
  id: codexSourceAgentId,
  name: "Codex",
  role: "代码 Agent",
  avatarColor: "#2f8f83",
  deskId: "desk-1",
};

export const defaultClaudeProfile = {
  id: claudeSourceAgentId,
  name: "Claude",
  role: "代码 Agent",
  avatarColor: "#c96442",
  deskId: "desk-2",
};

// Every real agent source the office understands, with the identity key used to
// validate its session agents and the visual profile used to render them.
export const officeAgentSources = [
  { sourceAgentId: codexSourceAgentId, identityKey: codexIdentityKey, profile: defaultCodexProfile },
  { sourceAgentId: claudeSourceAgentId, identityKey: claudeIdentityKey, profile: defaultClaudeProfile },
];

export const hookEventNames = [
  "task_started",
  "task_completed",
  "task_failed",
  "task_blocked",
  "user_input_required",
  "agent_idle",
];

export function isHookEventName(value) {
  return typeof value === "string" && hookEventNames.includes(value);
}
