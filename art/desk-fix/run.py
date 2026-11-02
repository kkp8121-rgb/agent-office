import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from fix import *
which = sys.argv[1:] or ["studio2", "library", "lounge"]
for d in which: restore(d)
if "studio2" in which:
    apply("studio2", (0, 90, 83, 54), [box(62, 32, 76, 51)])
if "library" in which:
    apply("library", (79, 0, 83, 57), [box(6, 33, 19, 50), box(63, 33, 76, 50)], mode='grain')
    apply("library", (163, 0, 106, 55), [box(8, 32, 25, 48), box(29, 31, 77, 36), box(83, 32, 99, 48)], mode='grain')
if "lounge" in which:
    face = {(x, y) for x in range(7, 20) for y in range(28 + max(0, (x - 13)//2), 42)}
    apply("lounge", (257, 0, 92, 73), [face], mode='grain', gkw=dict(lo=0.0, hi=1.0, run=(2, 5), ok=lambda c: c[0] > 0x90 and c[1]/c[0] < 0.55))
