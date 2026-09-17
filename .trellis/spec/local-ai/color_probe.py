"""复现 emulsion-desktop 现有主色算法 vs 改进算法，量化"暗部霸占色卡"问题。"""

import math
import os
import random
from collections import defaultdict
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))


# ─────────── 合成典型照片：小面积主体 + 大面积带噪声的暗背景 ───────────
# 真实照片的暗部不是单一颜色，而是连续渐变 + 传感器噪声，
# 在 4bit 分桶下会分裂成大量相邻桶 —— 这才是"暗部霸占色卡"的真正机理。

def _noisy_gradient(size, top, bottom, noise=10, seed=7):
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        base = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            n = rng.randint(-noise, noise)
            px[x, y] = tuple(max(0, min(255, c + n)) for c in base)
    return img


def _speckle(img, count, colors, radius=(2, 5), seed=11):
    rng = random.Random(seed)
    d = ImageDraw.Draw(img)
    w, h = img.size
    for _ in range(count):
        c = rng.choice(colors)
        r = rng.randint(*radius)
        x, y = rng.randint(0, w - 1), rng.randint(0, h - 1)
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)


def synth_night(size=200):
    """夜景城市：暗蓝渐变夜空 + 噪声 88%，窗户暖光 10%，橙色霓虹 2%"""
    img = _noisy_gradient(size, (4, 7, 14), (24, 36, 61), noise=9, seed=3)
    d = ImageDraw.Draw(img)
    for bx in range(20, 180, 26):
        for by in range(120, 190, 22):
            if (bx + by) % 3:
                d.rectangle([bx, by, bx + 12, by + 9], fill=(247, 202, 74))
    d.rectangle([60, 30, 140, 46], fill=(232, 129, 58))
    _speckle(img, 40, [(247, 202, 74), (232, 129, 58)], (1, 3), seed=5)
    return img, "夜景城市", [(247, 202, 74), (232, 129, 58)]


def synth_portrait(size=200):
    """暗调人像：暗棕渐变背景 + 噪声 78%，肤色 15%，红衣 7%"""
    img = _noisy_gradient(size, (22, 18, 16), (58, 48, 42), noise=11, seed=13)
    d = ImageDraw.Draw(img)
    d.ellipse([64, 38, 136, 112], fill=(214, 158, 128))
    _speckle(img, 300, [(214, 158, 128), (198, 142, 114)], (1, 2), seed=17)
    d.rectangle([70, 138, 130, 200], fill=(176, 55, 55))
    _speckle(img, 120, [(176, 55, 55), (158, 46, 46)], (1, 2), seed=19)
    return img, "暗调人像", [(214, 158, 128), (176, 55, 55)]


def synth_flower(size=200):
    """花卉微距：深浅不一暗绿叶 75%，红花 20%，黄花蕊 5%"""
    img = _noisy_gradient(size, (12, 30, 20), (34, 66, 46), noise=13, seed=23)
    _speckle(img, 900, [(20, 45, 30), (28, 58, 38), (16, 38, 26)], (2, 6), seed=29)
    d = ImageDraw.Draw(img)
    for cx, cy in ((62, 66), (132, 78), (98, 136)):
        d.ellipse([cx - 30, cy - 28, cx + 30, cy + 28], fill=(196, 38, 44))
    _speckle(img, 400, [(196, 38, 44), (178, 32, 38)], (1, 3), seed=31)
    d.ellipse([92, 94, 110, 112], fill=(244, 196, 80))
    return img, "暗叶红花", [(196, 38, 44), (244, 196, 80)]


def synth_offcenter(size=200):
    """偏心主体：暗背景 86%，亮青主体挤在左下角 —— 检验中心先验的边界"""
    img = _noisy_gradient(size, (10, 12, 16), (30, 34, 44), noise=10, seed=37)
    d = ImageDraw.Draw(img)
    d.ellipse([14, 128, 84, 192], fill=(64, 196, 208))
    _speckle(img, 260, [(64, 196, 208), (52, 178, 190)], (1, 3), seed=41)
    d.rectangle([150, 20, 190, 40], fill=(232, 96, 72))
    return img, "偏心主体", [(64, 196, 208), (232, 96, 72)]


# ─────────── 色彩空间 ───────────

def srgb_to_lab(r, g, b):
    def inv(u):
        u = u / 255.0
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    R, G, B = inv(r), inv(g), inv(b)
    X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047
    Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750)
    Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)
    fx, fy, fz = f(X), f(Y), f(Z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def chroma(lab):
    return math.hypot(lab[1], lab[2])


def delta_e76(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])


def hexof(rgb):
    return "#%02X%02X%02X" % rgb


# ─────────── 算法 A：现有实现（复现 media.go:601） ───────────

