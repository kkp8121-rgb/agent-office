"""Key, split and snap the raw sheets into assets/sprites/extra-NN.png / extra-NN-sit.png.
  python art/extras/build.py stand|sit [key ...]
Raw sheets: <work>/stand<i>.png or <work>/sit<i>.png (4 girls each, left to right)."""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.environ.get("AGENT_OFFICE_ART_WORK") or os.path.join(tempfile.gettempdir(), "agent-office-art", "extras")
KEYS = sorted(json.load(open(ROOT + "/art/prompts.json", encoding="utf-8"))["extras"])
mode = sys.argv[1]
only = set(sys.argv[2:])
for i in range(3):
    sheet = f"{WORK}/{mode}{i}.png"
    if not os.path.exists(sheet):
        continue
    out = f"{WORK}/p-{mode}{i}"
    r = subprocess.run(["python", ROOT + "/art/snap.py", "sheet", sheet, out, "--rows", "1"], capture_output=True, text=True)
    print(r.stdout.strip(), r.stderr.strip()[-200:])
    n = len([f for f in os.listdir(out) if f.startswith("piece-")]) if os.path.isdir(out) else 0
    if n != 4:
        print(f"sheet {mode}{i}: {n} pieces, skipped")
        continue
    for pi, k in enumerate(KEYS[i * 4:(i + 1) * 4]):
        if only and k not in only:
            continue
        dst = f"{ROOT}/assets/sprites/{k}{'-sit' if mode == 'sit' else ''}.png"
        subprocess.run(["python", ROOT + "/art/snap.py", "sprite", f"{out}/piece-{pi}.png", dst, "--height", "50" if mode == "sit" else "64", "--colors", "20"], check=True, capture_output=True)
        print("wrote", dst)
