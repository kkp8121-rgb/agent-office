"""Draw the 12 extra girls with Codex.
  python art/extras/gen.py stand <sheet 0-2> [tag]   standing sheets (4 girls each, looks in art/prompts.json "extras")
  python art/extras/gen.py sit   <sheet 0-2> [tag]   seated sheets, one reference per girl = her standing sprite
Raw output goes to the work folder (AGENT_OFFICE_ART_WORK or the default below)."""
import datetime, json, os, shutil, subprocess, sys, time

ROOT = "C:/Users/gustj/agent-office"
WORK = os.environ.get("AGENT_OFFICE_ART_WORK") or "C:/Users/gustj/AppData/Local/Temp/claude/C--Project/6106276a-a6e5-4468-8650-198bebbf83af/scratchpad/varied/extras"
LOG = WORK + "/codex-calls.log"
P = json.load(open(ROOT + "/art/prompts.json", encoding="utf-8"))
X = P["extras"]
KEYS = sorted(X)
mode, i = sys.argv[1], int(sys.argv[2])
tag = sys.argv[3] if len(sys.argv) > 3 else ""
keys = KEYS[i * 4:(i + 1) * 4]
out = f"{mode}{i}{tag}.png"
os.makedirs(WORK, exist_ok=True)
lines = [f"{n + 1}. {X[k]}" for n, k in enumerate(keys)]
if mode == "stand":
    refs = [f"{ROOT}/assets/sprites/{k}.png" for k in ("worker", "lead-3", "performance-reviewer")]
    prompt = (f"Create ONE pixel-art sprite sheet image with {len(keys)} different girls in a single row, wide gaps between them, each full body, standing, same size, on a flat solid #FF00FF magenta background (no magenta inside the characters). "
              + P["style"].replace("fully transparent background", "flat magenta background") +
              " The attached images are style references only (three existing girls): match their pixel size, outline and shading, but draw four NEW, clearly different girls, bright and colourful. Characters left to right: " + " | ".join(lines)
              + f" Render large, about 2000 px wide, crisp pixel edges, no stray speckle, no dither. Save the final image as {out} in the current directory.")
else:
    refs = [f"{ROOT}/assets/sprites/{k}.png" for k in keys]
    prompt = (f"Create ONE pixel-art sprite sheet image. Same characters as the attached reference sprites (one reference image per character, in the same left-to-right order as listed below): identical face, hair, outfit, palette, outline and pixel size/scale. "
              "Draw each one SITTING on an invisible chair, seen from a diagonal-front 3/4 view (body turned toward the viewer, head turned slightly toward the right), hands resting forward on an unseen desk/keyboard, knees and legs visible only as a short seat-level silhouette cut off just below the hips/thighs. No chair, no desk, no shadow, no text, no props held except what is unavoidable. "
              f"One single row of {len(keys)} characters with wide gaps between them, each about the same size, on a flat solid #FF00FF magenta background; do not use magenta inside the characters. Characters left to right: " + " | ".join(lines)
              + f" Render large, about 2000 px wide, crisp pixel-art edges, no stray speckle. Save the final image as {out} in the current directory.")
cmd = [shutil.which("codex"), "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", WORK]
for r in refs:
    cmd += ["-i", r]
cmd += ["--", prompt]
t = time.time()
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=900)
sec = round(time.time() - t)
with open(LOG, "a") as f:
    f.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {mode} {i}{tag} {sec}s exit {r.returncode}\n")
print("exit", r.returncode, sec, "s", os.path.exists(f"{WORK}/{out}"))
print(r.stdout[-300:])
