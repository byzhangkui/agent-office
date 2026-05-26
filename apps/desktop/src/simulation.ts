import { getDeskPointForDesk, getZoneById, getZonePoint } from "./officeLayout";
import type { Agent, AgentHookEvent, AgentProfile, AgentStatus, EventLogItem, Point, Zone } from "./types";

const moveSpeedPxPerMs = 0.09;
const idleDecisionDelayMs = 4200;
const minNonWorkingStayMs = 3000;

/** Creates the initial virtual employee roster and places each agent at its desk. */
export function createInitialAgents(params: { now: number; profiles: AgentProfile[] }): Agent[] {
  return params.profiles.map((profile, index): Agent => createInitialAgent({ now: params.now, profile, index }));
}

/** Creates one virtual employee from an explicit profile and initial desk slot. */
export function createInitialAgent(params: { now: number; profile: AgentProfile; index: number }): Agent {
  const deskPoint = getDeskPointForDesk({ deskId: params.profile.deskId });
  const startPoint = offsetPoint({ point: deskPoint, dx: params.index % 2 === 0 ? -12 : 12, dy: 18 });
  return {
    ...params.profile,
    targetZoneId: params.profile.deskId,
    position: startPoint,
    target: startPoint,
    status: "idle",
    arrivalStatus: undefined,
    taskId: undefined,
    taskTitle: undefined,
    lastTaskTitle: undefined,
    statusSince: params.now,
    nextDecisionAt: params.now + 1200 + params.index * 460,
  };
}

/** Advances all agent positions and idle behaviors for one animation frame. */
export function advanceAgents(params: { agents: Agent[]; now: number; deltaMs: number; speed: number }): Agent[] {
  const nextAgents = params.agents.map((agent): Agent => {
    const movedAgent = moveAgent({ agent, deltaMs: params.deltaMs * params.speed });
    if (!hasArrived({ agent: movedAgent })) {
      return movedAgent;
    }
    if (movedAgent.arrivalStatus !== undefined) {
      return arriveAtTarget({ agent: movedAgent, now: params.now });
    }
    if (isTaskLockedStatus({ status: movedAgent.status })) {
      return movedAgent;
    }
    if (isNonWorkingActivity({ status: movedAgent.status }) && params.now - movedAgent.statusSince < minNonWorkingStayMs) {
      return movedAgent;
    }
    if (params.now < movedAgent.nextDecisionAt) {
      return movedAgent;
    }
    return chooseNextIdleBehavior({ agent: movedAgent, now: params.now });
  });
  return applyCrowdFormation({ agents: nextAgents });
}

/** Applies one local hook event to the registered agent roster. */
export function applyHookEventToAgents(params: { agents: Agent[]; event: AgentHookEvent; now: number }): Agent[] {
  const nextAgents = params.agents.map((agent): Agent => {
    if (agent.id !== params.event.agentId) {
      return agent;
    }

    const deskPoint = getDeskPointForDesk({ deskId: agent.deskId });
    if (params.event.event === "task_started") {
      const isAtDesk = distanceBetween({ from: agent.position, to: deskPoint }) < 1;
      return {
        ...agent,
        status: isAtDesk ? "working" : "walking",
        arrivalStatus: isAtDesk ? undefined : "working",
        targetZoneId: agent.deskId,
        target: deskPoint,
        taskId: params.event.taskId,
        taskTitle: params.event.title,
        lastTaskTitle: params.event.title ?? agent.lastTaskTitle,
        statusSince: params.now,
        nextDecisionAt: Number.POSITIVE_INFINITY,
      };
    }

    if (params.event.event === "task_completed") {
      const activity = chooseExternalActivity({ agentId: agent.id, now: params.now });
      return {
        ...agent,
        status: activity.status,
        arrivalStatus: undefined,
        targetZoneId: activity.zoneId,
        target: nonWorkingTarget({ zoneId: activity.zoneId, agentId: agent.id, now: params.now }),
        taskId: undefined,
        taskTitle: undefined,
        lastTaskTitle: agent.lastTaskTitle,
        statusSince: params.now,
        nextDecisionAt: params.now + 6200,
      };
    }

    if (params.event.event === "task_failed" || params.event.event === "task_blocked") {
      const isAtDesk = distanceBetween({ from: agent.position, to: deskPoint }) < 1;
      return {
        ...agent,
        status: isAtDesk ? "blocked" : "walking",
        arrivalStatus: isAtDesk ? undefined : "blocked",
        targetZoneId: agent.deskId,
        target: deskPoint,
        taskId: params.event.taskId,
        taskTitle: params.event.title,
        lastTaskTitle: params.event.title ?? agent.lastTaskTitle,
        statusSince: params.now,
        nextDecisionAt: Number.POSITIVE_INFINITY,
      };
    }

    if (params.event.event === "user_input_required") {
      const isAtDesk = distanceBetween({ from: agent.position, to: deskPoint }) < 1;
      return {
        ...agent,
        status: isAtDesk ? "waiting" : "walking",
        arrivalStatus: isAtDesk ? undefined : "waiting",
        targetZoneId: agent.deskId,
        target: deskPoint,
        taskId: params.event.taskId,
        taskTitle: params.event.title,
        lastTaskTitle: params.event.title ?? agent.lastTaskTitle,
        statusSince: params.now,
        nextDecisionAt: Number.POSITIVE_INFINITY,
      };
    }

    return {
      ...agent,
      status: "idle",
      arrivalStatus: undefined,
      targetZoneId: "lounge",
      target: nonWorkingTarget({ zoneId: "lounge", agentId: agent.id, now: params.now }),
      taskId: undefined,
      taskTitle: undefined,
      lastTaskTitle: agent.lastTaskTitle,
      statusSince: params.now,
      nextDecisionAt: params.now + idleDecisionDelayMs,
    };
  });
  return applyCrowdFormation({ agents: nextAgents });
}

