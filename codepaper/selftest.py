"""核心链路自测（不依赖 Web 服务、不依赖真实文件）。

样例数据按用户提供的两张截图转录，答案行为**自测模拟值**，仅用于验证
「模板常量段匹配 / 一行多空 / 红色噪声过滤 / 代码块定位 / 全对判定」链路，
不代表真实试卷的标准答案。

P1 图片视觉通道的用例使用内存中的合成图 + 模拟 OCR box，只跑 cv2 检测与
组装逻辑，不启动 PaddleOCR、不写任何文件，因此可在无模型环境下离线验证。

运行：  .venv/Scripts/python.exe -m codepaper.selftest
"""
from __future__ import annotations

from . import core
from .ingest import from_text
from .model import NormDoc

# 试卷（Jupyter 代码填空题，按截图转录的关键行；答案为空位）
PAPER_SAMPLE = """import pandas as pd
# 读取一个Excel文件，并将读取到的数据存储在变量data中
data = ____
# 打印出数据集的前5行
print(data.head())
# 处理数据集中的缺失值
initial_row_count = ____    #处理前的数据行数
data = ____                 #删除缺失值所在行
final_row_count = ____      #处理后的数据行数
print(f"处理后数据行数：{final_row_count}")
X_train, X_test, y_train, y_test = ____(____, random_state=42)
"""

# 答案参考（完整代码；注释文字与试卷不同，用于验证「不能按行号硬对齐」）
ANSWER_SAMPLE = """import pandas as pd
# 加载数据
data = pd.read_csv('finance数据集.csv')
# 显示前五行的数据
print(data.head())
# 处理缺失值
initial_row_count = len(data)
data = data.dropna()
final_row_count = len(data)
print(f"处理后数据行数：{final_row_count}")
X_train, X_test, y_train, y_test = train_test_split(X, y, random_state=42)
# 下一题：箱线图（不属于本卷，验证代码块定位不会误抽）
import matplotlib.pyplot as plt
"""

# 答案文档里可能被标红的三类片段（含两类噪声）
RED_SPANS = [
    {"text": "pd.read_csv('finance数据集.csv')", "page_no": 1, "line_no": 3},
    {"text": "print(data.head())", "page_no": 1, "line_no": 5},
    {"text": "参考答案", "page_no": 1, "line_no": 1},
]

# P1 图片视觉通道自测用的答案（与合成试卷图配套）
VISUAL_ANSWER = """import pandas as pd
data = pd.read_csv('finance.csv')
print(data.head())
X_train, X_test = train_test_split(X,y, random_state=42)
"""


def _synthetic_sample():
    """生成合成试卷图 + 模拟 PaddleOCR 原始 box，完全不启动 OCR 引擎。

    图上有 3 条几何横线：L2 一条、L4 两条（一行多空），L5 是一行红字，
    用于同时验证横线检测、HSV 红分割与字符级插入顺序。
    """
    from pathlib import Path

    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.load_default()
    for candidate in (
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ):
        if Path(candidate).exists():
            font = ImageFont.truetype(candidate, 22)
            break

    image = Image.new("RGB", (1000, 360), (250, 249, 245))
    draw = ImageDraw.Draw(image)
    black, red = (25, 24, 22), (215, 32, 28)
    for y, text, color in (
        (40, "import pandas as pd", black),
        (100, "data =", black),
        (160, "print(data.head())", black),
        (220, "X_train, X_test =", black),
        (280, "data = pd.read_csv('finance.csv')", red),
    ):
        draw.text((40, y), text, font=font, fill=color)
    draw.text((405, 220), "(", font=font, fill=black)
    draw.text((525, 220), ", random_state=42)", font=font, fill=black)
    for x1, x2, y in ((200, 340, 128), (275, 400, 248), (425, 520, 248)):
        draw.rectangle((x1, y, x2, y + 2), fill=black)

    def box(text, x1, x2, y1, y2):
        return {
            "text": text, "x1": x1, "x2": x2, "y1": y1, "y2": y2,
            "cy": (y1 + y2) / 2, "h": y2 - y1, "score": 0.98,
        }

    paper_boxes = [
        box("import pandas as pd", 40, 290, 40, 66),
        box("data =", 40, 180, 100, 126),
        box("print(data.head())", 40, 300, 160, 186),
        box("X_train, X_test =", 40, 265, 220, 246),
        box("(", 405, 417, 220, 246),
        box(", random_state=42)", 525, 760, 220, 246),
    ]
    all_boxes = paper_boxes + [
        box("data = pd.read_csv('finance.csv')", 40, 430, 280, 306)
    ]
    return image, paper_boxes, all_boxes


