"""codepaper 持久化：幂等建表 + 结果读写。

v1.4.1 起整卷是**不可拆分**的最小复习单位：不再往 ``questions`` 写任何
``fill`` 单题，错题本以「一份卷 = 一组填空题」的形态呈现。旧库里
``questions.paper_id`` / ``paper_seq`` 两列只是历史遗留，不再读写。
"""
from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from .model import PaperResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS code_papers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'python',
    paper_file TEXT NOT NULL DEFAULT '',
    answer_file TEXT NOT NULL DEFAULT '',
    answer_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'parsed',
    blank_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    filled_count INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    passed_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS code_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL,
    block_id TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL DEFAULT 0,
    code_template TEXT NOT NULL DEFAULT '',
    code_filled TEXT NOT NULL DEFAULT '',
    page_no INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS blanks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    global_no INTEGER NOT NULL,
    slot_id TEXT NOT NULL DEFAULT '',
    anchor TEXT NOT NULL DEFAULT '',
    context_left TEXT NOT NULL DEFAULT '',
    context_right TEXT NOT NULL DEFAULT '',
    role_expected TEXT NOT NULL DEFAULT '',
    role_hint TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 1.0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    UNIQUE(run_id, global_no)
);
CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    raw TEXT NOT NULL DEFAULT '',
    normalized TEXT NOT NULL DEFAULT '',
    color_marked INTEGER NOT NULL DEFAULT 0,
    source_line INTEGER NOT NULL DEFAULT 0,
    page_no INTEGER NOT NULL DEFAULT 0,
    bbox TEXT,
    UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS blank_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    blank_no INTEGER NOT NULL,
    answer_no INTEGER,
    match_score REAL NOT NULL DEFAULT 0,
    filled_raw TEXT NOT NULL DEFAULT '',
    filled_rendered TEXT NOT NULL DEFAULT '',
    role_expected TEXT NOT NULL DEFAULT '',
    role_ok INTEGER NOT NULL DEFAULT 1,
    result TEXT NOT NULL DEFAULT 'fail',
    needs_review INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS verify_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    matched INTEGER NOT NULL DEFAULT 0,
    filled INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    conflicts INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    render_mode TEXT NOT NULL DEFAULT 'strict',
    auto_pass_allowed INTEGER NOT NULL DEFAULT 1,
    diff_blank_count INTEGER,
    located_start INTEGER,
    located_end INTEGER,
    color_evidence INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '{}',
    code_template TEXT NOT NULL DEFAULT '',
    code_filled TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS code_exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'exam',
    total INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_cp_runs_paper ON verify_runs(paper_id);
