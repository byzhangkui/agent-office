import { create } from "zustand";
import { fetchBridgeHistory, fetchBridgeLogs } from "./tauriBridge";
import { advanceAgents, applyHookEventToAgents, createEventLogItem, createInitialAgent } from "./simulation";
import { resolveAgentProfileForEvent } from "./officeConfig";
import type { Agent, AgentHookEvent, BridgeLogItem, EventLogItem } from "./types";

export type BridgeStatus = "connecting" | "connected" | "disconnected" | "error";

interface OfficeStore {
  agents: Agent[];
  eventLog: EventLogItem[];
  bridgeLogs: BridgeLogItem[];
  selectedAgentId: string | undefined;
  paused: boolean;
  speed: number;
  bridgeStatus: BridgeStatus;
  bridgeError: string | undefined;
  selectAgent: (params: { agentId: string }) => void;
  togglePaused: () => void;
  setSpeed: (params: { speed: number }) => void;
  resetSimulation: () => void;
  clockOutAgent: (params: { agentId: string }) => void;
  tick: (params: { now: number; deltaMs: number }) => void;
  applyHookEvent: (params: { event: AgentHookEvent }) => void;
  applyBridgeLog: (params: { log: BridgeLogItem }) => void;
  loadBridgeHistory: () => Promise<void>;
  loadBridgeLogs: () => Promise<void>;
  setBridgeState: (params: { status: BridgeStatus; error: string | undefined }) => void;
}

const maxLogItems = 80;

/** Global state store for the office simulation and local hook bridge. */
export const useOfficeStore = create<OfficeStore>((set, get) => ({
  agents: [],
  eventLog: [],
  bridgeLogs: [],
  selectedAgentId: undefined,
  paused: false,
  speed: 1,
  bridgeStatus: "disconnected",
  bridgeError: undefined,
  selectAgent: (params) => {
    set({ selectedAgentId: params.agentId });
  },
  togglePaused: () => {
    set((state) => ({ paused: !state.paused }));
  },
  setSpeed: (params) => {
    set({ speed: params.speed });
  },
  resetSimulation: () => {
    set({
      agents: [],
      eventLog: [],
      bridgeLogs: [],
      selectedAgentId: undefined,
      paused: false,
      speed: 1,
      bridgeError: undefined,
    });
  },
  clockOutAgent: (params) => {
    set((state) => {
      const nextAgents = state.agents.filter((agent) => agent.id !== params.agentId);
      if (nextAgents.length === state.agents.length) {
        return {};
      }
      return {
        agents: nextAgents,
        selectedAgentId: state.selectedAgentId === params.agentId
          ? nextAgents[0]?.id
          : state.selectedAgentId,
      };
    });
  },
  tick: (params) => {
    const state = get();
    if (state.paused) {
      return;
    }
    set({
      agents: advanceAgents({
        agents: state.agents,
        now: params.now,
        deltaMs: params.deltaMs,
        speed: state.speed,
      }),
    });
  },
  applyHookEvent: (params) => {
    const parsedTimestamp = Date.parse(params.event.timestamp);
    const now = Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp;
    const logItem = createEventLogItem({ event: params.event });
    set((state) => ({
      ...state,
      ...(state.eventLog.some((item) => item.id === params.event.id)
        ? {}
        : buildHookEventState({
            agents: state.agents,
            selectedAgentId: state.selectedAgentId,
            event: params.event,
            logItem,
            eventLog: state.eventLog,
            now,
      })),
    }));
  },
  applyBridgeLog: (params) => {
    set((state) => {
      if (state.bridgeLogs.some((item) => item.id === params.log.id)) {
        return {};
      }
      return {
        bridgeLogs: [params.log, ...state.bridgeLogs].slice(0, maxLogItems),
      };
    });
  },
  loadBridgeHistory: async () => {
    const result = await fetchBridgeHistory();
    if (!result.ok) {
      set({ bridgeError: result.error });
      return;
    }
    for (const event of result.events) {
      get().applyHookEvent({ event });
    }
  },
  loadBridgeLogs: async () => {
    const result = await fetchBridgeLogs();
    if (!result.ok) {
      set({ bridgeError: result.error });
      return;
    }
    set({ bridgeLogs: result.logs });
  },
  setBridgeState: (params) => {
    set({ bridgeStatus: params.status, bridgeError: params.error });
  },
}));

function buildHookEventState(params: {
  agents: Agent[];
  selectedAgentId: string | undefined;
  event: AgentHookEvent;
  logItem: EventLogItem;
  eventLog: EventLogItem[];
  now: number;
}): Pick<OfficeStore, "agents" | "eventLog" | "selectedAgentId"> {
  const agentsWithEventTarget = ensureAgentForEvent({
    agents: params.agents,
    event: params.event,
    now: params.now,
  });
  const nextAgents = applyHookEventToAgents({
    agents: agentsWithEventTarget,
    event: params.event,
    now: params.now,
  });
  const selectedAgentStillExists = params.selectedAgentId !== undefined
    && nextAgents.some((agent) => agent.id === params.selectedAgentId);
  const eventAgentExists = nextAgents.some((agent) => agent.id === params.event.agentId);

  return {
    agents: nextAgents,
    eventLog: [params.logItem, ...params.eventLog].slice(0, maxLogItems),
    selectedAgentId: selectedAgentStillExists
      ? params.selectedAgentId
      : eventAgentExists
        ? params.event.agentId
        : nextAgents[0]?.id,
  };
}

function ensureAgentForEvent(params: { agents: Agent[]; event: AgentHookEvent; now: number }): Agent[] {
  if (params.agents.some((agent) => agent.id === params.event.agentId)) {
    return params.agents;
  }

  const profile = resolveAgentProfileForEvent({
    event: params.event,
    existingAgents: params.agents,
  });
  if (profile === undefined) {
    return params.agents;
  }

  return [
    ...params.agents,
    createInitialAgent({
      now: params.now,
      profile,
      index: params.agents.length,
    }),
  ];
}