def _visual_checks(record) -> None:
    """P1 图片通道：几何横线 / 红分割 / 精确 bbox / 人工复核铁律。"""
    from . import vision

    if not vision.cv2_available():
        record("P1 图片视觉通道（跳过）", True, "skipped: cv2 不可用")
        return

    image, paper_boxes, all_boxes = _synthetic_sample()
    bars = vision.detect_horizontal_blanks(image, 26.0)
    reds = vision.detect_red_regions(image, 26.0)
    record(
        "几何横线检测：3 条（含一行两空）",
        len(bars) == 3,
        f"bars={[b['bbox'] for b in bars]}",
    )
    record(
        "HSV 红色分割：检出答案红字",
        len(reds) >= 1,
        f"red_regions={[r['bbox'] for r in reds]}",
    )

    paper_doc = vision.build_image_doc(
        paper_boxes, bars, [], kind="paper", doc_id="selftest-image",
        image_size=[1000, 360], warnings=[],
    )
    blanks, template = core.detect_blanks(paper_doc)
    record(
        "图片空位：3 个、带精确 bbox、低置信待复核",
        len(blanks) == 3
        and all(b.bbox and b.bbox[2] - b.bbox[0] > 50 for b in blanks)
        and all(b.needs_review and b.confidence == 0.8 for b in blanks),
        f"blanks={len(blanks)} bboxes={[b.bbox for b in blanks]}",
    )
    # detect_blanks 返回的是 code_template，空位已换成 {{global_no}} 占位符
    record(
        "一行多空：模板顺序为 {{2}}({{3}}",
        "{{2}}({{3}}" in template,
        [ln for ln in template.splitlines() if "X_train" in ln],
    )

    answer_doc = from_text(VISUAL_ANSWER, "answer", "text", "selftest-visual-answer")
    reviewed = core.align(paper_doc, answer_doc, [], reviewed_all=True)
    record(
        "图片试卷 → 文本答案：全链路 3 空全对",
        reviewed.passed and len(reviewed.answers) == 3 and not reviewed.conflicts,
        f"passed={reviewed.passed} answers={len(reviewed.answers)} "
        f"conflicts={reviewed.conflicts}",
    )
    unreviewed = core.align(paper_doc, answer_doc, [], reviewed_all=False)
    record(
        "图片来源未经人工复核不得自动通过",
        not unreviewed.passed
        and not unreviewed.detail["conditions"]["低置信度已复核"],
        f"passed={unreviewed.passed}",
    )

    answer_img = vision.build_image_doc(
        all_boxes, bars, reds, kind="answer", doc_id="selftest-answer-image",
        image_size=[1000, 360], warnings=[],
    )
    spans = answer_img.meta["red_spans"]
    record(
        "红色区域映射为 red_spans 证据",
        any("pd.read_csv" in span["text"] for span in spans),
        f"spans={[s['text'] for s in spans]}",
    )


def _docs(
    paper_text: str = PAPER_SAMPLE, answer_text: str = ANSWER_SAMPLE
) -> tuple[NormDoc, NormDoc]:
    return (
        from_text(paper_text, "paper", "text", "selftest-paper"),
        from_text(answer_text, "answer", "text", "selftest-answer"),
    )