CREATE INDEX IF NOT EXISTS idx_cp_blanks_run ON blanks(run_id, global_no);
CREATE INDEX IF NOT EXISTS idx_cp_checks_run ON blank_checks(run_id, blank_no);
CREATE INDEX IF NOT EXISTS idx_cp_exam_paper ON code_exam_attempts(paper_id, id DESC);
"""

_SCHEMA_READY = False


def ensure_schema(conn: sqlite3.Connection) -> None:
    """幂等建表；进程内缓存标记，重启后会自动重做一次。

    v1.4.1：不再给 ``questions`` 加 ``paper_id`` / ``paper_seq``。整卷不拆题，
    主题库里永远不会出现来自卷库的单题；旧库残留的两列保持原样，不迁移、不删除。
    """
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    conn.executescript(SCHEMA)
    conn.commit()
    _migrate_schema(conn)
    _SCHEMA_READY = True


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """为旧库补齐新增列（已存在则跳过），保证升级不打断现有数据。"""
    _ensure_col(conn, "code_papers", "answer_path", "TEXT NOT NULL DEFAULT ''")
    # 本卷「关联的全部参考答案」在原件里的页码 + 坐标（JSON），供整卷级原文切片
    _ensure_col(conn, "code_papers", "answer_regions", "TEXT NOT NULL DEFAULT ''")
    _ensure_col(conn, "answers", "page_no", "INTEGER NOT NULL DEFAULT 0")
    _ensure_col(conn, "answers", "bbox", "TEXT")
    conn.commit()


def _ensure_col(conn: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    try:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
    except sqlite3.Error:
        pass


def bbox_to_str(b: tuple[int, int, int, int] | None) -> str | None:
    if not b or len(b) != 4:
        return None
    return ",".join(str(int(v)) for v in b)


def str_to_bbox(s: str | None) -> tuple[int, int, int, int] | None:
    if not s:
        return None
    try:
        parts = [int(float(v)) for v in s.split(",")]
        if len(parts) == 4:
            return tuple(parts)
    except (ValueError, TypeError):
        return None
    return None


def _now() -> str:
    from datetime import datetime

    return datetime.now().isoformat(timespec="seconds")


def create_paper(
    conn: sqlite3.Connection,
    *,
    title: str = "",
    paper_file: str = "",
    answer_file: str = "",
    answer_path: str = "",
    answer_regions: str = "",
    language: str = "python",
) -> int:
    ensure_schema(conn)
    cursor = conn.execute(
        """INSERT INTO code_papers
           (title, language, paper_file, answer_file, answer_path, answer_regions, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'parsed', ?)""",
        (title, language, paper_file, answer_file, answer_path, answer_regions, _now()),
    )
    conn.commit()
    return int(cursor.lastrowid)


def save_result(conn: sqlite3.Connection, paper_id: int, result: PaperResult) -> int:
    """把一次完整校验结果落库，返回 run_id。"""
    ensure_schema(conn)
    detail = result.detail or {}
    start, end = result.located_range or (None, None)
    cursor = conn.execute(
        """INSERT INTO verify_runs
           (paper_id, created_at, total, matched, filled, correct, conflicts,
            passed, render_mode, auto_pass_allowed, diff_blank_count,
            located_start, located_end, color_evidence, detail,
            code_template, code_filled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            paper_id,
            _now(),
            len(result.blanks),
            sum(1 for c in result.checks if c.answer_no is not None),
            sum(1 for c in result.checks if c.filled_raw.strip()),
            sum(1 for c in result.checks if c.result == "pass"),
            len(result.conflicts),
            1 if result.passed else 0,
            detail.get("render_mode", "strict"),
            1,
            len(result.answers),
            start,
            end,
            result.color_evidence,
            json.dumps(detail, ensure_ascii=False),
            result.code_template,
            result.code_filled,
        ),
    )
    run_id = int(cursor.lastrowid)

    conn.execute(
        "DELETE FROM code_blocks WHERE paper_id = ?", (paper_id,)
    )
    conn.execute(
        """INSERT INTO code_blocks
           (paper_id, block_id, seq, code_template, code_filled, page_no)
           VALUES (?, 'BLK01', 1, ?, ?, 1)""",
        (paper_id, result.code_template, result.code_filled),
    )

    conn.executemany(
        """INSERT OR REPLACE INTO blanks
           (paper_id, run_id, global_no, slot_id, anchor, context_left,
            context_right, role_expected, role_hint, kind, confidence, needs_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                paper_id,
                run_id,
                blank.no,
                blank.slot_id,
                f"P{blank.page_no}-L{blank.line_no}-C{blank.col}",
                blank.context_left,
                blank.context_right,
                blank.role_expected,
                blank.role_hint,
                blank.kind,
                blank.confidence,
                1 if blank.needs_review else 0,
            )
            for blank in result.blanks
        ],
    )
    conn.executemany(
        """INSERT OR REPLACE INTO answers
           (paper_id, run_id, seq, raw, normalized, color_marked, source_line, page_no, bbox)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                paper_id,
                run_id,
                answer.no,
                answer.raw,
                answer.normalized,
                1 if answer.color_marked else 0,
                answer.source_line,
                int(answer.page_no or 0),
                bbox_to_str(answer.bbox),
            )
            for answer in result.answers
        ],
    )
    conn.executemany(
        """INSERT OR REPLACE INTO blank_checks
           (run_id, blank_no, answer_no, match_score, filled_raw,
            filled_rendered, role_expected, role_ok, result, needs_review, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                run_id,
                check.blank_no,
                check.answer_no,
                check.match_score,
                check.filled_raw,
                check.filled_raw,
                check.role_expected,
                1 if check.role_ok else 0,
                check.result,
                1 if check.needs_review else 0,
                check.note,
            )
            for check in result.checks
        ],
    )
    conn.execute(
        """UPDATE code_papers
           SET status = ?, blank_count = ?, matched_count = ?, filled_count = ?,
               correct_count = ?, conflict_count = ?, passed = ?, passed_at = ?
           WHERE id = ?""",
        (
            result.status,
            len(result.blanks),
            sum(1 for c in result.checks if c.answer_no is not None),
            sum(1 for c in result.checks if c.filled_raw.strip()),
            sum(1 for c in result.checks if c.result == "pass"),
            len(result.conflicts),
            1 if result.passed else 0,
            _now() if result.passed else None,
            paper_id,
        ),
    )
    # 重新封卷会写入新的 run，标准答案可能已变：按最新答案键重判该卷所有历史
    # 考试记录（correct / score / passed / detail）并落库。否则「整卷历史」「学习统计」
    # 与题库卡片仍读旧的缓存分数，只有详情接口实时重判能看到新答案。
    # 放在 save_result 这一公共落库点，覆盖全部重封卷入口（编辑保存 / 重新上传文件 /
    # 探针缓存落库），语义与 update_blank_answers 的刷新保持一致；新建卷无历史记录，空操作。
    recompute_attempt_scores(conn, paper_id)
    conn.commit()
    return run_id


def get_run(conn: sqlite3.Connection, run_id: int) -> dict[str, Any] | None:
    ensure_schema(conn)
    row = conn.execute("SELECT * FROM verify_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    run = dict(row)
    run["detail"] = json.loads(run.get("detail") or "{}")
    run["blanks"] = [
        dict(item)
        for item in conn.execute(
            "SELECT * FROM blanks WHERE run_id = ? ORDER BY global_no", (run_id,)
        )
    ]
    run["answers"] = [
        dict(item)
        for item in conn.execute(
            "SELECT * FROM answers WHERE run_id = ? ORDER BY seq", (run_id,)
        )
    ]
    run["checks"] = [
        dict(item)
        for item in conn.execute(
            "SELECT * FROM blank_checks WHERE run_id = ? ORDER BY blank_no", (run_id,)
        )
    ]
    return run


def save_review_result(
    conn: sqlite3.Connection,
    run_id: int,
    passed: bool,
    detail: dict[str, Any],
) -> None:
    """人工复核完成后重算通过状态；硬冲突不会被复核覆盖。"""
    conn.execute(
        "UPDATE verify_runs SET passed = ?, detail = ? WHERE id = ?",
        (1 if passed else 0, json.dumps(detail, ensure_ascii=False), run_id),
    )
    conn.execute(
        """UPDATE code_papers
           SET passed = ?, status = ?, passed_at = ?
           WHERE id = (SELECT paper_id FROM verify_runs WHERE id = ?)""",
        (
            1 if passed else 0,
            "passed" if passed else "reviewing",
            _now() if passed else None,
            run_id,
        ),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# v1.4.0 卷库 / 考场
# ---------------------------------------------------------------------------
def _latest_attempt(conn: sqlite3.Connection, paper_id: int) -> sqlite3.Row | None:
    """最近一次交卷：整卷错题组的进出只看这一条，不翻历史旧账。"""
    return conn.execute(
        """SELECT id, created_at, total, answered, correct, score, passed, detail
           FROM code_exam_attempts WHERE paper_id = ? ORDER BY id DESC LIMIT 1""",
        (paper_id,),
    ).fetchone()


def _decorate_map(conn: sqlite3.Connection, paper_ids: list[int]) -> dict[str, Any]:
    """一次性取出若干卷子的质检 / 考试聚合，避免逐卷 N+1 查询。

    原来每条卷子都跑 3 条 SQL（最新 run、考试计数、最近一次考试），100 份卷就会
    300 条查询。这里用 3 条聚合查询 + IN 子查询一次性取回，复杂度从 O(N) 降到 O(1)。
    """
    ids = [int(x) for x in paper_ids]
    if not ids:
        return {"run": {}, "agg": {}, "latest": {}}
    ph = ",".join("?" * len(ids))
    run_rows = conn.execute(
        f"SELECT paper_id, id, passed FROM verify_runs "
        f"WHERE id IN (SELECT MAX(id) FROM verify_runs WHERE paper_id IN ({ph}) GROUP BY paper_id)",
        ids,
    ).fetchall()
    run_map = {
        int(r["paper_id"]): {"id": int(r["id"]), "passed": bool(r["passed"])}
        for r in run_rows
    }
    agg_rows = conn.execute(
        f"SELECT paper_id, COUNT(*) AS c, COALESCE(MAX(score), 0) AS best "
        f"FROM code_exam_attempts WHERE paper_id IN ({ph}) GROUP BY paper_id",
        ids,
    ).fetchall()
    agg_map = {
        int(r["paper_id"]): {"c": int(r["c"]), "best": int(r["best"])}
        for r in agg_rows
    }
    latest_rows = conn.execute(
        f"SELECT a.* FROM code_exam_attempts a "
        f"WHERE a.id IN (SELECT MAX(id) FROM code_exam_attempts WHERE paper_id IN ({ph}) GROUP BY paper_id)",
        ids,
    ).fetchall()
    latest_map = {int(r["paper_id"]): dict(r) for r in latest_rows}
    return {"run": run_map, "agg": agg_map, "latest": latest_map}


def decorate_one(paper: dict[str, Any], dmap: dict[str, Any]) -> dict[str, Any]:
    """给单份卷子补上聚合字段（依赖 _decorate_map 的预取结果）。"""
    pid = int(paper["id"])
    run = dmap["run"].get(pid)
    agg = dmap["agg"].get(pid) or {"c": 0, "best": 0}
    latest = dmap["latest"].get(pid)
    paper["run_id"] = int(run["id"]) if run else None
    paper["verified"] = bool(run["passed"]) if run else False
    paper["attempt_count"] = int(agg["c"])
    paper["best_score"] = int(agg["best"])
    paper["last_exam_at"] = latest["created_at"] if latest else ""
    paper["last_score"] = int(latest["score"]) if latest else 0
    paper["last_correct"] = int(latest["correct"]) if latest else 0
    paper["last_total"] = int(latest["total"]) if latest else 0
    # 有任意一空错 / 未作答 → 整组进错题集；只有全卷全对才移出。
    paper["in_wrong_book"] = bool(latest) and not bool(latest["passed"])
    paper["miss_count"] = (paper["last_total"] - paper["last_correct"]) if latest else 0
    return paper


def _decorate(conn: sqlite3.Connection, paper: dict[str, Any]) -> dict[str, Any]:
    """兼容旧调用：单份卷子的聚合（内部走 _decorate_map）。"""
    return decorate_one(paper, _decorate_map(conn, [int(paper["id"])]))


def list_papers(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    ensure_schema(conn)
    rows = [
        dict(row)
        for row in conn.execute("SELECT * FROM code_papers ORDER BY id DESC LIMIT 100")
    ]
    dmap = _decorate_map(conn, [int(r["id"]) for r in rows])
    return [decorate_one(row, dmap) for row in rows]


def paper_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """整卷考试的全局统计：卷数、考试次数、最好成绩均值、攻克 / 待攻克，以及最近考试。

    供「学习统计」页的整卷模块使用；只聚合旁路表，不碰单题主链路。
    """
    ensure_schema(conn)
    papers = list_papers(conn)
    total = len(papers)
    exam_count = sum(int(p.get("attempt_count") or 0) for p in papers)
    mastered = sum(1 for p in papers if p.get("attempt_count") and not p.get("in_wrong_book"))
    pending = sum(1 for p in papers if p.get("in_wrong_book"))
    with_attempts = [p for p in papers if p.get("attempt_count")]
    avg_best = (
        round(sum(int(p.get("best_score") or 0) for p in with_attempts) / len(with_attempts))
        if with_attempts
        else 0
    )
    rows = conn.execute(
        """SELECT a.id AS attempt_id, a.paper_id, a.created_at, a.score, a.passed,
                  a.total, a.correct, a.mode, p.title
           FROM code_exam_attempts a LEFT JOIN code_papers p ON p.id = a.paper_id
           ORDER BY a.id DESC LIMIT 6"""
    ).fetchall()
    recent = [
        {
            "attempt_id": int(r["attempt_id"]),
            "paper_id": int(r["paper_id"]),
            "title": r["title"] or ("整卷 " + str(r["paper_id"])),
            "created_at": r["created_at"],
            "score": int(r["score"]),
            "passed": bool(r["passed"]),
            "total": int(r["total"]),
            "correct": int(r["correct"]),
            "mode": r["mode"] if "mode" in r.keys() else "exam",
        }
        for r in rows
    ]
    # 每卷刷题 / 考试次数 + 最好成绩，供「统计页面」逐卷展示。
    title_rows = conn.execute("SELECT id, title FROM code_papers").fetchall()
    title_map = {
        int(r["id"]): (r["title"] or ("整卷 " + str(r["id"]))) for r in title_rows
    }
    mode_rows = conn.execute(
        "SELECT paper_id, mode, COUNT(*) AS c FROM code_exam_attempts GROUP BY paper_id, mode"
    ).fetchall()
    best_rows = conn.execute(
        "SELECT paper_id, COALESCE(MAX(score), 0) AS best FROM code_exam_attempts GROUP BY paper_id"
    ).fetchall()
    best_map = {int(r["paper_id"]): int(r["best"]) for r in best_rows}
    counts: dict[int, dict[str, int]] = {}
    for r in mode_rows:
        pid = int(r["paper_id"])
        counts.setdefault(pid, {"practice": 0, "exam": 0})
        counts[pid][r["mode"]] = int(r["c"])
    by_paper = [
        {
            "paper_id": pid,
            "title": title_map.get(pid, "整卷 " + str(pid)),
            "practice_count": counts.get(pid, {}).get("practice", 0),
            "exam_count": counts.get(pid, {}).get("exam", 0),
            "best_score": best_map.get(pid, 0),
        }
        for pid in counts
    ]
    by_paper.sort(
        key=lambda x: (x["practice_count"] + x["exam_count"], x["best_score"]),
        reverse=True,
    )
    return {
        "total_papers": total,
        "exam_count": exam_count,
        "mastered": mastered,
        "pending": pending,
        "avg_best": avg_best,
        "recent": recent,
        "by_paper": by_paper,
    }


def get_paper(conn: sqlite3.Connection, paper_id: int) -> dict[str, Any] | None:
    ensure_schema(conn)
    row = conn.execute("SELECT * FROM code_papers WHERE id = ?", (paper_id,)).fetchone()
    if row is None:
        return None
    paper = _decorate(conn, dict(row))
    if paper["run_id"]:
        paper["run"] = get_run(conn, paper["run_id"])  # 含答案，仅管理端 / 质检页可见
    return paper


def find_paper_by_title(conn: sqlite3.Connection, title: str) -> dict[str, Any] | None:
    ensure_schema(conn)
    row = conn.execute(
        "SELECT * FROM code_papers WHERE title = ? ORDER BY id DESC LIMIT 1", (title,)
    ).fetchone()
    return _decorate(conn, dict(row)) if row else None


def _version_of(name: str) -> tuple[int, ...] | None:
    """从文件名 / 标题里提取多级编号版本（如 1.1.4 → (1,1,4)）。

    用于「按文件查重」时区分同名但不同版本的文件：同一份材料重新上传通常
    文件名与版本号都一致；若文件名相同但版本号不同（如把 1.1.4 的内容误存成
    1.1.5.ipynb），不应被判成「同一份卷子的二次上传」而覆盖错卷。
    """
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", name or "")
    if not m:
        return None
    return tuple(int(x) for x in m.groups() if x is not None)


def find_paper_by_file(conn: sqlite3.Connection, paper_file: str, answer_file: str = "") -> dict[str, Any] | None:
    """按上传文件名查重：同名试卷文件极可能是同一份卷子的二次上传。

    优先精确匹配「试卷文件 + 答案文件」两者都相同（同一份材料重新上传），
    否则退而只按「试卷文件」名匹配（用户可能只改了答案文件）。命中即视为同一卷。

    版本比对：命中同名文件后，再用文件名版本与已有卷的标题版本交叉校验。
    仅当双方都能解析出版本且版本不一致时，判定为「不同版本、不同卷」，返回 None，
    避免 1.1.4 与 1.1.5 这种不同版本被同名文件误判为重复（覆盖错卷）。
    """
    ensure_schema(conn)
    row = None
    if answer_file:
        row = conn.execute(
            "SELECT * FROM code_papers WHERE paper_file = ? AND answer_file = ? ORDER BY id DESC LIMIT 1",
            (paper_file, answer_file),
        ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT * FROM code_papers WHERE paper_file = ? ORDER BY id DESC LIMIT 1",
            (paper_file,),
        ).fetchone()
    if row is None:
        return None
    # 版本交叉校验：同名但版本不同 → 视为不同卷，不触发「重新解析并更新」
    new_ver = _version_of(paper_file)
    exist = dict(row)
    exist_ver = _version_of(exist.get("title") or "") or _version_of(exist.get("paper_file") or "")
    if new_ver and exist_ver and new_ver != exist_ver:
        return None
    return _decorate(conn, exist)


def exam_paper(conn: sqlite3.Connection, paper_id: int) -> dict[str, Any] | None:
    """考场取卷：只给模板与空位元数据，**绝不下发答案**。"""
    ensure_schema(conn)
    paper = get_paper(conn, paper_id)
    if paper is None or not paper["run_id"]:
        return None
    run = get_run(conn, paper["run_id"])
    blanks = [
        {
            "global_no": int(item["global_no"]),
            "slot_id": item["slot_id"],
            "context_left": item["context_left"],
            "context_right": item["context_right"],
            "role_expected": item["role_expected"],
        }
        for item in run["blanks"]
    ]
    # 待复核空数：被标记 needs_review 的（含大模型低置信补全），以及根本没抽到
    # 答案的空。仅供前端提示文案使用；真正的考试准入以 verified（run.passed）为准。
    review_row = conn.execute(
        "SELECT COUNT(*) FROM blank_checks WHERE run_id = ? "
        "AND (needs_review = 1 OR TRIM(COALESCE(filled_raw, '')) = '')",
        (paper["run_id"],),
    ).fetchone()
    return {
        "id": int(paper["id"]),
        "title": paper["title"],
        "language": paper["language"],
        "run_id": int(paper["run_id"]),
        "template": run["code_template"],
        "blanks": blanks,
        "blank_count": len(blanks),
        "verified": bool(paper["verified"]),
        "review_count": int(review_row[0]) if review_row else 0,
        "attempt_count": int(paper["attempt_count"]),
        "best_score": int(paper["best_score"]),
    }


def answer_key(conn: sqlite3.Connection, run_id: int) -> dict[int, str]:
    """从入库质检结果取标准答案；只服务端调用。"""
    return {
        int(row["blank_no"]): row["filled_raw"] or ""
        for row in conn.execute(
            "SELECT blank_no, filled_raw FROM blank_checks WHERE run_id = ?", (run_id,)
        )
    }


def save_exam_attempt(
    conn: sqlite3.Connection,
    paper_id: int,
    run_id: int,
    grade: dict[str, Any],
    *,
    mode: str = "exam",
    elapsed_ms: int = 0,
) -> int:
    ensure_schema(conn)
    cursor = conn.execute(
        """INSERT INTO code_exam_attempts
           (paper_id, run_id, created_at, mode, total, answered, correct,
            score, passed, elapsed_ms, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            paper_id,
            run_id,
            _now(),
            mode,
            grade["total"],
            grade["answered"],
            grade["correct"],
            grade["score"],
            1 if grade["passed"] else 0,
            elapsed_ms,
            json.dumps({"results": grade["results"]}, ensure_ascii=False),
        ),
    )
    conn.commit()
    return int(cursor.lastrowid)


