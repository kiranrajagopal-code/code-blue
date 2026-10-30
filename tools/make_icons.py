"""Builds the app icon (all Android sizes + adaptive layer) and launch screens into android-res/.
Run: python3 tools/make_icons.py"""
from PIL import Image, ImageDraw, ImageFont
import os, glob
S = 2048; RED = (215, 38, 61); BG = (6, 11, 24); W = (255, 255, 255, 255); CUT = (0, 0, 0, 0)

def pictogram():
    """Rescuer kneeling at the patient's side, facing the viewer, straight arms locked on the chest."""
    im = Image.new('RGBA', (S, S), CUT); d = ImageDraw.Draw(im)
    def line(p, q, w, fill=W):
        d.line([p, q], fill=fill, width=w)
        for c in (p, q): d.ellipse([c[0]-w/2, c[1]-w/2, c[0]+w/2, c[1]+w/2], fill=fill)
    # ground
    d.rounded_rectangle([250, 1560, 1800, 1610], radius=25, fill=W)
    # patient lying on back, head to the left
    d.ellipse([330-125, 1400-125, 330+125, 1400+125], fill=W)
    d.rounded_rectangle([480, 1335, 1780, 1470], radius=68, fill=W)
    cx = 820                                   # chest level of the patient
    # rescuer torso (behind the patient), shoulders over the chest
    d.polygon([(cx-190, 800), (cx+190, 800), (cx+120, 1335), (cx-120, 1335)], fill=W)
    d.rounded_rectangle([cx-200, 760, cx+200, 880], radius=60, fill=W)
    # head
    d.ellipse([cx-135, 470, cx+135, 740], fill=W)
    # arms: straight, from shoulders converging to the hands; red gap separates them from the torso
    for side in (-1, 1):
        sh = (cx + side*235, 830); hand = (cx + side*45, 1290)
        line(sh, hand, 150, fill=CUT)          # cut-out outline
    d.polygon([(cx-190, 800), (cx+190, 800), (cx+120, 1335), (cx-120, 1335)], fill=W)
    # re-cut the gaps between arms and torso
    for side in (-1, 1):
        sh = (cx + side*235, 830); hand = (cx + side*45, 1290)
        line(sh, hand, 150, fill=CUT)
    for side in (-1, 1):
        sh = (cx + side*235, 830); hand = (cx + side*45, 1290)
        line(sh, hand, 100)
    d.ellipse([cx-135, 470, cx+135, 740], fill=W)
    # stacked hands on the chest
    d.rounded_rectangle([cx-120, 1250, cx+120, 1345], radius=45, fill=W)
    # compression arrows on both sides
    for x in (cx-430, cx+430):
        d.rounded_rectangle([x-20, 930, x+20, 1110], radius=20, fill=W)
        d.polygon([(x-64, 1100), (x+64, 1100), (x, 1200)], fill=W)
    return im.crop(im.getbbox())

art = pictogram()

# ---- premium finish ----
from PIL import ImageFilter, ImageChops
def finish(a):
    """White pictogram with a faint cool sheen and a soft drop shadow for depth."""
    w, h = a.size; pad = int(max(w, h) * 0.08)
    out = Image.new('RGBA', (w + 2*pad, h + 2*pad), CUT)
    alpha = a.split()[3]
    sh = Image.new('RGBA', a.size, (70, 0, 18, 0)); sh.putalpha(alpha.point(lambda v: int(v * 0.35)))
    shl = Image.new('RGBA', out.size, CUT); shl.alpha_composite(sh, (pad, pad + int(h * 0.035)))
    shl = shl.filter(ImageFilter.GaussianBlur(max(w, h) * 0.025))
    sheen = Image.new('RGBA', a.size); px = []
    top, bot = (255, 255, 255), (236, 241, 255)
    grad = Image.linear_gradient('L').resize(a.size)
    sheen = Image.composite(Image.new('RGBA', a.size, bot + (255,)), Image.new('RGBA', a.size, top + (255,)), grad)
    sheen.putalpha(alpha)
    out.alpha_composite(shl); out.alpha_composite(sheen, (pad, pad))
    return out
art = finish(art)

