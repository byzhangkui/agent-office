import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { getZoneById, officeZones, WORLD_HEIGHT, WORLD_WIDTH } from "./officeLayout";
import { useOfficeStore } from "./store";
import type { Agent, Point, Zone } from "./types";

interface PixiLayers {
  app: Application;
  staticLayer: Container;
  deskLayer: Container;
  agentLayer: Container;
}

interface StageTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Renders the animated office scene with PixiJS. */
export function OfficeCanvas(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageTransform, setStageTransform] = useState<StageTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const agents = useOfficeStore((state) => state.agents);
  const clockOutAgent = useOfficeStore((state) => state.clockOutAgent);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    let disposed = false;
    let frameId = 0;
    let lastFrame = performance.now();
    let observer: ResizeObserver | undefined = undefined;
    const layersPromise = createPixiLayers({ host });

    layersPromise.then((layers) => {
      if (disposed) {
        layers.app.canvas.remove();
        layers.app.destroy();
        return;
      }

      drawOffice({ layer: layers.staticLayer });
      setStageTransform(resizeStage({ app: layers.app, host }));

      observer = new ResizeObserver(() => setStageTransform(resizeStage({ app: layers.app, host })));
      observer.observe(host);

      const loop = (frameTime: number): void => {
        const deltaMs = frameTime - lastFrame;
        lastFrame = frameTime;
        useOfficeStore.getState().tick({ now: Date.now(), deltaMs });
        renderDeskAssignments({
          layer: layers.deskLayer,
          agents: useOfficeStore.getState().agents,
        });
        renderAgents({
          layer: layers.agentLayer,
          agents: useOfficeStore.getState().agents,
          selectedAgentId: useOfficeStore.getState().selectedAgentId,
        });
        frameId = requestAnimationFrame(loop);
      };

      frameId = requestAnimationFrame(loop);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      layersPromise.then((layers) => {
        layers.app.canvas.remove();
        layers.app.destroy();
      });
    };
  }, []);

  return (
    <div className="office-canvas" ref={hostRef} data-testid="office-canvas">
      <div className="clock-out-overlay" aria-label="打卡下班操作">
        {agents.map((agent) => {
          const buttonStyle = clockOutButtonStyle({ agent, transform: stageTransform });
          if (buttonStyle === undefined) {
            return undefined;
          }
          return (
            <button
              key={agent.id}
              className="clock-out-button"
              type="button"
              style={buttonStyle}
              aria-label={`${agent.name} 打卡下班`}
              title={`${agent.name} 打卡下班`}
              onClick={() => clockOutAgent({ agentId: agent.id })}
            >
              打卡下班
            </button>
          );
        })}
      </div>
    </div>
  );
}

async function createPixiLayers(params: { host: HTMLDivElement }): Promise<PixiLayers> {
  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    preserveDrawingBuffer: true,
    resolution: window.devicePixelRatio || 1,
    resizeTo: params.host,
  });

  const staticLayer = new Container();
  const deskLayer = new Container();
  const agentLayer = new Container();
  app.stage.addChild(staticLayer);
  app.stage.addChild(deskLayer);
  app.stage.addChild(agentLayer);
  params.host.appendChild(app.canvas);

  return { app, staticLayer, deskLayer, agentLayer };
}

function resizeStage(params: { app: Application; host: HTMLDivElement }): StageTransform {
  const bounds = params.host.getBoundingClientRect();
  const scale = Math.min(bounds.width / WORLD_WIDTH, bounds.height / WORLD_HEIGHT);
  const offsetX = (bounds.width - WORLD_WIDTH * scale) / 2;
  const offsetY = (bounds.height - WORLD_HEIGHT * scale) / 2;
  params.app.stage.scale.set(scale);
  params.app.stage.position.set(offsetX, offsetY);
  return { scale, offsetX, offsetY };
}

function clockOutButtonStyle(params: { agent: Agent; transform: StageTransform }): CSSProperties | undefined {
  if (isAgentAtDesk({ agent: params.agent })) {
    return undefined;
  }

  const desk = getZoneById({ zoneId: params.agent.deskId });
  if (desk === undefined || desk.kind !== "desk") {
    return undefined;
  }

  const width = 58;
  const height = 20;
  const center = {
    x: desk.center.x + 27,
    y: desk.center.y + 15,
  };

  return {
    left: params.transform.offsetX + (center.x - width / 2) * params.transform.scale,
    top: params.transform.offsetY + (center.y - height / 2) * params.transform.scale,
    width: width * params.transform.scale,
    height: height * params.transform.scale,
    fontSize: Math.max(9, 10 * params.transform.scale),
  };
}

