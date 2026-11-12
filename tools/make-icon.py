"""Draws the Carbox Dash app icon (1024x1024, opaque, full-bleed: iOS rounds the corners itself).
Run: python tools/make-icon.py  ->  icons/icon-1024.png (+ 512, 180 for the web)."""
import math, os
import pygame

S = 2048                      # draw at 2x, scale down for clean edges
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # project root
pygame.init()
icon = pygame.Surface((S, S))

# graphite background with a soft centre light
for r in range(S // 2 * 3 // 2, 0, -8):
    t = r / (S * 0.75)
    c = int(10 + 18 * (1 - t) ** 2)
    pygame.draw.circle(icon, (c, c, c + 3), (S // 2, int(S * 0.54)), r)

def glow_layer(draw, color, width, blur):
    layer = pygame.Surface((S, S), pygame.SRCALPHA)
    draw(layer, color, width)
    small = pygame.transform.smoothscale(layer, (S // blur, S // blur))
    return pygame.transform.smoothscale(small, (S, S))

cx, cy, R = S // 2, int(S * 0.54), int(S * 0.36)
red = (255, 38, 62)
start, sweep = math.radians(135), math.radians(270)

def arc(surf, color, width, frac=1.0, r=R):
    """Arc as one filled ring polygon with round caps: no notches where segments meet."""
    n = 360
    outer = [(cx + math.cos(start + sweep * frac * k / n) * (r + width / 2), cy + math.sin(start + sweep * frac * k / n) * (r + width / 2)) for k in range(n + 1)]
    inner = [(cx + math.cos(start + sweep * frac * k / n) * (r - width / 2), cy + math.sin(start + sweep * frac * k / n) * (r - width / 2)) for k in range(n, -1, -1)]
    pygame.draw.polygon(surf, color, outer + inner)
    for a in (start, start + sweep * frac):
        pygame.draw.circle(surf, color, (int(cx + math.cos(a) * r), int(cy + math.sin(a) * r)), width // 2)

# dim full track, then the lit red sweep (to ~80%) with layered glow
arc(icon, (44, 44, 52), int(S * 0.05))
for blur, alpha in ((24, 255), (10, 200)):
    g = glow_layer(lambda s, c, w: arc(s, c, w, 0.8), red + (alpha,), int(S * 0.07), blur)
    icon.blit(g, (0, 0))
arc(icon, red, int(S * 0.05), 0.8)

# tick marks around the dial
for k in range(9):
    a = start + sweep * k / 8
    r1, r2 = R * 0.78, R * 0.88
    col = (255, 90, 100) if k >= 7 else (215, 220, 228)
    pygame.draw.line(icon, col, (cx + math.cos(a) * r1, cy + math.sin(a) * r1), (cx + math.cos(a) * r2, cy + math.sin(a) * r2), int(S * 0.012))

# needle pointing to the end of the sweep
a = start + sweep * 0.8
tip = (cx + math.cos(a) * R * 0.86, cy + math.sin(a) * R * 0.86)
needle = lambda s, c, w: pygame.draw.line(s, c, (cx, cy), tip, w)
icon.blit(glow_layer(needle, red + (255,), int(S * 0.04), 16), (0, 0))
pygame.draw.line(icon, (255, 235, 238), (cx, cy), tip, int(S * 0.016))
pygame.draw.circle(icon, (20, 20, 24), (cx, cy), int(S * 0.045))
pygame.draw.circle(icon, red, (cx, cy), int(S * 0.045), int(S * 0.008))

# the Z, in the app's display font, with a red bloom behind it
font = pygame.font.Font(os.path.join(here, "fonts", "Michroma-Regular.ttf"), int(S * 0.24))
z = font.render("Z", True, (250, 250, 252))
zr = z.get_rect(center=(cx, int(S * 0.735)))
bloom = pygame.Surface((S, S), pygame.SRCALPHA)
bloom.blit(font.render("Z", True, red), zr)
bloom = pygame.transform.smoothscale(pygame.transform.smoothscale(bloom, (S // 20, S // 20)), (S, S))
icon.blit(bloom, (0, 0)); icon.blit(bloom, (0, 0))
icon.blit(z, zr)

out = pygame.transform.smoothscale(icon, (1024, 1024))
os.makedirs(os.path.join(here, "icons"), exist_ok=True)
pygame.image.save(out, os.path.join(here, "icons", "icon-1024.png"))
for n in (512, 180):
    pygame.image.save(pygame.transform.smoothscale(out, (n, n)), os.path.join(here, "icons", f"icon-{n}.png"))
print("icons written")