def list_exam_attempts(
    conn: sqlite3.Connection, paper_id: int, limit: int = 20
) -> list[dict[str, Any]]:
    ensure_schema(conn)
    return [
        dict(row)
        for row in conn.execute(
            """SELECT id, created_at, mode, total, answered, correct,
                      score, passed, elapsed_ms
               FROM code_exam_attempts WHERE paper_id = ?
               ORDER BY id DESC LIMIT ?""",
            (paper_id, limit),
        )
    ]


def list_all_attempts(
    conn: sqlite3.Connection,
    mode: str | None = None,
    paper_id: int | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """跨卷的整卷记录总表：刷题 / 考试合并展示，可按模式、卷子过滤。

    供「整卷历史」页使用；左连接 code_papers 取标题，缺标题时回退为「整卷 N」。
    """
    ensure_schema(conn)
    sql = (
        "SELECT a.id, a.paper_id, a.run_id, a.created_at, a.mode, a.total, "
        "a.answered, a.correct, a.score, a.passed, a.elapsed_ms, p.title "
        "FROM code_exam_attempts a "
        "LEFT JOIN code_papers p ON p.id = a.paper_id WHERE 1=1"
    )
    params: list[Any] = []
    if mode:
        sql += " AND a.mode = ?"
        params.append(mode)
    if paper_id is not None:
        sql += " AND a.paper_id = ?"
        params.append(int(paper_id))
    sql += " ORDER BY a.id DESC LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    return [
        {
            "id": int(r["id"]),
            "paper_id": int(r["paper_id"]),
            "run_id": int(r["run_id"]),
            "created_at": r["created_at"],
            "mode": r["mode"],
            "title": r["title"] or ("整卷 " + str(r["paper_id"])),
            "total": int(r["total"]),
            "answered": int(r["answered"]),
            "correct": int(r["correct"]),
            "score": int(r["score"]),
            "passed": bool(r["passed"]),
            "elapsed_ms": int(r["elapsed_ms"]),
        }
        for r in rows
    ]


