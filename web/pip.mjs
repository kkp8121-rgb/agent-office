// Picture-in-picture helper (pure): the zoom that makes the widest floor fit the available width.

/** CSS zoom value for `widest` px of floor in `avail` px of room, or '' when it already fits (floors are never scaled up). */
export function fitZoom(avail, widest) {
  return widest > avail ? String(Math.max(avail, 0) / widest) : '';
}
