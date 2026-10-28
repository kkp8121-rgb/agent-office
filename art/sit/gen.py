"""Run one Codex sheet: python art/sit/gen.py <sheet index> (see prompts.json)."""
import shutil, json, os, subprocess, sys, time, datetime

ROOT = "C:/Users/gustj/agent-office"
WORK = "C:/Users/gustj/AppData/Local/Temp/claude/C--Project/6106276a-a6e5-4468-8650-198bebbf83af/scratchpad/layers/sit"
LOG = "C:/Users/gustj/AppData/Local/Temp/claude/C--Project/6106276a-a6e5-4468-8650-198bebbf83af/scratchpad/layers/codex-calls.log"
P = json.load(open(ROOT + "/art/sit/prompts.json", encoding="utf-8"))
i = int(sys.argv[1])
keys = P["sheets"][i]
extra = sys.argv[2] if len(sys.argv) > 2 else ""
out = f"sheet{i}{extra}.png"
lines = [f"{n + 1}. {k}: {P['roles'][k]}" for n, k in enumerate(keys)]
prompt = P["common"].format(n=len(keys), out=out) + " Characters left to right: " + " | ".join(lines) + (" Render the sheet large, about 2000 px wide, with crisp clean pixel-art edges, no stray speckle pixels, no dither noise." if extra else "")
cmd = [shutil.which("codex"), "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", WORK]
for k in keys:
    cmd += ["-i", f"{ROOT}/assets/sprites/{k}.png"]
cmd += ["--", prompt]
t = time.time()
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
sec = round(time.time() - t)
with open(LOG, "a") as f:
    f.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} sit sheet{i}{extra} {sec}\n")
print("exit", r.returncode, sec, "s", os.path.exists(f"{WORK}/{out}"))
print(r.stdout[-400:])