def tile(n, shape='square'):
    """Deep crimson gradient with a soft light from top-left and a gentle vignette."""
    gy = Image.linear_gradient('L'); gx = gy.rotate(90)
    g = ImageChops.add(gy, gx.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_TOP_BOTTOM), scale=2).resize((n, n), Image.BICUBIC)
    c1 = Image.new('RGBA', (n, n), (244, 64, 88, 255)); c2 = Image.new('RGBA', (n, n), (156, 14, 42, 255))
    bg = Image.composite(c2, c1, g)
    glow = Image.radial_gradient('L').resize((int(n*1.6), int(n*1.6)))
    glow = glow.point(lambda v: int(max(0, 255 - v) * 0.16))
    gl = Image.new('RGBA', glow.size, (255, 255, 255, 0)); gl.putalpha(glow)
    bg.alpha_composite(gl, (-int(n*0.55), -int(n*0.6)))
    if shape == 'full': return bg
    m = Image.new('L', (n, n), 0); d = ImageDraw.Draw(m)
    if shape == 'round': d.ellipse([0, 0, n-1, n-1], fill=255)
    else: d.rounded_rectangle([0, 0, n-1, n-1], radius=int(n*0.22), fill=255)
    o = Image.new('RGBA', (n, n), CUT); o.paste(bg, (0, 0), m); return o

def place(canvas, frac, yoff=0.0):
    n = canvas.size[0]; sc = frac*n/max(art.size)
    a = art.resize((max(1, int(art.size[0]*sc)), max(1, int(art.size[1]*sc))), Image.LANCZOS)
    canvas.alpha_composite(a, ((n-a.size[0])//2, (n-a.size[1])//2 + int(yoff*n))); return canvas

R = 'android-res'
for k, m in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    os.makedirs(f'{R}/mipmap-{k}', exist_ok=True)
    n = int(108*m); place(Image.new('RGBA', (n, n), CUT), 0.62, 0.0).save(f'{R}/mipmap-{k}/ic_launcher_foreground.png')
    tile(n, 'full').convert('RGB').save(f'{R}/mipmap-{k}/ic_launcher_background.png')
    n = int(48*m)
    sq = tile(n, 'square')
    place(sq, 0.82, 0.0).save(f'{R}/mipmap-{k}/ic_launcher.png')
    rd = tile(n, 'round')
    place(rd, 0.72, 0.0).save(f'{R}/mipmap-{k}/ic_launcher_round.png')

# launch screens (sizes match Capacitor's template)
SPL = {'drawable': (480, 320), 'drawable-land-hdpi': (800, 480), 'drawable-land-mdpi': (480, 320), 'drawable-land-xhdpi': (1280, 720),
       'drawable-land-xxhdpi': (1600, 960), 'drawable-land-xxxhdpi': (1920, 1280), 'drawable-port-hdpi': (480, 800), 'drawable-port-mdpi': (320, 480),
       'drawable-port-xhdpi': (720, 1280), 'drawable-port-xxhdpi': (960, 1600), 'drawable-port-xxxhdpi': (1280, 1920)}
icon = Image.open(f'{R}/mipmap-xxxhdpi/ic_launcher.png').convert('RGBA')
B = 'www/fonts/bsc-700.woff2'; Rg = 'www/fonts/barlow-500.woff2'
for folder, (w, h) in SPL.items():
    u = min(w, h); im = Image.new('RGBA', (w, h), BG+(255,)); d = ImageDraw.Draw(im)
    isz = int(u*0.34); top = int(h*0.5 - isz*0.85)
    im.alpha_composite(icon.resize((isz, isz), Image.LANCZOS), ((w-isz)//2, top))
    d.text((w/2, top+isz+int(u*0.06)), 'Code Blue', font=ImageFont.truetype(B, int(u*0.085)), fill=(255, 255, 255), anchor='mt')
    d.text((w/2, h-int(u*0.17)), 'Developed by', font=ImageFont.truetype(Rg, int(u*0.042)), fill=(138, 152, 170), anchor='mt')
    d.text((w/2, h-int(u*0.11)), 'Dr. Kiran Rajagopal', font=ImageFont.truetype(B, int(u*0.05)), fill=(255, 255, 255), anchor='mt')
    os.makedirs(f'{R}/{folder}', exist_ok=True); im.convert('RGB').save(f'{R}/{folder}/splash.png')

# also keep a 1024 px master icon
place(tile(1024, 'full'), 0.80).convert('RGB').save('assets/icon-only.png')
# web / iPhone icons (iOS rounds the corners itself, so these are full-bleed and opaque)
os.makedirs('www/icons', exist_ok=True)
for name, n, frac in (('apple-touch-icon.png', 180, 0.74), ('icon-192.png', 192, 0.74), ('icon-512.png', 512, 0.74), ('icon-maskable-512.png', 512, 0.58)):
    place(tile(n, 'full'), frac + 0.06).convert('RGB').save('www/icons/' + name)
print('icons + splash written')
