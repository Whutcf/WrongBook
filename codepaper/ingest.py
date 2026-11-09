"""格式解析层：docx / PDF / 图片 / 纯文本 → 统一 ``NormDoc``。

优先级原则：结构化格式（Word 的 ``w:u`` 下划线 run、PDF 文本层与 span 颜色）
可精确提取，完全不走 OCR；只有图片/扫描件才降级到 OCR + 几何检测。

图片路径由 ``vision`` 提供 P1 能力：OCR 明细 box（保留行内 x）+ 几何横线
检测 + HSV 红色分割；OCR / OpenCV 缺失时明确写入 warnings 并降级到
手工粘贴通道，绝不静默把「没检测到空位」当成「试卷没有空位」。
"""
from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .model import BLANK_TOKEN, CodeLine, NormDoc, Token

BLANK_CHARS_RE = re.compile(r"_{3,}|＿{2,}")
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_TEXT_EXTS = {".txt", ".py", ".md", ".csv"}

#: 整本答案 PDF 里的「试卷分段标题」识别正则：命中即在它之前切出一套答案区段。
#: 覆盖常见中文（第N套 / 试卷N / 练习N）、英文（Assignment/Task/Part/Q/Question N）
#: 以及整行答案标记（参考答案 / 答案 / 标准答案）。
_SECTION_RE = re.compile(
    r"^(第\s*[一二三四五六七八九十\d]+\s*(?:套|部分|章|节|题)"
    r"|试卷\s*[一二三四五六七八九十\d]+"
    r"|练习\s*[一二三四五六七八九十\d]+"
    r"|Assignment\s*\d+|Task\s*\d+|Part\s*\d+"
    r"|Q\s*\d+|Question\s*\d+"
    r"|参考答案|答案如下|标准答案|参考解答)",
    re.IGNORECASE,
)

# 编号标题：至少两级点分（如 1.1.3 / 1.1 智能XX系统），用于按「套」切分整本答案。
# 仅单级编号（1. 2. 步骤号）不算，避免把逐题步骤误切成大区段。
_SECTION_NO_RE = re.compile(r"^\s*\d+(?:\.\d+){1,}\b")

# 目录（TOC）条目：编号/名称后跟一长串点线 + 页码，例如
#   "1.1.5  智能交通系统的数据采集、处理和审核流程设计 ............................. 25"
# 这类行只是目录，不是正文章节头（正文章节头没有末尾的「点线+页码」）。
# 若把它当成分段边界，整本答案会被切成大量「目录微段」，污染 match_section 的
# 匹配与 _derive_paper_title 的命中段标题，导致抽到的名字退化成整本文档标题。
# 因此分段时须把目录行排除掉。
_TOC_TAIL_RE = re.compile(r"[.\u2026・．]{3,}\s*\d{1,4}\s*$")


def _is_toc_entry(txt: str) -> bool:
    """是否为目录（TOC）条目：末尾一长串点线/省略号 + 页码。"""
    return bool(_TOC_TAIL_RE.search((txt or "").strip()))

#: 标题行识别：行首 2+ 级编号 +（可选分隔符）+ 中文/字母开头的名称。
#: 用于建立「编号 → 完整标题」全文索引，支撑跨文档按编号补全标题：
#: 答案区段只写了编号（如 1.1.4）时，到题干/试卷或答案目录里找「1.1.4 电商平台…」。
_SECTION_TITLE_LINE_RE = re.compile(
    r"^\s*#?\s*(\d+(?:\.\d+){1,})\s*[、.·\-—　]*\s*([\u4e00-\u9fffA-Za-z0-9][^\n]{1,140})$"
)
#: 强代码行特征：含赋值/括号/关键字，不可能是标题行，建索引时排除，避免把
#: 「1.1.4 import pandas as pd  # 加载数据」这类代码行误当成标题。
_CODE_LINE_RE = re.compile(r"(=|\(|\)|;|\bimport\b|\bdef\b|\bclass\b|\breturn\b|\bprint\b)", re.IGNORECASE)


