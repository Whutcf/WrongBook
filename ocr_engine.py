"""Offline OCR engine (PaddleOCR 3.x / PP-OCRv5·v6) and line reconstruction.

The engine runs fully offline on the local CPU. Recognition uses the official
PaddleOCR 3.x pipeline (PP-OCRv5 / PP-OCRv6), which returns structured results
that we re-shape into the same reading-order line list the rest of the app
already consumes.
"""
from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageOps

import db as _db

# PaddlePaddle 3.3.x ships a OneDNN/PIR bug that either crashes CPU inference
# (NotImplementedError: ConvertPirAttribute2RuntimeAttribute) or silently yields
# empty output when MKLDNN is disabled. The community-confirmed fix is to pin
# paddlepaddle==3.2.2 (see requirements.txt); on that build MKLDNN works and is
# the fast path. Keep it enabled unless you have verified a different Paddle
# build regresses.
_ENABLE_MKLDNN = True

# PP-OCRv5 mobile tier: on a local CPU it is ~40x faster than the server tier
# (sub-second vs ~20s) with indistinguishable accuracy on printed/screenshot
# text, which is the dominant input for this app. The model auto-downloads on
# first use and is cached under ~/.paddlex.
_TEXT_DET_MODEL = "PP-OCRv5_mobile_det"
_TEXT_REC_MODEL = "PP-OCRv5_mobile_rec"

_ENGINE_NAME = "PaddleOCR 3.x · PP-OCRv5"
_engine = None
_engine_lock = threading.Lock()
_infer_lock = threading.Lock()
_ocr_corrections = (
    ("娄据", "数据"),
    ("数处据", "数据"),
    ("数捃", "数据"),
    ("数椐", "数据"),
    ("存储据", "存储数据"),
    ("分析据", "分析数据"),
    ("清洗据", "清洗数据"),
    ("展示据", "展示数据"),
    ("王要", "主要"),
    ("正碗", "正确"),
    ("数居", "数据"),
)


# Cache for user-curated corrections loaded from the database. We refresh it on
# every add/delete (via refresh_corrections) and also expire it after a short
# TTL so a long-running server still picks up manual DB edits eventually.
_DB_CORRECTIONS_CACHE: list[tuple[str, str]] | None = None
_DB_CORRECTIONS_AT = 0.0
_DB_CACHE_TTL = 30.0


def _load_db_corrections() -> list[tuple[str, str]]:
    global _DB_CORRECTIONS_CACHE, _DB_CORRECTIONS_AT
    now_ts = time.time()
    if _DB_CORRECTIONS_CACHE is not None and (now_ts - _DB_CORRECTIONS_AT) < _DB_CACHE_TTL:
        return _DB_CORRECTIONS_CACHE
    try:
        pairs = _db.get_correction_pairs()
    except Exception:
        pairs = []
    _DB_CORRECTIONS_CACHE = pairs
    _DB_CORRECTIONS_AT = now_ts
    return pairs


def refresh_corrections() -> None:
    """Force the next correction lookup to re-read the database."""
    global _DB_CORRECTIONS_CACHE, _DB_CORRECTIONS_AT
    _DB_CORRECTIONS_CACHE = None
    _DB_CORRECTIONS_AT = 0.0


def _correct(text: str) -> str:
    for wrong, right in _ocr_corrections:
        if wrong:
            text = text.replace(wrong, right)
    for wrong, right in _load_db_corrections():
        if wrong:
            text = text.replace(wrong, right)
    return text


def engine_status() -> dict[str, Any]:
    try:
        import paddleocr  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on local runtime
        return {
            "available": False,
            "loaded": _engine is not None,
            "name": _ENGINE_NAME,
            "message": f"OCR 组件未安装：{exc}",
        }
    return {
        "available": True,
        "loaded": _engine is not None,
        "name": _ENGINE_NAME,
        "message": "离线识别，图片不会上传到任何服务器",
    }


def _load_engine():
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            from paddleocr import PaddleOCR

            _engine = PaddleOCR(
                use_doc_orientation_classify=False,
                use_textline_orientation=False,
                use_doc_unwarping=False,
                enable_mkldnn=_ENABLE_MKLDNN,
                text_detection_model_name=_TEXT_DET_MODEL,
                text_recognition_model_name=_TEXT_REC_MODEL,
            )
    return _engine


def _prepare_image(path: str | Path) -> Image.Image:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    if width < 1800:
        scale = min(3.0, max(1.0, 1800 / max(width, 1)))
        if scale > 1.02:
            image = image.resize(
                (int(width * scale), int(height * scale)), Image.Resampling.LANCZOS
            )
    image = ImageEnhance.Contrast(image).enhance(1.05)
    if max(image.size) > 3600:
        ratio = 3600 / max(image.size)
        image = image.resize(
            (int(image.width * ratio), int(image.height * ratio)),
            Image.Resampling.LANCZOS,
        )
    return image