def exam_prefill(conn: sqlite3.Connection, paper_id: int) -> dict[str, str]:
    """整卷重考：返回上次考试中「已答对」的空位及其标准答案，供前端自动预填。

    只预填 ``is_correct`` 的空——这些空用户已经会了，重考时直接填好锁定，
    把答错 / 未作答的空留出来让用户重做。无考试记录时返回空字典。
    """
    latest = _latest_attempt(conn, paper_id)
    if latest is None:
        return {}
    detail = latest["detail"]
    if isinstance(detail, (bytes, bytearray)):
        detail = detail.decode("utf-8", "replace")
    if isinstance(detail, str):
        try:
            detail = json.loads(detail)
        except Exception:
            return {}
    results = (detail or {}).get("results") or []
    prefill: dict[str, str] = {}
    for r in results:
        if r.get("is_correct"):
            no = str(r.get("no"))
            prefill[no] = (r.get("correct_answer") or r.get("user") or "").strip()
    return prefill


def delete_paper(conn: sqlite3.Connection, paper_id: int) -> bool:
    """删卷：连带清掉质检与考试记录，错题本里的整卷组随之消失。"""
    ensure_schema(conn)
    if not conn.execute("SELECT 1 FROM code_papers WHERE id = ?", (paper_id,)).fetchone():
        return False
    run_ids = [
        row[0]
        for row in conn.execute("SELECT id FROM verify_runs WHERE paper_id = ?", (paper_id,))
    ]
    for run_id in run_ids:
        conn.execute("DELETE FROM blanks WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM answers WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM blank_checks WHERE run_id = ?", (run_id,))
    conn.execute("DELETE FROM verify_runs WHERE paper_id = ?", (paper_id,))
    conn.execute("DELETE FROM code_blocks WHERE paper_id = ?", (paper_id,))
    conn.execute("DELETE FROM code_exam_attempts WHERE paper_id = ?", (paper_id,))
    conn.execute("DELETE FROM code_papers WHERE id = ?", (paper_id,))
    conn.commit()
    return True