def _norm_title(title: str) -> str:
    """归一化试卷标题：去空白，作为答案 PDF 区段切分的强匹配钥匙。"""
    return re.sub(r"\s+", "", title or "")


def _is_red(color: Any) -> bool:
    """判断 docx / PDF 取到的颜色是否为红色系（容忍扫描色偏）。"""
    if color is None:
        return False
    try:
        if isinstance(color, int):
            r, g, b = (color >> 16) & 255, (color >> 8) & 255, color & 255
        elif isinstance(color, (tuple, list)) and len(color) >= 3:
            r, g, b = color[0], color[1], color[2]
        elif isinstance(color, str):
            raw = color.lstrip("#")
            if len(raw) != 6:
                return False
            r, g, b = int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
        else:
            return False
    except (ValueError, TypeError):
        return False
    return r > 120 and r > g * 1.5 and r > b * 1.5


def _guess_kind(raw: str) -> str:
    text = raw.strip()
    if text.startswith("#"):
        return "comment"
    if not text:
        return "code"
    if re.search(r"[\u4e00-\u9fff]", text) and not re.search(r"[=()\[\]_.:]", text):
        return "prose"
    return "code"


#: 试卷类型（用户态枚举）。与 DB 列 ``code_papers.language`` 的持久化值完全一致；
#: 录入面板、题库展示、改类型接口都以此为准，「通用」表示未明确归类 / 混合卷。
PAPER_TYPES = ("通用", "代码", "数学", "英语", "文史", "其它")

#: 代码卷特征：语言关键字 / 语法糖 / 函数调用写法。命中越密集越像代码卷。
_CODE_HINTS = re.compile(
    r"(?:\b(?:def|class|import|from|return|print|function|var|let|const|public|private|"
    r"protected|static|void|int|float|double|string|bool|struct|enum|if|else|for|while|"
    r"switch|case|try|catch|new|async|await|lambda|yield|include|using|namespace|func|"
    r"package|interface|extends|implements|throw|raise|end)\b"
    r"|=>|::|;\s*$|^\s*#|\bconsole\.log\b|\bSystem\.out\b|/\*|\*/|//|print\()",
    re.IGNORECASE | re.MULTILINE,
)

#: 数学 / 公式特征：公式符号、LaTeX 命令、数学术语、希腊字母。
_MATH_HINTS = re.compile(
    r"(?:[∑∫√∂∏∞±×÷≤≥≈≠≡∈∉⊆∪∩]\s*"
    r"|\\(?:frac|sqrt|sum|int|lim|alpha|beta|gamma|theta|lambda|Delta|pi|infty|times|"
    r"div|leq|geq|neq|equiv|in|notin|cup|cap|subset|vec|hat|bar|dot)\b"
    r"|[α-ωΑ-Ω]"
    r"|\b(?:方程|函数|导数|积分|矩阵|向量|等差数列|等比数列|三角函数|几何|概率|不等式|"
    r"求解|证明|化简|因式分解|行列式|方程组)\b)"
)

#: 英语 / 外语特征：整段英文指示语（区别于代码：代码不会只讲「读下面文章选答案」）。
_ENGLISH_HINTS = re.compile(
    r"(?:\b(?:Read the|Choose the|Answer the|Translate|Fill in|Complete the|Write an|"
    r"According to|Which of the following|The passage|Grammar|Vocabulary|Listening|"
    r"Speaking|Writing|Reading comprehension|True or False)\b)",
    re.IGNORECASE,
)

#: 文史 / 语文特征：书名号、文言虚词、作文题面、课文 / 作者 / 朝代等。
_LIT_HINTS = re.compile(
    r"(?:《[^》]{1,30}》"
    r"|\b(?:子曰|文言文|古诗|诗词|散文|作者|朝代|课文|作文|阅读理解|默写|赏析|"
    r"翻译下列|请把下列|请以.{0,20}为题|阅读下面的)\b"
    r"|之乎者也)"
)


