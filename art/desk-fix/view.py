import sys
from PIL import Image
R={"studio2":{"desk":[0,90,83,54],"lead-desk":[340,0,104,56]},"lounge":{"desk":[257,0,92,73],"lead-desk":[113,0,108,78]},"library":{"desk":[79,0,83,57],"lead-desk":[163,0,106,55]},"greenhouse":{"desk":[355,0,83,55],"lead-desk":[250,0,104,60]}}
sel=[a.split(":") for a in sys.argv[2:]]
S=int(sys.argv[1]); rows=[]
for d,n in sel:
    x,y,w,h=R[d][n]; r=[]
    for src in ("art/desk-fix/orig/%s.png"%d,"assets/scenes/%s/objects.png"%d):
        try: im=Image.open(src).convert("RGBA")
        except: im=Image.open("assets/scenes/%s/objects.png"%d).convert("RGBA")
        c=im.crop((x,y,x+w,y+h)); bg=Image.new("RGBA",(w,h),(255,0,255,255)); bg.alpha_composite(c); r.append(bg.resize((w*S,h*S),0))
    rows.append(r)
W=max(sum(i.width for i in r)+10 for r in rows); H=sum(r[0].height+10 for r in rows)
sh=Image.new("RGB",(W,H),(40,40,40)); yy=0
for r in rows:
    xx=0
    for i in r: sh.paste(i,(xx,yy)); xx+=i.width+10
    yy+=r[0].height+10
sh.save("../desk/view.png")
