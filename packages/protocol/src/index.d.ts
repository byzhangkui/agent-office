export type AgentHookEventName =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "user_input_required"
  | "agent_idle";

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  avatarColor: string;
  deskId: string;
}

export interface AgentSource {
  sourceAgentId: string;
  identityKey: string;
  profile: AgentProfile;
}

export declare const codexSourceAgentId: "codex";
export declare const codexIdentityKey: "codex";
export declare const claudeSourceAgentId: "claude";
export declare const claudeIdentityKey: "claude";
export declare const hookServerHost: "127.0.0.1";
export declare const hookServerPort: 47391;
export declare const hookServerUrl: "http://127.0.0.1:47391";
export declare const maxHookBodyBytes: 65536;
export declare const maxLogItems: 200;
export declare const agentSourceIdDetailKey: "agentSourceId";
export declare const agentSessionIdDetailKey: "agentSessionId";
export declare const agentIdentityDetailKey: "agentIdentityKey";
export declare const defaultCodexProfile: AgentProfile;
export declare const defaultClaudeProfile: AgentProfile;
export declare const officeAgentSources: AgentSource[];
export declare const hookEventNames: AgentHookEventName[];
export declare function isHookEventName(value: unknown): value is AgentHookEventName;