def _english_ratio(sample: str) -> float:
    """拉丁字母占比：用于把「整段英文」与「中文里夹着的英文术语」区分开。"""
    letters = sum(1 for ch in sample if ch.isascii() and ch.isalpha())
    cjk = sum(1 for ch in sample if "一" <= ch <= "鿿")
    total = letters + cjk
    return letters / total if total else 0.0


def detect_paper_type(text: str) -> str:
    """根据卷面文本粗判试卷类型，返回 ``PAPER_TYPES`` 中的值。

    判定顺序（先强特征后弱特征）：

    1. 代码：语法关键字 / 调用写法密集出现（``def`` / ``print(`` / ``=>`` 等）。
    2. 数学：公式符号、LaTeX 命令、数学术语或希腊字母。
    3. 英语：英文指示语，或拉丁字母占比过高（整段英文而非中文夹术语）。
    4. 文史：文言文、书名号、作文题面、课文 / 作者 / 朝代等。
    5. 兜底通用：以上都不显著命中。

    这是上传时的「辅助预判」，识别不准不算错误——用户可在录入面板手动改，
    也可用题库里的「改类型」入口随时修正。判定强度只到「粗分」，不追求 100% 准。
    """
    if not text or not text.strip():
        return "通用"
    sample = text[:6000]  # 取前 6000 字足够判断卷型，避免大卷全文扫描
    # 1) 代码优先：语法关键字出现的密集信号
    if len(_CODE_HINTS.findall(sample)) >= 4:
        return "代码"
    # 2) 数学：公式符号 / 数学术语
    if _MATH_HINTS.search(sample):
        return "数学"
    # 3) 英语：整段英文指示语或拉丁字母占比过高
    if _ENGLISH_HINTS.search(sample) or _english_ratio(sample) > 0.6:
        return "英语"
    # 4) 文史：文言文 / 书名号 / 作文等
    if _LIT_HINTS.search(sample):
        return "文史"
    # 5) 兜底
    return "通用"


def _make_line(page_no: int, line_no: int, text: str, **kwargs: Any) -> CodeLine:
    text = BLANK_CHARS_RE.sub(BLANK_TOKEN, text)
    stripped = text.lstrip()
    return CodeLine(
        page_no=page_no,
        line_no=line_no,
        text=text.rstrip(),
        indent=len(text) - len(stripped),
        kind=_guess_kind(text),
        **kwargs,
    )


def from_text(text: str, kind: str, source_type: str = "text", doc_id: str = "") -> NormDoc:
    """纯文本/粘贴文本 → NormDoc（自测与手工复核通道也走这里）。"""
    lines = [
        _make_line(1, idx, raw)
        for idx, raw in enumerate(text.splitlines(), 1)
    ]
    return NormDoc(
        doc_id=doc_id or f"{kind}-text",
        kind=kind,
        source_type=source_type,
        pages=[lines],
    )