/** Converts a hook event into a compact timeline item. */
export function createEventLogItem(params: { event: AgentHookEvent }): EventLogItem {
  return {
    id: params.event.id,
    agentId: params.event.agentId,
    event: params.event.event,
    title: params.event.title ?? getEventLabel({ event: params.event.event }),
    description: `${params.event.agentId} · ${params.event.workspace}`,
    timestamp: params.event.timestamp,
  };
}

/** Returns a human-readable label for a virtual employee status. */
export function getStatusLabel(params: { status: AgentStatus }): string {
  const labels: Record<AgentStatus, string> = {
    idle: "空闲",
    walking: "走动",
    working: "工作中",
    chatting: "聊天",
    drinking: "喝水",
    restroom: "离开",
    blocked: "阻塞",
    waiting: "等待",
  };
  return labels[params.status];
}

/** Returns a stable CSS tone name for the current status. */
export function getStatusTone(params: { status: AgentStatus }): string {
  if (params.status === "blocked") {
    return "danger";
  }
  if (params.status === "working") {
    return "active";
  }
  if (params.status === "waiting") {
    return "warning";
  }
  return "neutral";
}

function getEventLabel(params: { event: AgentHookEvent["event"] }): string {
  const labels: Record<AgentHookEvent["event"], string> = {
    task_started: "任务开始",
    task_completed: "任务完成",
    task_failed: "任务失败",
    task_blocked: "任务阻塞",
    user_input_required: "需要用户输入",
    agent_idle: "回到空闲",
  };
  return labels[params.event];
}

function moveAgent(params: { agent: Agent; deltaMs: number }): Agent {
  const distance = distanceBetween({ from: params.agent.position, to: params.agent.target });
  if (distance < 1) {
    return { ...params.agent, position: params.agent.target };
  }
  const travel = Math.min(distance, moveSpeedPxPerMs * params.deltaMs);
  const ratio = travel / distance;
  return {
    ...params.agent,
    position: {
      x: params.agent.position.x + (params.agent.target.x - params.agent.position.x) * ratio,
      y: params.agent.position.y + (params.agent.target.y - params.agent.position.y) * ratio,
    },
  };
}