def update_paper_meta(
    conn: sqlite3.Connection, paper_id: int, *, title: str = "", language: str = "python"
) -> None:
    """仅改卷子的展示元信息（标题 / 类型），不动已封存的空位与答案。"""
    conn.execute(
        "UPDATE code_papers SET title = ?, language = ? WHERE id = ?",
        (title, language, paper_id),
    )
    conn.commit()


def update_paper_full(
    conn: sqlite3.Connection,
    paper_id: int,
    *,
    title: str = "",
    language: str = "python",
    paper_file: str = "",
    answer_file: str = "",
    answer_path: str = "",
    answer_regions: str = "",
) -> None:
    """重新上传文件重封卷时，连文件元信息一起刷新（文件名 / 答案原件路径 / 区段坐标）。

    与 update_paper_meta（只改标题/类型）区分：用户改了源文件内容后重新上传，
    必须同步更新 paper_file / answer_file / answer_path，否则后续「同名文件」查重会失效，
    且「参考答案原文」拼图仍指向旧文件。
    """
    ensure_schema(conn)
    conn.execute(
        """UPDATE code_papers
           SET title = ?, language = ?, paper_file = ?, answer_file = ?,
               answer_path = ?, answer_regions = ?
           WHERE id = ?""",
        (title, language, paper_file, answer_file, answer_path, answer_regions, paper_id),
    )
    conn.commit()