function drawOffice(params: { layer: Container }): void {
  params.layer.removeChildren().forEach((child) => child.destroy({ children: true }));

  const floor = new Graphics();
  floor.roundRect(8, 8, WORLD_WIDTH - 16, WORLD_HEIGHT - 16, 18)
    .fill({ color: 0xf4f1e8 })
    .stroke({ color: 0x27313a, width: 3, alpha: 0.9 });
  params.layer.addChild(floor);

  const corridor = new Graphics();
  corridor.roundRect(64, 420, 872, 98, 16)
    .fill({ color: 0xe4ebdf })
    .stroke({ color: 0xb5c3b3, width: 2 });
  params.layer.addChild(corridor);

  for (const zone of officeZones) {
    drawZone({ layer: params.layer, zone });
  }
}

function drawZone(params: { layer: Container; zone: Zone }): void {
  const left = params.zone.center.x - params.zone.width / 2;
  const top = params.zone.center.y - params.zone.height / 2;
  const zoneGraphic = new Graphics();
  zoneGraphic.roundRect(left, top, params.zone.width, params.zone.height, 10)
    .fill({ color: hexToNumber({ hex: params.zone.color }), alpha: params.zone.kind === "walkway" ? 0.38 : 1 })
    .stroke({ color: 0x77806f, width: 1, alpha: 0.55 });
  params.layer.addChild(zoneGraphic);

  if (params.zone.kind === "desk") {
    const screen = new Graphics();
    screen.roundRect(left + 18, top + 12, 38, 22, 4).fill({ color: 0x253746 });
    screen.rect(left + 28, top + 35, 18, 4).fill({ color: 0x5b6873 });
    screen.roundRect(left + 64, top + 15, 38, 32, 5).fill({ color: 0xc49360, alpha: 0.75 });
    params.layer.addChild(screen);
  }

  if (params.zone.kind === "water") {
    const cooler = new Graphics();
    cooler.roundRect(params.zone.center.x - 13, params.zone.center.y - 22, 26, 44, 6).fill({ color: 0x80c7d7 });
    cooler.circle(params.zone.center.x, params.zone.center.y - 29, 17).fill({ color: 0xbfe8ef });
    params.layer.addChild(cooler);
  }

  if (params.zone.kind !== "desk") {
    const label = new Text({
      text: params.zone.label,
      style: { fontFamily: "Inter, ui-sans-serif, system-ui", fontSize: 12, fill: 0x3d453d },
    });
    label.anchor.set(0.5);
    label.position.set(params.zone.center.x, top - 18);
    params.layer.addChild(label);
  }
}

function renderAgents(params: { layer: Container; agents: Agent[]; selectedAgentId: string | undefined }): void {
  params.layer.removeChildren().forEach((child) => child.destroy({ children: true }));
  for (const agent of params.agents) {
    drawAgent({ layer: params.layer, agent, selected: agent.id === params.selectedAgentId });
  }
}

function renderDeskAssignments(params: { layer: Container; agents: Agent[] }): void {
  params.layer.removeChildren().forEach((child) => child.destroy({ children: true }));
  for (const agent of params.agents) {
    drawDeskAssignment({ layer: params.layer, agent });
  }
}

function drawDeskAssignment(params: { layer: Container; agent: Agent }): void {
  const desk = getZoneById({ zoneId: params.agent.deskId });
  if (desk === undefined || desk.kind !== "desk") {
    return;
  }

  const left = desk.center.x - desk.width / 2;
  const top = desk.center.y - desk.height / 2;
  if (!isAgentAtDesk({ agent: params.agent })) {
    drawDeskAwaySign({ layer: params.layer, left, top });
  }

  const assignmentText = deskAssignmentText({ agent: params.agent });
  const label = new Text({
    text: assignmentText,
    style: {
      fontFamily: "Inter, ui-sans-serif, system-ui",
      fontSize: 10,
      lineHeight: 13,
      fill: 0x283038,
      wordWrap: true,
      wordWrapWidth: desk.width - 14,
    },
  });
  label.position.set(left + 7, top + desk.height + 7);

  const background = new Graphics();
  background.roundRect(left + 5, top + desk.height + 3, desk.width - 10, Math.max(28, label.height + 8), 5)
    .fill({ color: 0xf8f7f0, alpha: 0.94 })
    .stroke({ color: params.agent.status === "working" ? 0x2f7c70 : 0xcbd3c4, width: 1, alpha: 0.9 });
  params.layer.addChild(background);
  params.layer.addChild(label);
}

