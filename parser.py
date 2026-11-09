"""Turn OCR text lines into editable question drafts.

The parser is intentionally conservative: when a field cannot be inferred with
confidence it is left empty and a warning is attached, so the UI can ask the
user to confirm instead of silently storing a wrong answer.
"""
from __future__ import annotations

import re
from typing import Any

from keyword_extractor import extract_tag

LETTERS = "ABCDEFGH"
FULLWIDTH_MAP = str.maketrans(
    "ＡＢＣＤＥＦＧＨａｂｃｄｅｆｇｈ０１２３４５６７８９",
    "ABCDEFGHabcdefgh0123456789",
)

NOISE_EXACT = {
    "收起解析",
    "展开解析",
    "查看解析",
    "解析",
    "答案解析",
    "纠错",
    "收藏",
    "已收藏",
    "分享",
    "笔记",
    "答题卡",
    "上一题",
    "下一题",
    "提交",
    "交卷",
    "继续答题",
    "查看答案",
    "我的答案",
    "正确答案",
    "回答正确",
    "回答错误",
    "你答对了",
    "你答错了",
}

NOISE_CONTAINS = (
    "本题正确率",
    "全站正确率",
    "正确率：",
    "正确率:",
    "共",
    "题量",
    "剩余时间",
    "已用时",
    "点击查看",
    "展开",
)

ANSWER_RE = re.compile(
    r"(?:正确答案|参考答案|标准答案|答案)\s*(?:是|为)?\s*[:：]?\s*"
    r"([A-H](?:\s*[、,，/|]\s*[A-H])*|正确|错误|对|错|true|false)",
    re.IGNORECASE,
)
USER_ANSWER_RE = re.compile(
    r"你的答案\s*(?:是|为)?\s*[:：]?\s*"
    r"([A-H](?:\s*[、,，/|]\s*[A-H])*|正确|错误|对|错|true|false)",
    re.IGNORECASE,
)
EXPLANATION_RE = re.compile(r"^\s*(?:答案)?解析\s*[:：]?\s*(.*)$")
OPTION_START_RE = re.compile(r"^([A-H])\s*[.、．)）:：]\s*(.*)$")
OPTION_SPACE_RE = re.compile(r"^([A-H])\s+(.+)$")
OPTION_LABEL_ONLY_RE = re.compile(r"^([A-H])\s*[.、．)）:：]?\s*$")
INLINE_OPTION_RE = re.compile(r"(?<![A-Za-z])([A-H])\s*[.、．)）:：]\s*")
QSTART_RE = re.compile(
    r"^\s*(?:第\s*)?(\d{1,3})\s*(?:题)?\s*[.、．)）:：]\s*(.+)$"
)
QSTART_SPACE_RE = re.compile(r"^\s*(\d{1,3})\s+(.+)$")
QSTART_GLUED_RE = re.compile(
    r"^\s*(\d{1,3})(?=[\u4e00-\u9fff（(])(?![年月日个次人种元米斤克])(.{4,})$"
)
QSTART_ONLY_RE = re.compile(r"^\s*(\d{1,3})\s*$")
TRAILING_META_RE = re.compile(
    r"(?:正确答案|参考答案|标准答案|你的答案|你答对|你答错|回答正确|回答错误)"
)


def clean_text(value: str) -> str:
    text = (value or "").translate(FULLWIDTH_MAP)
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = text.replace("丨", "|")
    text = re.sub(r"[ \t]+", " ", text).strip()
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[，。；：、？！）】」》])", "", text)
    text = re.sub(r"(?<=[（【「《])\s+(?=[\u4e00-\u9fff])", "", text)
    text = re.sub(r"\s+([，。；：、？！])", r"\1", text)
    return text.strip()


# 中文排版里，视觉折行不等于语义换行。OCR 会把排版上折成两行的同一句话
# 识别成两行文本，这里按下面的规则把它们接回成一段连续文字：
#   · 中文之间直接相连（不加空格，符合中文排版）
#   · 中西文交界处补一个空格（避免 "O(nlog n)" 这类内容被粘住）
#   · 编号/选项列表项之间补空格（避免 "1. 数据2. 存储"）
_CJK_CHAR_RE = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]")
_LATIN_CHAR_RE = re.compile(r"[A-Za-z0-9]")
_LIST_START_RE = re.compile(
    r"^(\d+[.、．)）]|[A-Za-z][.、．)）]|[①-⑳]|[（(【\[]|[•▪◆※·])"
)
_LIST_END_RE = re.compile(
    r"(\d+[.、．)）]|[A-Za-z][.、．)）]|[①-⑳]|[（(【\[]|[•▪◆※])$"
)