def current_algorithm(img, count=5):
    """严格复现 extractDominantColors：RGB 4bit 分桶，按像素数降序，无暗部过滤。"""
    px = img.convert("RGB")
    w, h = px.size
    step = 1
    while w // step > 200 or h // step > 200:
        step += 1
    buckets = defaultdict(lambda: [0, 0, 0, 0])
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px.getpixel((x, y))
            if r > 250 and g > 250 and b > 250:
                continue
            key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
            bucket = buckets[key]
            bucket[0] += 1
            bucket[1] += r
            bucket[2] += g
            bucket[3] += b
    rows = sorted(buckets.values(), key=lambda v: -v[0])[:count]
    return [(v[1] // v[0], v[2] // v[0], v[3] // v[0]) for v in rows]


# ─────────── 算法 B：改进版（零模型） ───────────

def improved_algorithm(img, count=5, dark_l=18, light_l=95,
                       min_chroma=8.0, center_bonus=1.6):
    """Lab 空间分桶 + 排除极暗/极亮/低饱和 + 中心先验加权 + ΔE 去重。"""
    px = img.convert("RGB")
    w, h = px.size
    step = 1
    while w // step > 200 or h // step > 200:
        step += 1
    cx, cy = w / 2.0, h / 2.0
    maxd = math.hypot(cx, cy)
    buckets = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])

    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px.getpixel((x, y))
            lab = srgb_to_lab(r, g, b)
            if lab[0] < dark_l or lab[0] > light_l:
                continue
            if chroma(lab) < min_chroma:
                continue
            dist = math.hypot(x - cx, y - cy) / maxd
            weight = (1.0 + center_bonus * (1.0 - dist)) * (0.25 + chroma(lab) / 60.0)
            key = (int(lab[0] // 8), int((lab[1] + 128) // 12), int((lab[2] + 128) // 12))
            bucket = buckets[key]
            bucket[0] += weight
            bucket[1] += r * weight
            bucket[2] += g * weight
            bucket[3] += b * weight

    ranked = sorted(buckets.values(), key=lambda v: -v[0])
    out = []
    for v in ranked:
        rgb = (int(v[1] / v[0]), int(v[2] / v[0]), int(v[3] / v[0]))
        lab = srgb_to_lab(*rgb)
        if any(delta_e76(lab, srgb_to_lab(*c)) < 12 for c in out):
            continue
        out.append(rgb)
        if len(out) >= count:
            break
    return out


# ─────────── 评估指标 ───────────

def score(colors, targets):
    """命中主题色的个数 + 暗色/灰色个数 + 重复对数"""
    hits = 0
    for t in targets:
        tl = srgb_to_lab(*t)
        if any(delta_e76(tl, srgb_to_lab(*c)) < 25 for c in colors):
            hits += 1
    dirty = 0
    for c in colors:
        lab = srgb_to_lab(*c)
        if lab[0] < 25 or chroma(lab) < 12:
            dirty += 1
    dup = 0
    for i in range(len(colors)):
        for j in range(i + 1, len(colors)):
            if delta_e76(srgb_to_lab(*colors[i]), srgb_to_lab(*colors[j])) < 12:
                dup += 1
    return hits, dirty, dup


# ─────────── 主流程 ───────────

def swatch(colors, cell=44):
    w = cell * max(1, len(colors))
    im = Image.new("RGB", (w, cell), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for i, c in enumerate(colors):
        d.rectangle([i * cell, 0, (i + 1) * cell, cell], fill=c)
    return im


def main():
    cases = [synth_night(), synth_portrait(), synth_flower(), synth_offcenter()]
    rows = []
    cards = []

    for img, name, targets in cases:
        a = current_algorithm(img)
        b = improved_algorithm(img)
        sa = score(a, targets)
        sb = score(b, targets)
        rows.append((name, [hexof(c) for c in targets],
                     [hexof(c) for c in a], sa,
                     [hexof(c) for c in b], sb))

        thumb = img.resize((120, 120))
        cell = 44
        strip = cell * 5
        card = Image.new("RGB", (120 + 10 + strip + 14 + strip, 120), (246, 246, 246))
        card.paste(thumb, (0, 0))
        card.paste(swatch(a, cell), (130, 38))
        card.paste(swatch(b, cell), (130 + strip + 14, 38))
        cards.append(card)

    pad = 30
    width = max(c.width for c in cards) + 24
    height = pad + sum(c.height + 14 for c in cards)
    sheet = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    d.text((130, 10), "CURRENT algorithm", fill=(150, 40, 40))
    d.text((130 + 5 * 44 + 14, 10), "IMPROVED algorithm", fill=(30, 110, 60))
    y = pad
    for c in cards:
        sheet.paste(c, (12, y))
        y += c.height + 14
    sheet = sheet.resize((int(sheet.width * 1.35), int(sheet.height * 1.35)))
    sheet.save(os.path.join(OUT, "swatch-compare.png"))

    total_targets = sum(len(r[1]) for r in rows)
    print("=" * 100)
    print("%-12s %-20s %-46s %s" % ("场景", "主题色(真值)", "现有算法", "命中/暗灰/重复对"))
    print("=" * 100)
    for name, targets, a, sa, b, sb in rows:
        print("%-12s %-20s %-46s %d/%d   %d    %d"
              % (name, ",".join(targets), " ".join(a), sa[0], len(targets), sa[1], sa[2]))
    print("-" * 100)
    print("%-12s %-20s %-46s %s" % ("", "改进算法", "", "命中/暗灰/重复对"))
    for name, targets, a, sa, b, sb in rows:
        print("%-12s %-20s %-46s %d/%d   %d    %d"
              % (name, "", " ".join(b), sb[0], len(targets), sb[1], sb[2]))
    print("=" * 100)
    ta = sum(r[3][0] for r in rows)
    tb = sum(r[5][0] for r in rows)
    da = sum(r[3][1] for r in rows)
    db = sum(r[5][1] for r in rows)
    ra = sum(r[3][2] for r in rows)
    rb = sum(r[5][2] for r in rows)
    print("主题色命中：现有 %d/%d (%.0f%%) → 改进 %d/%d (%.0f%%)"
          % (ta, total_targets, 100.0 * ta / total_targets,
             tb, total_targets, 100.0 * tb / total_targets))
    print("暗色/灰色占位：现有 %d/20 → 改进 %d/20" % (da, db))
    print("色卡内重复对：现有 %d 对 → 改进 %d 对" % (ra, rb))
    print("对比图已输出：swatch-compare.png")


if __name__ == "__main__":
    main()
