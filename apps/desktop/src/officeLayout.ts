import type { Point, Zone } from "./types";

export const WORLD_WIDTH = 1000;
export const WORLD_HEIGHT = 600;

export const officeZones: Zone[] = [
  { id: "desk-1", label: "工位 1", kind: "desk", center: { x: 125, y: 145 }, width: 120, height: 74, color: "#d9efe7" },
  { id: "desk-2", label: "工位 2", kind: "desk", center: { x: 285, y: 145 }, width: 120, height: 74, color: "#d9efe7" },
  { id: "desk-3", label: "工位 3", kind: "desk", center: { x: 445, y: 145 }, width: 120, height: 74, color: "#f5dfd4" },
  { id: "desk-4", label: "工位 4", kind: "desk", center: { x: 605, y: 145 }, width: 120, height: 74, color: "#e4e1fb" },
  { id: "desk-5", label: "工位 5", kind: "desk", center: { x: 125, y: 285 }, width: 120, height: 74, color: "#f0e8c8" },
  { id: "desk-6", label: "工位 6", kind: "desk", center: { x: 285, y: 285 }, width: 120, height: 74, color: "#d7edf5" },
  { id: "desk-7", label: "工位 7", kind: "desk", center: { x: 445, y: 285 }, width: 120, height: 74, color: "#e6ebcf" },
  { id: "desk-8", label: "工位 8", kind: "desk", center: { x: 605, y: 285 }, width: 120, height: 74, color: "#f7d9dd" },
  { id: "meeting", label: "会议室", kind: "meeting", center: { x: 838, y: 122 }, width: 286, height: 96, color: "#dde6f4" },
  { id: "restroom", label: "洗手间", kind: "restroom", center: { x: 737, y: 268 }, width: 88, height: 96, color: "#e8e2ed" },
  { id: "lounge", label: "休息区", kind: "lounge", center: { x: 884, y: 268 }, width: 192, height: 140, color: "#f4ead8" },
  { id: "water", label: "茶水间", kind: "water", center: { x: 660, y: 430 }, width: 84, height: 74, color: "#d5eff4" },
  { id: "walkway", label: "走廊", kind: "walkway", center: { x: 470, y: 465 }, width: 760, height: 68, color: "#edf0e6" },
];

const fallbackPoint: Point = { x: 500, y: 520 };

/** Returns a layout zone by stable id. */
export function getZoneById(params: { zoneId: string }): Zone | undefined {
  return officeZones.find((zone) => zone.id === params.zoneId);
}

/** Returns a stable point for a zone, falling back to the walkway when the zone is missing. */
export function getZonePoint(params: { zoneId: string }): Point {
  const zone = getZoneById({ zoneId: params.zoneId });
  return zone === undefined ? fallbackPoint : zone.center;
}

/** Returns the home point for an agent's assigned zone (a real desk, or the meeting room for overflow agents). */
export function getDeskPointForDesk(params: { deskId: string }): Point {
  const zone = getZoneById({ zoneId: params.deskId });
  return zone === undefined ? fallbackPoint : zone.center;
}