def parse_docx(path: Path, kind: str) -> NormDoc:
    try:
        from docx import Document
    except ImportError as exc:  # pragma: no cover - 依赖缺失时给明确提示
        raise RuntimeError(
            "解析 .docx 需要 python-docx，请先安装：pip install \"python-docx>=1.1\""
        ) from exc

    document = Document(str(path))
    lines: list[CodeLine] = []
    red_spans: list[dict[str, Any]] = []
    line_no = 0

    def add_runs(runs: Any) -> str:
        nonlocal line_no
        line_no += 1
        pieces: list[str] = []
        tokens: list[Token] = []
        for run in runs:
            text = run.text or ""
            color = None
            try:
                rgb = run.font.color.rgb if run.font.color else None
                if rgb is not None:
                    color = str(rgb)
            except (AttributeError, ValueError):
                pass
            underline = False
            try:
                underline = bool(run.underline or run.font.underline)
            except (AttributeError, ValueError):
                pass
            # Word 里「带下划线的空白」是最可靠的空位形态
            if underline and text and not text.strip():
                text = BLANK_TOKEN
            style = "red" if _is_red(color) else ("underline" if underline else "plain")
            tokens.append(Token(text=text, style=style, color=color))
            pieces.append(text)
            if style == "red" and text.strip():
                red_spans.append(
                    {"text": text, "page_no": 1, "line_no": line_no}
                )
        joined = "".join(pieces)
        lines.append(
            _make_line(1, line_no, joined, tokens=tokens)
        )
        return joined

    for paragraph in document.paragraphs:
        add_runs(paragraph.runs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    add_runs(paragraph.runs)

    return NormDoc(
        doc_id=f"{kind}-{path.stem}",
        kind=kind,
        source_type="docx",
        pages=[lines],
        meta={"red_spans": red_spans},
    )


def parse_pdf(path: Path, kind: str) -> NormDoc:
    try:
        try:
            import pymupdf as fitz  # PyMuPDF >= 1.24 推荐入口
        except ImportError:
            import fitz  # 旧版兼容别名（会给出弃用警告，功能一致）
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "解析 PDF 需要 PyMuPDF，请先安装：pip install \"PyMuPDF>=1.24\""
        ) from exc

    document = fitz.open(str(path))
    pages: list[list[CodeLine]] = []
    red_spans: list[dict[str, Any]] = []
    vector_lines: list[dict[str, Any]] = []
    source_type = "pdf_text"

    for page_no, page in enumerate(document, 1):
        lines: list[CodeLine] = []
        data = page.get_text("dict")
        for line_no, line in enumerate(
            (ln for block in data.get("blocks", []) for ln in block.get("lines", [])),
            1,
        ):
            pieces: list[str] = []
            tokens: list[Token] = []
            for span in line.get("spans", []):
                text = span.get("text", "")
                raw_color = span.get("color")
                color = f"{raw_color:06X}" if isinstance(raw_color, int) else None
                style = "red" if _is_red(color) else "plain"
                bbox = span.get("bbox")
                tokens.append(
                    Token(
                        text=text,
                        bbox=tuple(bbox) if bbox else None,
                        style=style,
                        color=color,
                    )
                )
                pieces.append(text)
                if style == "red" and text.strip():
                    red_spans.append(
                        {"text": text, "page_no": page_no, "line_no": line_no}
                    )
            line_bbox = line.get("bbox")
            lines.append(
                _make_line(
                    page_no,
                    line_no,
                    "".join(pieces),
                    tokens=tokens,
                    bbox=tuple(line_bbox) if line_bbox else None,
                )
            )
        # 矢量下划线（图形横线空位）：先记录坐标；与文字行做 cy 对齐属 P2，
        # 图片通道的同类能力已由 vision.py 实现（坐标系不同，不能直接复用）
        for drawing in page.get_drawings():
            for item in drawing.get("items", []):
                if item and item[0] == "l":
                    vector_lines.append(
                        {"page": page_no, "item": [list(p) for p in item[1:]]}
                    )
        if not lines:
            source_type = "pdf_scan"
        pages.append(lines)

    # 文本层为空或含大量乱码（CJK 字体 CMap 损坏 / 扫描件未被识别）：
    # 用图片识别(OCR)回退，逐页渲染后识别文字与坐标，尽量挽回「答案解析不出来」的情况。
    ocr_warn: list[str] = []
    if _looks_garbled(pages):
        try:
            ocr_pages, ocr_warn = _ocr_pdf_fallback(document, kind)
            if any(ocr_pages):
                pages = ocr_pages
                source_type = "pdf_scan"
                red_spans = []
                vector_lines = []
        except Exception as exc:  # noqa: BLE001 - OCR 回退失败不应阻断录入
            ocr_warn.append(f"OCR 回退解析失败：{exc}")

    if source_type == "pdf_scan":
        warn_list = ["该 PDF 文本层不可用（扫描件或字体损坏），已用图片识别(OCR)回退解析"]
        if not any(pages):
            warn_list = ["PDF 无文本层且 OCR 也未识别到内容，请改用图片通道或手工粘贴文本"]
        warn_list.extend(ocr_warn)
        return NormDoc(
            doc_id=f"{kind}-{path.stem}",
            kind=kind,
            source_type=source_type,
            pages=pages,
            warnings=warn_list,
            meta={"red_spans": red_spans, "vector_lines": vector_lines},
        )
    return NormDoc(
        doc_id=f"{kind}-{path.stem}",
        kind=kind,
        source_type=source_type,
        pages=pages,
        warnings=[],
        meta={"red_spans": red_spans, "vector_lines": vector_lines},
    )


