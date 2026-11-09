"""整卷入库 · 图片视觉层（P1）。

真实样例是 Jupyter Notebook 屏幕翻拍：空位是**几何横线**而不是 ``____``
字符，答案文档可能用红色标答案。P0 只有 OCR 文本通道，识别不到这两类信息。

本模块只负责「像素 → 结构」，不碰数据库与 Web：

1. ``detect_horizontal_blanks``：自适应二值化 + 水平形态学开运算检出填空横线，
   再用「是否穿过文字主体 / 是否超长」排除表格线与页眉分隔线。
2. ``detect_red_regions``：HSV 双红区间 + 高斯/形态学抑制翻拍摩尔纹，
   聚合出红色片段的 bbox。
3. ``build_image_doc``：把 OCR 原始 box、横线、红区按 y 聚成行，生成 NormDoc。

坐标铁律：视觉检测与 OCR 必须跑在**同一张增强图**上（``ocr_engine.prepare_image``），
所有 bbox 都是页级像素，前端可按显示比例缩放叠加复核框。

为什么需要字符级映射：PaddleOCR 的文本检测框通常是「一整行一个 poly」，
没有词级 x 明细。仅靠「横线落在哪两个 box 之间」处理不了一行多空，
所以额外用字符宽度加权把横线 x 映射到文本内的字符位置。CJK/全角按 1.0、
拉丁按 0.55 估宽，够用于确定插入顺序；strict 模式后续会去空白比较，
近似误差不影响常量段匹配。

图片来源一律低置信度、强制人工复核（见 ``core.detect_blanks``），
颜色只作线索，绝不参与自动放行。
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any

from .model import BLANK_TOKEN, CodeLine, NormDoc, Token

#: OCR 有时会把填空横线本身识别成下划线字符，此时文本通道已覆盖，不再视觉插入
_OCR_BLANK_RE = re.compile(r"_{3,}|＿{2,}|─{3,}|—{3,}")
_BLANK_SPLIT = re.compile(r"(\[\[BLANK\]\])")
_WIDE_RE = re.compile(
    r"[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff"
    r"\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]"
)


# ---------------------------------------------------------------------------
# 依赖与图像转换
# ---------------------------------------------------------------------------
def cv2_available() -> bool:
    return _cv2() is not None


def _cv2() -> Any:
    try:
        import cv2  # PaddleOCR 依赖链里已带 opencv；缺失时整体降级，不静默失败
        return cv2
    except Exception:  # noqa: BLE001 - 导入失败即降级
        return None


def _bgr(image: Any) -> Any:
    import numpy as np

    cv2 = _cv2()
    rgb = np.asarray(image.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


# ---------------------------------------------------------------------------
# 几何横线检测
# ---------------------------------------------------------------------------
def detect_horizontal_blanks(image: Any, median_h: float = 20.0) -> list[dict[str, Any]]:
    """返回填空横线区域，按 (y, x) 排序。

    形态学水平核只保留「连续的水平笔画」，文字竖笔画被腐蚀掉；随后用
    宽/高比、绝对宽度、面积占比过滤噪点，超长线（页面分隔/表格边框）在
    ``_bar_belongs`` 里再按与文字行的关系排除一次。
    """
    cv2 = _cv2()
    if cv2 is None:
        return []
    bgr = _bgr(image)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # 屏幕翻拍的摩尔纹：先 3x3 高斯压掉高频条纹，再做自适应二值
    smooth = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(
        smooth, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 12,
    )
    mh = max(10.0, float(median_h or 20.0))
    kernel_w = max(16, int(mh * 1.6))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, 1))
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    horizontal = cv2.dilate(
        horizontal,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1)),
        iterations=1,
    )

    count, _, stats, _ = cv2.connectedComponentsWithStats(horizontal, 8)
    width_img = bgr.shape[1]
    min_w = max(24.0, mh * 1.5)
    max_w = width_img * 0.55
    max_h = max(4.0, mh * 0.32)
    regions: list[dict[str, Any]] = []
    for idx in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[idx])
        if w < min_w or w > max_w:
            continue
        if h > max_h or w / max(1, h) < 6:
            continue
        if area < w * 0.55:
            continue
        regions.append(
            {
                "bbox": (x, y, x + w, y + h),
                "cy": y + h / 2.0,
                "width": w,
                "height": h,
                "confidence": round(min(0.95, 0.6 + w / (min_w * 8)), 2),
            }
        )
    regions.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
    return regions


# ---------------------------------------------------------------------------
# HSV 红色分割
# ---------------------------------------------------------------------------
def detect_red_regions(image: Any, median_h: float = 20.0) -> list[dict[str, Any]]:
    """检出红色文字片段的 bbox（颜色只作线索，不参与自动放行）。"""
    cv2 = _cv2()
    if cv2 is None:
        return []
    bgr = _bgr(image)
    hsv = cv2.cvtColor(cv2.GaussianBlur(bgr, (3, 3), 0), cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    # 双红区间容忍翻拍偏橙(H≈10)与偏洋红(H≈172)；米色纸底 S 很低，不会误命中
    mask = (((hue <= 15) | (hue >= 165)) & (sat >= 70) & (val >= 50))
    mask = mask.astype("uint8") * 255
    # 同行相邻红字连成片段，再去掉孤立噪点
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (11, 3)),
    )
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 2)),
    )
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    mh = max(10.0, float(median_h or 20.0))
    regions: list[dict[str, Any]] = []
    for idx in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[idx])
        if w < 10 or h < 7 or area < 50:
            continue
        if h > mh * 3.2 or w / max(1, h) < 1.0:
            continue
        regions.append(
            {"bbox": (x, y, x + w, y + h), "cy": y + h / 2.0, "area": area}
        )
    return _merge_red_regions(regions, mh)


def _merge_red_regions(
    regions: list[dict[str, Any]], med: float
) -> list[dict[str, Any]]:
    """把同一行、x 间隙很小的红字连通域合成一个片段。

    印刷红字的字符间空隙会把一行答案切成若干个连通域；不合并的话，
    ``red_spans`` 会出现一堆碎片，既放大 color_evidence 也会制造噪声警告。
    """
    if not regions:
        return []
    ordered = sorted(
        regions,
        key=lambda item: (round(item["cy"] / max(1.0, med * 0.6)), item["bbox"][0]),
    )
    merged: list[dict[str, Any]] = []
    for region in ordered:
        x1, y1, x2, y2 = region["bbox"]
        if merged:
            last = merged[-1]
            lx1, ly1, lx2, ly2 = last["bbox"]
            if (
                abs(last["cy"] - region["cy"]) <= med * 0.5
                and x1 - lx2 <= med * 0.9
            ):
                last["bbox"] = (
                    min(lx1, x1), min(ly1, y1), max(lx2, x2), max(ly2, y2)
                )
                last["area"] += region["area"]
                continue
        merged.append(
            {"bbox": (x1, y1, x2, y2), "cy": region["cy"], "area": region["area"]}
        )
    merged.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
    return merged


# ---------------------------------------------------------------------------
# 行分组与字符级坐标
# ---------------------------------------------------------------------------
def group_boxes_into_lines(
    boxes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], float]:
    """按 y 把 OCR 原始 box 聚成行，保留行内每个 box 的 x 明细。"""
    heights = sorted(float(b["h"]) for b in boxes)
    med = heights[len(heights) // 2] if heights else 20.0
    groups: list[dict[str, Any]] = []
    for box in sorted(boxes, key=lambda item: (item["y1"], item["x1"])):
        target = None
        for group in groups:
            overlap = min(group["y2"], box["y2"]) - max(group["y1"], box["y1"])
            if overlap > 0.45 * min(group["h"], box["h"]) or abs(
                group["cy"] - box["cy"]
            ) < 0.5 * med:
                target = group
                break
        if target is None:
            groups.append(
                {
                    "boxes": [box],
                    "x1": box["x1"], "x2": box["x2"],
                    "y1": box["y1"], "y2": box["y2"],
                    "cy": box["cy"], "h": box["h"],
                }
            )
        else:
            target["boxes"].append(box)
            target["x1"] = min(target["x1"], box["x1"])
            target["x2"] = max(target["x2"], box["x2"])
            target["y1"] = min(target["y1"], box["y1"])
            target["y2"] = max(target["y2"], box["y2"])
            target["cy"] = (target["y1"] + target["y2"]) / 2
            target["h"] = max(target["h"], box["h"])
    for group in groups:
        group["boxes"].sort(key=lambda item: item["x1"])
    groups.sort(key=lambda group: group["y1"])
    return groups, med


def _char_offsets(text: str, x1: float, x2: float) -> list[float]:
    """估算每个字符边界的 x 像素位置（CJK 全角按 1.0，拉丁按 0.55 加权）。"""
    weights = [1.0 if _WIDE_RE.match(ch) else 0.55 for ch in text]
    total = sum(weights) or 1.0
    unit = (x2 - x1) / total
    offsets: list[float] = []
    cursor = 0.0
    for weight in weights:
        offsets.append(x1 + cursor * unit)
        cursor += weight
    offsets.append(x2)
    return offsets


def _index_at_x(text: str, box: dict[str, Any], px: float) -> int:
    offsets = _char_offsets(text, box["x1"], box["x2"])
    best, distance = 0, float("inf")
    for idx, offset in enumerate(offsets):
        delta = abs(offset - px)
        if delta < distance:
            best, distance = idx, delta
    return min(best, len(text))


def _text_in_x(text: str, box: dict[str, Any], x1: float, x2: float) -> str:
    """取落在 [x1, x2] 像素范围内的文本片段，用于把红区映射成 red_span。"""
    start = _index_at_x(text, box, x1)
    end = _index_at_x(text, box, x2)
    return text[start:end] if end > start else ""


def _bar_belongs(bar: dict[str, Any], group: dict[str, Any], med: float) -> bool:
    """横线是否属于这一文字行：落在基线附近，且不是穿过文字主体的表格线。"""
    x1, y1, x2, y2 = bar["bbox"]
    cy = (y1 + y2) / 2
    if not (group["y1"] + 0.25 * med <= cy <= group["y2"] + 0.95 * med):
        return False
    for box in group["boxes"]:
        inside_text = (
            y1 > box["y1"] + 0.15 * box["h"]
            and y2 < box["y2"] - 0.35 * box["h"]
        )
        if inside_text and x1 < box["x2"] and x2 > box["x1"]:
            return False
    return True


def _locate_bar(
    bar: dict[str, Any], row_boxes: list[dict[str, Any]], med: float
) -> tuple[int, int]:
    """决定横线插入到第几个 box 的第几个字符位置。"""
    x1, _, x2, _ = bar["bbox"]
    if not row_boxes:
        return 0, 0
    for idx, box in enumerate(row_boxes):
        if x2 <= box["x1"] + 0.15 * med:
            return idx, 0
        if x1 < box["x2"] and x2 > box["x1"]:
            if x1 >= box["x2"] - 0.25 * med:
                return idx, len(box["text"])
            return idx, _index_at_x(box["text"], box, x1)
    last = len(row_boxes) - 1
    return last, len(row_boxes[last]["text"])


def _apply_inserts(text: str, indices: list[int]) -> str:
    """在若干字符位置插入 BLANK_TOKEN，保留重复位置（一行多空）。"""
    out, cursor = "", 0
    for raw in sorted(indices):
        pos = max(cursor, min(raw, len(text)))
        out += text[cursor:pos] + BLANK_TOKEN
        cursor = pos
    return out + text[cursor:]


def _join_segments(segments: list[list[Any]]) -> str:
    out = ""
    for seg in segments:
        # blank 段是 3 元素 [text, style, bbox]，普通段多带一个 color，
        # 这里只取前两项，避免定长解包
        text, style = seg[0], seg[1]
        if not text:
            continue
        if not out:
            out = text
        elif text == BLANK_TOKEN or out.endswith(BLANK_TOKEN):
            out += text
        elif out[-1] in "([=,." or text[0] in ")]=,.":
            out += text
        else:
            out += " " + text
    return out


def _guess_kind(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("#"):
        return "comment"
    if not stripped:
        return "code"
    if re.search(r"[\u4e00-\u9fff]", stripped) and not re.search(
        r"[=()\[\]_.:]", stripped
    ):
        return "prose"
    return "code"


# ---------------------------------------------------------------------------
# 组装 NormDoc
# ---------------------------------------------------------------------------
def build_image_doc(
    boxes: list[dict[str, Any]],
    bars: list[dict[str, Any]],
    reds: list[dict[str, Any]],
    *,
    kind: str,
    doc_id: str,
    image_size: list[int],
    warnings: list[str],
) -> NormDoc:
    """把 OCR box + 几何横线 + 红区组装成统一 NormDoc。"""
    groups, med = group_boxes_into_lines(boxes)
    lines: list[CodeLine] = []
    red_spans: list[dict[str, Any]] = []

    for line_no, group in enumerate(groups, 1):
        row_boxes = group["boxes"]
        line_bbox = (
            int(group["x1"]), int(group["y1"]),
            int(group["x2"]), int(group["y2"]),
        )
        row_bars = [r for r in bars if _bar_belongs(r, group, med)]
        row_bars.sort(key=lambda item: item["bbox"][0])
        row_reds = [
            r for r in reds if abs(r["cy"] - group["cy"]) <= max(med * 0.9, 10)
        ]

        # OCR 已把横线识别成 ____ / —— 时不再重复插入，只借用 bbox 精化复核框
        normalized = [
            _OCR_BLANK_RE.sub(BLANK_TOKEN, box["text"]) for box in row_boxes
        ]
        ocr_has_blank = any(BLANK_TOKEN in text for text in normalized)
        insert_map: dict[int, list[int]] = {}
        if not ocr_has_blank:
            for bar in row_bars:
                box_idx, char_idx = _locate_bar(bar, row_boxes, med)
                insert_map.setdefault(box_idx, []).append(char_idx)
            # 多条横线挤在同一个文字间隙：通常是两空之间的 '(' / ',' 太短
            # 被 OCR 漏识了。模板依然保留全部空位（数量一致），但必须明确
            # 告诉复核页这一行为什么会对不上，不能让用户面对无声的冲突。
            clustered = Counter(
                (box_idx, char_idx)
                for box_idx, chars in insert_map.items()
                for char_idx in chars
            )
            squeezed = sum(count for count in clustered.values() if count >= 2)
            if squeezed:
                warnings.append(
                    f"第 {line_no} 行有 {squeezed} 条横线落在同一文字间隙，"
                    "OCR 可能漏识了空位之间的括号/逗号；该行模板需在复核页人工核对"
                )

        # 红区 → red_span（按 box 的 x 顺序拼接命中的文本片段）
        for red in row_reds:
            rx1, _, rx2, _ = red["bbox"]
            pieces = [
                _text_in_x(text, box, rx1, rx2)
                for text, box in zip(normalized, row_boxes)
                if rx1 < box["x2"] and rx2 > box["x1"]
            ]
            span_text = "".join(pieces).strip()
            if span_text:
                red_spans.append(
                    {
                        "text": span_text,
                        "page_no": 1,
                        "line_no": line_no,
                        "bbox": red["bbox"],
                        "confidence": 0.75,
                        "source": "hsv",
                    }
                )

        segments: list[list[Any]] = []
        for idx, (text, box) in enumerate(zip(normalized, row_boxes)):
            merged = _apply_inserts(text, insert_map.get(idx, []))
            red_here = any(
                red["bbox"][0] < box["x2"] and red["bbox"][2] > box["x1"]
                for red in row_reds
            )
            for part in _BLANK_SPLIT.split(merged):
                if not part:
                    continue
                if part == BLANK_TOKEN:
                    segments.append([part, "blank", None])
                else:
                    segments.append(
                        [
                            part,
                            "red" if red_here else "plain",
                            box["bbox"] if "bbox" in box else (
                                int(box["x1"]), int(box["y1"]),
                                int(box["x2"]), int(box["y2"]),
                            ),
                            "FF0000" if red_here else None,
                        ]
                    )
        # 视觉横线 bbox 按 x 顺序分给本行的空位 token（供前端精确叠加）
        blank_segments = [seg for seg in segments if seg[1] == "blank"]
        for seg, bar in zip(blank_segments, row_bars):
            seg[2] = bar["bbox"]

        tokens: list[Token] = []
        for seg in segments:
            text, style, bbox = seg[0], seg[1], seg[2]
            color = seg[3] if len(seg) > 3 else None
            tokens.append(Token(text=text, bbox=bbox, style=style, color=color))
        joined = _join_segments(segments).rstrip()
        lines.append(
            CodeLine(
                page_no=1,
                line_no=line_no,
                text=joined,
                tokens=tokens,
                bbox=line_bbox,
                indent=len(joined) - len(joined.lstrip()),
                kind=_guess_kind(joined),
            )
        )

    return NormDoc(
        doc_id=doc_id,
        kind=kind,
        source_type="image",
        pages=[lines],
        warnings=list(warnings),
        meta={
            "red_spans": red_spans,
            "image_size": list(image_size),
            "median_line_h": round(float(med), 1),
        },
    )


# ---------------------------------------------------------------------------
# 对外主入口
# ---------------------------------------------------------------------------
def analyse_image(path: str | Path, kind: str) -> NormDoc:
    """图片 → NormDoc：OCR 明细 box + 几何横线 + 红色分割。

    OCR 或 OpenCV 任一不可用时都明确写入 warnings 并降级，绝不静默把
    「没检测到空位」当成「试卷没有空位」。
    """
    target = Path(path)
    doc_id = f"{kind}-{target.stem}"
    try:
        import ocr_engine

        detail = ocr_engine.recognize_detail(target)
    except Exception as exc:  # noqa: BLE001 - OCR 引擎/模型不可用时降级
        return NormDoc(
            doc_id=doc_id, kind=kind, source_type="image", pages=[[]],
            warnings=[f"OCR 失败：{exc}；请在复核页手工粘贴试卷/答案文本"],
            meta={"red_spans": [], "visual": {"available": False}},
        )

    boxes = detail["boxes"]
    image = detail["image"]
    image_size = detail["image_size"]
    if not boxes:
        return NormDoc(
            doc_id=doc_id, kind=kind, source_type="image", pages=[[]],
            warnings=["图片未识别到文字，请提高清晰度或改用手工粘贴文本通道"],
            meta={"red_spans": [], "visual": {"available": False}},
        )

    warnings: list[str] = []
    if _cv2() is None:
        bars: list[dict[str, Any]] = []
        reds: list[dict[str, Any]] = []
        warnings.append(
            "未安装 OpenCV(cv2)：几何横线与红色分割已跳过，仅 OCR 文本通道可用；"
            "请在复核页手工补 ____"
        )
    else:
        _, med = group_boxes_into_lines(boxes)
        bars = detect_horizontal_blanks(image, med)
        reds = detect_red_regions(image, med) if kind == "answer" else []
        warnings.append(
            f"图片视觉通道：几何横线检出 {len(bars)} 处，空位一律标记待人工复核"
        )
        if kind == "answer":
            warnings.append(
                f"图片视觉通道：红色区域检出 {len(reds)} 处（颜色只作线索，不参与自动放行）"
            )
        if not bars and kind == "paper":
            warnings.append(
                "未检出几何横线；若试卷空位是 ____ 字符，OCR 文本通道可自动识别"
            )

    doc = build_image_doc(
        boxes, bars, reds,
        kind=kind, doc_id=doc_id, image_size=image_size, warnings=warnings,
    )
    doc.meta["visual"] = {
        "available": _cv2() is not None,
        "blank_regions": len(bars),
        "red_regions": len(reds),
        "ocr_boxes": len(boxes),
        "median_line_h": doc.meta.get("median_line_h"),
    }
    return doc