function drawDeskAwaySign(params: { layer: Container; left: number; top: number }): void {
  const sign = new Graphics();
  sign.roundRect(params.left + 62, params.top + 18, 46, 18, 5)
    .fill({ color: 0xfff2b8, alpha: 0.98 })
    .stroke({ color: 0xc7973c, width: 1.4, alpha: 0.95 });
  params.layer.addChild(sign);

  const text = new Text({
    text: "摸鱼中",
    style: {
      fontFamily: "Inter, ui-sans-serif, system-ui",
      fontSize: 10,
      fontWeight: "700",
      fill: 0x6d4d12,
    },
  });
  text.anchor.set(0.5);
  text.position.set(params.left + 85, params.top + 27);
  params.layer.addChild(text);
}

function drawAgent(params: { layer: Container; agent: Agent; selected: boolean }): void {
  const x = params.agent.position.x;
  const y = params.agent.position.y;
  const distanceToTarget = Math.hypot(params.agent.target.x - x, params.agent.target.y - y);

  const shadow = new Graphics();
  shadow.ellipse(x, y + 17, 18, 7).fill({ color: 0x1f2a30, alpha: 0.16 });
  params.layer.addChild(shadow);

  const body = new Graphics();
  body.eventMode = "static";
  body.cursor = "pointer";
  body.circle(x, y, params.selected ? 18 : 15).fill({ color: hexToNumber({ hex: params.agent.avatarColor }) });
  body.circle(x - 5, y - 4, 2.2).fill({ color: 0xffffff });
  body.circle(x + 5, y - 4, 2.2).fill({ color: 0xffffff });
  body.roundRect(x - 9, y + 9, 18, 18, 6).fill({ color: 0x2f3840, alpha: 0.9 });
  if (params.selected) {
    body.circle(x, y, 22).stroke({ color: 0xffc857, width: 4 });
  }
  body.on("pointertap", () => {
    useOfficeStore.getState().selectAgent({ agentId: params.agent.id });
  });
  params.layer.addChild(body);

  if (params.agent.status === "working") {
    drawWorkIndicator({ layer: params.layer, agent: params.agent });

    const keyboard = new Graphics();
    keyboard.roundRect(x - 19, y + 24, 38, 8, 3).fill({ color: 0x1f2c35 });
    keyboard.rect(x - 14, y + 26, 5, 2).fill({ color: 0x84d2b5 });
    keyboard.rect(x - 6, y + 26, 5, 2).fill({ color: 0x84d2b5 });
    keyboard.rect(x + 2, y + 26, 5, 2).fill({ color: 0x84d2b5 });
    params.layer.addChild(keyboard);
  }

  if (params.agent.status === "blocked" || params.agent.status === "waiting") {
    const marker = new Text({
      text: params.agent.status === "blocked" ? "!" : "?",
      style: { fontFamily: "Inter, ui-sans-serif, system-ui", fontSize: 22, fontWeight: "700", fill: 0xc24444 },
    });
    marker.anchor.set(0.5);
    marker.position.set(x + 20, y - 24);
    params.layer.addChild(marker);
  }

  if (distanceToTarget > 4) {
    const trail = new Graphics();
    trail.moveTo(x, y + 20).lineTo(params.agent.target.x, params.agent.target.y).stroke({ color: 0x9ea8a1, width: 2, alpha: 0.28 });
    params.layer.addChild(trail);
  }

  if (!isAgentAtDesk({ agent: params.agent })) {
    drawAgentLabel({ layer: params.layer, agent: params.agent });
  }
}

function hexToNumber(params: { hex: string }): number {
  return Number.parseInt(params.hex.replace("#", ""), 16);
}

