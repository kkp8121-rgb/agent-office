// Building cross-section rules (pure): the order of the rooms, where each one stands, how far the whole building is zoomed,
// which floors are alive, which way the view slides, what the basement racks and the facade windows show.
// Numbers come from `ui.building` (config.json). No DOM, no timers, no clock: building-view.mjs does the drawing.
import { LOBBY_ID, CEO_ID } from './view.mjs';

export const ROOF_ID = 'roof';
export const BASEMENT_ID = 'basement';

/** Scale that fits a room `sceneW` px wide into the inner width `innerW` of the building (the lobby is wider, so it shrinks). */
export const floorScale = (sceneW, innerW) => innerW / sceneW;

/**
 * Top to bottom: the roof, the CEO room (always the top floor), the session floors with the highest floor number first,
 * the lobby, the basement. `views` is [{sessionId, floorNo}]. A new session has the highest number, so it lands right under the CEO room.
 * @param {{sessionId: string, floorNo: number}[]} views
 * @param {{ceo?: boolean, lobby?: boolean}} on which of the two special floors exist
 * @returns {string[]}
 */
export function buildingOrder(views, { ceo = true, lobby = true } = {}) {
  const sessions = [...views].sort((a, b) => b.floorNo - a.floorNo).map((v) => v.sessionId);
  return [ROOF_ID, ...(ceo ? [CEO_ID] : []), ...sessions, ...(lobby ? [LOBBY_ID] : []), BASEMENT_ID];
}

/** Where a floor that has just appeared goes in `order` (the index of its row): right under the CEO room, else right under the roof. */
export function insertSlot(order) {
  const i = order.indexOf(CEO_ID);
  return i >= 0 ? i + 1 : 1;
}

/**
 * Where everything stands, in building px (before the zoom). `rows` are the room floors top to bottom [{id, w, h}] (scene sizes).
 * @returns {{outerW: number, totalH: number, roof: {top: number, h: number}, basement: {top: number, h: number},
 *   rows: {id: string, s: number, top: number, h: number}[]}}
 */
export function layoutBuilding(rows, cfg) {
  let y = cfg.roofPx;
  const out = rows.map((r) => {
    const s = floorScale(r.w, cfg.innerW);
    const h = r.h * s;
    const row = { id: r.id, s, top: y, h };
    y += h + cfg.slabPx;
    return row;
  });
  return {
    outerW: cfg.facadePx + cfg.innerW + cfg.shaftPx,
    totalH: y + cfg.basementPx,
    roof: { top: 0, h: cfg.roofPx },
    basement: { top: y, h: cfg.basementPx },
    rows: out,
  };
}

/**
 * The zoom of the whole building: it fits the room, at most `maxZoom`; below `minZoom` it stays at `minZoom` (never wider than the room)
 * and the building scrolls up and down.
 * @returns {{z: number, scroll: boolean}}
 */
export function fitBuilding(availW, availH, outerW, totalH, cfg) {
  const zw = availW / outerW;
  const zh = availH / totalH;
  let z = Math.min(zw, zh, cfg.maxZoom);
  if (z < cfg.minZoom) z = Math.min(cfg.minZoom, zw);
  z = Math.max(z, 0);
  return { z, scroll: totalH * z > availH + 0.5 };
}

/**
 * The floors that may be alive: the ones that touch the view (plus `marginPx` of screen above and below), and when more than `maxLive`
 * touch it, the ones nearest to the middle of the view. Everything else stands still.
 * @param {{id: string, top: number, h: number}[]} rows room floors (building px)
 * @param {{viewTop: number, viewH: number, z: number, marginPx: number, maxLive: number}} v view in building px (viewTop/viewH already divided by z)
 * @returns {Set<string>}
 */
export function pickLive(rows, { viewTop, viewH, z, marginPx, maxLive }) {
  const m = z > 0 ? marginPx / z : 0;
  const mid = viewTop + viewH / 2;
  const near = rows
    .filter((r) => r.top + r.h > viewTop - m && r.top < viewTop + viewH + m)
    .map((r) => ({ id: r.id, d: Math.abs(r.top + r.h / 2 - mid) }))
    .sort((a, b) => a.d - b.d);
  return new Set(near.slice(0, Math.max(0, maxLive)).map((r) => r.id));
}

/** Does a block (the basement) touch the view? Same margin rule as pickLive. */
export function touchesView(top, h, { viewTop, viewH, z, marginPx }) {
  const m = z > 0 ? marginPx / z : 0;
  return top + h > viewTop - m && top < viewTop + viewH + m;
}

/**
 * Which way the content slides when the view goes from floor `fromId` to floor `toId`: a higher floor comes in from above ('down'),
 * a lower one from below ('up'); null when it is the same floor or one of them is not in `order`.
 */
export function slideDir(order, fromId, toId) {
  const a = order.indexOf(fromId);
  const b = order.indexOf(toId);
  if (a < 0 || b < 0 || a === b) return null;
  return b < a ? 'down' : 'up';
}

/** How many of `racks` server racks are lit: the share of the CPU load, rounded; none while there is no sample (cpu null). */
export function racksOn(cpu, racks) {
  if (cpu === null || cpu === undefined || !Number.isFinite(cpu)) return 0;
  return Math.max(0, Math.min(racks, Math.round((cpu / 100) * racks)));
}

/** The blink period of a lit rack: `blinkSlowMs` at 0 % CPU down to `blinkFastMs` at 100 %. */
export function blinkMs(cpu, cfg) {
  const k = Math.max(0, Math.min(1, (cpu ?? 0) / 100));
  return Math.round(cfg.blinkSlowMs + (cfg.blinkFastMs - cfg.blinkSlowMs) * k);
}

/**
 * The facade window picture of a floor: by day the daylight glass; at night warm light when the floor is busy (the lobby and the CEO room
 * are always lit), else dark glass.
 * @param {{id: string, status?: string}} floor
 * @returns {'day'|'night-on'|'night-off'}
 */
export function windowPic(floor, night) {
  if (!night) return 'day';
  return floor.id === LOBBY_ID || floor.id === CEO_ID || floor.status === 'busy' ? 'night-on' : 'night-off';
}

/** The extra dimming of a floor at night: a session floor that is not busy gets `idleNightDim`, the others 0. */
export function idleDim(floor, night, cfg) {
  if (!night || floor.id === LOBBY_ID || floor.id === CEO_ID) return 0;
  return floor.status === 'busy' ? 0 : cfg.idleNightDim;
}
