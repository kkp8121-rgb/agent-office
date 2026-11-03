"""Hand-drawn desk props for the decor layer (too small for imagegen). Used by art/decor/build.py.

Characters: '.' clear; every other key is a colour of PAL. Rows are padded with '.' on the right.
Only the body is drawn here; build.py adds a selective 1 px outline (a darker shade of the neighbouring colour,
or a white die-cut border for stickers), a light-from-the-left bevel and a soft contact shadow.
Each entry: id -> dict(slot, tags, rows, personal?, outline?, shade?)
"""

PAL = {
    "h": (255, 250, 235), "w": (240, 232, 214), "x": (205, 200, 188),
    "c": (244, 208, 146), "C": (221, 191, 124),
    "r": (203, 86, 72), "R": (146, 52, 52),
    "p": (236, 152, 150), "P": (196, 100, 112),
    "y": (246, 204, 84), "Y": (205, 152, 52),
    "n": (236, 142, 52), "N": (184, 96, 40),
    "g": (104, 138, 76), "G": (62, 92, 62), "l": (156, 184, 92),
    "b": (84, 128, 176), "B": (54, 84, 132), "u": (150, 196, 226),
    "v": (140, 108, 170), "V": (96, 70, 128), "q": (190, 150, 210),
    "t": (78, 160, 156), "T": (48, 112, 116),
    "k": (84, 92, 104), "K": (50, 56, 66),
    "s": (178, 184, 190), "S": (126, 132, 142),
    "m": (150, 108, 62), "M": (98, 66, 40), "d": (62, 40, 30),
    "e": (242, 200, 160), "E": (210, 160, 120),
    "z": (30, 24, 28), "a": (255, 236, 120),
}

ITEMS = {}


def _rows(rows):
    return rows if isinstance(rows, list) else [r for r in rows.split("\n") if r != ""]


def add(id_, slot, tags, rows, **kw):
    ITEMS[id_] = dict(slot=slot, tags=list(tags), rows=_rows(rows), **kw)


def sub(rows, **m):
    return [''.join(m.get(ch, ch) for ch in r) for r in _rows(rows)]


def sticker(id_, rows):
    add(id_, "bezel", ["sticker"], rows, outline="white", shade=False)