function chooseNextIdleBehavior(params: { agent: Agent; now: number }): Agent {
  const seed = stableAgentSeed({ agentId: params.agent.id });
  const choice = Math.floor((params.now / 1000 + (seed % 23)) % 8);
  if (choice === 0) {
    return idleUpdate({ agent: params.agent, status: "chatting", targetZoneId: "lounge", target: nonWorkingTarget({ zoneId: "lounge", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  if (choice === 1) {
    return idleUpdate({ agent: params.agent, status: "drinking", targetZoneId: "water", target: nonWorkingTarget({ zoneId: "water", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  if (choice === 2) {
    return idleUpdate({ agent: params.agent, status: "restroom", targetZoneId: "restroom", target: nonWorkingTarget({ zoneId: "restroom", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  if (choice === 3) {
    return idleUpdate({ agent: params.agent, status: "walking", targetZoneId: "walkway", target: roamingPoint({ now: params.now, agentId: params.agent.id }), now: params.now });
  }
  if (choice === 4) {
    return idleUpdate({ agent: params.agent, status: "idle", targetZoneId: "lounge", target: nonWorkingTarget({ zoneId: "lounge", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  if (choice === 5) {
    return idleUpdate({ agent: params.agent, status: "chatting", targetZoneId: "lounge", target: nonWorkingTarget({ zoneId: "lounge", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  if (choice === 6) {
    return idleUpdate({ agent: params.agent, status: "drinking", targetZoneId: "water", target: nonWorkingTarget({ zoneId: "water", agentId: params.agent.id, now: params.now }), now: params.now });
  }
  return idleUpdate({ agent: params.agent, status: "idle", targetZoneId: "walkway", target: roamingPoint({ now: params.now, agentId: params.agent.id }), now: params.now });
}

function idleUpdate(params: { agent: Agent; status: AgentStatus; targetZoneId: string; target: Point; now: number }): Agent {
  return {
    ...params.agent,
    status: params.status,
    arrivalStatus: undefined,
    targetZoneId: params.targetZoneId,
    target: params.target,
    lastTaskTitle: params.agent.lastTaskTitle,
    statusSince: params.now,
    nextDecisionAt: params.now + idleDecisionDelayMs + (stableAgentSeed({ agentId: params.agent.id }) % 4) * 900,
  };
}

function roamingPoint(params: { now: number; agentId: string }): Point {
  const seed = params.now / 800 + stableAgentSeed({ agentId: params.agentId });
  return {
    x: 460 + Math.sin(seed) * 310,
    y: 465 + Math.cos(seed * 0.7) * 22,
  };
}

function distanceBetween(params: { from: Point; to: Point }): number {
  const dx = params.to.x - params.from.x;
  const dy = params.to.y - params.from.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function hasArrived(params: { agent: Agent }): boolean {
  return distanceBetween({ from: params.agent.position, to: params.agent.target }) < 1;
}

function offsetPoint(params: { point: Point; dx: number; dy: number }): Point {
  return { x: params.point.x + params.dx, y: params.point.y + params.dy };
}

function isTaskLockedStatus(params: { status: AgentStatus }): boolean {
  return params.status === "working" || params.status === "blocked" || params.status === "waiting";
}

function chooseExternalActivity(params: { agentId: string; now: number }): { status: AgentStatus; zoneId: string } {
  const activities: Array<{ status: AgentStatus; zoneId: string }> = [
    { status: "idle", zoneId: "lounge" },
    { status: "chatting", zoneId: "lounge" },
    { status: "restroom", zoneId: "restroom" },
    { status: "drinking", zoneId: "water" },
  ];
  return activities[(stableAgentSeed({ agentId: params.agentId }) + Math.floor(params.now / 1000)) % activities.length];
}

function isNonWorkingActivity(params: { status: AgentStatus }): boolean {
  return params.status === "idle"
    || params.status === "chatting"
    || params.status === "drinking"
    || params.status === "restroom";
}

function nonWorkingTarget(params: { zoneId: string; agentId: string; now: number }): Point {
  const zone = getZoneById({ zoneId: params.zoneId });
  if (zone === undefined) {
    return getZonePoint({ zoneId: params.zoneId });
  }
  const seed = params.now / 1300 + stableAgentSeed({ agentId: params.agentId });
  return {
    x: zone.center.x + Math.sin(seed) * Math.max(0, zone.width / 2 - 34),
    y: zone.center.y + Math.cos(seed * 0.8) * Math.max(0, zone.height / 2 - 30),
  };
}

function arriveAtTarget(params: { agent: Agent; now: number }): Agent {
  const status = params.agent.arrivalStatus;
  if (status === undefined) {
    return params.agent;
  }
  return {
    ...params.agent,
    status,
    arrivalStatus: undefined,
    statusSince: params.now,
    nextDecisionAt: isTaskLockedStatus({ status }) ? Number.POSITIVE_INFINITY : params.now + idleDecisionDelayMs,
  };
}

function applyCrowdFormation(params: { agents: Agent[] }): Agent[] {
  const groups = new Map<string, Agent[]>();
  for (const agent of params.agents) {
    if (!shouldSpreadZone({ zoneId: agent.targetZoneId })) {
      continue;
    }
    const group = groups.get(agent.targetZoneId) ?? [];
    group.push(agent);
    groups.set(agent.targetZoneId, group);
  }

  return params.agents.map((agent) => {
    const group = groups.get(agent.targetZoneId);
    if (group === undefined || group.length < 2) {
      return agent;
    }

    const index = group.findIndex((item) => item.id === agent.id);
    return {
      ...agent,
      target: crowdPoint({ zoneId: agent.targetZoneId, index, count: group.length }),
    };
  });
}

function shouldSpreadZone(params: { zoneId: string }): boolean {
  const zone = getZoneById({ zoneId: params.zoneId });
  return zone !== undefined && zone.kind !== "desk";
}

function crowdPoint(params: { zoneId: string; index: number; count: number }): Point {
  const zone = getZoneById({ zoneId: params.zoneId });
  if (zone === undefined) {
    return getZonePoint({ zoneId: params.zoneId });
  }

  const radius = crowdRadius({ zone, count: params.count });
  const angle = -Math.PI / 2 + (Math.PI * 2 * params.index) / params.count;
  return {
    x: zone.center.x + Math.cos(angle) * radius,
    y: zone.center.y + Math.sin(angle) * radius * 0.72,
  };
}

function crowdRadius(params: { zone: Zone; count: number }): number {
  const base = params.count <= 2 ? 30 : 34 + params.count * 6;
  const zoneBound = Math.max(30, Math.min(params.zone.width, params.zone.height) / 2 - 10);
  return Math.min(Math.max(base, zoneBound), 84);
}

function stableAgentSeed(params: { agentId: string }): number {
  let seed = 0;
  for (let index = 0; index < params.agentId.length; index += 1) {
    seed += params.agentId.charCodeAt(index) * (index + 1);
  }
  return seed;
}
