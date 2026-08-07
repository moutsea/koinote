#!/usr/bin/env python3
"""从原始水墨图生成站内 logo 与 favicon。

留着这个脚本而不是只提交产物：以后要换尺寸、调密度或换一张原图，
不必重新推导那几个阈值 —— 它们都是量出来的，不是试出来的，见下面注释。

用法：python3 scripts/build_logo.py <原图.png>
原图要求：宣纸底 + 墨色笔触，四角是干净的纸面（用来采样纸色）。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

# 纸面基准。取自原图四角与左侧空白区的采样：
#   纸色 (246,238,225)，亮度中位数 239，最暗处 222（纸纹）
PAPER = (246, 238, 225)
PAPER_LUM = 239.0
# 纸纹最深处对应 alpha≈0.07，取 0.10 作底噪门槛
ALPHA_FLOOR = 0.10
# 纸面自身的暖色偏移最大 25，朱砂最高 165 —— 28 这条线把两者分开
PAPER_CHROMA = 28
CINNABAR_CHROMA = 165

lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def cutout(src: Path) -> Image.Image:
    """抠掉纸底，还原笔触自身的颜色与半透明。"""
    im = Image.open(src).convert("RGB")
    w, h = im.size
    px = im.load()
    out = Image.new("RGBA", (w, h))
    op = out.load()

    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            a = (PAPER_LUM - lum((r, g, b))) / PAPER_LUM
            chroma = max(r, g, b) - min(r, g, b)
            if chroma > PAPER_CHROMA:
                # 朱砂在亮度上并不深，只按亮度算 alpha 会让它变半透明、
                # 混上纸色后洗成脏粉色。有彩度的像素改按彩度定 alpha。
                a = max(a, (chroma - PAPER_CHROMA) / (CINNABAR_CHROMA - PAPER_CHROMA))
            if a < ALPHA_FLOOR:
                op[x, y] = (0, 0, 0, 0)
                continue
            a = min(1.0, a)
            # 反预乘：从「笔触叠在纸上」的观察值还原笔触本身的颜色
            op[x, y] = (
                *(min(255, max(0, round((c - PAPER[i] * (1 - a)) / a))) for i, c in enumerate((r, g, b))),
                round(a * 255),
            )

    bbox = out.getbbox()
    crop = out.crop(bbox)
    cw, ch = crop.size
    side = int(max(cw, ch) * 1.06)  # 只留一点呼吸位，小尺寸下不浪费像素
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(crop, ((side - cw) // 2, (side - ch) // 2), crop)
    return sq


def reverse(mark: Image.Image) -> Image.Image:
    """深色模式用：墨反白，朱砂原样留着。

    不用 CSS filter:invert()，那会把朱砂一起翻成青色。
    alpha 完全不动，所以笔锋和飞白一模一样。
    """
    w, h = mark.size
    px = mark.load()
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                op[x, y] = (0, 0, 0, 0)
            elif max(r, g, b) - min(r, g, b) > 40:
                op[x, y] = (r, g, b, a)  # 朱砂在深底上本来就读得清
            else:
                v = 255 - int(lum((r, g, b)))
                # 偏暖的宣纸白，对齐 .dark 里的 --ink-black #ece6d6
                op[x, y] = (min(255, v + 8), min(255, int(v * 0.97) + 6), min(255, int(v * 0.86) + 2), a)
    return out


def densify(mark: Image.Image, size: int, gamma: float) -> Image.Image:
    """缩小后补回墨色密度。

    笔丝很细，缩到 30px 上下时重采样会把它和纸面平均掉，alpha 整体变淡 ——
    看着像褪了色的一道钩，认不出是鱼尾。对 alpha 做 gamma 提升压实。
    只动 alpha，色相不漂。
    """
    m = mark.resize((size, size), Image.LANCZOS)
    r, g, b, a = m.split()
    a = a.point(lambda v: min(255, int(255 * ((v / 255) ** gamma))))
    return Image.merge("RGBA", (r, g, b, a))


def plate(mark: Image.Image, size: int, bg, gamma: float) -> Image.Image:
    """favicon：圆角底板 + 笔触。"""
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(c).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=bg)
    inner = int(size * 0.84)
    m = densify(mark, inner, gamma)
    off = (size - inner) // 2
    c.paste(m, (off, off), m)
    return c


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path("public")
    mark = cutout(Path(sys.argv[1]))
    rev = reverse(mark)

    # 站内：透明底，跟随主题。最大用途是登录页 56px，128 够 2x
    densify(mark, 128, 0.62).save(out / "logo.png", optimize=True)
    densify(rev, 128, 0.62).save(out / "logo-dark.png", optimize=True)

    # favicon：焦墨底 + 反白笔触。透明底的淡墨在深色标签栏上会消失，
    # 深底两种标签栏都立得住，不必做两套
    ink = (31, 35, 40, 255)
    plate(rev, 192, ink, 0.5).save(out / "favicon.png", optimize=True)
    plate(rev, 180, ink, 0.5).save(out / "apple-touch-icon.png", optimize=True)
    print("wrote logo.png logo-dark.png favicon.png apple-touch-icon.png")


if __name__ == "__main__":
    main()