# ---------------------------------------------------------------- surface: figurines and toys
add("fig-bear", "surface", ["figure", "toy"], """
mm....mm
mmmmmmmm
mzmmmmzm
mmCCCCmm
.mCzzCm.
..mmmm..
.mmmmmm.
mmmCCmmm
mmmCCmmm
.mm..mm.""")
add("fig-cat", "surface", ["figure", "toy"], """
n....n..
nn..nn..
nnnnnn..
nznnzn..
nnnpnn..
.nnnnn..
.nnnnnn.
.nnnnnnn
.nn.nn.n""")
add("fig-bunny", "surface", ["figure", "toy"], """
ww...ww
wp...pw
wp...pw
wwwwwww
wzwwwzw
wwwpwww
.wwwww.
.wwwww.
wwwwwww
wwwwwww
.ww.ww.""")
add("fig-penguin", "surface", ["figure", "toy"], """
..KKK..
.KKKKK.
.KwKwK.
.KKyKK.
KKwwwKK
KKwwwKK
KKwwwKK
.KwwwK.
.KKKKK.
.yy.yy.""")
add("fig-dino", "surface", ["figure", "toy"], """
.ggg......
gzggg.y.y.
gggggggggg
.ggggggggg
.ggggggggg
..ggggggg.
..gg..gg..
..gg..gg..""")
add("fig-owl", "surface", ["figure", "toy"], """
m.....m
mmmmmmm
wzwmwzw
mmmymmm
mmcccmm
mcCcCcm
mmcccmm
.mmmmm.
.y...y.""")
add("fig-fox", "surface", ["figure", "toy"], """
n.....n.
nn...nn.
nnnnnnn.
nznnnzn.
wnnnnnw.
wwnzNww.
.wwwww..
.nnnnnnn
.nn.nn.nw""")
add("fig-frog", "surface", ["figure", "toy"], """
.gg..gg.
gwzggzwg
gggggggg
ggrrrrgg
.gllllg.
.g.gg.g.""")
add("fig-ghost", "surface", ["figure", "toy"], """
..www..
.wwwww.
wwwwwww
wzwwwzw
wwwzwww
wwwwwww
wwwwwww
wwwwwww
w.ww.ww""")
add("fig-astronaut", "surface", ["figure", "toy"], """
..sss..
.swwws.
swbbbws
swbbbws
.swwws.
..www..
.wwrww.
wwwwwww
w.www.w
..w.w..""")
add("toy-robot", "surface", ["figure", "toy", "tech"], """
...y...
...S...
.sssss.
.sbsbs.
.sssss.
..SSS..
ssrsrss
s.sss.s
s.sss.s
..s.s..
.kk.kk.""")
add("fig-bobblehead", "surface", ["figure", "toy", "personal"], """
.ddddd.
deeeeed
ezeeeze
eeeEeee
eeezzee
.eeeee.
...S...
...s...
..bbb..
.bbbbb.
..d.d..""")
add("plush-heart", "surface", ["toy", "plush"], """
.rr..rr.
rrrrrrrr
rzrrrrzr
rprrrrpr
.rrrrrr.
..rrrr..
...rr...""")
add("rubber-duck", "surface", ["toy", "figure"], """
..yyy....
.yyyyy...
.yzyyy...
nnyyyy.y.
.yyyyyyyy
.yyyyyyyy
..yyyyyy.
...yyyy..""")
add("lucky-cat", "surface", ["figure", "personal", "charm"], """
w.....w.
wwwwwww.
wzwwwzww
wwwpwwww
.rrrrrw.
.wyyywww
.wyyyw..
wwwwwww.
wwwwwww.
.ww.ww..""")
add("toy-rocket", "surface", ["toy", "figure"], """
..r..
.rrr.
.rwr.
.www.
.wbw.
.www.
rwwwr
rrwrr
.n.n.""")
add("toy-blocks", "surface", ["toy"], """
..yyyy..
..ywwy..
..yyyy..
bbbbgggg
bwwbgwwg
bbbbgggg""")
add("rubik-cube", "surface", ["toy"], """
rrzyyzbb
rrzyyzbb
zzzzzzzz
yyzbbzgg
yyzbbzgg
zzzzzzzz
nnzggzrr
nnzggzrr""", shade=False)
add("dice-red", "surface", ["toy"], """
rrrrrrr
rwrrrwr
rrrrrrr
rrrwrrr
rrrrrrr
rwrrrwr
rrrrrrr""")
add("game-controller", "surface", ["tech", "toy"], """
.KKKKKKKK.
KKKwKKKrKK
KKwwwKyKbK
KKKwKKKgKK
KKKKKKKKKK
.KK....KK.""")

# ---------------------------------------------------------------- surface: plants
add("plant-cactus", "surface", ["plant"], """
...p...
..ggg..
..glg..
g.ggg..
g.ggg.g
ggggg.g
.gggggg
..ggg..
.nnnnn.
.nNnNn.
..nnn..""")
add("plant-succulent", "surface", ["plant"], """
.l.ll.l.
.lgllgl.
lgllllgl
.llggll.
..tttt..
..tTTt..
...tt...""")
add("plant-tulips", "surface", ["plant"], """
.r...y.
rrr.yyy
.r.g.y.
..ggg..
...g...
.bbbbb.
.bBbBb.
..bbb..""")
add("plant-bonsai", "surface", ["plant"], """
..gggg.gg.
.gggggggggg
gggGgggGgg
.gggggggg.
..gg.mgg..
.....m....
....mm....
.ssssssss.
.bbbbbbbb.
..b....b..""")
add("plant-sprout", "surface", ["plant"], """
.l.l.
lglgl
.ggg.
..g..
wwwww
wwwww
.www.""")

# ---------------------------------------------------------------- surface: mugs, cups, drinks
_MUG = """
.ddddd...
.######..
.#####.#.
.#####.#.
.######..
..####..."""
for _id, _c in (("mug-red", "r"), ("mug-blue", "b"), ("mug-green", "g"), ("mug-white", "w"), ("mug-yellow", "y"), ("mug-teal", "t"), ("mug-violet", "v")):
    add(_id, "surface", ["mug"], sub(_MUG, **{"#": _c}))