function drawWorkIndicator(params: { layer: Container; agent: Agent }): void {
  const x = params.agent.position.x;
  const y = params.agent.position.y - 36;
  const width = 64;
  const height = 16;
  const elapsed = Math.max(0, Date.now() - params.agent.statusSince);
  const progress = (elapsed % 1800) / 1800;
  const fillWidth = Math.max(8, Math.floor((width - 8) * progress));

  const indicator = new Graphics();
  indicator.roundRect(x - width / 2, y - height / 2, width, height, 6)
    .fill({ color: 0xf8f7f0, alpha: 0.96 })
    .stroke({ color: 0x2f7c70, width: 1.5, alpha: 0.9 });
  indicator.roundRect(x - width / 2 + 4, y - 3, fillWidth, 6, 3)
    .fill({ color: 0x2f7c70, alpha: 0.88 });
  indicator.circle(x + width / 2 + 7, y - 1, 2).fill({ color: 0x2f7c70, alpha: 0.95 });
  indicator.circle(x + width / 2 + 13, y - 1, 2).fill({ color: 0x2f7c70, alpha: 0.55 + progress * 0.35 });
  indicator.circle(x + width / 2 + 19, y - 1, 2).fill({ color: 0x2f7c70, alpha: 0.25 + progress * 0.5 });
  params.layer.addChild(indicator);

  const elapsedText = new Text({
    text: formatDuration({ elapsedMs: elapsed }),
    style: {
      fontFamily: "Inter, ui-sans-serif, system-ui",
      fontSize: 10,
      fontWeight: "700",
      fill: 0x1f4f45,
    },
  });
  elapsedText.anchor.set(0.5);
  elapsedText.position.set(x, y);
  params.layer.addChild(elapsedText);
}

function deskAssignmentText(params: { agent: Agent }): string {
  const title = params.agent.status === "working"
    ? params.agent.taskTitle
    : params.agent.lastTaskTitle;
  return `${truncateDeskText({ value: params.agent.name, maxLength: 13 })}\n${truncateDeskText({ value: title ?? "暂无任务", maxLength: 16 })}`;
}

function drawAgentLabel(params: { layer: Container; agent: Agent }): void {
  const position = agentLabelPoint({ agent: params.agent });
  const label = new Text({
    text: truncateLabel({ value: params.agent.name }),
    style: { fontFamily: "Inter, ui-sans-serif, system-ui", fontSize: 11, fill: 0x283038 },
  });
  label.anchor.set(0.5);
  label.position.set(position.x, position.y);

  const background = new Graphics();
  background.roundRect(position.x - label.width / 2 - 5, position.y - 9, label.width + 10, 18, 4)
    .fill({ color: 0xf8f7f0, alpha: 0.92 })
    .stroke({ color: 0xd2d8ca, width: 1, alpha: 0.8 });
  params.layer.addChild(background);
  params.layer.addChild(label);
}

function agentLabelPoint(params: { agent: Agent }): Point {
  const zone = getZoneById({ zoneId: params.agent.targetZoneId });
  if (zone !== undefined && zone.kind !== "desk") {
    const dx = params.agent.position.x - zone.center.x;
    const dy = params.agent.position.y - zone.center.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 4) {
      return {
        x: params.agent.position.x + (dx / distance) * 14,
        y: params.agent.position.y + (dy / distance) * 14,
      };
    }
  }

  return {
    x: params.agent.position.x,
    y: params.agent.position.y + 42,
  };
}

function truncateLabel(params: { value: string }): string {
  return params.value.length > 10 ? `${params.value.slice(0, 10)}...` : params.value;
}

function truncateDeskText(params: { value: string; maxLength: number }): string {
  return params.value.length > params.maxLength ? `${params.value.slice(0, params.maxLength - 3)}...` : params.value;
}

function formatDuration(params: { elapsedMs: number }): string {
  const seconds = Math.max(0, Math.floor(params.elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function isAgentAtDesk(params: { agent: Agent }): boolean {
  const desk = getZoneById({ zoneId: params.agent.deskId });
  if (desk === undefined || desk.kind !== "desk") {
    return false;
  }
  return Math.hypot(params.agent.position.x - desk.center.x, params.agent.position.y - desk.center.y) < 42;
}
