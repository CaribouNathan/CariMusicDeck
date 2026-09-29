# Génère les icônes du plugin (exécuté une fois ; les PNG sont versionnés).
from PIL import Image, ImageDraw, ImageFilter
import math, os, sys
OUT = sys.argv[1]
os.makedirs(f"{OUT}/imgs/plugin", exist_ok=True)
os.makedirs(f"{OUT}/imgs/actions/cover", exist_ok=True)

def disc(size, bg=(28,28,30,255), rounded=False):
    S = size*4
    im = Image.new("RGBA", (S,S), (0,0,0,0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0,0,S-1,S-1], radius=int(S*0.22), fill=bg)
    else:
        d.rectangle([0,0,S,S], fill=bg)
    c = S/2; R = S*0.40
    d.ellipse([c-R,c-R,c+R,c+R], fill=(10,10,11,255))
    # sillons
    for i in range(14):
        r = R*(0.40 + i*0.043)
        a = 22 if i%2 else 34
        d.ellipse([c-r,c-r,c+r,c+r], outline=(a,a,a+2,255), width=max(1,S//512))
    # reflet
    hl = Image.new("L", (S,S), 0); hd = ImageDraw.Draw(hl)
    hd.pieslice([c-R,c-R,c+R,c+R], 200, 250, fill=40)
    hd.pieslice([c-R,c-R,c+R,c+R], 20, 70, fill=28)
    hl = hl.filter(ImageFilter.GaussianBlur(S*0.02))
    white = Image.new("RGBA",(S,S),(255,255,255,255))
    mask = Image.new("L",(S,S),0); ImageDraw.Draw(mask).ellipse([c-R,c-R,c+R,c+R], fill=255)
    from PIL import ImageChops
    im.paste(white, (0,0), ImageChops.multiply(hl, mask))
    # étiquette dégradé orange → rose
    L = R*0.36
    lab = Image.new("RGBA",(S,S))
    ld = ImageDraw.Draw(lab)
    for y in range(int(c-L), int(c+L)+1):
        t = (y-(c-L))/(2*L)
        col = (int(255*(1-t)+255*t), int(159*(1-t)+45*t), int(10*(1-t)+85*t), 255)
        ld.line([(c-L,y),(c+L,y)], fill=col)
    lm = Image.new("L",(S,S),0); ImageDraw.Draw(lm).ellipse([c-L,c-L,c+L,c+L], fill=255)
    im.paste(lab,(0,0),lm)
    h = R*0.05
    d.ellipse([c-h,c-h,c+h,c+h], fill=bg if not rounded else (28,28,30,255))
    return im.resize((size,size), Image.LANCZOS)

def glyph(size):
    S = size*8
    im = Image.new("RGBA",(S,S),(0,0,0,0)); d = ImageDraw.Draw(im)
    c=S/2; R=S*0.44; w=int(S*0.085)
    d.ellipse([c-R,c-R,c+R,c+R], outline=(255,255,255,255), width=w)
    r=S*0.15
    d.ellipse([c-r,c-r,c+r,c+r], fill=(255,255,255,255))
    h=S*0.05
    d.ellipse([c-h,c-h,c+h,c+h], fill=(0,0,0,0))
    return im.resize((size,size), Image.LANCZOS)

disc(1024).convert("RGB").save(f"{OUT}/imgs/idle.png")
for n,s in (("key",72),("key@2x",144)):
    disc(s).save(f"{OUT}/imgs/actions/cover/{n}.png")
for n,s in (("marketplace",288),("marketplace@2x",576)):
    disc(s, rounded=True).save(f"{OUT}/imgs/plugin/{n}.png")
for n,s in (("category-icon",28),("category-icon@2x",56)):
    glyph(s).save(f"{OUT}/imgs/plugin/{n}.png")
for n,s in (("icon",20),("icon@2x",40)):
    glyph(s).save(f"{OUT}/imgs/actions/cover/{n}.png")
print("ok")