add("teacup", "surface", ["mug"], """
.mmmmm...
.wwwwww..
.wwwww.w.
..www.w..
sssssssss
.sssssss.""")
_TAKEOUT = """
.KKKK.
KKKKKK
.wwww.
.wwww.
.rrrr.
.rrrr.
.wwww.
..ww.."""
add("cup-takeout", "surface", ["mug", "food"], _TAKEOUT)
add("cup-takeout-green", "surface", ["mug", "food"], sub(_TAKEOUT, r="g"))
add("drink-iced", "surface", ["mug", "food"], """
....r.
...r..
.wwww.
.nnnn.
.nnnn.
.nnnn.
..nn..""")
add("pen-cup", "surface", ["note", "tech"], """
.r.b.y.
.r.b.y.
.r.b.y.
ttttttt
ttttttt
ttttttt
.ttttt.""")
_CANDLE = """
..n..
.nyn.
.nyn.
..d..
ppppp
pwwwp
ppppp
ppppp"""
add("candle-pink", "surface", ["food", "charm"], _CANDLE)
add("candle-teal", "surface", ["food", "charm"], sub(_CANDLE, p="t"))

# ---------------------------------------------------------------- surface: books, paper, stationery
add("book-stack-a", "surface", ["book"], """
.rrrrrrrr.
.rRRRRRRr.
bbbbbbbbbb
bBBBBBBBBb
.gggggggg.
.gGGGGGGg.""")
add("book-stack-b", "surface", ["book"], """
..vvvvvv.
..vVVVVv.
.yyyyyyyy
.yYYYYYYY
..tttttt.
..tTTTTt.
nnnnnnnnn
nNNNNNNNN""")
add("photo-frame", "surface", ["note", "personal"], """
mmmmmmm
muuyuum
muuuuum
mgggggm
mgGgggm
mmmmmmm""")
add("photo-frame-pair", "surface", ["note", "personal"], """
ccccccccc
cppcbbcbc
cpecbeeeb
cppcbbbcb
ccccccccc""")
add("desk-calendar", "surface", ["note"], """
.S.S.S.
rrrrrrr
wwwwwww
wzwzwzw
wwwwwww
wzwzwzw
wwwwwww""")
_PAD = """
yyyyyy
yYYyyy
yyyyyy
YYYYYY
YYYYYY"""
add("sticky-pad-yellow", "surface", ["note"], _PAD)
add("sticky-pad-pink", "surface", ["note"], sub(_PAD, y="p", Y="P"))
add("sticky-pad-blue", "surface", ["note"], sub(_PAD, y="u", Y="b"))
add("stapler", "surface", ["note"], """
.rrrrrrr
rrrrrrrr
KKKKKKKK
KKKKKKKK""")
add("alarm-clock", "surface", ["tech"], """
.rr..rr.
..rrrr..
.rrrrrr.
rrwwwwrr
rwwzwwwr
rwwzzwwr
rrwwwwrr
.rrrrrr.
.r....r.""")

# ---------------------------------------------------------------- surface: tech, decor
add("trophy-small", "surface", ["personal"], """
.yyyy.
y.yy.y
yyyyyy
.yyyy.
..yy..
..yy..
.mmmm.
mmmmmm""")
add("globe-desk", "surface", ["personal"], """
..bbbb..
.bgbbbb.
bggbbgbb
bbgbbggb
.bbbggb.
..bbbb..
..mm....
...mm...
.mmmmmm.""")
add("fan-desk", "surface", ["tech"], """
..bbbbb..
.buubuub.
.bubbbub.
.bbbSbbb.
.bubbbub.
.buubuub.
..bbbbb..
....S....
..sssss..""")
add("headphones", "surface", ["tech", "personal"], """
..KKKKKK..
.KK....KK.
KK......KK
rrr....rrr
rrr....rrr
.r......r.""")
add("snack-chips", "surface", ["food"], """
yYyYyYy
yyyyyyy
yrrrrry
yrwwwry
yrrrrry
yyyyyyy
yYyyyYy""")
add("cookie-jar", "surface", ["food"], """
..MMM..
.MMMMM.
.xxxxx.
xnMnnMx
xnnnMnx
xMnnnnx
xnnMnnx
.xxxxx.""")
_LAMP = """
..rrrr..
.rrrrrr.
rrrrrrrr
...S....
...S....
...S....
.SSSSSS."""
add("lamp-red", "surface", ["tech"], _LAMP)
add("lamp-green", "surface", ["tech"], sub(_LAMP, r="G"))
add("aquarium", "surface", ["tech", "figure"], """
SSSSSSSSSS
SuuuuuuuuS
SuuunnuuuS
SuugnnuguS
SugguuuugS
SCCCCCCCCS
SSSSSSSSSS""")
add("fishbowl", "surface", ["figure"], """
.uuuuuu.
uwuuuuuu
uuunuuuu
uunnnuuu
uuuunuuu
uuuuuuuu
.uCCCCu.
..SSSS..""")
add("hourglass", "surface", ["personal"], """
mmmmmm
.CCCC.
..CC..
...C..
..CC..
.CCCC.
mmmmmm""")
add("speaker", "surface", ["tech"], """
KKKKKKK
KsSsSsK
KSsSsSK
KsSsSsK
KSsSsSK
KKKbKKK""")

