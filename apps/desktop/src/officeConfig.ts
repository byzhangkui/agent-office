import {
  agentSessionIdDetailKey,
  agentSourceIdDetailKey,
  defaultClaudeProfile,
  defaultCodexProfile,
} from "@agent-office/protocol";
import { officeZones } from "./officeLayout";
import type { Agent, AgentHookEvent, AgentProfile } from "./types";

/** Built-in real agent source profiles the desktop app can render. */
export const officeAgentProfiles: AgentProfile[] = [defaultCodexProfile, defaultClaudeProfile];

/** Resolves the visual profile for a hook event, including per-source session agents. */
export function resolveAgentProfileForEvent(params: { event: AgentHookEvent; existingAgents: Agent[] }): AgentProfile | undefined {
  const configuredProfile = officeAgentProfiles.find((profile) => profile.id === params.event.agentId);
  if (configuredProfile !== undefined) {
    return configuredProfile;
  }

  const sourceAgentId = readOptionalStringFromRecord({ source: params.event.details, key: agentSourceIdDetailKey });
  const sessionId = readOptionalStringFromRecord({ source: params.event.details, key: agentSessionIdDetailKey });
  if (sourceAgentId === undefined || sessionId === undefined) {
    return undefined;
  }

  const sourceProfile = officeAgentProfiles.find((profile) => profile.id === sourceAgentId);
  if (sourceProfile === undefined) {
    return undefined;
  }

  const shortSession = params.event.agentId.slice(-4).toUpperCase();
  return {
    id: params.event.agentId,
    name: `${sourceProfile.name} ${shortSession}`,
    role: sourceProfile.role,
    avatarColor: pickAvatarColor({ agentId: params.event.agentId, sourceColor: sourceProfile.avatarColor }),
    deskId: pickDeskId({ agentId: params.event.agentId, existingAgents: params.existingAgents, fallbackDeskId: sourceProfile.deskId }),
  };
}

function readOptionalStringFromRecord(params: { source: Record<string, unknown>; key: string }): string | undefined {
  const value = params.source[params.key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function pickAvatarColor(params: { agentId: string; sourceColor: string }): string {
  const colors = uniqueStrings({
    values: [
      params.sourceColor,
      "#4b77be",
      "#c47f3f",
      "#6d5cae",
      "#b14f6a",
      "#3b8c5a",
      "#8b6f3d",
      "#3b8295",
    ],
  });
  return colors[stableHashNumber({ value: params.agentId }) % colors.length];
}

function pickDeskId(params: { agentId: string; existingAgents: Agent[]; fallbackDeskId: string }): string {
  const deskIds = officeZones.filter((zone) => zone.kind === "desk").map((zone) => zone.id);
  if (deskIds.length === 0) {
    return params.fallbackDeskId;
  }

  const usedDeskIds = new Set(params.existingAgents.map((agent) => agent.deskId));
  const availableDeskId = deskIds.find((deskId) => !usedDeskIds.has(deskId));
  if (availableDeskId !== undefined) {
    return availableDeskId;
  }

  return deskIds[stableHashNumber({ value: params.agentId }) % deskIds.length];
}

function uniqueStrings(params: { values: string[] }): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of params.values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function stableHashNumber(params: { value: string }): number {
  let hash = 0;
  for (let index = 0; index < params.value.length; index += 1) {
    hash = (hash * 31 + params.value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
