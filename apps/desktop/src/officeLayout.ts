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
  { id: "lounge", label: "休息区", kind: "lounge", center: { x: 825, y: 175 }, width: 210, height: 120, color: "#f4ead8" },
  { id: "restroom", label: "洗手间", kind: "restroom", center: { x: 835, y: 345 }, width: 150, height: 90, color: "#e8e2ed" },
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

/** Returns the center point for an explicit desk zone id. */
export function getDeskPointForDesk(params: { deskId: string }): Point {
  const zone = getZoneById({ zoneId: params.deskId });
  return zone === undefined || zone.kind !== "desk" ? fallbackPoint : zone.center;
}