def _looks_garbled(pages: list[list[CodeLine]]) -> bool:
    """文本层是否基本不可用：完全空（扫描件）或乱码（豆腐块）占比过高。"""
    total = 0
    bad = 0
    for plines in pages:
        for ln in plines:
            t = ln.text or ""
            total += len(t)
            bad += t.count("\ufffd")
    if total == 0:
        return True
    return bad / total > 0.10


def _ocr_pdf_fallback(document, kind: str):
    """逐页渲染后用 PaddleOCR 识别文字与坐标，重建可对齐的 NormDoc。

    复用 vision.group_boxes_into_lines 做按行聚类；坐标为渲染图像素，
    按 zoom 倍率折算回 PDF 点。OCR 不可用或页面无文字时返回空行列表。
    """
    import fitz  # pymupdf
    from . import vision

    try:
        import ocr_engine
    except Exception:  # noqa: BLE001
        ocr_engine = None
    new_pages: list[list[CodeLine]] = []
    warnings: list[str] = []
    zoom = 2.0
    tmp_dir = Path(tempfile.mkdtemp(prefix="cp_ocr_"))
    try:
        for page_no, page in enumerate(document, 1):
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            tmp = tmp_dir / f"p{page_no}.png"
            pix.save(str(tmp))
            boxes: list[dict[str, Any]] = []
            if ocr_engine is not None:
                try:
                    detail = ocr_engine.recognize_detail(str(tmp))
                    boxes = (detail or {}).get("boxes") or []
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"第 {page_no} 页 OCR 失败：{exc}")
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            if not boxes:
                new_pages.append([])
                continue
            groups, _ = vision.group_boxes_into_lines(boxes)
            lines: list[CodeLine] = []
            for gi, g in enumerate(groups, 1):
                txt = "".join(b.get("text", "") for b in g["boxes"])
                if not txt.strip():
                    continue
                bbox = (
                    g["x1"] / zoom, g["y1"] / zoom,
                    g["x2"] / zoom, g["y2"] / zoom,
                )
                lines.append(_make_line(page_no, gi, txt, bbox=tuple(bbox)))  # type: ignore[arg-type]
            new_pages.append(lines)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return new_pages, warnings


def parse_image(path: Path, kind: str) -> NormDoc:
    """图片通道（P1）：委托 ``vision.analyse_image``。

    试卷图走几何横线 → ``BLANK_TOKEN``；答案图额外走 HSV 红色分割 →
    ``meta["red_spans"]``，由 ``load_file`` 交给 ``core.align`` 作辅助证据。
    """
    from . import vision  # 局部导入：视觉层依赖 cv2，避免文本通道被连累

    return vision.analyse_image(path, kind)


