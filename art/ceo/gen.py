"""Draw the boss (정장 차림 사장님) with Codex.
  python art/ceo/gen.py stand [tag]   standing sheet: look/outfit in art/prompts.json "ceo", style = prompts.json "style"
  python art/ceo/gen.py snap stand|sit [tag]   cut the raw sheet <mode><tag>.png in the work folder and snap it into assets/sprites (35x64 / 39x50)
  python art/ceo/gen.py sit   [tag]   seated picture: the sentence in art/sit/prompts.json roles.ceo, reference = assets/sprites/ceo.png
Raw output goes to the work folder AGENT_OFFICE_ART_WORK (outside the repo); one line per call in its codex-calls.log.
If the file is missing in the work folder it is taken from ~/.codex/generated_images/<session id printed by THIS call> only."""
import datetime, json, os, re, shutil, subprocess, sys, time, glob

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).replace("\\", "/")
WORK = os.environ.get("AGENT_OFFICE_ART_WORK") or "C:/Users/gustj/agent-office-art-work/v11-e4"
LOG = WORK + "/codex-calls.log"
P = json.load(open(ROOT + "/art/prompts.json", encoding="utf-8"))
S = json.load(open(ROOT + "/art/sit/prompts.json", encoding="utf-8"))
SIZE = {"stand": (35, 64, "ceo.png"), "sit": (39, 50, "ceo-sit.png")}  # the sizes of the 9.3 table: the raw figure is stretched to this aspect, then snap.py --colors 20 like every other character
if sys.argv[1] == "snap":
    from PIL import Image
    kind, tag = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
    w, h, name = SIZE[kind]
    d = f"{WORK}/snap-{kind}{tag}"
    subprocess.run(["python", ROOT + "/art/snap.py", "sheet", f"{WORK}/{kind}{tag}.png", d, "--rows", "1"], check=True)
    im = Image.open(f"{d}/piece-0.png").convert("RGBA")
    im.resize((round(im.height * w / h), im.height), Image.LANCZOS).save(f"{d}/piece-wide.png")
    subprocess.run(["python", ROOT + "/art/snap.py", "sprite", f"{d}/piece-wide.png", f"{ROOT}/assets/sprites/{name}", "--height", str(h), "--colors", "20"], check=True)
    sys.exit(0)
mode = sys.argv[1]
tag = sys.argv[2] if len(sys.argv) > 2 else ""
out = f"{mode}{tag}.png"
os.makedirs(WORK, exist_ok=True)
if os.path.exists(f"{WORK}/{out}"):
    os.remove(f"{WORK}/{out}")
ceo = P["ceo"]
if mode == "stand":
    refs = [f"{ROOT}/assets/sprites/{k}.png" for k in ("worker", "lead-3", "performance-reviewer")]
    prompt = ("Create ONE pixel-art sprite image of ONE character, full body, standing, centered, on a flat solid #FF00FF magenta background (no magenta inside the character). "
              + P["style"].replace("fully transparent background", "flat magenta background") +
              " The attached images are style references only (three existing staff): match their pixel size, outline and shading, but draw a NEW, clearly different person: a man. "
              + ceo["look"] + ". Outfit: " + ceo["outfit"] + ". Chibi proportions like the references: head about 33% of the height, slim torso, legs about 30% of the height with the two legs clearly separate, whole figure about 55% as wide as it is tall. A bright red tie on a clearly white shirt with a white collar, and a big white coffee mug held in front of the chest in one hand, both large enough to stay readable when the picture is shrunk to 64 pixels tall."
              f" Render large, about 1000 px tall, crisp pixel edges, no stray speckle, no dither. Save the final image as {out} in the current directory.")
else:
    refs = [f"{ROOT}/assets/sprites/ceo.png"]
    prompt = (f"Create ONE pixel-art sprite image. Same character as the attached reference sprite: identical face, hair, outfit, palette, outline and pixel size/scale. "
              "Draw him SITTING on an invisible chair, seen from a diagonal-front 3/4 view (body turned toward the viewer, head turned slightly toward the right), hands resting forward on an unseen desk/keyboard, knees and legs visible only as a short seat-level silhouette cut off just below the hips/thighs. "
              "No chair, no desk, no shadow, no text. One single character on a flat solid #FF00FF magenta background; do not use magenta inside the character. "
              + S["roles"]["ceo"] + f". Render large, about 1000 px tall, crisp pixel-art edges, no stray speckle. Save the final image as {out} in the current directory.")
cmd = [shutil.which("codex"), "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", WORK]
for r in refs:
    cmd += ["-i", r]
cmd += ["--", prompt]
t = time.time()
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=900)
sec = round(time.time() - t)
found = os.path.exists(f"{WORK}/{out}")
sid = re.search(r"session id:\s*([0-9a-f-]{36})", (r.stdout or "") + (r.stderr or ""))
src = ""
if not found and sid:
    g = sorted(glob.glob(os.path.expanduser("~/.codex/generated_images/") + sid.group(1) + "/*.png"), key=os.path.getmtime)
    if g:
        shutil.copy(g[-1], f"{WORK}/{out}")
        found, src = True, "generated_images/" + sid.group(1)
with open(LOG, "a") as f:
    f.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {mode}{tag} {sec}s exit {r.returncode} session {sid.group(1) if sid else '?'} {src}\n")
print("exit", r.returncode, sec, "s", found, src)
print((r.stdout or "")[-300:]); print((r.stderr or "")[-400:].encode("ascii","replace").decode())
