"""Draw the four big pictures of the building cross-section view with Codex (README "Re-drawing the art").
  python art/building/gen.py roof|basement|exterior-day|exterior-night [tag]
Raw output goes to the work folder (AGENT_OFFICE_ART_WORK, outside the repo) as <key><tag>.png.
Then: python art/building/build.py (snaps the raw pictures and draws the small pieces).
exterior-night attaches the accepted exterior-day raw as its composition reference.
If Codex saved the file elsewhere, take it only from ~/.codex/generated_images/<the session id printed by THIS call>/."""
import datetime, glob, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
WORK = (os.environ.get("AGENT_OFFICE_ART_WORK") or os.path.join(REPO, "art", "building", "work")).replace("\\", "/")
LOG = WORK + "/codex-calls.log"
P = json.load(open(os.path.join(HERE, "prompts.json"), encoding="utf-8"))
key = sys.argv[1]
tag = sys.argv[2] if len(sys.argv) > 2 else ""
if key not in P or key == "style":
    sys.exit("unknown key " + key)
out = f"{key}{tag}.png"
os.makedirs(WORK, exist_ok=True)
refs = [REPO + "/art/floors/studio2.png"]
if key == "exterior-night":
    refs.append(f"{WORK}/exterior-day.png")
prompt = P["style"] + " " + P[key] + f" Render large (at least 1600 px on the long side), crisp pixel edges. Save the final image as {out} in the current directory."
cmd = [shutil.which("codex"), "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", WORK]
for r in refs:
    cmd += ["-i", r]
cmd += ["--", prompt]
t = time.time()
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=900)
sec = round(time.time() - t)
text = (r.stdout or "") + (r.stderr or "")
m = re.search(r"session id: ([0-9a-f-]{36})", text)
sid = m.group(1) if m else "?"
with open(LOG, "a") as f:
    f.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {key}{tag} {sec}s exit {r.returncode} session {sid}\n")
ok = os.path.exists(f"{WORK}/{out}")
if not ok and m:
    c = sorted(glob.glob(os.path.expanduser(f"~/.codex/generated_images/{sid}/*")), key=os.path.getmtime)
    if c:
        shutil.copy(c[-1], f"{WORK}/{out}")
        ok = True
print("exit", r.returncode, sec, "s", "session", sid, ok)