# ---------------------------------------------------------------- monitor top
add("top-cat", "monitorTop", ["figure", "toy"], """
n.n......
nnnnn....
nznzn....
nnnnnnnnn
nnnnnnnnN
.nnnnnnn.""")
add("top-alien", "monitorTop", ["figure", "toy"], """
..ggg..
.ggggg.
gzzgzzg
ggggggg
.ggggg.
..g.g..
..g.g..""")
add("top-bear", "monitorTop", ["figure", "toy"], """
mm..mm
mmmmmm
mzmmzm
mmCCmm
.mmmm.
.mmmm.""")
add("top-plant", "monitorTop", ["plant"], """
.l.l.
lglgl
.ggg.
nnnnn
nNnNn
.nnn.""")
add("top-duck", "monitorTop", ["figure", "toy"], """
.yyy..
yyzyy.
nnyyyyy
.yyyyyy
..yyyy.""")
add("top-ghost", "monitorTop", ["figure", "toy"], """
.www.
wwwww
wzwzw
wwwww
wwwww
w.w.w""")
add("webcam", "monitorTop", ["tech"], """
.KKKK.
KKbbKK
KKbuKK
.KKKK.
..SS..""")

# ---------------------------------------------------------------- bezel stickers (white die-cut border)
sticker("sticker-star", """
..y..
.yyy.
yyyyy
.yyy.
.y.y.""")
sticker("sticker-heart", """
.r.r.
rrrrr
rrrrr
.rrr.
..r..""")
sticker("sticker-cat", """
n....n
nn..nn
nnnnnn
nznnzn
.nnnn.""")
sticker("sticker-bolt", """
..yyy
.yyy.
yyyyy
..yy.
.yy..
.y...""")
sticker("sticker-smile", """
.yyyy.
yzyyzy
yyyyyy
yzyyzy
.yzzy.""")
sticker("sticker-moon", """
.yyy.
yy...
yy...
yy...
.yyy.""")
sticker("sticker-flower", """
.ppp.
ppypp
ppypp
.ppp.
..g..""")
sticker("sticker-rainbow", """
..rrr..
.ryyyr.
rybbbyr
rb...br""")
sticker("sticker-mushroom", """
.rrr.
rwrwr
rrrrr
.www.
.www.""")
sticker("sticker-sparkle", """
..u..
..u..
uuwuu
..u..
..u..""")
sticker("sticker-skull", """
.www.
wzwzw
wwwww
.www.
.w.w.""")

# ---------------------------------------------------------------- monitor edge: sticky notes
_NOTE = """
yyyyyy
yYYYYy
yyyyyy
yYYyyy
yyyyyy
yyyyyy"""
add("note-yellow", "monitorEdge", ["note"], _NOTE, shade=False)
add("note-pink", "monitorEdge", ["note"], sub(_NOTE, y="p", Y="P"), shade=False)
add("note-blue", "monitorEdge", ["note"], sub(_NOTE, y="u", Y="b"), shade=False)
add("note-green", "monitorEdge", ["note"], sub(_NOTE, y="l", Y="g"), shade=False)

