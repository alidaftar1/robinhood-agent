#!/usr/bin/env python3
"""Build the LinkedIn carousel (5 portrait slides + a swipeable PDF) from the
architecture diagram + dashboard + risk-panel screenshots. Dark theme to match."""
import os
from PIL import Image, ImageDraw, ImageFont

ASSETS = "/Users/ali/Desktop/linkedin-assets"
OUT = os.path.join(ASSETS, "carousel")
os.makedirs(OUT, exist_ok=True)

W, H = 1080, 1350
BG = (13, 13, 13)
WHITE = (240, 240, 240)
MUTE = (150, 150, 150)
DIM = (95, 95, 95)
GREEN = (125, 186, 125)
AMBER = (212, 163, 90)
MARGIN = 72
CW = W - 2 * MARGIN
LANCZOS = Image.Resampling.LANCZOS

HELV = "/System/Library/Fonts/Helvetica.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"

def F(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()

f_big      = F(HELV, 62, 1)   # bold
f_title    = F(HELV, 44, 1)
f_eyebrow  = F(MENLO, 23, 0)
f_cap      = F(MENLO, 25, 0)
f_cap_b    = F(MENLO, 25, 1)
f_body     = F(MENLO, 29, 0)
f_foot     = F(MENLO, 21, 0)

def wrap(d, text, fnt, max_w):
    out, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out

def block(d, text, fnt, x, y, max_w, fill, lh):
    for line in wrap(d, text, fnt, max_w):
        d.text((x, y), line, font=fnt, fill=fill)
        y += lh
    return y

def footer(d, idx, total):
    d.text((MARGIN, H - 56), "robinhood-agent", font=f_foot, fill=DIM)
    s = f"{idx}/{total}"
    d.text((W - MARGIN - d.textlength(s, font=f_foot), H - 56), s, font=f_foot, fill=DIM)

def paste_fit(canvas, path, box):
    bx, by, bw, bh = box
    im = Image.open(path).convert("RGBA")
    s = min(bw / im.width, bh / im.height)
    nw, nh = int(im.width * s), int(im.height * s)
    im = im.resize((nw, nh), LANCZOS)
    px, py = bx + (bw - nw) // 2, by + (bh - nh) // 2
    canvas.paste(im, (px, py), im)

def slide():
    img = Image.new("RGB", (W, H), BG)
    return img, ImageDraw.Draw(img)

S = []

# 1 — COVER
img, d = slide()
d.text((MARGIN, 150), "BUILDING IN PUBLIC", font=f_eyebrow, fill=GREEN)
y = block(d, "I let an AI trade a real Robinhood account.", f_big, MARGIN, 224, CW, WHITE, 74)
y = block(d, "Here's what I shipped — and what it taught me about where AI actually belongs.", f_cap, MARGIN, y + 28, CW, MUTE, 40)
d.text((MARGIN, H - 150), "swipe →", font=f_cap_b, fill=GREEN)
footer(d, 1, 5); S.append(img)

# 2 — ARCHITECTURE
img, d = slide()
d.text((MARGIN, 92), "THE SYSTEM", font=f_eyebrow, fill=DIM)
block(d, "Autonomous, self-monitoring, self-healing", f_title, MARGIN, 128, CW, WHITE, 52)
paste_fit(img, os.path.join(ASSETS, "robinhood-agent-architecture@2x.png"), (MARGIN, 240, CW, 770))
block(d, "Daily rebalance across two sleeves, then a two-layer oversight system checks its own work every morning.", f_cap, MARGIN, 1040, CW, MUTE, 38)
footer(d, 2, 5); S.append(img)

# 3 — DASHBOARD
img, d = slide()
d.text((MARGIN, 92), "IS IT ACTUALLY WORKING?", font=f_eyebrow, fill=DIM)
block(d, "It just edged ahead of the S&P", f_title, MARGIN, 128, CW, WHITE, 52)
paste_fit(img, os.path.join(ASSETS, "Dashboard Summary.png"), (MARGIN, 230, CW, 760))
y = block(d, "+1.18% ahead of the market in the first two weeks —", f_cap, MARGIN, 1028, CW, GREEN, 38)
block(d, "not by big wins, but by losing less when the market pulled back.", f_cap, MARGIN, y, CW, MUTE, 38)
footer(d, 3, 5); S.append(img)

# 4 — RISK PANEL
img, d = slide()
d.text((MARGIN, 92), "MEASURE RISK, NOT RETURNS", font=f_eyebrow, fill=DIM)
block(d, "The panel a commenter pushed me to build", f_title, MARGIN, 128, CW, WHITE, 52)
paste_fit(img, os.path.join(ASSETS, "Risk Panel.png"), (MARGIN, 300, CW, 540))
block(d, "Beta (it swings less than the market), sector mix, cash drag, drawdown. The panel showed I'm quietly low-beta — it cushions drops: −1.03% worst fall vs the market's −2.63%.", f_cap, MARGIN, 895, CW, MUTE, 38)
footer(d, 4, 5); S.append(img)

# 5 — LESSON
img, d = slide()
d.text((MARGIN, 150), "THE LESSON", font=f_eyebrow, fill=AMBER)
y = block(d, "Deterministic vs. LLM", f_big, MARGIN, 220, CW, WHITE, 74)
y = block(d, "The LLM “reviewer” kept hallucinating problems that weren’t there.", f_body, MARGIN, y + 36, CW, MUTE, 44)
y = block(d, "The boring deterministic checks caught the one bug that actually cost money.", f_body, MARGIN, y + 22, CW, MUTE, 44)
block(d, "Use LLMs for judgment — never as your source of truth.", f_body, MARGIN, y + 44, CW, GREEN, 44)
d.text((MARGIN, H - 150), "Full writeup in the post.  What would you build next?", font=f_cap, fill=DIM)
footer(d, 5, 5); S.append(img)

for i, s in enumerate(S, 1):
    s.save(os.path.join(OUT, f"slide-{i}.png"))
S[0].save(os.path.join(OUT, "carousel.pdf"), save_all=True, append_images=S[1:], resolution=150.0)
print("wrote", len(S), "slides + carousel.pdf to", OUT)