def _as_points(box: Any) -> list[list[float]]:
    """Normalize a polygon (numpy array or nested list) to [[x, y], ...]."""
    if box is None:
        return []
    try:
        import numpy as np

        arr = np.asarray(box, dtype=float)
    except Exception:
        return []
    if arr.size == 0:
        return []
    if arr.ndim == 1:
        arr = arr.reshape(-1, 2)
    if arr.ndim == 2 and arr.shape[1] >= 2:
        return arr[:, :2].tolist()
    return []


def _normalize_result(raw: Any) -> list[Any]:
    """Convert a PaddleOCR 3.x result page into [box, text, score] entries."""
    entries: list[Any] = []
    if not raw:
        return entries
    page = raw[0] if isinstance(raw, list) and len(raw) > 0 else raw

    # PaddleOCR 3.x object with attribute access (OCRResult / dataclass).
    texts = getattr(page, "rec_texts", None)
    scores = getattr(page, "rec_scores", None)
    polys = getattr(page, "rec_polys", None) or getattr(page, "dt_polys", None)

    if isinstance(page, dict):
        tl = (
            page.get("text_lines")
            or page.get("overall_ocr_res", {}).get("text_lines")
            or []
        )
        if tl:
            for ln in tl:
                if isinstance(ln, dict):
                    entries.append(
                        [
                            _as_points(ln.get("bbox")),
                            ln.get("text", ""),
                            float(ln.get("score", 0.0)),
                        ]
                    )
                else:
                    entries.append(ln)
            return entries
        texts = page.get("rec_texts")
        scores = page.get("rec_scores")
        polys = page.get("rec_polys") or page.get("dt_polys")

    if texts is None and isinstance(page, (list, tuple)):
        # Legacy PaddleOCR 2.x list format: [ [box, (text, score)], ... ]
        for entry in page:
            if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                box = entry[0]
                if isinstance(entry[1], (list, tuple)) and len(entry[1]) >= 2:
                    text = str(entry[1][0])
                    score = float(entry[1][1])
                else:
                    text = str(entry[1])
                    score = float(entry[2]) if len(entry) > 2 else 0.0
                entries.append([_as_points(box), text, score])
            else:
                entries.append(entry)
        return entries

    texts = list(texts or [])
    polys = list(polys or [])
    scores = list(scores or [])
    for i, text in enumerate(texts):
        box = polys[i] if i < len(polys) else None
        score = scores[i] if i < len(scores) else 0.0
        entries.append([_as_points(box), str(text), float(score)])
    return entries


def _join_text(left: str, right: str) -> str:
    left, right = left.strip(), right.strip()
    if not left:
        return right
    if not right:
        return left
    if left[-1] in "，。；：、？！）】》」" or right[0] in "，。；：、？！）】》」":
        return left + right
    if left[-1] in "（【《「" or right[0] in "（【《「":
        return left + right
    if _is_cjk(left[-1]) and _is_cjk(right[0]):
        return left + right
    if left[-1].isdigit() and right[0].isdigit():
        return left + " " + right
    return left + " " + right


def _is_cjk(char: str) -> bool:
    return "\u4e00" <= char <= "\u9fff"


