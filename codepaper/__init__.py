"""代码填空整卷处理（codepaper）— WrongBook P0 旁路模块。

分层：
    model    统一数据模型（NormDoc / Blank / Answer / Check / PaperResult）
    core     纯逻辑内核（模板常量段匹配、对齐、全对判定）
    ingest   docx / PDF / 图片 / 文本 → NormDoc
    store    SQLite 幂等建表与结果读写
    routes   Flask Blueprint（/api/code-papers/* 与 /codepaper 复核页）
    selftest 核心链路自测

版本只在此处定义一次，app.py 与模板统一读取。
"""
from .model import VERSION
from .core import (
    AlignmentConflict,
    align,
    detect_blanks,
    extract_answers,
    fill,
    filter_red_spans,
    locate_answer_block,
    verify,
)

__all__ = [
    "VERSION",
    "AlignmentConflict",
    "align",
    "detect_blanks",
    "extract_answers",
    "fill",
    "filter_red_spans",
    "locate_answer_block",
    "verify",
]