def parse_ipynb(path: Path, kind: str) -> NormDoc:
    """Jupyter notebook (.ipynb) → NormDoc。

    ipynb 本质是 JSON：``cells`` 里 ``code`` 单元格的源码拼成代码行，
    ``markdown`` 单元格（说明 / 背景 / 判分依据）整段入行保留语义。
    空白处用连续下划线 ``____`` 标记，经 ``_make_line`` 自动转成空位记号，
    与现有判分 / 回填逻辑完全一致。若首条 ``# 标题`` markdown 存在，仅记一份
    ``meta.notebook_title`` 作为**可选辅助线索**（答案 PDF 切分时的附加边界信号）；
    即便没有标题，整卷也能靠「代码行指纹」与答案 PDF 自动对齐（见
    ``core.match_section``），**匹配不依赖试卷名字**。
    """
    import json as _json

    try:
        nb = _json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001 - 反馈明确错误，而非 500
        raise ValueError(f"ipynb 解析失败（不是合法的 notebook JSON）：{exc}") from exc

    cells = nb.get("cells", []) if isinstance(nb, dict) else []
    lines: list[CodeLine] = []
    notebook_title = ""
    line_no = 0
    for cell in cells:
        ctype = (cell or {}).get("cell_type", "code")
        src = (cell or {}).get("source", [])
        text = "".join(src) if isinstance(src, list) else str(src)
        if not text.strip():
            continue
        if ctype == "markdown":
            for raw_line in text.splitlines():
                line_no += 1
                lines.append(_make_line(1, line_no, raw_line))
            if not notebook_title:
                for ml in text.splitlines():
                    mt = re.match(r"^#\s+(.*)$", ml.strip())
                    if mt:
                        notebook_title = mt.group(1).strip()
                        break
            continue
        # code / 其他类型：逐行入卷（空白试卷里的 ____ 会被识别成空位）
        for raw_line in text.splitlines():
            line_no += 1
            lines.append(_make_line(1, line_no, raw_line))

    return NormDoc(
        doc_id=f"{kind}-{path.stem}",
        kind=kind,
        source_type="ipynb",
        pages=[lines],
        meta={"notebook_title": notebook_title, "red_spans": []},
    )


def red_spans_from_doc(doc: NormDoc) -> list[dict[str, Any]]:
    """从已解析 NormDoc 的 token 中重建红色片段列表（答案通道辅助证据）。"""
    out: list[dict[str, Any]] = []
    for ln in doc.lines():
        for tok in ln.tokens:
            if getattr(tok, "style", None) == "red" and (tok.text or "").strip():
                out.append(
                    {"text": tok.text, "page_no": ln.page_no, "line_no": ln.line_no}
                )
    return out


def _clean_title(t: str) -> str:
    """清理「编号 标题 ..... 12」这类标题：先去行尾页码，再去占位点与破折号。"""
    t = re.sub(r"\s+", " ", t or "").strip()
    t = re.sub(r"\s+\d+$", "", t).strip()          # 去行尾页码，如「…… 19」
    t = re.sub(r"[·・\u2026.\-—–]+$", "", t).strip()  # 再去占位点 / 破折号
    return t


def _title_looks_named(t: str) -> bool:
    """标题是否已「带名字」：含汉字且不只是纯编号（如 1.1.4）。"""
    if not t:
        return False
    if re.fullmatch(r"\s*\d+(?:\.\d+)*\s*", t):
        return False
    return bool(re.search(r"[\u4e00-\u9fff]", t))


def _head_number(text: str) -> str:
    """从一行里提取前置的多级编号（如 1.1.4），用于按编号跨文档查标题。

    兼容 ipynb 注释行前缀 ``#``（如 ``# 1.1.4 标题``）。
    """
    m = re.match(r"^\s*#?\s*(\d+(?:\.\d+){1,})", (text or ""))
    return m.group(1) if m else ""


