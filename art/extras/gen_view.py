"""Generate the window-view panoramas of a room with Codex (README "Window views").
  python art/extras/gen_view.py <room> <day|night> [tag]
Work folder: /views (or art/views next to this repo): raw pictures go to raw/, style references to refs/<room>-w<N>-crop.png
(a 3x crop of one old pane of the room: colours and brush only, not the composition). The guide picture (canvas aspect, red horizon line) is made here.
The night picture attaches the accepted day picture as the composition reference. Then: python art/view.py <room> <day|night> raw/<room>-<mode>.png <horizon fraction>."""
import datetime, os, shutil, subprocess, sys, time
from PIL import Image, ImageDraw
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(os.environ.get("AGENT_OFFICE_ART_WORK") or os.path.join(REPO, "art"), "views").replace("\\", "/")
WORK = HERE + "/raw"
ROOMS = {  # canvas w,h, horizon y in canvas, style ref
 "studio2": (624, 224, 80, "studio2-w4-crop.png"),
 "lounge": (376, 136, 68, "lounge-w0-crop.png"),
 "library": (304, 112, 58, "library-w1-crop.png"),
 "greenhouse": (992, 328, 96, "greenhouse-w5-crop.png"),
}
STYLE = ("Pixel art, 16-bit era, same rendering style, palette and pixel size as the attached style reference (it is a crop of the old window view of this room: match colours and brush, ignore its composition). "
 "Flat 2-3 tone shading, about 48 colours, soft low contrast for far things. One single continuous wide landscape, NOT several separate pictures. No window frame, no glass, no reflection, no text, no people, no characters, no border, no vignette. "
 "Output exactly the aspect ratio of the attached guide image; the horizon is the thin red line of the guide image (do not draw the red line), keep the horizon on that line across the whole width.")
P = {
"studio2-day": "Wide panorama of a sunny city seen from a high window, pale blue sky with three small white clouds, a hazy distant skyline of tiny blue-grey towers sitting on the horizon (haze fades them toward the sky colour), nearer beige, pink and blue buildings with tiny window dots in the middle distance, and large yellow-green tree canopies and a few rooftops filling the bottom third. Strong scale difference: far towers very small, mid buildings medium, trees large.",
"studio2-night": "The same city, same composition, same horizon and same building positions as the attached day image, at night: deep navy sky, crescent moon, a few small stars, dark blue skyline with sparse small warm-yellow lit windows, dark teal tree canopies with a few small street-lamp dots. No light glow, no bloom, flat pixel lights only. Paint it about 40% brighter than a realistic night.",
"lounge-day": "Wide panorama of a sunny lake valley seen at EYE LEVEL from a low viewpoint on the shore, not from above: small hazy layered blue mountains in the upper third, a far shore with a dark-green forest right on the horizon line, only a thin band of calm blue lake at the horizon, and the whole lower half filled with big close yellow flowering bushes and bright green foliage that look large and near (each bush about 30 to 50 px in the final 376x136 picture). The viewer stands among the bushes, the water is a narrow strip behind them. Bright sky with a few small clouds, the sky takes only the top quarter.",
"lounge-night": "Edit the attached day image into a night version of EXACTLY the same picture: every mountain, tree, bush, flower cluster and the thin lake strip stay in exactly the same pixel positions and shapes, the horizon and the top of the bushes stay on the same rows, nothing moves, nothing is added or removed in the landscape. Only recolour it for night: deep navy sky with a moon and a few small stars, dark indigo mountains, dark teal forest, dark navy lake strip with a pale moon streak, dark green bushes whose yellow flowers become dim pale yellow dots. No glow, flat pixel lights, painted brighter than realistic.",
"library-day": "Wide panorama: jagged blue-grey mountains with small snow caps on the horizon, a pine forest in the middle distance, a sunlit green meadow with a few large pine crowns in the bottom third, bright sky with a few white clouds. Far mountains hazy and small, near pines large.",
"library-night": "The same landscape, same composition, horizon and silhouettes as the attached day image, at night: moon and stars, dark blue mountains, almost black-green pines, one tiny lit cabin window in the forest, a few 1 px pale firefly dots on the meadow. No glow, painted brighter than realistic.",
"greenhouse-day": "Very wide garden panorama: bright blue sky with small clouds across the top third (completely empty of trees there), a hazy blue-green treeline on the horizon, mid-distance garden trees, hedges and flower beds with white, pink and yellow flowers, a pale stone path in the exact horizontal centre narrowing toward a vanishing point on the horizon, and big near foliage and large flowers in the bottom third and at both outer edges.",
"greenhouse-night": "The same garden, same composition, horizon and silhouettes as the attached day image, at night: moon and stars in the top third, dark teal treeline, dim flower beds with a few small lantern and firefly points, pale stone path, dark near foliage. No glow, painted brighter than realistic.",
}
room, mode = sys.argv[1], sys.argv[2]
tag = sys.argv[3] if len(sys.argv) > 3 else ""
w, h, hy, ref = ROOMS[room]
os.makedirs(WORK, exist_ok=True)
g = Image.new("RGB", (w * 3, h * 3), (160, 215, 250))
d = ImageDraw.Draw(g)
d.rectangle([0, hy * 3, w * 3, h * 3], fill=(110, 150, 90))
d.line([0, hy * 3, w * 3, hy * 3], fill=(255, 0, 0), width=2)
guide = f"{HERE}/refs/{room}-guide.png"; g.save(guide)
out = f"{room}-{mode}{tag}.png"
refs = [f"{HERE}/refs/{ref}"]
if mode == "night":
    refs.append(f"{WORK}/{room}-day.png")  # accepted day
refs.append(guide)
prompt = P[f"{room}-{mode}"] + " " + STYLE + f" The attached images in order: style reference{', day image to keep composition from' if mode=='night' else ''}, aspect/horizon guide. Save the final image as {out} in the current directory."
cmd = [shutil.which("codex"), "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", WORK]
for r in refs: cmd += ["-i", r]
cmd += ["--", prompt]
t = time.time()
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=900)
sec = round(time.time() - t)
ok = os.path.exists(f"{WORK}/{out}")
with open(WORK + "/codex-calls.log", "a") as f:
    f.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {room} {mode}{tag} {sec}s exit {r.returncode} file={ok}\n")
print(room, mode, tag, "exit", r.returncode, sec, "s", ok); print(r.stdout[-200:])
