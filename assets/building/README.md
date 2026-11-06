# assets/building - the building cross-section art (package E2)

Drawn by `python art/building/build.py` (small pieces = hand pixels in `art/building/pieces.py`; roof, basement and the two exteriors = Codex pictures from `python art/building/gen.py <key>`, snapped by `build.py`). Check sheet: `art/building/contact.png`.
Widths come from `config.json` `ui.building`: `innerW` 1024, `facadePx` 40, `shaftPx` 72, `roofPx` 150, `basementPx` 170.

| file | size | what / how it is used |
|---|---|---|
| facade-window-day.png | 40x140 | two stacked windows (28x56 at x 6, y 8 and y 76), daylight glass; the wall behind is CSS |
| facade-window-night-off.png | 40x140 | same windows, dark glass (floor not working) |
| facade-window-night-on.png | 40x140 | same windows, warm lit glass (floor busy; lobby and CEO room always) |
| roof.png | 1024x150 | rooftop terrace strip, transparent sky: water tank, two benches, parasol, planters, crane tower, railing |
| basement.png | 1024x170 | server room cross-section, opaque, eight empty rack alcoves in a row |
| rack-off.png | 56x96 | server rack, LEDs dark |
| rack-on.png | 56x96 | server rack, LEDs lit; six slots, slot top y = 9 + 14 i, LEDs 2x2 at x 8 (green) and x 12 (amber), y = slot top + 4; stands on the basement floor line inside one alcove |
| crane-arm.png | 224x60 | crane jib (left end = tip, right end = counterweight) |
| crane-hook.png | 14x64 | cable with hook, hangs from the trolley (cable top = y 1) |
| elev-car.png | 64x96 | elevator car, lit inside |
| elev-shaft-door.png | 64x96 | closed steel door on the shaft side of a floor, red indicator light |
| sign-stand.png | 72x56 | standing sign, blank cream panel x 6..65, y 4..39 (text is drawn by CSS) |
| exterior-day.png | 320x640 | building front by day, opaque, blinds down, sign board blank |
| exterior-night.png | 320x640 | same picture at night, only the ground-floor lobby windows lit |

Small pieces (everything but roof, basement, exterior-*) are RGBA with transparent corners and a 1px dark outline (luma <= 90) on every opaque pixel that touches a transparent one.