def run_selftest() -> dict:
    checks: list[dict] = []

    def record(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    # 1) 完整链路：6 个空、全部对齐、整卷通过
    paper_doc, answer_doc = _docs()
    result = core.align(paper_doc, answer_doc, RED_SPANS)
    record(
        "完整链路：6 空全部对齐并判定通过",
        len(result.blanks) == 6
        and len(result.answers) == 6
        and not result.conflicts
        and result.passed,
        f"blanks={len(result.blanks)} answers={len(result.answers)} "
        f"conflicts={len(result.conflicts)} passed={result.passed}",
    )
    record(
        "回填代码无残留占位符且含标准答案",
        "{{" not in result.code_filled
        and "pd.read_csv('finance数据集.csv')" in result.code_filled,
        result.code_filled.splitlines()[2] if result.code_filled else "",
    )

    # 2) 一行多空：L30 抽出 2 个答案
    multi = core.extract_answers(
        "X_train, X_test, y_train, y_test = ____(____, random_state=42)",
        "X_train, X_test, y_train, y_test = train_test_split(X, y, random_state=42)",
    )
    record(
        "一行多空：抽出 train_test_split 与 X,y",
        multi == ["train_test_split", "X,y"],
        repr(multi),
    )

    # 3) 红色有效性过滤：噪声被丢弃，只留真答案
    kept, dropped = core.filter_red_spans(RED_SPANS, paper_doc.code_lines())
    reasons = {item.get("drop_reason", "") for item in dropped}
    record(
        "红色噪声过滤：强调标记与标题被丢弃",
        len(kept) == 1 and len(dropped) == 2
        and any("强调标记" in r for r in reasons)
        and any("标题" in r for r in reasons),
        f"kept={len(kept)} dropped={len(dropped)} reasons={sorted(reasons)}",
    )

    # 4) 缺一个答案 → 冲突 + 绝不通过
    broken_answer = ANSWER_SAMPLE.replace("final_row_count = len(data)\n", "")
    _, broken_doc = _docs(answer_text=broken_answer)
    broken = core.align(paper_doc, broken_doc, [])
    record(
        "缺失答案：产生冲突且整卷不通过",
        bool(broken.conflicts) and not broken.passed,
        f"conflicts={broken.conflicts} passed={broken.passed}",
    )

    # 5) 常量段不匹配 → 抛 AlignmentConflict，不顺延
    raised = False
    try:
        core.extract_answers("data = ____", "totally_different = 1")
    except core.AlignmentConflict:
        raised = True
    record("常量段失配：抛冲突而非顺延补齐", raised, "")

    # 6) 注释差异不影响对齐（两份文档注释文字不同）
    record(
        "注释文字不同仍能对齐",
        not result.conflicts and result.checks[0].result == "pass",
        f"first_check={result.checks[0].result if result.checks else 'n/a'}",
    )

    # 7) P1 图片视觉通道（合成图，不启动 PaddleOCR）
    _visual_checks(record)

    # 8) v1.4.0 考场判分：与「入库质检」互不替代
    exam_blanks = [
        {
            "global_no": b.no, "slot_id": b.slot_id,
            "context_left": b.context_left, "context_right": b.context_right,
            "role_expected": b.role_expected,
        }
        for b in result.blanks
    ]
    key = {b.no: a.raw for b, a in zip(result.blanks, result.answers)}
    full = core.grade_exam(exam_blanks, key, {str(k): v for k, v in key.items()})
    record(
        "考场判分：全对 → 100 分且 passed",
        full["score"] == 100 and full["passed"] and full["correct"] == 6,
        f"score={full['score']} correct={full['correct']} passed={full['passed']}",
    )
    partial = core.grade_exam(exam_blanks, key, {"1": key[1], "2": "故意答错"})
    record(
        "考场判分：答错 / 未作答分别记分，不通过",
        partial["correct"] == 1 and partial["answered"] == 2
        and partial["score"] == 17 and not partial["passed"]
        and partial["results"][2]["answered"] is False,
        f"correct={partial['correct']} answered={partial['answered']} score={partial['score']}",
    )
    alt = core.grade_exam(
        [{"global_no": 1}, {"global_no": 2}],
        {1: "A||B", 2: "C"},
        {"1": " B ", "2": "C"},
    )
    record(
        "考场判分：去空白 + || 等价答案",
        alt["correct"] == 2 and alt["passed"],
        f"correct={alt['correct']}",
    )
    record(
        "取卷数据不含标准答案（答案只在服务端）",
        all("correct_answer" not in item and "raw" not in item for item in exam_blanks),
        f"keys={sorted(exam_blanks[0])}",
    )

    # 9) v1.4.1 卷库 / 成绩 / 整卷错题组：内存 SQLite，不碰正式数据库
    def _store_checks():
        import json
        import sqlite3

        from . import store

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        # 故意保留旧版的 paper_id / paper_seq 两列，用来证明「即使旧库有列，
        # v1.4.1 也一行都不会往主题库里写」。
        conn.execute(
            """CREATE TABLE questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, qno TEXT DEFAULT '',
                stem TEXT NOT NULL, qtype TEXT NOT NULL DEFAULT 'single',
                options TEXT NOT NULL DEFAULT '{}', answer TEXT NOT NULL DEFAULT '',
                explanation TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                source_image TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL UNIQUE,
                wrong_count INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0, mastery INTEGER NOT NULL DEFAULT 0,
                last_practiced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0, image_digest TEXT NOT NULL DEFAULT '',
                paper_id INTEGER, paper_seq INTEGER)"""
        )
        saved = store._SCHEMA_READY  # noqa: SLF001 - 内存库需要重建一次表
        store._SCHEMA_READY = False
        try:
            pid = store.create_paper(conn, title="自测卷")
            rid = store.save_result(conn, pid, result)
            exam = store.exam_paper(conn, pid)
            record(
                "卷库取卷：模板带占位符、不含答案原文",
                exam is not None and "{{1}}" in exam["template"]
                and "read_csv" not in exam["template"]
                and len(exam["blanks"]) == 6,
                f"blanks={len(exam['blanks']) if exam else 0}",
            )

            # 错 1 空（其余留空）→ 整卷作为一组进错题集，而不是 6 道单题
            one_wrong = core.grade_exam(
                exam["blanks"], store.answer_key(conn, rid),
                {"1": key[1], "2": "故意答错"},
            )
            store.save_exam_attempt(conn, pid, rid, one_wrong, elapsed_ms=42000)
            wrong = store.wrong_papers(conn)
            group = wrong["items"][0] if wrong["items"] else {}
            decorated = store.list_papers(conn)[0]
            record(
                "整卷错题组：一个空错 → 整卷进组，按空位格阵呈现",
                len(wrong["items"]) == 1
                and group.get("miss_count") == 5
                and len(group.get("grid") or []) == 6
                and decorated["in_wrong_book"] is True
                and wrong["cleared_count"] == 0,
                f"groups={len(wrong['items'])} miss={group.get('miss_count')}",
            )

            payload = json.dumps(wrong, ensure_ascii=False)
            record(
                "整卷不拆单题：主题库 0 行，错题组不下发标准答案",
                conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 0
                and "correct_answer" not in payload
                and "read_csv" not in payload,
                f"questions=0 leaks={'read_csv' in payload}",
            )

            # 全卷全对 → 整组移出错题集（不是逐空分别掌握）
            full_grade = core.grade_exam(
                exam["blanks"], store.answer_key(conn, rid),
                {str(k): v for k, v in key.items()},
            )
            store.save_exam_attempt(conn, pid, rid, full_grade, elapsed_ms=31000)
            cleared = store.wrong_papers(conn)
            papers = store.list_papers(conn)
            target = next(item for item in papers if item["id"] == pid)
            record(
                "全卷全对 → 整组移出错题集，成绩留档",
                len(cleared["items"]) == 0 and cleared["cleared_count"] == 1
                and target["in_wrong_book"] is False
                and target["attempt_count"] == 2 and target["best_score"] == 100
                and len(store.list_exam_attempts(conn, pid)) == 2,
                f"groups={len(cleared['items'])} best={target['best_score']}",
            )

            store.delete_paper(conn, pid)
            record(
                "删卷：清卷库、成绩与错题组，不动主题库",
                store.get_paper(conn, pid) is None
                and conn.execute(
                    "SELECT COUNT(*) FROM code_exam_attempts"
                ).fetchone()[0] == 0
                and store.wrong_papers(conn)["items"] == []
                and conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 0,
                "",
            )
        finally:
            store._SCHEMA_READY = saved  # noqa: SLF001
            conn.close()

    _store_checks()

    passed = all(item["ok"] for item in checks)
    return {
        "ok": passed,
        "total": len(checks),
        "passed": sum(1 for item in checks if item["ok"]),
        "checks": checks,
        "sample_result": {
            "blanks": len(result.blanks),
            "answers": len(result.answers),
            "status": result.status,
            "conditions": result.detail.get("conditions", {}),
            "code_filled": result.code_filled,
        },
    }


if __name__ == "__main__":
    import json

    print(json.dumps(run_selftest(), ensure_ascii=False, indent=2))