def update_blank_answers(
    conn: sqlite3.Connection, paper_id: int, edits: list[dict[str, Any]]
) -> tuple[int, dict[str, Any] | None]:
    """逐空改答案（不重新解析整份卷）。

    直接改最新 run 的 ``blank_checks.filled_raw`` 与对应的 ``answers``，并据新答案
    重算 ``role_ok / result / needs_review`` 与整卷的通过状态。考试取答案走
    ``blank_checks.filled_raw``，改完立即对后续开考生效。

    返回 (改动空位数, 更新后的卷子)。
    """
    from . import core  # 延迟导入，避免循环依赖

    row = conn.execute(
        "SELECT id FROM verify_runs WHERE paper_id = ? ORDER BY id DESC LIMIT 1",
        (paper_id,),
    ).fetchone()
    if row is None:
        return 0, None
    run_id = int(row["id"])
    changed = 0
    for edit in edits or []:
        no = int(edit.get("blank_no") or edit.get("no") or 0)
        raw = str(edit.get("raw") or "").strip()
        if not no:
            continue
        chk = conn.execute(
            "SELECT answer_no, role_expected FROM blank_checks WHERE run_id = ? AND blank_no = ?",
            (run_id, no),
        ).fetchone()
        if chk is None:
            continue
        role_ok_flag = 1 if (raw and core.role_ok(chk["role_expected"], raw)) else 0
        result = "pass" if (raw and role_ok_flag) else "fail"
        conn.execute(
            """UPDATE blank_checks
               SET filled_raw = ?, filled_rendered = ?, role_ok = ?, result = ?,
                   needs_review = 0 WHERE run_id = ? AND blank_no = ?""",
            (raw, raw, role_ok_flag, result, run_id, no),
        )
        if chk["answer_no"] is not None:
            conn.execute(
                "UPDATE answers SET raw = ?, normalized = ? WHERE run_id = ? AND seq = ?",
                (raw, core.squash(raw), run_id, chk["answer_no"]),
            )
        elif raw:
            # 这个空原本没被规则抽到答案（answer_no 为空）。手动订正 / 定向重解析
            # 补上时，除了写 filled_raw，还要补一条 answers 记录并回填 answer_no，
            # 否则「标准答案清单」与后续 get_run 会一直少显示这一空。
            exists = conn.execute(
                "SELECT 1 FROM answers WHERE run_id = ? AND seq = ?", (run_id, no)
            ).fetchone()
            if not exists:
                conn.execute(
                    """INSERT INTO answers
                       (paper_id, run_id, seq, raw, normalized,
                        color_marked, source_line, page_no)
                       VALUES (?, ?, ?, ?, ?, 0, 0, 0)""",
                    (paper_id, run_id, no, raw, core.squash(raw)),
                )
            conn.execute(
                "UPDATE blank_checks SET answer_no = ? WHERE run_id = ? AND blank_no = ?",
                (no, run_id, no),
            )
        changed += 1

    # 重算整卷聚合与通过状态（all-or-nothing，与 verify 同构）
    checks = conn.execute(
        "SELECT filled_raw, role_ok FROM blank_checks WHERE run_id = ?", (run_id,)
    ).fetchall()
    total = len(checks)
    filled = sum(1 for c in checks if (c["filled_raw"] or "").strip())
    correct = sum(1 for c in checks if (c["filled_raw"] or "").strip() and c["role_ok"])
    passed = total > 0 and filled == total and correct == total
    conn.execute(
        """UPDATE verify_runs
           SET passed = ?, total = ?, matched = ?, filled = ?, correct = ?, conflicts = 0
           WHERE id = ?""",
        (1 if passed else 0, total, filled, filled, correct, run_id),
    )
    conn.execute(
        """UPDATE code_papers
           SET blank_count = ?, matched_count = ?, filled_count = ?, correct_count = ?,
               conflict_count = 0, passed = ?, status = ?
           WHERE id = ?""",
        (
            total,
            filled,
            filled,
            correct,
            1 if passed else 0,
            "passed" if passed else "reviewing",
            paper_id,
        ),
    )
    # 答案刷新后，按当前 run 的标准答案重判该卷所有历史考试记录的分数并落库，
    # 避免「学习统计」列表(读缓存 score)与详情(实时重判)分数不一致。
    recompute_attempt_scores(conn, paper_id)
    conn.commit()
    return changed, get_paper(conn, paper_id)