def build_title_index(doc: NormDoc | None) -> dict[str, str]:
    """扫描文档全文，建立 编号→完整标题 索引，供「答案只有编号、标题在别处」时补全。

    扫描范围覆盖**整个文档**（题干/试卷、答案目录页等任意位置），不只看答案区段本身，
    实现用户要求的「根据编号全文匹配试卷名称」。

    收录规则：行首 2+ 级编号 + 中文/字母名称，且不是代码行、不含空位标记；同一编号
    多次出现时保留最长（最完整）的标题。返回的标题已用 :func:`_clean_title` 清理。
    """
    index: dict[str, str] = {}
    if doc is None:
        return index
    for ln in doc.lines():
        t = (ln.text or "").strip()
        if not t or len(t) > 160 or BLANK_TOKEN in t:
            continue
        if _CODE_LINE_RE.search(t):  # 排除 import / def / = 等代码行
            continue
        if _is_toc_entry(t):  # 排除目录条目（编号+名称+点线+页码），避免索引到目录而非正文标题
            continue
        m = _SECTION_TITLE_LINE_RE.match(t)
        if not m:
            continue
        no = m.group(1)
        title = _clean_title(f"{no} {m.group(2)}")
        if not re.search(r"[\u4e00-\u9fff]", title) or re.fullmatch(r"\s*\d+(?:\.\d+)*\s*", title):
            continue
        if no not in index or len(title) > len(index[no]):
            index[no] = title
    return index


def _pick_display_title(seg: list[CodeLine]) -> str:
    """从答案区段前几行里挑出最像『完整标题』的行（如 1.1.3 智能XX系统）。

    切分边界行往往是「第N套 / 参考答案」这类弱信号；真正有用的标题常是
    「编号 + 文字」形式。优先返回它，让前端区段下拉与入库 title 都能显示全名，
    而不是只剩一个编号。标题会经过 ``_clean_title`` 去掉行尾的占位点与页码。
    """
    pat = re.compile(r"^\s*\d+(?:\.\d+)*[\s、.·\-—]+[\u4e00-\u9fffA-Za-z].{1,}$")
    fallback = ""
    for ln in seg[:12]:
        t = (ln.text or "").strip()
        # 行太长多半是代码/正文而非标题，直接跳过（上限放宽到 160，避免带占位点的长标题被误删）
        if not t or len(t) > 160:
            continue
        if pat.match(t):
            return _clean_title(t)
        # 含「x.y.z」编号且带汉字、长度适中，也视为标题候选
        if re.search(r"\d+\.\d+", t) and re.search(r"[\u4e00-\u9fff]", t) and len(t) >= 4:
            return _clean_title(t)
        if _SECTION_RE.match(t) and not re.search(r"[\u4e00-\u9fffA-Za-z]", t[3:]):
            fallback = _clean_title(t)  # 纯「第N套」之类，作为兜底而非首选
    return fallback