def _group_lines(result: list[Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for entry in result:
        if len(entry) < 2:
            continue
        box, text = entry[0], str(entry[1]).strip()
        if not text:
            continue
        score = float(entry[2]) if len(entry) > 2 else 0.0
        if not isinstance(box, (list, tuple)) or len(box) == 0:
            continue
        try:
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
        except Exception:
            continue
        x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
        items.append(
            {
                "text": _correct(text),
                "score": score,
                "x1": x1,
                "x2": x2,
                "y1": y1,
                "y2": y2,
                "cy": (y1 + y2) / 2,
                "h": max(1.0, y2 - y1),
            }
        )

    items.sort(key=lambda item: (item["y1"], item["x1"]))
    groups: list[dict[str, Any]] = []
    for item in items:
        target = None
        for group in groups:
            overlap = min(group["y2"], item["y2"]) - max(group["y1"], item["y1"])
            min_height = max(1.0, min(group["h"], item["h"]))
            cy_close = abs(group["cy"] - item["cy"]) < min_height * 0.55
            if overlap > min_height * 0.55 or cy_close:
                target = group
                break
        if target is None:
            groups.append(
                {
                    "items": [item],
                    "x1": item["x1"],
                    "x2": item["x2"],
                    "y1": item["y1"],
                    "y2": item["y2"],
                    "cy": item["cy"],
                    "h": item["h"],
                }
            )
        else:
            target["items"].append(item)
            target["x1"] = min(target["x1"], item["x1"])
            target["x2"] = max(target["x2"], item["x2"])
            target["y1"] = min(target["y1"], item["y1"])
            target["y2"] = max(target["y2"], item["y2"])
            target["cy"] = (target["y1"] + target["y2"]) / 2
            target["h"] = max(target["h"], item["h"])

    groups.sort(key=lambda group: (group["y1"], group["x1"]))
    lines: list[dict[str, Any]] = []
    for group in groups:
        parts = sorted(group["items"], key=lambda item: item["x1"])
        text = ""
        for part in parts:
            text = _join_text(text, part["text"])
        text = text.strip()
        if not text:
            continue
        lines.append(
            {
                "text": text,
                "score": round(
                    sum(part["score"] for part in parts) / max(1, len(parts)), 3
                ),
                "x": round(group["x1"]),
                "y": round(group["y1"]),
                "width": round(group["x2"] - group["x1"]),
                "height": round(group["y2"] - group["y1"]),
            }
        )
    return lines


def prepare_image(path: str | Path) -> Image.Image:
    """公开入口：返回 OCR 实际使用的那张增强图。

    codepaper 的视觉层（几何横线 / HSV 红色分割）必须跑在**同一张图**上，
    否则检测出的像素坐标与 OCR box 坐标不在同一坐标系，无法插入空位。
    """
    return _prepare_image(path)


def _infer(image: Image.Image) -> list[Any]:
    """把增强图送进 PaddleOCR，返回未合并的 [poly, text, score] 列表。"""
    try:
        engine = _load_engine()
    except Exception as exc:
        raise RuntimeError(f"OCR 引擎初始化失败：{exc}") from exc

    # 临时 PNG 放在 data/tmp，不要落在图片所在目录——否则 uploads/ 里会多出
    # tmpXXXX.png，被「已上传图片」列表当成用户上传的图片显示出来。
    tmp_dir = _db.DATA_DIR / "tmp"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        tmp_dir = None
    fd, tmp_path = tempfile.mkstemp(
        suffix=".png", dir=str(tmp_dir) if tmp_dir else None
    )
    try:
        os.close(fd)
        image.save(tmp_path, "PNG")
        with _infer_lock:
            raw = engine.ocr(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    return _normalize_result(raw)


def _entries_to_boxes(result: list[Any]) -> list[dict[str, Any]]:
    """把 OCR 原始条目转成带像素坐标的 box，**不按行合并**。

    ``_group_lines`` 会把同一行的多个 box 拼成一条文本，行内 x 明细随之
    丢失；整卷入库需要知道每个几何横线落在哪两个 token 之间，所以这里
    单独保留每个 box 的 x1/x2。
    """
    boxes: list[dict[str, Any]] = []
    for entry in result:
        if len(entry) < 2:
            continue
        poly, text = entry[0], str(entry[1]).strip()
        if not text or not isinstance(poly, (list, tuple)) or len(poly) == 0:
            continue
        try:
            xs = [float(point[0]) for point in poly]
            ys = [float(point[1]) for point in poly]
        except Exception:  # noqa: BLE001 - 畸形 box 直接跳过
            continue
        x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
        if x2 <= x1 or y2 <= y1:
            continue
        boxes.append(
            {
                "text": _correct(text),
                "score": float(entry[2]) if len(entry) > 2 else 0.0,
                "x1": x1, "x2": x2, "y1": y1, "y2": y2,
                "cy": (y1 + y2) / 2,
                "h": max(1.0, y2 - y1),
            }
        )
    boxes.sort(key=lambda item: (item["y1"], item["x1"]))
    return boxes


def recognize_detail(path: str | Path) -> dict[str, Any]:
    """整卷入库专用：返回原始 OCR box + 增强图，坐标与视觉检测共用。

    不改动 ``recognize()`` 的任何行为，主链路（图片识题）完全不受影响。
    返回的 ``image`` 是进程内 PIL 对象，仅供视觉层读取，不参与 JSON 序列化。
    """
    started = time.time()
    image = prepare_image(path)
    boxes = _entries_to_boxes(_infer(image) or [])
    return {
        "boxes": boxes,
        "image": image,
        "image_size": list(image.size),
        "elapsed": round(time.time() - started, 2),
        "engine": _ENGINE_NAME,
    }


def recognize(path: str | Path) -> dict[str, Any]:
    """Run OCR and return reconstructed reading-order lines."""
    started = time.time()
    image = _prepare_image(path)
    result = _infer(image)
    lines = _group_lines(result or [])
    raw_text = "\n".join(line["text"] for line in lines)
    return {
        "lines": lines,
        "raw_text": raw_text,
        "line_count": len(lines),
        "elapsed": round(time.time() - started, 2),
        "engine": _ENGINE_NAME,
        "image_size": list(image.size),
    }