def recompute_attempt_scores(conn: sqlite3.Connection, paper_id: int) -> int:
    """刷新标准答案后，重判该卷所有历史 ``code_exam_attempts`` 的缓存分数并落库。

    与详情接口 ``/api/code-papers/attempts/<id>`` 的实时重判逻辑保持一致：取当前
    run 的标准答案键，按 ``blank_no(=global_no)`` 覆盖旧快照的 ``correct_answer``
    并重判 ``is_correct``，再重算 ``total / correct / score / passed``。这样无论
    列表(读 ``score`` 缓存)还是详情(实时重判)看到的数字都一致。

    返回受影响(被重算)的考试记录数。无当前 run 时直接跳过(无法重判)。
    """
    from . import core  # 延迟导入，避免循环依赖

    row = conn.execute(
        "SELECT id FROM verify_runs WHERE paper_id = ? ORDER BY id DESC LIMIT 1",
        (paper_id,),
    ).fetchone()
    if row is None:
        return 0
    run_id = int(row["id"])
    key_by_no = answer_key(conn, run_id)  # {int blank_no: filled_raw}
    if not key_by_no:
        return 0
    attempts = conn.execute(
        "SELECT id, detail FROM code_exam_attempts WHERE paper_id = ?",
        (paper_id,),
    ).fetchall()
    updated = 0
    for a in attempts:
        detail = json.loads(a["detail"] or "{}")
        results = detail.get("results") or []
        if not results:
            continue
        new_results = []
        for it in results:
            no = int(it.get("no") or 0)
            cur = key_by_no.get(no)
            if cur is None or cur == it.get("correct_answer"):
                new_results.append(it)
                continue
            raw_key = str(cur or "")
            alts = [p.strip() for p in re.split(r"\|\||｜｜", raw_key) if p.strip()] or [raw_key]
            user_norm = core.squash(str(it.get("user") or "").strip())
            is_correct = bool(user_norm) and any(
                user_norm == core.squash(x) for x in alts
            )
            ni = dict(it)
            ni["correct_answer"] = alts[0]
            ni["is_correct"] = is_correct
            new_results.append(ni)
        results = new_results
        total = len(results)
        correct = sum(1 for x in results if x.get("is_correct"))
        score = round(correct / total * 100) if total else 0
        passed = total > 0 and correct == total
        detail["results"] = results
        conn.execute(
            """UPDATE code_exam_attempts
               SET total = ?, correct = ?, score = ?, passed = ?, detail = ?
               WHERE id = ?""",
            (
                total,
                correct,
                score,
                1 if passed else 0,
                json.dumps(detail, ensure_ascii=False),
                int(a["id"]),
            ),
        )
        updated += 1
    return updated


