// Walking legs (pure): where the legs of a sprite start, so the picture can be cut into body and two leg halves.
// No new art: while a character walks, its own picture is drawn three times (body down to the hip line, then the part
// below it left and right of `split`) and the two leg halves swap sides in CSS (style.css "walking legs").

/** The CSS values `--hip` (% of the picture's height where the legs start) and `--sp` (% of its width where they part) for a sprite key. */
export function legVars(walk, key) {
  const [hip, split] = walk.hips[key] ?? walk.hipDefault;
  return { hip: `${hip}%`, sp: `${split}%` };
}