# ---------------------------------------------------------------- personal: one per role sprite key
add("p-scout", "surface", ["personal"], """
.SSSS...
SuuuuS..
SuwuuS..
SuuuuS..
.SSSSm..
.....mm.
......mm
.......m""", personal="scout")
add("p-worker-low", "surface", ["personal"], """
.wwwwww.
wwwzzwww
wwzwwzww
wwzzzzww
wwzwwzww
wSSSSSSw
SSSSSSSS""", personal="worker-low")
add("p-worker", "surface", ["personal"], """
.KKK.
.sss.
sbbbs
sbwbs
sbbbs
sbbbs
sbbbs
sbbbs
.bbb.""", personal="worker")
add("p-worker-high", "surface", ["personal"], """
..SSSSSS..
..S....S..
rrrrrrrrrr
rRRRRRRRRr
rrryyyyrrr
rrrrrrrrrr
RRRRRRRRRR""", personal="worker-high")
add("p-architect", "surface", ["personal"], """
.bbbbbbb.
bcbbbbbbb
bcwbwbwbb
bcbbbbbbb
.bbbbbbb.""", personal="architect")
add("p-architect-high", "surface", ["personal"], """
u.......
uu......
uwu.....
uwwu....
uwwwu...
uwwwwu..
uuuuuuuu""", personal="architect-high")
add("p-explore", "surface", ["personal"], """
...YY...
..YYYY..
.YwwwrY.
YwwwrwwY
YwwzzwwY
YwzwwwwY
.YzwwwY.
..YYYY..""", personal="explore")
add("p-plan", "surface", ["personal"], """
dgggggg
dgwwwwg
dgwxxwg
dgwwwwg
dgggggg
dgggrgg
dgggrgg
dgggggg""", personal="plan")
add("p-code-critic", "surface", ["personal"], """
......SK
.....rrK
....rrr.
...rrr..
..rrr...
.rrr....
.zr.....
z.......""", personal="code-critic")
add("p-security-reviewer", "surface", ["personal"], """
..SSS..
.S...S.
.S...S.
yyyyyyy
yyyzyyy
yyyzyyy
yyyyyyy""", personal="security-reviewer")
add("p-performance-reviewer", "surface", ["personal"], """
...ss...
...ss...
.SSSSSS.
SwwwwrwS
SwwwrwwS
SwwrwwwS
SwwwwwwS
.SSSSSS.""", personal="performance-reviewer")
add("p-i18n-reviewer", "surface", ["personal"], """
mrrr.mbbb
mwww.mywy
mrrr.mbbb
m....m...
m....m...
m....m...
SSSSSSSSS""", personal="i18n-reviewer")
add("p-a11y-reviewer", "surface", ["personal"], """
..SSSS..
..bbbb..
.bbwwbb.
bbbwwbbb
bwwwwwwb
bbbwwbbb
bbwbbwbb
.bbbbbb.""", personal="a11y-reviewer")
add("p-frontend", "surface", ["personal"], """
..ccccc..
.cryccbc.
ccccccccc
cgcczcccp
.ccccccc.
..cc.cc..""", personal="frontend")
add("p-backend", "surface", ["personal"], """
KKKKKKKK
KsssssgK
KKKKKKKK
KsssssyK
KKKKKKKK
KsssssrK
KKKKKKKK""", personal="backend")
add("p-app", "surface", ["personal"], """
KKKKK
KuuuK
KuruK
KuuuK
KubuK
KuuuK
KuuuK
KKwKK""", personal="app")
add("p-default", "surface", ["personal"], """
.SSSS.
mSSSSm
mwwwwm
mwzzwm
mwwwwm
mwzzwm
mwwwwm
mmmmmm""", personal="default")

# ---------------------------------------------------------------- lead desks
add("lead-nameplate", "surface", ["lead"], """
.yyyyyyy.
yYYyYYyYy
yyyyyyyyy
MMMMMMMMM""")
add("lead-vase", "surface", ["lead", "plant"], """
.p.w.p.
pppwppp
.ppypp.
..gg...
..bbb..
.bbBbb.
.bbbbb.
..bbb..""")
def _trophies():
    gold = ["..yyyy", "y.yy.y", "yyyyyy", ".yyyy.", "..yy..", "..yy..", "mmmmmm"]
    silver = [None, None, "sssss", ".sss.", "..s..", "..s..", "mmmmm"]
    bronze = [None, None, None, "NNNNN", ".NNN.", "..N..", "mmmmm"]
    gold[0] = ".yyyy."
    rows = []
    for i in range(7):
        rows.append(gold[i] + (silver[i] or "....."[:5]) + (bronze[i] or "....."[:5]))
    return rows


add("lead-trophies", "surface", ["lead", "personal"], _trophies())
add("lead-bell", "surface", ["lead"], """
..yy..
.yyyy.
yyyyyy
yyyyyy
SSSSSS""")
add("lead-reports", "surface", ["lead", "book"], """
.wwwwwwww
wwwwwwwww
wxwxwxwxw
wwwwwwwww
.SS......
wwwwwwwww
wxwxwxwxw
wwwwwwwww""")
add("lead-fountain-pen", "surface", ["lead"], """
..K...
..Y...
.KKK..
.KyK..
.KKK..
.KKK..
SSSSSS
SKKKKS""")