# ---------------------------------------------------------------------------
# v1.4.1 整卷错题组：一份卷 = 一组填空题，绝不拆成单题
# ---------------------------------------------------------------------------
def wrong_papers(conn: sqlite3.Connection) -> dict[str, Any]:
    """错题本取「待攻克的整卷组」。

    进出规则（与入库质检的 all-or-nothing 同构）：
      * 最近一次交卷有任意一空错 / 未作答 → 整卷进错题集；
      * 最近一次交卷全部答对 → 整卷移出错题集；
      * 从未考过 → 不进错题集（还没错过，谈不上复习）。

    **安全边界**：这里只下发每个空的「对 / 错 / 未作答」三态，绝不返回
    ``correct_answer`` / ``user`` / 代码上下文，避免错题本变成答案速查表。
    标准答案只在交卷后的成绩单里出现。
    """
    ensure_schema(conn)
    papers = [
        dict(row)
        for row in conn.execute("SELECT * FROM code_papers ORDER BY id DESC LIMIT 100")
    ]
    dmap = _decorate_map(conn, [int(r["id"]) for r in papers])
    items: list[dict[str, Any]] = []
    cleared = 0
    for raw in papers:
        latest = dmap["latest"].get(int(raw["id"]))
        if latest is None:
            continue
        if latest["passed"]:
            cleared += 1
            continue
        try:
            detail = json.loads(latest["detail"] or "{}")
            results = detail.get("results") or []
        except (TypeError, ValueError):
            results = []
        grid = [
            {
                "no": int(r.get("no") or i + 1),
                "ok": bool(r.get("is_correct")),
                "answered": bool(r.get("answered")),
            }
            for i, r in enumerate(results)
        ]
        items.append(
            {
                "id": int(raw["id"]),
                "title": raw["title"] or f"整卷 {raw['id']}",
                "language": raw["language"] or "python",
                "blank_count": len(grid) or int(raw["blank_count"] or 0),
                "total": int(latest["total"]),
                "correct": int(latest["correct"]),
                "score": int(latest["score"]),
                "miss_count": int(latest["total"]) - int(latest["correct"]),
                "last_exam_at": latest["created_at"],
                "attempt_id": int(latest["id"]),
                # 最后一次入库质检是否通过：待复核卷不允许考试 / 刷题，
                # 错题本据此把「整卷重考」换成「先去质检」。
                "verified": bool((dmap["run"].get(int(raw["id"])) or {}).get("passed")),
                "grid": grid,
            }
        )
    items.sort(key=lambda item: item["last_exam_at"], reverse=True)
    return {
        "items": items,
        "cleared_count": cleared,
        "total_papers": len(papers),
    }
