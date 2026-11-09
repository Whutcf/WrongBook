"""代码填空整卷处理：统一数据模型。

``NormDoc`` 是所有格式解析层（docx / pdf / image / text）的唯一交换格式；
``Blank`` / ``Answer`` / ``Check`` / ``PaperResult`` 是解析、对齐、校验各阶段
的结果对象。所有坐标统一为页级像素，前端按显示比例缩放叠加复核框。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

#: 各格式解析层把「空位」统一改写成这个内部标记
BLANK_TOKEN = "[[BLANK]]"

#: 项目版本：升版只改这一处，app.py / 模板 / 导出接口统一读取
VERSION = "1.4.3"


@dataclass
class Token:
    text: str
    bbox: tuple[int, int, int, int] | None = None
    style: str = "plain"          # plain | underline | red | blank
    color: str | None = None      # 例如 "FF0000"


@dataclass
class CodeLine:
    page_no: int
    line_no: int
    text: str
    tokens: list[Token] = field(default_factory=list)
    bbox: tuple[int, int, int, int] | None = None
    indent: int = 0
    kind: str = "code"            # code | prose | comment | title


@dataclass
class NormDoc:
    doc_id: str
    kind: str                     # paper | answer
    source_type: str              # docx | pdf_text | pdf_scan | image | text
    language: str = "python"
    pages: list[list[CodeLine]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def lines(self) -> list[CodeLine]:
        """按全卷阅读序展平（页序 → 行序），空位编号只认这个顺序。"""
        return [line for page in self.pages for line in page]

    def code_lines(self) -> list[CodeLine]:
        return [ln for ln in self.lines() if ln.kind == "code" and ln.text.strip()]


@dataclass
class Blank:
    no: int                       # global_no：全卷连续，不按页/题重置
    slot_id: str                  # P{页}-L{行}-C{列}
    page_no: int
    line_no: int
    col: int
    context_left: str
    context_right: str
    role_expected: str = "expr"   # expr | iterable | cond | params | arg | element | callable
    role_hint: str = ""           # 空位右侧中文注释（强语义线索）
    kind: str = "line"            # line | underline_run | chars
    confidence: float = 1.0
    needs_review: bool = False
    bbox: tuple[int, int, int, int] | None = None


@dataclass
class Answer:
    no: int
    raw: str
    normalized: str
    color_marked: bool = False
    source_line: int = 0
    confidence: float = 1.0
    bbox: tuple[int, int, int, int] | None = None
    page_no: int = 0           # 1-based 源 PDF 页码，供「原文切片」定位（0 = 无几何信息）


@dataclass
class Check:
    blank_no: int
    answer_no: int | None
    match_score: float
    filled_raw: str
    role_expected: str
    role_ok: bool
    result: str                   # pass | fail | missing | conflict
    needs_review: bool
    note: str = ""


@dataclass
class PaperResult:
    blanks: list[Blank] = field(default_factory=list)
    answers: list[Answer] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    code_template: str = ""
    code_filled: str = ""
    located_range: tuple[int, int] | None = None
    color_evidence: int = 0
    passed: bool = False
    status: str = "parsed"        # parsed | aligned | filled | verified | passed | reviewing
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
