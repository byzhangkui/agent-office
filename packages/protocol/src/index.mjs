export const codexSourceAgentId = "codex";
export const codexIdentityKey = "codex";
export const hookServerHost = "127.0.0.1";
export const hookServerPort = 47391;
export const hookServerUrl = `http://${hookServerHost}:${hookServerPort}`;
export const maxHookBodyBytes = 65536;
export const maxLogItems = 200;

export const defaultCodexProfile = {
  id: codexSourceAgentId,
  name: "Codex",
  role: "代码 Agent",
  avatarColor: "#2f8f83",
  deskId: "desk-1",
};

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
