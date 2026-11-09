"""代码填空整卷处理：纯逻辑内核。

不依赖 Web 框架、数据库或任何文件格式，输入是 ``NormDoc``，输出是
``PaperResult``。这样格式解析层（docx / pdf / image）可以独立替换与测试。

核心算法是「模板常量段顺序匹配」：把试卷行按空位切成常量段，在答案文档
的对应代码行中按顺序定位这些常量段，两段之间夹出的文本即该空答案。
它同时解决：答案不带空格、一行多空、题目/空位无编号、两份文档排版不同。

设计铁律：任何一步不确定就报冲突并退回人工，**绝不自动顺延补齐**。
"""
from __future__ import annotations

import concurrent.futures
import json
import re
from typing import Any

from .model import (
    BLANK_TOKEN,
    Answer,
    Blank,
    Check,
    CodeLine,
    NormDoc,
    PaperResult,
)
from . import ingest  # 复用 ingest._clean_title 清理标题

#: 空位标记：内部标记 / 连续下划线 / 全角下划线 / 长横线（OCR 常见）
BLANK_SPLIT_RE = re.compile(r"(\[\[BLANK\]\]|_{3,}|＿{2,}|─{3,}|—{3,})")
PLACEHOLDER_RE = re.compile(r"\{\{(\d+)\}\}")

#: 答案文档里的红色标题/页眉，不是答案
TITLE_WORDS = ("参考答案", "复习题", "答案如下", "标准答案", "试题答案")

#: PDF 文本层会把一条长代码（如 ``selected_features = [...]`` 的中文长列表）
#: 折成十几条物理行，甚至跨页。单行匹配失败时，允许把后续连续行拼成一条
#: 逻辑行再匹配 —— 这是「答案翻页 / 换行后找不到」的主要解药。
MAX_JOIN_LINES = 32        # 单个逻辑答案最多拼接多少条物理行
MAX_JOIN_START_SPAN = 64   # 从当前游标起最多向下试探多少个起点
MAX_TEMPLATE_GROUP = 8     # 试卷模板一条语句最多折成几行含空位

#: 大模型只是「补缺口」的可选增强：网络不通 / 免费额度排队 / 模型卡住时，
#: 绝不能让整次入库跟着挂起。这里在 llm_client 的 HTTP 超时之外再包一层
#: 独立线程的墙钟超时，超时立即带着规则结果返回。
#: 智谱 Flash 系列不限制 token、且有免费额度，因此放宽到 45s：让模型有机会
#: 读完接近全文的答案区段。强制思考模型（GLM-5.3/4.7）额外放宽到 110s。
LLM_ASSIST_WALL_TIMEOUT = 45
LLM_ASSIST_WALL_TIMEOUT_THINKING = 110
_ASSIST_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=2, thread_name_prefix="cp-parse-llm"
)


class AlignmentConflict(Exception):
    """模板常量段无法在答案行中顺序定位。"""


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------
def split_comment(line: str) -> tuple[str, str]:
    """拆成 (代码部分, 注释文本)，保护字符串字面量里的 ``#``。"""
    quote = ""
    escaped = False
    for idx, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and quote:
            escaped = True
            continue
        if quote:
            if ch == quote:
                quote = ""
            continue
        if ch in ("'", '"'):
            quote = ch
            continue
        if ch == "#":
            return line[:idx], line[idx + 1 :].strip()
    return line, ""


def squash(value: str) -> str:
    """去空白规范化。

    用户前提：答案片段本身不带空格，所以规范化不损失答案信息。
    注意：若答案含带空格的字符串字面量，需改走 bbox/token 通道（P2）。
    """
    return re.sub(r"\s+", "", value or "")


def normalize_code(line: str) -> str:
    """剥离注释 + 去空白，仅用于匹配与比较，不用于回填。"""
    return squash(split_comment(line)[0])


def has_blank(text: str) -> bool:
    return bool(BLANK_SPLIT_RE.search(text or ""))


def _is_blank_token(segment: str) -> bool:
    return bool(segment) and bool(BLANK_SPLIT_RE.fullmatch(segment))


# ---------------------------------------------------------------------------
# 空位识别与编号
# ---------------------------------------------------------------------------
def infer_role(left: str, right: str = "", hint: str = "") -> str:
    """由空位左右上下文推断它期望的语法角色（不依赖空格以外的任何编号）。"""
    stripped = left.rstrip()
    if not stripped.strip() and right.lstrip().startswith("("):
        return "callable"
    if re.search(r"\bfor\b.*\bin\s*$", stripped):
        return "iterable"
    if re.search(r"\b(if|elif|while)\b\s*$", stripped):
        return "cond"
    if re.search(r"\bdef\b.*\(\s*$", stripped):
        return "params"
    if stripped.endswith("["):
        return "element"
    if stripped.endswith("("):
        return "arg"
    return "expr"