def split_answer_book(doc: NormDoc, paper_title: str = "", title_index: dict | None = None) -> list[NormDoc]:
    """把一整本答案 PDF（含多套试卷的答案）按标题切成若干区段。

    每套答案里的「完整代码」是后续与试卷对齐的唯一依据（见 ``core.align`` 的
    ``locate_answer_block``）。切分失败时回退为整本文档一段，保证旧的单卷答案
    流程完全不受影响。

    边界识别优先级（标题仅为可选辅助，缺失时不影响切分）：
      1. 整行命中 ``_SECTION_RE``（第N套 / 试卷N / Assignment N / 参考答案…）；
      2. 行内包含试卷标题（ipynb 的 ``# 标题`` 归一化后，仅当标题存在时启用）。
         注意：这是辅助边界信号，**真正与试卷对齐的是答案 PDF 里的整段代码**——
         ``locate_answer_block`` 用试卷代码行指纹而非名字来定位，无标题同样可匹配。
    """
    all_lines = doc.lines()
    if not all_lines:
        return [doc]
    key = _norm_title(paper_title)
    bounds = [0]
    for i, ln in enumerate(all_lines):
        txt = (ln.text or "").strip()
        if not (0 < len(txt) <= 60 and not BLANK_CHARS_RE.search(txt)):
            continue
        is_boundary = bool(_SECTION_RE.match(txt)) or bool(_SECTION_NO_RE.match(txt))
        # 目录（TOC）条目（末尾「点线+页码」）只是目录，不是正文章节头，排除出边界，
        # 否则整本答案会被切成大量目录微段，污染区段匹配与标题派生。
        if is_boundary and _is_toc_entry(txt):
            is_boundary = False
        if not is_boundary and key and len(key) >= 3 and key in re.sub(r"\s+", "", txt):
            is_boundary = True
        if is_boundary:
            bounds.append(i)
    bounds.append(len(all_lines))

    sections: list[NormDoc] = []
    owner = ""  # 最近一次出现的「编号 + 名称」标题：给紧跟其后的「参考答案」段落认领归属
    for bi in range(len(bounds) - 1):
        start, end = bounds[bi], bounds[bi + 1]
        if end - start <= 1:
            continue
        seg = all_lines[start:end]
        display = _pick_display_title(seg)
        # 区段自身没解析出「编号+名称」的强标题时，按首部编号去全文索引里补全全名
        # （答案区段只有编号、完整标题在题干/试卷或答案目录里的情况）。
        if not _title_looks_named(display) and title_index:
            for sl in seg[:8]:
                n = _head_number(sl.text or "")
                if n and n in title_index:
                    display = title_index[n]
                    break
        if _title_looks_named(display):
            owner = display
        title = display or (seg[0].text or "").strip()[:40] or f"区段 {bi + 1}"
        # 整本答案里「参考答案」四个字会出现几十次，段落本身没有身份；
        # 记下最近一个带名字的标题，才能把 2.1.1 的答案和 2.1.2 的答案区分开。
        label = f"{title} · {owner}" if owner and owner != title else title
        red: list[dict[str, Any]] = []
        for sl in seg:
            for tok in sl.tokens:
                if getattr(tok, "style", None) == "red" and (tok.text or "").strip():
                    red.append(
                        {"text": tok.text, "page_no": sl.page_no, "line_no": sl.line_no}
                    )
        sections.append(
            NormDoc(
                doc_id=f"{doc.doc_id}-sec{bi}",
                kind="answer",
                source_type=doc.source_type,
                language=doc.language,
                pages=[seg],
                meta={
                    "section_title": title,
                    "section_title_display": display,
                    "section_owner": owner,
                    "section_label": label,
                    # 原文行区间：供「往下多探索」时按文档顺序拼接跨页/跨区段答案
                    "line_start": start,
                    "line_end": end,
                    "red_spans": red,
                },
            )
        )
    # 完全没切出区段（答案里找不到「第N套 / x.y.z 编号」等任何边界）→ 回退整本文档；
    # 只要切出了区段就保留（哪怕只有 1 段），否则单套答案的「编号+标题」会被丢掉，
    # 导致入库标题只剩文件名编号（如 1.1.4）。每段的完整标题写在 meta.section_title_display。
    if not sections:
        return [doc]
    return sections


def load_file(path: str | Path, kind: str) -> tuple[NormDoc, list[dict[str, Any]]]:
    """按扩展名分发，返回 (NormDoc, 红色片段列表)。"""
    target = Path(path)
    suffix = target.suffix.lower()
    if suffix in (".docx", ".docm"):
        doc = parse_docx(target, kind)
    elif suffix == ".pdf":
        doc = parse_pdf(target, kind)
    elif suffix == ".ipynb":
        doc = parse_ipynb(target, kind)
    elif suffix in _IMAGE_EXTS:
        doc = parse_image(target, kind)
    elif suffix in _TEXT_EXTS:
        doc = from_text(
            target.read_text(encoding="utf-8", errors="replace"),
            kind,
            "text",
            doc_id=f"{kind}-{target.stem}",
        )
    elif suffix == ".doc":
        raise ValueError("旧版 .doc 不受支持，请另存为 .docx 后重试")
    else:
        raise ValueError(f"不支持的文件类型：{suffix or '(无扩展名)'}")
    return doc, list(doc.meta.get("red_spans", []))