def merge_wrapped_lines(text: str) -> str:
    """把 OCR 因排版折行产生的多行文本合并成一段连续文字。"""
    lines = [line.strip() for line in (text or "").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    out = lines[0]
    for index in range(1, len(lines)):
        prev_line = lines[index - 1]
        current = lines[index]
        prev_char = out[-1]
        current_char = current[0]
        needs_space = bool(
            _LIST_START_RE.match(current)
            or _LIST_END_RE.search(prev_line)
            or (_LATIN_CHAR_RE.match(prev_char) and _LATIN_CHAR_RE.match(current_char))
            or (_CJK_CHAR_RE.match(prev_char) and _LATIN_CHAR_RE.match(current_char))
            or (_LATIN_CHAR_RE.match(prev_char) and _CJK_CHAR_RE.match(current_char))
        )
        out += (" " if needs_space else "") + current
    return out


def is_noise(text: str) -> bool:
    if not text:
        return True
    if text in NOISE_EXACT:
        return True
    if any(word in text for word in ("收起解析", "展开解析", "查看解析")):
        return True
    if len(text) <= 8 and any(word == text for word in ("A", "B", "C", "D")):
        return False
    if any(word in text for word in NOISE_CONTAINS):
        return True
    return False


def normalize_letters(value: str) -> str:
    letters = sorted(set(re.findall(r"[A-H]", (value or "").upper())))
    return "".join(letters)


def qstart(text: str) -> tuple[str, str] | None:
    match = QSTART_RE.match(text)
    if match:
        return match.group(1), match.group(2).strip()
    match = QSTART_SPACE_RE.match(text)
    if match:
        return match.group(1), match.group(2).strip()
    match = QSTART_GLUED_RE.match(text)
    if match:
        return match.group(1), match.group(2).strip()
    match = QSTART_ONLY_RE.match(text)
    if match:
        return match.group(1), ""
    return None


def option_start_index(lines: list[str]) -> int | None:
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if OPTION_LABEL_ONLY_RE.match(stripped):
            # A lone label is only an option when a following non-label line exists.
            if any(not OPTION_LABEL_ONLY_RE.match(n.strip()) for n in lines[index + 1 :]):
                return index
        if OPTION_START_RE.match(stripped):
            return index
        if OPTION_SPACE_RE.match(stripped):
            return index
        matches = list(INLINE_OPTION_RE.finditer(stripped))
        if len(matches) >= 3 and matches[0].start() == 0:
            return index
    return None


def split_inline_options(text: str) -> list[tuple[str, str]]:
    matches = list(INLINE_OPTION_RE.finditer(text))
    if len(matches) < 2 or matches[0].start() != 0:
        return []
    result: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        content = text[match.end() : end].strip(" ，,；;")
        result.append((match.group(1), content))
    return result


def parse_options(lines: list[str]) -> dict[str, str]:
    options: dict[str, str] = {}
    pending: str | None = None
    last_letter: str | None = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        inline = split_inline_options(line)
        if inline:
            for letter, content in inline:
                content = clean_text(content)
                if content:
                    options[letter] = content
                    last_letter = letter
            pending = None
            continue

        label_only = OPTION_LABEL_ONLY_RE.match(line)
        if label_only:
            pending = label_only.group(1)
            last_letter = pending
            continue

        match = OPTION_START_RE.match(line) or OPTION_SPACE_RE.match(line)
        if match:
            letter = match.group(1)
            content = clean_text(match.group(2))
            if content:
                options[letter] = content
                last_letter = letter
            else:
                pending = letter
            continue

        if pending:
            content = clean_text(line)
            if content:
                options[pending] = content
                last_letter = pending
            pending = None
        elif last_letter and line and not ANSWER_RE.search(line):
            sep = "" if re.search(r"[\u4e00-\u9fff]$", options.get(last_letter, "")) else " "
            options[last_letter] = (options.get(last_letter, "") + sep + clean_text(line)).strip()

    return {letter: value for letter, value in sorted(options.items()) if value}


TF_LABELS = {"对", "错", "正确", "错误", "true", "false", "t", "f", "√", "×"}


def truefalse_value(raw: str, options: dict[str, str] | None = None) -> str:
    """Normalize any true/false marker to 正确 or 错误."""
    text = clean_text(raw)
    if not text:
        return ""
    options = options or {}
    upper = text.upper()
    if upper in options and clean_text(options[upper]) in TF_LABELS:
        text = clean_text(options[upper])
    normalized = text.lower()
    if normalized in ("对", "正确", "true", "t", "√", "1", "yes"):
        return "正确"
    if normalized in ("错", "错误", "false", "f", "×", "0", "no"):
        return "错误"
    # With no explicit option labels, A/B is the conventional true/false mapping.
    if normalized == "a":
        return "正确"
    if normalized == "b":
        return "错误"
    return ""


def answer_value(raw: str, options: dict[str, str], qtype: str) -> str:
    if not raw:
        return ""
    text = clean_text(raw)
    if qtype == "truefalse":
        return truefalse_value(text, options)
    letters = normalize_letters(text)
    return letters or text


def answers_equal(answer: str, user: str, qtype: str) -> bool:
    if qtype == "truefalse":
        return bool(truefalse_value(answer)) and truefalse_value(answer) == truefalse_value(user)

    def norm(value: str) -> str:
        value = (value or "").strip().upper()
        if qtype == "fill":
            value = re.sub(r"\s+", "", value)
            value = value.strip("。．.，,；;：:")
            return value
        return normalize_letters(value) or value

    left, right = norm(answer), norm(user)
    if not left or not right:
        return False
    if qtype == "fill":
        alternatives = [part.strip() for part in re.split(r"\|\||｜｜", left) if part.strip()]
        return right in alternatives or left == right
    return left == right


def infer_type(options: dict[str, str], answer: str) -> str:
    answer_text = clean_text(answer).lower()
    answer_is_tf = answer_text in TF_LABELS
    if not options:
        return "truefalse" if answer_is_tf else "fill"
    labels = {k: clean_text(v) for k, v in options.items()}
    if len(labels) == 2 and set(labels.values()) <= {"正确", "错误", "对", "错"}:
        return "truefalse"
    if answer_is_tf:
        return "truefalse"
    letters = normalize_letters(answer)
    if len(letters) > 1:
        return "multiple"
    return "single"


def _strip_qstart(lines: list[str]) -> tuple[str, list[str]]:
    if not lines:
        return "", []
    first = lines[0]
    match = qstart(first)
    if not match:
        return "", lines
    number, rest = match
    rest_lines = ([rest] if rest else []) + lines[1:]
    return number, rest_lines


def _metadata_kind(line: str) -> str:
    if ANSWER_RE.search(line):
        return "answer"
    if USER_ANSWER_RE.search(line):
        return "user"
    if TRAILING_META_RE.search(line):
        return "footer"
    if EXPLANATION_RE.match(line):
        return "explanation"
    return ""


def parse_segment(lines: list[str], image_url: str = "", avg_score: float = 1.0) -> dict[str, Any]:
    number, body = _strip_qstart([clean_text(line) for line in lines if clean_text(line)])
    warnings: list[str] = []

    correct_answer = ""
    user_answer = ""
    explanation_parts: list[str] = []
    explanation_started = False
    answer_indices: list[int] = []
    user_indices: list[int] = []
    meta_indices: list[int] = []

    for index, line in enumerate(body):
        answer_match = ANSWER_RE.search(line)
        user_match = USER_ANSWER_RE.search(line)
        expl_match = EXPLANATION_RE.match(line)
        if answer_match:
            correct_answer = answer_match.group(1)
            answer_indices.append(index)
        if user_match:
            user_answer = user_match.group(1)
            user_indices.append(index)
        if expl_match:
            explanation_started = True
            if expl_match.group(1).strip():
                explanation_parts.append(clean_text(expl_match.group(1)))
            meta_indices.append(index)
            continue
        if answer_match or user_match:
            meta_indices.append(index)
            # Text after the answer footer on the same line is usually explanation.
            tail = re.split(
                r"(?:正确答案|参考答案|标准答案|你的答案)[^。；;]*?(?:你答对|你答错|回答正确|回答错误)?[。．.]?",
                line,
            )
            tail = [part.strip() for part in tail if len(part.strip()) > 8]
            if tail and not explanation_parts:
                explanation_parts.extend(clean_text(part) for part in tail)

    # Explanation without an explicit "解析" label: trailing content after metadata.
    last_meta = max(meta_indices, default=-1)
    if not explanation_started and last_meta >= 0:
        for line in body[last_meta + 1 :]:
            if is_noise(line):
                continue
            if _metadata_kind(line):
                continue
            if len(line) >= 6:
                explanation_parts.append(clean_text(line))
    elif explanation_started:
        expl_idx = next(
            (i for i, line in enumerate(body) if EXPLANATION_RE.match(line)), None
        )
        if expl_idx is not None:
            for line in body[expl_idx + 1 :]:
                if is_noise(line):
                    continue
                if _metadata_kind(line) in ("answer", "user", "footer"):
                    continue
                if line.strip():
                    explanation_parts.append(clean_text(line))

    # Content region stops at the first answer/user/explanation footer.
    content_end = min(
        [i for i in answer_indices + user_indices + meta_indices if i >= 0],
        default=len(body),
    )
    content = body[:content_end]
    content = [line for line in content if not is_noise(line)]
    if number:
        content = [
            re.sub(r"^\s*%s\s*[.、．)）:：]?\s*" % re.escape(number), "", line).strip()
            for line in content
        ]
        content = [line for line in content if line]

    opt_index = option_start_index(content)
    stem_lines = content if opt_index is None else content[:opt_index]
    option_lines = [] if opt_index is None else content[opt_index:]
    options = parse_options(option_lines)

    stem = "\n".join(clean_text(line) for line in stem_lines if clean_text(line))
    stem = re.sub(r"^(?:题目|题干)\s*[:：]\s*", "", stem).strip()
    # 题干在排版上折行时，OCR 会拆成多行；题干语义上是一句话，这里合并成一行，
    # 避免把视觉折行当成内容换行带进题库。
    stem = merge_wrapped_lines(stem)
    stem = re.sub(r"\s*[（(]\s*[）)]\s*$", "（  ）", stem).strip()
    if not stem:
        warnings.append("未识别到题干，请手动补充")

    if not correct_answer:
        warnings.append("未识别到正确答案，请手动补充")

    qtype = infer_type(options, correct_answer)
    if qtype == "truefalse":
        options = {}
    if not options and qtype not in ("fill", "truefalse") and any(
        word in stem for word in ("（ ）", "()", "下列", "以下", "选项")
    ):
        warnings.append("疑似选择题，但未识别到选项")

    correct_answer = answer_value(correct_answer, options, qtype)
    user_answer = answer_value(user_answer, options, qtype)

    if correct_answer and options:
        letters = normalize_letters(correct_answer)
        missing = [letter for letter in letters if letter not in options]
        if missing:
            warnings.append("答案选项缺失：" + "、".join(missing))
    if qtype == "single" and len(normalize_letters(correct_answer)) > 1:
        qtype = "multiple"
    if qtype in ("single", "multiple") and len(options) < 2:
        warnings.append("选项少于 2 个，请检查")
    if avg_score and avg_score < 0.78:
        warnings.append("图片文字较小或较模糊，识别置信度偏低")

    explanation = "\n".join(part for part in explanation_parts if part).strip()
    is_wrong = bool(correct_answer and user_answer) and not answers_equal(
        correct_answer, user_answer, qtype
    )

    return {
        # The screenshot number is only used for splitting; numbering is assigned
        # automatically by question type when the question is saved.
        "qno": "",
        "stem": stem,
        "qtype": qtype,
        "options": options,
        "answer": correct_answer,
        "explanation": explanation,
        "user_answer": user_answer,
        "tags": [extract_tag(stem)] if stem else ["其他"],
        "source_image": image_url,
        "source_text": "\n".join(clean_text(line) for line in lines if clean_text(line)),
        "warnings": warnings,
        "confidence": round(float(avg_score or 0), 3),
        "needs_review": bool(warnings),
        "was_wrong": is_wrong,
    }


def parse_lines(lines: list[dict[str, Any]], image_url: str = "") -> list[dict[str, Any]]:
    """Split OCR lines into question segments, then parse each segment."""
    normalized: list[dict[str, Any]] = []
    for line in lines:
        text = clean_text(line.get("text", ""))
        if not text or is_noise(text):
            continue
        normalized.append({**line, "text": text})

    segments: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for index, line in enumerate(normalized):
        text = line["text"]
        start = qstart(text)
        if start:
            new_number = int(start[0]) if start[0].isdigit() else 0
            current_number = None
            if current:
                for item in current:
                    found = qstart(item["text"])
                    if found:
                        current_number = int(found[0]) if found[0].isdigit() else None
                        break
            has_options = any(
                OPTION_START_RE.match(item["text"]) for item in current
            )
            has_answer = any(ANSWER_RE.search(item["text"]) for item in current)
            # Only split when the current block is a complete question. This
            # avoids splitting on numbered lists inside a long stem.
            is_new = bool(current) and (
                has_answer
                or has_options
                or (current_number is not None and new_number > current_number)
            )
            if is_new:
                segments.append(current)
                current = [line]
                continue
        current.append(line)

    if current:
        segments.append(current)

    drafts: list[dict[str, Any]] = []
    for segment in segments:
        scores = [float(item.get("score", 0) or 0) for item in segment]
        avg = sum(scores) / len(scores) if scores else 0
        draft = parse_segment(
            [item["text"] for item in segment], image_url=image_url, avg_score=avg
        )
        draft["image_url"] = image_url
        drafts.append(draft)

    # A screenshot with no numbered question still becomes one editable draft.
    if not drafts and normalized:
        avg = sum(float(item.get("score", 0) or 0) for item in normalized) / len(normalized)
        draft = parse_segment(
            [item["text"] for item in normalized], image_url=image_url, avg_score=avg
        )
        draft["image_url"] = image_url
        drafts.append(draft)

    return drafts