def role_ok(role: str, answer: str) -> bool:
    """答案文本是否适配该空的语法位置（独立于答案文档的交叉验证）。"""
    value = (answer or "").strip()
    if not value or BLANK_TOKEN in value or re.search(r"_{3,}", value):
        return False
    if role == "callable":
        return bool(re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", value))
    if re.match(r"^(import|from|def|class|for|while|if|elif|return|print)\b", value):
        return False
    if role in ("iterable", "cond", "element"):
        # 表达式位不应塞进一条赋值语句（== / >= 等比较运算符除外）
        if "=" in value and not any(op in value for op in ("==", ">=", "<=", "!=")):
            return False
    # arg / params 位里 ``test_size=0.2`` 这类关键字实参是合法的，
    # 与赋值语句长得一样但不能一刀切判错（曾导致 2.1.2 的 B11 误判）。
    return True


def detect_blanks(doc: NormDoc) -> tuple[list[Blank], str]:
    """检测空位并生成 ``code_template``（占位符 ``{{global_no}}``）。

    同时保留空位左右上下文、右侧中文注释（role_hint）与页/行/列锚点。
    结构化来源置信度 1.0；图片/扫描件一律降为 0.8 并强制人工复核。
    """
    blanks: list[Blank] = []
    template_lines: list[str] = []
    number = 0
    low_confidence = doc.source_type in ("image", "pdf_scan")

    # 保留「代码行 + 纯注释行」两类，按原顺序；纯注释行原样进模板（展示用，不产生空位）
    for line in [ln for ln in doc.lines() if ln.kind in ("code", "comment") and ln.text.strip()]:
        # 纯注释行（如 `# 第二步：归一化`）：原样保留进试卷模板，
        # 让考试 / 质检 / 回填视图能看到原卷的说明文字；它不参与空位检测与答案抽取。
        if line.kind == "comment":
            template_lines.append(line.text.strip())
            continue
        code, comment = split_comment(line.text)
        matches = list(BLANK_SPLIT_RE.finditer(code))
        # 图片视觉层会为每个几何横线写入精确的 Token bbox；数量对得上时
        # 用它替换整行 bbox，前端复核框才能圈住单个空位而不是一整行。
        token_boxes = [
            token.bbox
            for token in line.tokens
            if token.text == BLANK_TOKEN and token.bbox
        ]
        blank_boxes = token_boxes if len(token_boxes) == len(matches) else []
        pieces: list[str] = []
        cursor = 0
        for match_index, match in enumerate(matches):
            number += 1
            left, right = code[: match.start()], code[match.end() :]
            pieces.append(code[cursor : match.start()])
            blanks.append(
                Blank(
                    no=number,
                    slot_id=f"P{line.page_no}-L{line.line_no}-C{match.start()}",
                    page_no=line.page_no,
                    line_no=line.line_no,
                    col=match.start(),
                    context_left=left[-48:],
                    context_right=right[:48],
                    role_expected=infer_role(left, right, comment),
                    role_hint=comment,
                    kind="underline_run" if match.group(0) == BLANK_TOKEN else "chars",
                    confidence=0.8 if low_confidence else 1.0,
                    needs_review=low_confidence,
                    bbox=blank_boxes[match_index] if blank_boxes else line.bbox,
                )
            )
            pieces.append("{{%d}}" % number)
            cursor = match.end()
        pieces.append(code[cursor:])
        rendered = "".join(pieces).rstrip()
        # 保留试卷每行右侧的中文注释（# 之后）：解析后随模板/回填代码一并留存、
        # 在考试/质检/回填视图里原样展示。注释不参与答案抽取——extract_answers 内部
        # 会用 normalize_code 剥离它，只把它当作展示用途。
        if comment:
            if code.strip():
                rendered = rendered + "  # " + comment
            else:
                # 整行都是注释（无代码部分）时原样保留，避免被重新规整成「  # 注释」
                rendered = line.text.strip()
        template_lines.append(rendered)

    return blanks, "\n".join(template_lines)


# ---------------------------------------------------------------------------
# 答案抽取：模板常量段顺序匹配
# ---------------------------------------------------------------------------
def _find_const(answer: str, segment: str, cursor: int, fuzzy: bool) -> tuple[int, int]:
    """在答案逻辑行里定位一个常量段，返回 (起点, 命中长度)。

    ``fuzzy=True`` 时容忍试卷排版/原件笔误带来的冗余闭合括号：例如试卷写
    ``([[B]](18, 70)) &`` 而答案写 ``between(18,70) &``，精确匹配永远失败。
    逐级弱化：去掉段首孤立 ``]``/``)`` → 折叠连续 ``)`` → 只取段中最有辨识
    力的参数字面量 ``(18,70)``。首个常量段仍要求精确命中，避免定位到别的题。
    """
    if not segment:
        return len(answer), 0
    pos = answer.find(segment, cursor)
    if pos >= 0:
        return pos, len(segment)
    if not fuzzy:
        return -1, 0
    weak = re.sub(r"\){2,}", ")", segment.lstrip("])"))
    if weak and weak != segment:
        pos = answer.find(weak, cursor)
        if pos >= 0:
            return pos, len(weak)
    for m in re.finditer(r"\([^()]*\d[^()]*\)", weak or segment):
        frag = m.group(0)
        if len(frag) >= 4:
            pos = answer.find(frag, cursor)
            if pos >= 0:
                return pos, len(frag)
    return -1, 0


def extract_answers(
    template_line: str, answer_line: str, *, fuzzy: bool = False
) -> list[str]:
    """从「试卷模板行 + 答案完整代码行」抽出该行每个空的答案。

    例：``X_train,... = [[B]]([[B]], random_state=42)`` 的常量段是
    ``X_train,...=`` / ``(`` / ``,random_state=42)``；在答案行中顺序定位后，
    夹出的就是 ``train_test_split`` 与 ``X,y``。
    """
    template = normalize_code(template_line)
    answer = normalize_code(answer_line)
    if not has_blank(template):
        return []
    parts = BLANK_SPLIT_RE.split(template)
    answers: list[str] = []
    cursor = 0
    idx = 0
    while idx < len(parts):
        segment = parts[idx]
        if _is_blank_token(segment):
            following = parts[idx + 1] if idx + 1 < len(parts) else ""
            if following:
                # 空位之后的常量段用于「夹出」答案；fuzzy 只作用于这里
                pos, hit_len = _find_const(answer, following, cursor, fuzzy)
            else:
                pos, hit_len = len(answer), 0
            if pos < 0:
                raise AlignmentConflict(f"常量段未匹配: {following!r}")
            answers.append(answer[cursor:pos])
            cursor = pos + hit_len
            idx += 2
        else:
            if segment:
                pos, hit_len = _find_const(answer, segment, cursor, fuzzy and idx > 0)
                if pos < 0:
                    raise AlignmentConflict(f"常量段未匹配: {segment!r}")
                cursor = pos + hit_len
            idx += 1
    return answers


def fill(template: str, answers: dict[int, str]) -> str:
    """把 ``{{no}}`` 替换为答案原文（strict 模式：不做空格渲染）。"""
    return PLACEHOLDER_RE.sub(
        lambda m: answers.get(int(m.group(1)), m.group(0)), template
    )


# ---------------------------------------------------------------------------
# 红色标记：有效性过滤与答案代码块定位
# ---------------------------------------------------------------------------
def filter_red_spans(
    spans: list[dict[str, Any]], paper_lines: list[CodeLine]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """红色 ≠ 空位答案，必须过滤噪声。

    样例证据：``print(data.head())`` 在试卷里是已给出的完整代码行，却在答案
    文档里被标红；红标题「参考答案」也是噪声。命中这些规则即丢弃。
    """
    complete = {
        key
        for key in (normalize_code(ln.text) for ln in paper_lines if not has_blank(ln.text))
        if len(key) >= 4
    }
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for span in spans or []:
        text = (span.get("text") or "").strip()
        key = squash(text)
        reason = ""
        if not key:
            reason = "空片段"
        elif any(word in text for word in TITLE_WORDS) and not any(
            ch in text for ch in "(=."
        ):
            reason = "标题/说明文字"
        elif key in complete:
            reason = "与试卷完整代码行相同（强调标记）"
        elif len(key) >= 6 and any(key in c or c in key for c in complete):
            reason = "与试卷完整代码行重合（强调标记）"
        item = dict(span)
        if reason:
            item["drop_reason"] = reason
            dropped.append(item)
        else:
            kept.append(item)
    return kept, dropped


def locate_answer_block(
    answer_lines: list[CodeLine], paper_lines: list[CodeLine]
) -> tuple[int, int, dict[str, Any]]:
    """在「多题混排 / 跨页」的答案文档中确认与试卷对应的代码区。

    用试卷里不含空位的代码行作骨架指纹。**指纹只作为定位证据与警告来源，
    不用于硬截断**：实测中答案行可能出现在任意两个骨架行之间，甚至第一个
    骨架行之前（样例里 ``data = pd.read_csv(...)`` 就在 ``print(data.head())``
    之前）。真正的筛选交给 ``extract_answers`` 的模板常量段强匹配——其他
    题目的代码几乎不可能命中 ``X_train,X_test,...=`` 这类长常量段。
    """
    fingerprints = [
        key
        for key in (normalize_code(ln.text) for ln in paper_lines if not has_blank(ln.text))
        if len(key) >= 8
    ]
    unique = list(dict.fromkeys(fingerprints))
    answer_keys = [normalize_code(ln.text) for ln in answer_lines]
    hits: list[int] = []
    for fingerprint in unique:
        for idx, key in enumerate(answer_keys):
            if key and (key == fingerprint or (len(fingerprint) >= 12 and fingerprint in key)):
                hits.append(idx)
                break
    if not hits:
        return 0, len(answer_lines), {
            "matched": 0,
            "fingerprints": len(unique),
            "warning": "未找到试卷骨架指纹，答案代码块未能定位（已按全文处理，需人工复核）",
        }
    return 0, len(answer_lines), {
        "matched": len(hits),
        "fingerprints": len(unique),
        "first_hit": min(hits),
        "last_hit": max(hits),
        "warning": "",
    }


def match_section(
    paper_doc: NormDoc, sections: list[NormDoc]
) -> tuple[int, list[dict[str, Any]]]:
    """整本答案 PDF 含多套试卷答案时，为当前试卷选出对应区段。

    对每段答案调用 ``locate_answer_block``，用「试卷骨架指纹覆盖率」作为匹配度
    （覆盖率 = 命中指纹数 / 指纹总数）。覆盖率相同则取代码行更少的区段——即只
    包含本套答案、不含其它套的「最紧凑匹配」，避免整本文档与单套区段打平。
    """
    paper_lines = paper_doc.code_lines()
    # 试卷标识：优先 ipynb 的 # 标题，其次文件名编号（parse 阶段写入 source_stem）
    paper_key = re.sub(r"\s+", "", (paper_doc.meta.get("notebook_title") or paper_doc.meta.get("source_stem") or ""))
    candidates: list[dict[str, Any]] = []
    for i, sec in enumerate(sections):
        _start, _end, loc = locate_answer_block(sec.code_lines(), paper_lines)
        fps = int(loc.get("fingerprints", 0) or 0)
        matched = int(loc.get("matched", 0) or 0)
        score = round(matched / fps, 3) if fps else 0.0
        # 编号 / 标题命中：试卷标识（# 标题或文件名编号）出现在该段前几行，
        # 或出现在该段「归属标题」里。整本答案有几十个同名「参考答案」段落，
        # 归属标题（如 2.1.2 低碳生活…）是区分本套与上一套答案的关键证据。
        title_hit = 0
        if paper_key:
            head = "".join((sl.text or "") for sl in sec.code_lines()[:6])
            owner = re.sub(r"\s+", "", str(sec.meta.get("section_owner") or ""))
            if paper_key in re.sub(r"\s+", "", head) or paper_key in owner:
                title_hit = 1
        combined = round(0.65 * score + 0.35 * title_hit, 3) if (fps or title_hit) else 0.0
        candidates.append(
            {
                "index": i,
                "title": sec.meta.get("section_label")
                or sec.meta.get("section_title_display")
                or sec.meta.get("section_title", f"区段 {i + 1}"),
                "score": score,
                "matched": matched,
                "fingerprints": fps,
                "title_hit": title_hit,
                "combined": combined,
                "code_lines": len(sec.code_lines()),
            }
        )
    # 综合分降序；相同 → 代码行更少者优先（更紧凑 = 更可能是本套专属区段）
    candidates.sort(key=lambda c: (-c["combined"], c["code_lines"]))
    best = candidates[0]["index"] if candidates else 0
    return best, candidates


# ---------------------------------------------------------------------------
# 对齐与全对判定
# ---------------------------------------------------------------------------
def _is_page_furniture(line: CodeLine) -> bool:
    """页眉 / 页脚 / 纯页码：不该进入「参考答案原文」的裁剪范围。"""
    t = (line.text or "").strip()
    if not t:
        return True
    if re.fullmatch(r"\d{1,4}\s*/\s*", t):     # 「60 /」这类页脚
        return True
    if any(w in t for w in TITLE_WORDS) and len(t) <= 80:
        return True
    return False


def _template_continues(line: str) -> bool:
    """试卷模板行是否明显是续行（下一条含空位行仍属于同一条语句）。

    判据：括号未闭合，或行尾是 ``& , + - * / | = <`` 等续行运算符。
    只用于**额外的合并候选**；合并失败会回退逐行匹配，不会降低召回。
    """
    code = split_comment(line)[0].rstrip()
    if not code:
        return False
    balance = 0
    for ch in code:
        if ch in "([{":
            balance += 1
        elif ch in ")]}":
            balance -= 1
    if balance > 0:
        return True
    return bool(re.search(r"[&,\+\-\*/\|=<]\s*$", code))


def _const_prefix_ok(head: str, const: str) -> bool:
    """跨行拼接的起点判据：起点行与模板首个常量段互为前缀即可。

    PDF 常把 ``sensor_stats = data.groupby(...)`` 拆成 ``sensor_stats`` /
    ``=`` / ``data.groupby(...)`` 三条物理行。旧判据要求起点行以完整常量段
    ``sensor_stats=`` 开头，这类折行会被整段跳过，答案永远找不齐。
    """
    if not const:
        return True
    if head.startswith(const) or const.startswith(head):
        return True
    bare = const.rstrip("=([{ ,")
    return bool(bare) and len(head) >= 4 and (
        head.startswith(bare) or bare.startswith(head)
    )


def collect_answer_region(
    block: list[CodeLine], spans: list[tuple[int, int]], sink: list[dict[str, Any]]
) -> None:
    """把「本卷关联的全部参考答案」的物理行坐标写入 sink。

    取首个命中行到末个命中行之间的**连续区间**（含跨行窗口里的每一条物理行、
    以及夹在中间的注释），按页聚合后交给切片接口渲染。这样即使某空解析失败，
    只要它落在本卷答案代码块里，仍会出现在原文图中，方便人工照着订正。
    """
    if not spans or not block:
        return
    first = min(s for s, _ in spans)
    last = max(e for _, e in spans)
    # 只在同一页内前后各带两行（保住 import / 末尾注释），绝不跨页扩到下一套题
    first_page, last_page = block[first].page_no, block[last].page_no
    lo, hi = first, last
    for _ in range(2):
        if lo > 0 and block[lo - 1].page_no == first_page:
            lo -= 1
    for _ in range(2):
        if hi < len(block) - 1 and block[hi + 1].page_no == last_page:
            hi += 1
    for ln in block[lo : hi + 1]:
        if not ln.bbox or _is_page_furniture(ln):
            continue
        sink.append(
            {
                "page_no": int(ln.page_no),
                "bbox": [int(v) for v in ln.bbox],
                "line_no": int(ln.line_no),
            }
        )


def align(
    paper_doc: NormDoc,
    answer_doc: NormDoc,
    red_spans: list[dict[str, Any]] | None = None,
    *,
    reviewed_all: bool = False,
    region_sink: list[dict[str, Any]] | None = None,
) -> PaperResult:
    """完整链路：检测空位 → 定位答案块 → 单行/跨行双通道抽取 → 回填 → 全对判定。

    ``region_sink`` 非空时，把本卷关联答案行的 (页码, bbox) 追加进去，供
    「参考答案原文」整卷切片使用；不改变 PaperResult 的序列化结构。
    """
    blanks, template = detect_blanks(paper_doc)
    paper_lines = paper_doc.code_lines()
    answer_lines = answer_doc.code_lines()
    start, end, location = locate_answer_block(answer_lines, paper_lines)
    block = answer_lines[start:end]

    conflicts: list[str] = []
    warnings: list[str] = []
    warnings.extend(paper_doc.warnings)
    warnings.extend(answer_doc.warnings)
    if location.get("warning"):
        warnings.append(location["warning"])

    # 保序双指针：只处理试卷中含空位的行，不按行号硬对齐（两份文档注释不同）。
    #
    # 关键：空位编号与模板行严格一一对应（每行 expected 个空，编号连续）。
    # 某行找不到答案时**留空并记住真实空号**，绝不把后面找到的答案顺延贴到
    # 前面的空位上——旧实现用 ``Answer(no=i+1)`` 按位置编号，中间漏一行就会
    # 让后续所有答案错位，且数量可能恰好对得上，极难发现。
    template_rows = [
        ln for ln in paper_lines if has_blank(split_comment(ln.text)[0])
    ]
    # 每行对应的全局空号预先算好：分组匹配成功时要一次消耗多行，
    # 但空号仍必须与 detect_blanks 的编号完全一致。
    row_nos: list[list[int]] = []
    _n = 1
    for _ln in template_rows:
        _cnt = len(list(BLANK_SPLIT_RE.finditer(split_comment(_ln.text)[0])))
        row_nos.append(list(range(_n, _n + _cnt)))
        _n += _cnt
    consumed: set[int] = set()
    cursor = 0
    by_no: dict[int, tuple[str, int, int, Any]] = {}
    used_spans: list[tuple[int, int]] = []
    joined_count = 0
    missing_labels: list[str] = []
    # 红色优先：答案文件中红色字体默认即正确答案，优先采用红色片段作为答案。
    # 仅当「过滤噪声后的红色片段数量 == 全部空位数量」时才整体启用，否则回退到
    # 现有模板对齐方案兜底（避免红色不完整 / 噪声导致答案错配）。
    red_plan: list[list[str]] | None = None
    if red_spans:
        _kept, _ = filter_red_spans(red_spans, paper_lines)
        _total = sum(len(_n) for _n in row_nos)
        if _kept and _total and len(_kept) == _total:
            _flat = [str(_s.get("text", "")) for _s in _kept]
            _plan: list[list[str]] = []
            _i = 0
            _ok = True
            for _nos in row_nos:
                _exp = len(_nos)
                if _i + _exp > len(_flat):
                    _ok = False
                    break
                _plan.append(_flat[_i:_i + _exp])
                _i += _exp
            if _ok:
                red_plan = _plan
                warnings.append("已优先采用答案文件中的红色字体作为各空正确答案。")
    for pos_i, line in enumerate(template_rows):
        if pos_i in consumed:
            continue
        code, _ = split_comment(line.text)
        nos = row_nos[pos_i]
        expected = len(nos)
        parts = BLANK_SPLIT_RE.split(normalize_code(code))
        first_const = parts[0] if parts and not _is_blank_token(parts[0]) else ""
        found: tuple[list[str], int, int] | None = None

        # 红色优先：本卷若用红色字体标注了正确答案，直接采用，跳过模板对齐通道
        if red_plan is not None:
            _ra = red_plan[pos_i]
            if _ra and len(_ra) == expected and all(_ra):
                found = (_ra, -1, -1)

        # 通道 0（优先）：试卷模板**自身**折了行（一条语句拆成多行、每行
        # 各带空位），且原件字面与模板略有出入时，先把连续续行合成一条逻辑
        # 行做整组匹配。必须优先于单行：否则首行会先命中并「吃掉」答案逻辑
        # 行的开头，后续折行再也够不到（1.1.5 的 between(... ) 四连行）。
        # 整组要求全部空都命中且首个常量段精确，失败自动回退通道 1 / 2。
        if found is None and len(block) > 1 and _template_continues(line.text):
            group = [line]
            j = pos_i + 1
            while (
                j < len(template_rows)
                and len(group) < MAX_TEMPLATE_GROUP
                and j not in consumed
                and _template_continues(template_rows[j - 1].text)
            ):
                group.append(template_rows[j])
                j += 1
            if len(group) > 1:
                joined_tpl = "".join(ln.text.strip() for ln in group)
                group_nos = [n for k in range(pos_i, j) for n in row_nos[k]]
                gparts = BLANK_SPLIT_RE.split(normalize_code(joined_tpl))
                gconst = gparts[0] if gparts and not _is_blank_token(gparts[0]) else ""
                if len(gconst) >= 4:
                    for start in range(cursor, min(len(block), cursor + MAX_JOIN_START_SPAN)):
                        if has_blank(split_comment(block[start].text)[0]):
                            continue
                        head = normalize_code(block[start].text)
                        if not head or not _const_prefix_ok(head, gconst):
                            continue
                        buf = ""
                        for end in range(start, min(len(block), start + MAX_JOIN_LINES)):
                            part = block[end].text or ""
                            if has_blank(split_comment(part)[0]) or _is_page_furniture(block[end]):
                                continue
                            if not part.lstrip().startswith("#"):
                                buf += part
                            if not buf or end == start:
                                continue
                            try:
                                ganswers = extract_answers(joined_tpl, buf, fuzzy=True)
                            except AlignmentConflict:
                                continue
                            if len(ganswers) == len(group_nos) and all(ganswers):
                                found = (ganswers, start, end)
                                nos = group_nos
                                for k in range(pos_i + 1, j):
                                    consumed.add(k)
                                break
                        if found:
                            break

        # 通道 1：单行匹配（分组已命中时跳过，避免重复消费同一批答案行）
        for idx in (range(cursor, len(block)) if found is None else []):
            # 答案行自身若还带空位标记，说明是未填写的空白卷，不能当答案
            if has_blank(split_comment(block[idx].text)[0]):
                continue
            try:
                answers = extract_answers(line.text, block[idx].text)
            except AlignmentConflict:
                continue
            if len(answers) == expected and all(item for item in answers):
                found = (answers, idx, idx)
                break

        # 通道 2：跨行 / 跨页匹配。PDF 把长列表、长字符串、甚至 ``变量名`` /
        # ``=`` / ``表达式`` 拆成三条物理行时，逐行永远凑不齐模板的常量段；
        # 把连续行拼成一条逻辑行再匹配即可。起点只需与模板首个常量段**互为
        # 前缀**（旧实现要求 startswith 全常量段，``sensor_stats`` 单独成行时
        # 会直接被跳过）。页眉页脚不参与拼接，避免污染常量段。
        if found is None and len(block) > 1:
            start_limit = min(len(block), cursor + MAX_JOIN_START_SPAN)
            for start in range(cursor, start_limit):
                if has_blank(split_comment(block[start].text)[0]):
                    continue
                head = normalize_code(block[start].text)
                if not head or not _const_prefix_ok(head, first_const):
                    continue
                buf = ""
                for end in range(start, min(len(block), start + MAX_JOIN_LINES)):
                    part = block[end].text or ""
                    if has_blank(split_comment(part)[0]):
                        break
                    if _is_page_furniture(block[end]):
                        continue
                    # 注释不参与拼接（split_comment 会在 # 处截断），但窗口继续
                    if not part.lstrip().startswith("#"):
                        buf += part
                    if not buf or end == start:
                        continue
                    try:
                        answers = extract_answers(line.text, buf)
                    except AlignmentConflict:
                        continue
                    if len(answers) == expected and all(item for item in answers):
                        found = (answers, start, end)
                        break
                if found:
                    break

        # 折行整组匹配已在通道 0 优先尝试，这里不再重复计算。

        if found is None:
            label = ",".join(f"B{n}" for n in nos)
            missing_labels.append(label)
            conflicts.append(f"L{line.line_no}（{label}）未找到可对齐的答案行")
            continue
        answers, idx, end = found
        if end > idx:
            joined_count += 1
        used_spans.append((idx, end))
        cursor = end + 1
        for no, item in zip(nos, answers):
            if idx >= 0 and end >= 0 and 0 <= idx < len(block):
                _src = block[idx].line_no
                _pno = block[idx].page_no
                _bbox = block[idx].bbox
            else:
                _src = _pno = _bbox = None
            by_no[no] = (item, _src, _pno, _bbox)

    if joined_count:
        warnings.append(
            f"有 {joined_count} 处答案在原件里被折成多行/跨页，已合并连续行完成对齐"
        )
    if region_sink is not None:
        collect_answer_region(block, used_spans, region_sink)

    # 只创建真正找到的答案，no 保留检测阶段的全局编号；缺失的空位不占位、
    # 不产生答案对象，因此 ``len(answers)`` 始终等于真实召回数。
    answer_objects = [
        Answer(
            no=no, raw=raw, normalized=squash(raw), source_line=src,
            page_no=pno, bbox=bbox,
        )
        for no, (raw, src, pno, bbox) in sorted(by_no.items())
    ]

    # 颜色通道只作高置信线索：与模板通道不一致时记警告，不静默采信
    kept, dropped = filter_red_spans(red_spans or [], paper_lines)
    if kept:
        diff_keys = [a.normalized for a in answer_objects]
        unmatched = []
        for span in kept:
            key = squash(span.get("text") or "")
            if not any(key and (key in item or item in key) for item in diff_keys):
                unmatched.append(key)
        if unmatched:
            warnings.append(
                f"颜色通道有 {len(unmatched)} 个片段与模板通道不一致，已交人工复核"
            )

    if len(answer_objects) != len(blanks):
        hint = "、".join(missing_labels[:8]) + ("…" if len(missing_labels) > 8 else "")
        conflicts.append(
            f"空位数 {len(blanks)} 与答案数 {len(answer_objects)} 不一致"
            f"（缺失 {hint}；已按真实空号保留，禁止顺延补齐）"
        )

    # 按真实空号查答案，绝不按列表下标贴位置
    ans_by_no = {a.no: a for a in answer_objects}
    checks: list[Check] = []
    for blank in blanks:
        answer = ans_by_no.get(blank.no)
        found = bool(answer and (answer.raw or "").strip())
        filled = answer.raw if found else ""
        role_pass = role_ok(blank.role_expected, filled)
        checks.append(
            Check(
                blank_no=blank.no,
                answer_no=answer.no if found else None,
                match_score=1.0 if found else 0.0,
                filled_raw=filled,
                role_expected=blank.role_expected,
                role_ok=role_pass,
                result="pass" if (found and role_pass) else "fail",
                needs_review=blank.needs_review or not (found and role_pass),
                note=blank.role_hint,
            )
        )

    code_filled = fill(template, {a.no: a.raw for a in answer_objects})
    result = PaperResult(
        blanks=blanks,
        answers=answer_objects,
        checks=checks,
        conflicts=conflicts,
        warnings=warnings,
        code_template=template,
        code_filled=code_filled,
        located_range=(start, end),
        color_evidence=len(kept),
        status="filled",
    )
    passed, detail = verify(result, reviewed_all=reviewed_all)
    result.passed = passed
    result.status = "passed" if passed else "reviewing"
    result.detail = detail
    return result


def verify(result: PaperResult, *, reviewed_all: bool = False) -> tuple[bool, dict[str, Any]]:
    """严格 all-or-nothing：每个空都填好且正确，整卷才通过。

    strict 模式下不要求回填代码可编译——答案本来就不带空格，能编译不是
    验收标准。低置信度项必须人工确认（``reviewed_all``）。
    """
    checks = result.checks
    conditions = {
        "空位已检出": len(result.blanks) > 0,
        "数量一致": len(result.answers) == len(result.blanks),
        "无对齐冲突": not result.conflicts,
        "全部已绑定": all(
            c.answer_no is not None and c.match_score >= 0.7 for c in checks
        ),
        "全部已填写": all((c.filled_raw or "").strip() for c in checks),
        "逐空一致": all(c.result == "pass" for c in checks),
        "语法角色匹配": all(c.role_ok for c in checks),
        "无残留占位符": "{{" not in result.code_filled,
        "低置信度已复核": reviewed_all or not any(c.needs_review for c in checks),
    }
    passed = all(conditions.values())
    return passed, {
        "conditions": conditions,
        "total_blanks": len(result.blanks),
        "total_answers": len(result.answers),
        "passed_count": sum(1 for c in checks if c.result == "pass"),
        "conflicts": list(result.conflicts),
        "color_evidence": result.color_evidence,
        "render_mode": "strict",
    }


# ---------------------------------------------------------------------------
# 大模型二次核对（v1.4.2，可选）：与图片识别（OCR）是两个独立通道
# ---------------------------------------------------------------------------
def _parse_llm_list(text: str) -> list[dict[str, Any]]:
    """从模型输出里尽力解析出一个 JSON 数组（容错版）。"""
    text = (text or "").strip()
    if not text:
        return []
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < 0 or end <= start:
        return []
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _title_has_name(t: str) -> bool:
    """标题是否「带名字」：含汉字且不只是纯编号（如 1.1.4）。"""
    if not t:
        return False
    t = t.strip()
    if re.fullmatch(r"\s*\d+(?:\.\d+)*\s*", t):
        return False
    return bool(re.search(r"[\u4e00-\u9fff]", t))


def _parse_channel_enabled() -> bool:
    """整卷解析大模型通道（parse scope）是否已启用且配置了生效模型。"""
    try:
        import llm_client
    except Exception:
        return False
    try:
        cfg = llm_client.load_config("parse")
    except Exception:
        return False
    if not cfg.get("enabled"):
        return False
    active = llm_client.get_active("parse")
    return bool(active and active.get("base_url") and active.get("api_key") and active.get("model"))


def _chunk_text(text: str, size: int) -> list[str]:
    """按行把长文本切成不超过 size 字符的块，供大模型分块处理。"""
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    cur = ""
    for ln in text.splitlines():
        if cur and len(cur) + len(ln) + 1 > size:
            chunks.append(cur)
            cur = ln
        else:
            cur = (cur + "\n" + ln) if cur else ln
    if cur:
        chunks.append(cur)
    return chunks or [text]


def llm_augment_titles(
    doc: NormDoc, sections: list[NormDoc], paper_key: str = ""
) -> list[NormDoc] | None:
    """用「整卷解析大模型」为规则切出的答案区段补全/修正标题。

    只把每段开头若干行发给模型，让其返回 ``{section_index, no, title}``，
    **绝不重生成代码**——标题写回后区段仍保留规则切出的真实代码，答案抽取零风险。
    任一环节失败都返回 ``None``，调用方继续走规则结果。仅当标题确有改善才返回新列表。
    """
    if not sections:
        return None
    try:
        import llm_client
    except Exception:
        return None
    cfg = llm_client.load_config("parse")
    if not cfg.get("enabled"):
        return None
    active = llm_client.get_active("parse")
    if not (active and active.get("base_url") and active.get("api_key") and active.get("model")):
        return None

    items = [
        {"section_index": i, "head_preview": "\n".join((ln.text or "") for ln in s.lines()[:10])[:300]}
        for i, s in enumerate(sections)
    ]
    prompt = (
        "你是试卷答案整理助手。下面是一份整卷答案里若干「答案区段」的开头若干行。"
        "请识别每个区段对应的试卷「编号」与「完整标题」（如 1.1.4 智能医疗系统中的业务数据处理流程设计）。\n"
        "编号通常是 x.y.z 形式；标题是紧随其后的中文名称。若开头行里没有编号/标题，请尽量从该区段正文推断，推断不出就留空。\n"
        "只输出一个 JSON 数组，不要解释、不要 Markdown 代码块，例如：\n"
        '[{"section_index":0,"no":"1.1.4","title":"智能医疗系统中的业务数据处理流程设计"}]\n'
        "待识别区段：\n" + json.dumps(items, ensure_ascii=False)
    )
    text, err = llm_client.chat([{"role": "user", "content": prompt}], cfg=active)
    if err:
        return None
    parsed = _parse_llm_list(text)
    if not parsed:
        return None
    by_idx = {it.get("section_index"): it for it in parsed if isinstance(it, dict)}
    new_secs: list[NormDoc] = []
    improved = False
    for i, s in enumerate(sections):
        it = by_idx.get(i)
        if not isinstance(it, dict):
            new_secs.append(s)
            continue
        no = str(it.get("no") or "").strip()
        title = str(it.get("title") or "").strip()
        if not (no or title):
            new_secs.append(s)
            continue
        display = ingest._clean_title(f"{no} {title}".strip() if no else title)
        if not display:
            new_secs.append(s)
            continue
        if display != (s.meta.get("section_title_display") or ""):
            new_secs.append(
                NormDoc(
                    doc_id=s.doc_id,
                    kind=s.kind,
                    source_type=s.source_type,
                    language=s.language,
                    pages=s.pages,
                    warnings=s.warnings,
                    meta={**s.meta, "section_title": display, "section_title_display": display},
                )
            )
            improved = True
        else:
            new_secs.append(s)
    return new_secs if improved else None


def llm_split_answer_book(doc: NormDoc, paper_key: str = "") -> list[NormDoc] | None:
    """用「整卷解析大模型」对整本答案做拆卷 + 标题解析（规则切分彻底失败时的兜底）。

    适用：规则 ``split_answer_book`` 完全切不开（只得到 1 段、却可能内含多套试卷）。
    模型返回每套的 ``{no, title, code}``，据此构建与规则同形的 ``NormDoc`` 区段。
    大文档按行分块发给模型逐块解析再合并。任一失败返回 ``None``。
    """
    try:
        import llm_client
    except Exception:
        return None
    cfg = llm_client.load_config("parse")
    if not cfg.get("enabled"):
        return None
    active = llm_client.get_active("parse")
    if not (active and active.get("base_url") and active.get("api_key") and active.get("model")):
        return None

    text = "\n".join((ln.text or "") for ln in doc.lines())
    chunks = _chunk_text(text, 6000)
    collected: list[NormDoc] = []
    for ci, ch in enumerate(chunks):
        prompt = (
            "你是试卷答案拆卷助手。下面是一份编程考试答案文档（可能含多套试卷）。"
            "请按「编号 + 标题」把文档切成若干区段，每套试卷一段。\n"
            "编号通常是 x.y.z 形式（如 1.1.4），标题是紧随其后的中文名称。\n"
            "对每套试卷，请如实抄录其答案代码（务必保持缩进与空行），并给出编号与标题。\n"
            "只输出一个 JSON 数组，不要解释、不要 Markdown 代码块，例如：\n"
            '[{"no":"1.1.4","title":"智能医疗系统中的业务数据处理流程设计",'
            '"code":"import pandas as pd\\nX_train, X_test = train_test_split(____, random_state=42)"}]\n'
            "若只有一套试卷，也输出一个元素的数组。\n"
            f"这是第 {ci + 1}/{len(chunks)} 块：\n" + ch
        )
        out, err = llm_client.chat([{"role": "user", "content": prompt}], cfg=active)
        if err:
            continue
        parsed = _parse_llm_list(out)
        for it in parsed:
            if not isinstance(it, dict):
                continue
            no = str(it.get("no") or "").strip()
            title = str(it.get("title") or "").strip()
            code = str(it.get("code") or "")
            if not (no or title) and not code.strip():
                continue
            display = ingest._clean_title(f"{no} {title}".strip() if no else title)
            lines = [
                CodeLine(page_no=1, line_no=k + 1, text=ln, kind="code")
                for k, ln in enumerate(code.splitlines())
            ]
            collected.append(
                NormDoc(
                    doc_id=f"{doc.doc_id}-llm{len(collected)}",
                    kind="answer",
                    source_type=doc.source_type,
                    language=doc.language,
                    pages=[lines],
                    meta={
                        "section_title": display,
                        "section_title_display": display,
                        "red_spans": [],
                        "llm_split": True,
                    },
                )
            )
    return collected or None


def llm_assist(
    result: PaperResult,
    paper_doc: NormDoc,
    answer_doc: NormDoc,
    *,
    model: Any | None = None,
) -> tuple[PaperResult, bool, list[str]]:
    """可选大模型：**只补齐规则没找到的空位**（免费额度友好、双路径健壮）。

    与图片识别（OCR）是两条完全独立的通道，这里读的是「整卷解析」parse 通道。
    设计约束：

    - 规则链路永远先跑完整；关掉大模型时结果与开启时**同源**，不会崩、不会空。
    - 规则已找齐 → **零调用**，不消耗免费额度（旧实现每次都整体复核一遍）。
    - 只在有缺口时调用 1 次，且只写缺失空号，**绝不改写已抽出的答案**
      （旧实现会改写所有答案，免费模型常把正确答案改坏）。
    - 任何未启用 / 未配置 / 超时 / 异常 / 不可解析都静默降级为规则结果。
    """
    if not result.blanks:
        return result, False, ["没有可核对的空位，跳过大模型"]

    found_nos = {a.no for a in result.answers if (a.raw or "").strip()}
    missing = [b for b in result.blanks if b.no not in found_nos]
    if not missing:
        return result, False, [
            f"规则已找齐 {len(result.blanks)}/{len(result.blanks)} 个空，"
            "未调用大模型（已节省本次额度）"
        ]

    try:
        import llm_client
    except Exception:
        return result, False, ["大模型模块不可用，保留规则结果"]

    cfg = llm_client.load_config("parse")
    if not cfg.get("enabled"):
        return result, False, [
            f"规则尚有 {len(missing)} 个空未找到；整卷解析大模型未启用，"
            "保留规则结果（设置 → 大模型 → ② 整卷解析大模型）"
        ]
    active = llm_client.get_active("parse")
    if not active or not all(active.get(k) for k in ("base_url", "api_key", "model")):
        return result, False, ["未配置生效的「整卷解析大模型」，保留规则结果"]

    # 给模型的是「缺失空的试卷模板行」+「已定位到本卷的答案原件区段」，
    # 而不是凭空猜：原件常有 PDF 抽取抖动（字符间空格 / 折行 / 括号笔误）。
    paper_by_line = {ln.line_no: ln.text for ln in paper_doc.code_lines()}
    items = [
        {
            "no": b.no,
            "template_line": (paper_by_line.get(b.line_no) or "")[:200],
            "context_left": (b.context_left or "")[-60:],
            "context_right": (b.context_right or "")[:60],
            "role": b.role_expected,
        }
        for b in missing
    ]
    # 智谱 Flash 免费且上下文宽裕：把已定位区段的答案原文接近全文地交给模型，
    # 不再只截前 9000 字符；跨页、长列表、末尾几题也有机会被对照补全。
    # 60k 只是防止极端大文档把请求打爆的保险，正常单卷远小于此。
    excerpt = "\n".join((ln.text or "") for ln in answer_doc.code_lines())[:60000]
    prompt = (
        "你是代码填空题的答案抽取助手。规则解析已从下面的「答案原件」里抽出大部分空的答案，"
        "但仍有几个空没找到对应行。请只针对这些缺失空，结合「试卷模板行」与「答案原件」"
        "判断该空应填的代码片段。\n"
        "注意：答案原件可能是 PDF 抽取质量差的结果（字符间被插入空格、长行被折行、"
        "括号或参数与试卷模板略有出入），请据语义还原，不要照抄乱码。\n"
        "只输出一个 JSON 数组，不要解释、不要 Markdown 代码块，例如：\n"
        '[{"no":14,"answer":"data[\'Speed\'].between","ok":true}]\n'
        "规则：answer 只写该空对应的填空内容，不要重复上下文、不要写整行代码；"
        "没有把握就返回 ok=false 且 answer 留空，绝对不要编造答案。\n"
        "缺失空位：\n" + json.dumps(items, ensure_ascii=False) +
        "\n答案原件：\n" + excerpt
    )
    # 独立线程的墙钟看门狗：即使远端完全不响应，也只等 wall 秒就带着规则结果
    # 正常封卷。后台线程会自行结束，不阻塞主线程（线程池最多 2 个并发）。
    # 模型端不限制 token，输出预算保底 4096（截断时 llm_client 自动升到 8192）；
    # 强制思考模型（GLM-5.3/4.7）内部推理耗时更长，单独放宽超时与墙钟。
    fast = dict(active)
    _model_name = str(active.get("model") or "").lower()
    thinking = ("glm-5.3" in _model_name) or ("glm-4.7" in _model_name)
    fast["max_tokens"] = max(int(active.get("max_tokens") or 2048), 4096)
    fast["timeout"] = min(int(active.get("timeout") or 60), 100 if thinking else 40)
    wall = LLM_ASSIST_WALL_TIMEOUT_THINKING if thinking else LLM_ASSIST_WALL_TIMEOUT
    try:
        fut = _ASSIST_EXECUTOR.submit(
            llm_client.chat,
            [{"role": "user", "content": prompt}],
            fast,
        )
        text, err = fut.result(timeout=wall)
    except concurrent.futures.TimeoutError:
        return result, False, [
            f"大模型 {wall}s 未响应，已跳过并保留规则结果"
            "（可在质检页逐空订正；不影响本次入库）"
        ]
    except Exception as exc:  # noqa: BLE001 - 大模型异常绝不影响封卷
        return result, False, [f"大模型调用异常，保留规则结果：{type(exc).__name__}"]
    if err:
        return result, False, [f"大模型调用失败，保留规则结果：{err[:120]}"]
    parsed = _parse_llm_list(text)
    if not parsed:
        return result, False, ["大模型未返回可解析结果，保留规则结果"]

    missing_nos = {b.no for b in missing}
    by_no = {it.get("no"): it for it in parsed if isinstance(it, dict)}
    added: list[Answer] = []
    notes: list[str] = []
    for no in sorted(missing_nos):
        it = by_no.get(no)
        if not it or it.get("ok") is False:
            continue
        cand = (it.get("answer") or "").strip()
        if not cand or len(cand) > 200 or BLANK_SPLIT_RE.search(cand):
            continue
        # 大模型补全没有原文坐标，confidence 降级并强制人工复核
        added.append(Answer(no=no, raw=cand, normalized=squash(cand), confidence=0.6))
        notes.append(f"B{no} 由大模型补齐：{cand}")
    if not added:
        return result, False, ["大模型未能给出可信补全，保留规则结果（可在质检页逐空订正）"]

    new_answers = sorted(result.answers + added, key=lambda a: a.no)
    ans_by_no = {a.no: a for a in new_answers}
    new_checks: list[Check] = []
    llm_nos = {a.no for a in added}
    for blank in result.blanks:
        answer = ans_by_no.get(blank.no)
        found = bool(answer and (answer.raw or "").strip())
        filled = answer.raw if found else ""
        role_pass = role_ok(blank.role_expected, filled)
        new_checks.append(
            Check(
                blank_no=blank.no,
                answer_no=answer.no if found else None,
                match_score=1.0 if found else 0.0,
                filled_raw=filled,
                role_expected=blank.role_expected,
                role_ok=role_pass,
                result="pass" if (found and role_pass) else "fail",
                needs_review=blank.needs_review or blank.no in llm_nos or not (found and role_pass),
                note=blank.role_hint,
            )
        )
    result.answers = new_answers
    result.checks = new_checks
    result.code_filled = fill(result.code_template, {a.no: a.raw for a in new_answers})
    # 规则阶段的「未找到 / 数量不一致」已被补齐，但补齐项无原文坐标，
    # 换成一条明确待复核的冲突，避免质检页同时显示互相矛盾的两条结论。
    result.conflicts = [
        c for c in result.conflicts
        if "未找到可对齐的答案行" not in c and "与答案数" not in c
    ]
    result.conflicts.append(
        f"{len(added)} 个空由大模型补齐（无原文坐标），请在质检页人工复核"
    )

    model_label = f"{active.get('name', '')} · {active.get('model', '')}".strip(" ·")
    notes.insert(0, f"整卷解析大模型补齐 {len(added)}/{len(missing)} 个规则未命中的空（{model_label}）；这些空无原文坐标，已标记人工复核")
    return result, True, notes


def result_from_run(run: dict) -> PaperResult:
    """从 ``store.get_run`` 返回的字典重建内存 ``PaperResult``，供定向重调等二次处理。"""
    blanks = [
        Blank(
            no=b.get("global_no", 0),
            slot_id=b.get("slot_id") or "",
            page_no=b.get("page_no") or 0,
            line_no=b.get("line_no") or 0,
            col=b.get("col") or 0,
            context_left=b.get("context_left") or "",
            context_right=b.get("context_right") or "",
            role_expected=b.get("role_expected") or "expr",
            role_hint=b.get("role_hint") or "",
            kind=b.get("kind") or "line",
            confidence=b.get("confidence") or 1.0,
            needs_review=bool(b.get("needs_review")),
        )
        for b in run.get("blanks", [])
    ]
    answers = [
        Answer(
            no=a.get("seq", 0),
            raw=a.get("raw") or "",
            normalized=a.get("normalized") or squash(a.get("raw") or ""),
            color_marked=bool(a.get("color_marked")),
            source_line=a.get("source_line") or 0,
            confidence=a.get("confidence") or 1.0,
        )
        for a in run.get("answers", [])
    ]
    checks = [
        Check(
            blank_no=c.get("blank_no"),
            answer_no=c.get("answer_no"),
            match_score=c.get("match_score") or 0.0,
            filled_raw=c.get("filled_raw") or "",
            role_expected=c.get("role_expected") or "expr",
            role_ok=bool(c.get("role_ok")),
            result=c.get("result") or "fail",
            needs_review=bool(c.get("needs_review")),
            note=c.get("note") or "",
        )
        for c in run.get("checks", [])
    ]
    return PaperResult(blanks=blanks, answers=answers, checks=checks, status=run.get("status", "verified"))


def llm_assist_targeted(
    result: PaperResult,
    *,
    target: dict | None = None,
    extra_prompt: str = "",
    answer_excerpt: str = "",
    model: Any | None = None,
) -> tuple[PaperResult, bool, list[str]]:
    """定向二次核对：只针对某一个空位（按 ``no`` 空号 或 ``line`` 源行号指定），
    附带用户补充提示词与「本卷参考答案原件」，让大模型对照原件判断该空当前
    答案是否被抽取错（截断 / 夹带代码 / 串行 / 数值不一致），明显有误才回写。
    只回写这一个空，不影响其它空。需启用并配置「整卷解析大模型」通道。

    ``answer_excerpt`` 为空（旧卷没保留答案原件）时仍可调用，但提示词会要求
    模型在无依据时保持原样，避免凭语法猜答案。
    """
    if not result.blanks:
        return result, False, ["没有可核对的空位，跳过大模型复核"]

    ttype = (target or {}).get("type") or "no"
    tval = (target or {}).get("value")
    if tval is None or tval == "":
        return result, False, ["未指定目标空位（target.value 为空）"]

    line_to_no = {a.source_line: a.no for a in result.answers if a.source_line}
    blank = None
    if ttype == "line":
        no_by_line = line_to_no.get(int(tval)) if str(tval).isdigit() else None
        blank = next((b for b in result.blanks if b.no == no_by_line), None) if no_by_line else None
    else:
        blank = next((b for b in result.blanks if b.no == int(tval)), None) if str(tval).isdigit() else None
    if blank is None:
        return result, False, [f"找不到指定的空位（{ttype}={tval}）"]

    try:
        import llm_client
    except Exception:
        return result, False, ["大模型模块不可用，无法定向重调"]

    # 注意：读取的是「整卷解析」通道，不是图片识别（OCR）那条通道
    cfg = llm_client.load_config("parse")
    if not cfg.get("enabled"):
        return result, False, ["整卷解析大模型未启用，无法定向重调（设置 → 大模型 → ② 整卷解析大模型）"]
    active = llm_client.get_active("parse")
    if not active or not active.get("base_url") or not active.get("api_key") or not active.get("model"):
        return result, False, ["未配置生效的整卷解析大模型，无法定向重调"]

    chk = next((c for c in result.checks if c.blank_no == blank.no), None)
    src_line = next((a.source_line for a in result.answers if a.no == blank.no), 0)
    item = {
        "no": blank.no,
        "line": src_line,
        "template_line": (blank.context_left or "")[-90:] +
                         " ▢ " + (blank.context_right or "")[:90],
        "context_left": (blank.context_left or "")[:120],
        "context_right": (blank.context_right or "")[:120],
        "role": blank.role_expected,
        "current_answer": (chk.filled_raw if chk else ""),
    }
    user_extra = (extra_prompt or "").strip()
    prompt = (
        "你是代码填空题的答案核对助手。下面只给了一个空位，以及本卷的参考答案原件。\n"
        "请对照「参考答案原件」与「试卷上下文」，判断该空当前抽取出的答案是否明显错误："
        "被截断、夹带了相邻代码或标点、串到了别的空、或与原件里的变量名 / 数值不一致。\n"
        "若当前答案与原件一致、或没有把握，请保持原样；若明显错误，给出原件里对应的填空内容。\n"
        "只输出一个 JSON 数组，不要解释、不要 Markdown 代码块，例如：\n"
        '[{"no":1,"answer":"修正后的答案","ok":true,"note":""}]\n'
        "规则：answer 只写该空对应的填空内容，不要重复上下文、不要写整行代码；"
        "除非确有把握，否则保持原答案不变；置信不足时 ok=false 且 answer 留空，绝对不要编造。\n"
        "待核对空位：\n" + json.dumps([item], ensure_ascii=False)
    )
    if answer_excerpt:
        # 智谱 Flash 不限制 token 且有免费额度：把接近全文的答案原件交给模型，
        # 让单空复核有据可依，而不是只凭语法猜。60k 只是防极端大文档的保险。
        prompt += (
            "\n本卷参考答案原件（PDF 抽取可能出现字符间空格 / 折行 / 括号笔误）：\n"
            + answer_excerpt[:60000]
        )
    else:
        prompt += "\n（本卷未保留答案原件，只能依据试卷上下文判断；没有把握请务必保持原样。）"
    if user_extra:
        prompt += "\n用户补充提示（请重点参考）：" + user_extra

    # 与入库补缺口同一套保护：输出预算保底 4096、强制思考模型单独放宽超时，
    # 并用独立线程的墙钟看门狗，避免模型排队时把「定向重解析」永久卡住。
    fast = dict(active)
    _mn = str(active.get("model") or "").lower()
    thinking = ("glm-5.3" in _mn) or ("glm-4.7" in _mn)
    fast["max_tokens"] = max(int(active.get("max_tokens") or 2048), 4096)
    fast["timeout"] = min(int(active.get("timeout") or 60), 100 if thinking else 40)
    wall = LLM_ASSIST_WALL_TIMEOUT_THINKING if thinking else LLM_ASSIST_WALL_TIMEOUT
    try:
        fut = _ASSIST_EXECUTOR.submit(
            llm_client.chat,
            [{"role": "user", "content": prompt}],
            fast,
        )
        text, err = fut.result(timeout=wall)
    except concurrent.futures.TimeoutError:
        return result, False, [
            f"大模型 {wall}s 未响应，已跳过定向重调（原答案保持不变）"
        ]
    except Exception as exc:  # noqa: BLE001 - 模型异常绝不影响本次复核
        return result, False, [f"大模型调用异常，原答案保持不变：{type(exc).__name__}"]
    if err:
        return result, False, [f"大模型调用失败：{err[:140]}"]
    parsed = _parse_llm_list(text)
    if not parsed:
        return result, False, ["大模型未返回可解析的核对结果，按原答案保留"]
    it = next((x for x in parsed if isinstance(x, dict) and x.get("no") == blank.no), None)
    if it is None and isinstance(parsed[0], dict):
        it = parsed[0]
    if not it:
        return result, False, ["大模型返回结构与预期不符，按原答案保留"]

    # 模型明确说「没把握」（ok=false）时，即便顺手给了个猜测也不能回写
    cand = "" if it.get("ok") is False else (it.get("answer") or "").strip()
    notes: list[str] = []
    current = chk.filled_raw if chk else ""
    if cand and cand != current and not BLANK_SPLIT_RE.search(cand) and len(cand) <= 200:
        for a in result.answers:
            if a.no == blank.no:
                a.raw = cand
                a.normalized = squash(cand)
                break
        else:
            # 该空原本没被规则抽到（answers 里缺这一条）：定向重解析同样可以补齐
            result.answers.append(
                Answer(no=blank.no, raw=cand, normalized=squash(cand), confidence=0.6)
            )
            result.answers.sort(key=lambda a: a.no)
        role_pass = role_ok(blank.role_expected, cand)
        for c in result.checks:
            if c.blank_no == blank.no:
                c.filled_raw = cand
                c.match_score = 1.0
                c.role_ok = role_pass
                c.result = "pass" if role_pass else "fail"
                c.needs_review = blank.needs_review or not role_pass
                c.note = blank.role_hint
                break
        else:
            result.checks.append(
                Check(
                    blank_no=blank.no, answer_no=blank.no, match_score=1.0,
                    filled_raw=cand, role_expected=blank.role_expected,
                    role_ok=role_pass, result="pass" if role_pass else "fail",
                    needs_review=True, note=blank.role_hint,
                )
            )
        model_label = f"{active.get('name', '')} · {active.get('model', '')}".strip(" ·")
        notes.append(f"B{blank.no} 定向重调为：{cand}（{model_label}）")
    else:
        notes.append(
            f"B{blank.no} 复核完成：原答案保持不变"
            + ("（已对照参考答案原件）" if answer_excerpt else "（本卷无答案原件）")
        )
    return result, True, notes



def grade_exam(
    blanks: list[dict[str, Any]],
    answer_key: dict[int, str],
    responses: dict[str, Any],
) -> dict[str, Any]:
    """逐空判分。答案只在服务端持有，交卷后才随结果下发。

    ``verify`` 判的是「答案参考文档有没有把卷子填对」（入库质检）；
    这里判的是「考生自己填的答案对不对」（考试）。两者互不替代。

    - 比对前用 :func:`squash` 去空白（沿用「答案不带空格」前提）
    - 允许标准答案用 ``||`` 写多个等价写法
    - 未作答只记 ``answered=False``，不抛异常、不给分
    """
    def display_context(value: Any) -> str:
        """一行多空时 context 里会夹着别的空位标记，展示时统一画成 ▢。"""
        return BLANK_SPLIT_RE.sub("▢", str(value or ""))

    results: list[dict[str, Any]] = []
    for blank in blanks:
        no = int(blank.get("global_no") or 0)
        raw_key = str(answer_key.get(no, "") or "")
        user = str(responses.get(str(no)) or responses.get(no) or "").strip()
        alternatives = [
            part.strip() for part in re.split(r"\|\||｜｜", raw_key) if part.strip()
        ] or [raw_key]
        user_norm = squash(user)
        is_correct = bool(user_norm) and any(
            user_norm == squash(alt) for alt in alternatives
        )
        results.append(
            {
                "no": no,
                "slot_id": blank.get("slot_id", ""),
                "context_left": display_context(blank.get("context_left")),
                "context_right": display_context(blank.get("context_right")),
                "role": blank.get("role_expected", "expr"),
                "user": user,
                "correct_answer": alternatives[0],  # 交卷后才下发
                "is_correct": is_correct,
                "answered": bool(user_norm),
            }
        )
    total = len(results)
    correct = sum(1 for item in results if item["is_correct"])
    answered = sum(1 for item in results if item["answered"])
    return {
        "total": total,
        "answered": answered,
        "correct": correct,
        "score": round(correct / total * 100) if total else 0,
        "passed": total > 0 and correct == total,
        "results": results,
    }
