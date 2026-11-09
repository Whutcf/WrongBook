"""Answer normalization and grading."""
from __future__ import annotations

import re
from typing import Any

import parser


def _text(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        value = "".join(str(item) for item in value)
    return str(value or "").strip()


def _option_letter(text: str, options: dict[str, str]) -> str:
    cleaned = text.strip()
    if not cleaned:
        return ""
    letters = parser.normalize_letters(cleaned)
    if letters:
        return letters
    for letter, content in options.items():
        if cleaned == content.strip():
            return letter
    return ""


def normalize_user_answer(qtype: str, options: dict[str, str], raw: Any) -> str:
    text = _text(raw)
    if not text:
        return ""
    if qtype == "fill":
        return text[:1000]
    if qtype == "truefalse":
        return parser.truefalse_value(text, options) or text
    letter = _option_letter(text, options)
    if qtype == "single":
        return (letter or text)[:1].upper()
    return parser.normalize_letters(letter or text) or text.upper()


def _normalize_fill(value: str) -> str:
    value = value.strip().lower()
    value = value.replace("（", "(").replace("）", ")")
    value = re.sub(r"\s+", "", value)
    value = value.strip("。．.，,；;：:、!！?？\"'“”‘’")
    return value


def grade_answer(
    qtype: str, options: dict[str, str], correct_answer: str, user_answer: str
) -> tuple[bool, str]:
    correct_raw = _text(correct_answer)
    user_raw = _text(user_answer)
    if not user_raw or not correct_raw:
        return False, correct_raw

    if qtype == "truefalse":
        normalized_correct = parser.truefalse_value(correct_raw, options)
        normalized_user = parser.truefalse_value(user_raw, options)
        return (
            bool(normalized_correct) and normalized_correct == normalized_user,
            normalized_correct or correct_raw,
        )

    if qtype == "fill":
        user_norm = _normalize_fill(user_raw)
        alternatives = [
            part
            for part in re.split(r"\|\||｜｜", correct_raw)
            if _normalize_fill(part)
        ]
        if len(alternatives) <= 1 and "|" in correct_raw:
            alternatives = [part for part in correct_raw.split("|") if part.strip()]
        for alternative in alternatives or [correct_raw]:
            if user_norm == _normalize_fill(alternative):
                return True, correct_raw
        return False, correct_raw

    correct_letters = parser.normalize_letters(correct_raw)
    if not correct_letters:
        correct_letters = _option_letter(correct_raw, options)
    user_letters = parser.normalize_letters(user_raw)
    if not user_letters:
        user_letters = _option_letter(user_raw, options)

    if not correct_letters:
        return False, correct_raw

    if qtype == "single":
        return correct_letters[:1] == user_letters[:1], correct_letters[:1]
    return sorted(correct_letters) == sorted(user_letters), correct_letters
