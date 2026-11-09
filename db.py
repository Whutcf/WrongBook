"""SQLite storage for WrongBook."""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("WRONGBOOK_DATA", BASE_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
# 真正生成了题目的原图单独放这里；uploads/ 只保留尚未生成题目的上传图片
QUESTION_IMAGE_DIR = DATA_DIR / "question_images"
DB_PATH = DATA_DIR / "wrongbook.db"

DEFAULT_TAGS = ["其他"]
QNO_PREFIXES = {
    "single": "单选",
    "multiple": "多选",
    "truefalse": "判断",
    "fill": "填空",
}
QNO_RE = re.compile(r"^(单选|多选|判断|填空)-(\d+)$")


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _file_digest(path: Path) -> str:
    """SHA-256 content hash of a file (used to recognise the same image)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


IMAGE_REF_PREFIXES = ("uploads", "question_images")
QUESTION_IMAGE_INDEX = "题目索引.csv"


def _image_name(rel: str) -> str:
    """Extract a safe bare filename from a logical image path."""
    prefix, sep, name = (rel or "").replace("\\", "/").lstrip("/").partition("/")
    if not sep or prefix not in IMAGE_REF_PREFIXES or not name:
        return ""
    if "/" in name or ".." in name or not name.strip():
        return ""
    return name


def is_image_ref(rel: str) -> bool:
    """Whether ``rel`` is a well-formed logical image path we accept."""
    return bool(_image_name(rel))


def image_name(rel: str) -> str:
    """Bare filename of a logical image path (empty when malformed)."""
    return _image_name(rel)


def resolve_image(rel: str) -> Path | None:
    """Resolve ``uploads/<name>`` or ``question_images/<name>`` to a real file.

    Both folders are checked, so a stale row still pointing at the old folder
    keeps working after its image has been archived (and vice versa).
    """
    name = _image_name(rel)
    if not name:
        return None
    archived = str(rel).replace("\\", "/").lstrip("/").startswith("question_images/")
    folders = (
        (QUESTION_IMAGE_DIR, UPLOAD_DIR)
        if archived
        else (UPLOAD_DIR, QUESTION_IMAGE_DIR)
    )
    for folder in folders:
        candidate = folder / name
        if candidate.is_file():
            return candidate
    return None


def image_ref_url(rel: str) -> str:
    """Public URL for a logical image path (used by templates / API responses)."""
    name = _image_name(rel)
    if not name:
        return ""
    prefix = "question_images" if str(rel).replace("\\", "/").lstrip("/").startswith("question_images/") else "uploads"
    return f"/{prefix}/{name}"


def sync_question_images(conn: sqlite3.Connection) -> dict[str, int]:
    """Keep ``question_images/`` as the single home of images that produced questions.

    Idempotent: called on startup and after any write that changes
    ``questions.source_image``.  Files no longer referenced by any question are
    moved back into ``uploads/`` so they appear in the "已上传图片" list again.
    Also writes a CSV index so the folder is browsable in the file manager.
    """
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    QUESTION_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    stats = {"moved": 0, "restored": 0, "indexed": 0}
    rows = conn.execute(
        "SELECT id, qno, stem, qtype, answer, source_image FROM questions "
        "WHERE source_image <> ''"
    ).fetchall()
    referenced: set[str] = set()
    for row in rows:
        rel = row["source_image"] or ""
        name = _image_name(rel)
        if not name:
            continue
        referenced.add(name)
        src, dst = UPLOAD_DIR / name, QUESTION_IMAGE_DIR / name
        if src.is_file():
            if dst.is_file():
                # 同名文件已归档：内容一致就删掉 uploads 里的副本，不一致就都不动
                if _file_digest(src) == _file_digest(dst):
                    try:
                        src.unlink()
                    except OSError:
                        pass
                else:
                    continue
            else:
                try:
                    shutil.move(str(src), str(dst))
                    stats["moved"] += 1
                except OSError:
                    continue
        new_rel = f"question_images/{name}"
        if dst.is_file() and rel != new_rel:
            conn.execute(
                "UPDATE questions SET source_image=? WHERE source_image=?",
                (new_rel, rel),
            )

    # 归档目录里不再被任何题目引用的文件退回 uploads/，避免变成找不到归属的孤儿
    for path in QUESTION_IMAGE_DIR.iterdir():
        if not path.is_file() or path.name == QUESTION_IMAGE_INDEX:
            continue
        if path.name in referenced:
            continue
        target = UPLOAD_DIR / path.name
        try:
            if target.is_file():
                path.unlink()
            else:
                shutil.move(str(path), str(target))
                stats["restored"] += 1
        except OSError:
            pass

    # 目录索引：在资源管理器里也能按编号查到对应的图片文件
    try:
        import csv

        fresh = conn.execute(
            "SELECT qno, stem, qtype, answer, source_image, id FROM questions "
            "WHERE source_image <> '' ORDER BY id"
        ).fetchall()
        with (QUESTION_IMAGE_DIR / QUESTION_IMAGE_INDEX).open(
            "w", encoding="utf-8-sig", newline=""
        ) as handle:
            writer = csv.writer(handle)
            writer.writerow(["编号", "题干", "题型", "答案", "图片文件", "题目ID"])
            for item in fresh:
                writer.writerow(
                    [
                        item["qno"],
                        (item["stem"] or "").replace("\n", " "),
                        item["qtype"],
                        item["answer"],
                        _image_name(item["source_image"]),
                        item["id"],
                    ]
                )
        stats["indexed"] = len(fresh)
    except OSError:
        pass
    return stats


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    QUESTION_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    QUESTION_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                qno TEXT DEFAULT '',
                stem TEXT NOT NULL,
                qtype TEXT NOT NULL DEFAULT 'single',
                options TEXT NOT NULL DEFAULT '{}',
                answer TEXT NOT NULL DEFAULT '',
                explanation TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '["其他"]',
                source_image TEXT NOT NULL DEFAULT '',
                source_text TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                fingerprint TEXT NOT NULL UNIQUE,
                wrong_count INTEGER NOT NULL DEFAULT 0,
                correct_count INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0,
                mastery INTEGER NOT NULL DEFAULT 0,
                last_practiced_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                user_answer TEXT NOT NULL DEFAULT '',
                correct_answer TEXT NOT NULL DEFAULT '',
                is_correct INTEGER NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT 'practice',
                duration_ms INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_path TEXT NOT NULL DEFAULT '',
                raw_text TEXT NOT NULL DEFAULT '',
                line_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS mobile_inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ocr_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wrong TEXT NOT NULL,
                right_text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS image_hashes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                digest TEXT NOT NULL UNIQUE,
                image_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_attempt_keys (
                client_key TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery);
            CREATE INDEX IF NOT EXISTS idx_questions_wrong ON questions(wrong_count, mastery);
            CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts(created_at);
            CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
            CREATE INDEX IF NOT EXISTS idx_mobile_inbox_created ON mobile_inbox(created_at);
            CREATE INDEX IF NOT EXISTS idx_image_hashes_digest ON image_hashes(digest);
            """
        )
        conn.commit()
        seeded = conn.execute("SELECT value FROM settings WHERE key='seeded'").fetchone()
        if not seeded:
            _seed_sample(conn)
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES('seeded', ?)",
                (now(),),
            )
            conn.commit()

        numbered = conn.execute(
            "SELECT value FROM settings WHERE key='qno_scheme_v2'"
        ).fetchone()
        if not numbered:
            renumber_questions(conn)
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES('qno_scheme_v2', ?)",
                (now(),),
            )
            conn.commit()

        # 迁移：题目增加 image_digest，用于按图片内容（而非文件名）判断是否真重复
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(questions)").fetchall()}
        if "image_digest" not in cols:
            conn.execute(
                "ALTER TABLE questions ADD COLUMN image_digest TEXT NOT NULL DEFAULT ''"
            )
            conn.commit()
        # 回填：为已有题目（带原图、无 image_digest）补算内容指纹
        pending = conn.execute(
            "SELECT id, source_image FROM questions WHERE image_digest='' AND source_image<>''"
        ).fetchall()
        if pending:
            for q in pending:
                img = resolve_image(q["source_image"])
                if img:
                    digest = _file_digest(img)
                    if digest:
                        conn.execute(
                            "UPDATE questions SET image_digest=? WHERE id=?", (digest, q["id"])
                        )
            conn.commit()


def next_qno(conn: sqlite3.Connection, qtype: str) -> str:
    prefix = QNO_PREFIXES.get(qtype, "题目")
    maximum = 0
    for row in conn.execute("SELECT qno FROM questions WHERE qtype=?", (qtype,)):
        match = QNO_RE.match(row["qno"] or "")
        if match and match.group(1) == prefix:
            maximum = max(maximum, int(match.group(2)))
    return f"{prefix}-{maximum + 1}"


def renumber_questions(conn: sqlite3.Connection) -> None:
    """Number questions by insertion order inside each question type."""
    for qtype, prefix in QNO_PREFIXES.items():
        rows = conn.execute(
            "SELECT id FROM questions WHERE qtype=? ORDER BY id", (qtype,)
        ).fetchall()
        for index, row in enumerate(rows, start=1):
            conn.execute(
                "UPDATE questions SET qno=? WHERE id=?",
                (f"{prefix}-{index}", row["id"]),
            )


def _seed_sample(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM questions").fetchone()["n"]
    if count:
        return
    source = BASE_DIR / "seed_question.png"
    image_rel = ""
    if source.exists():
        target = UPLOAD_DIR / "sample_question.png"
        if not target.exists():
            shutil.copyfile(source, target)
        image_rel = "uploads/sample_question.png"

    stem = "数据可视化工具的主要作用是（  ）"
    options = {
        "A": "展示数据",
        "B": "分析数据",
        "C": "存储数据",
        "D": "清洗数据",
    }
    answer = "A"
    explanation = (
        "数据可视化工具的主要作用是将数据以图形、图表等形式展示出来，"
        "便于用户理解分析。"
    )
    source_text = (
        "46 数据可视化工具的主要作用是（ ）\n"
        "A. 展示数据\nB. 分析数据\nC. 存储数据\nD. 清洗数据\n"
        "正确答案是 A，你的答案是 B. 你答错了"
    )
    created = now()
    cur = conn.execute(
        """
        INSERT INTO questions
        (qno, stem, qtype, options, answer, explanation, tags, source_image,
         source_text, fingerprint, wrong_count, correct_count, streak, mastery,
         last_practiced_at, created_at, updated_at)
        VALUES (?, ?, 'single', ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?)
        """,
        (
            "单选-1",
            stem,
            json.dumps(options, ensure_ascii=False),
            answer,
            explanation,
            json.dumps(["示例", "计算机基础", "数据可视化"], ensure_ascii=False),
            image_rel,
            source_text,
            fingerprint(stem),
            created,
            created,
            created,
        ),
    )
    qid = cur.lastrowid
    conn.execute(
        """
        INSERT INTO attempts(question_id, user_answer, correct_answer, is_correct,
                             mode, duration_ms, created_at)
        VALUES (?, 'B', 'A', 0, 'import', 0, ?)
        """,
        (qid, created),
    )


def fingerprint(stem: str) -> str:
    normalized = re.sub(r"\s+", "", stem or "")
    normalized = re.sub(r"[（(]\s*[）)]", "", normalized)
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def soft_normalize(stem: str) -> str:
    """更宽松的题干归一化：去掉空白与所有标点（中英文括号、句号、逗号等），
    只保留字母、数字与 CJK 字符，用于“近似重复”判断。

    这样即使 OCR 把“使用。”识别成“使用”、“模型部署工具”前后多了空格，
    也能归一到同一串，从而命中题库里已存在的题目。"""
    if not stem:
        return ""
    chars: list[str] = []
    for ch in stem:
        o = ord(ch)
        if ch.isalnum() or 0x4E00 <= o <= 0x9FFF:  # 字母/数字 或 CJK 统一表意文字
            chars.append(ch)
    return "".join(chars)


def containment(a: str, b: str) -> float:
    """返回 a、b 中最长公共连续片段占较短串的比例（0~1）。

    用于识别“OCR 把答案/解析也扫进了题干”的情况：此时某题题干被另一题题干完整包含，
    普通相似度会被长串稀释，但包含度仍接近 1。"""
    if not a or not b:
        return 0.0
    sm = difflib.SequenceMatcher(None, a, b)
    longest = max((blk.size for blk in sm.get_matching_blocks()), default=0)
    return longest / min(len(a), len(b))


def find_duplicate_question(
    conn: sqlite3.Connection,
    stem: str,
    threshold: float = 0.9,
    exclude_id: int | None = None,
    rows: list | None = None,
) -> dict | None:
    """在题库中查找与 stem 高度相似的题目。命中返回 {id, stem, similarity}，否则 None。

    匹配四档（由强到弱）：
      ① 指纹完全一致（与现有 exact 行为一致）；
      ② 软归一化后完全一致（吞掉标点/空格差异）；
      ③ difflib 相似度 ≥ threshold（容忍少量增删改，覆盖 OCR 误差）；
      ④ 包含度 ≥ 0.85 且较短串 ≥ 18 字（OCR 把答案/解析也扫进题干，原题被完整包含在长串里）。
    """
    target_fp = fingerprint(stem)
    target_soft = soft_normalize(stem)
    if not target_soft:
        return None
    tlen = len(target_soft)
    if rows is None:
        rows = conn.execute("SELECT id, stem, fingerprint FROM questions").fetchall()
    best: dict | None = None
    for row in rows:
        rid = row["id"]
        if exclude_id is not None and rid == exclude_id:
            continue
        if row["fingerprint"] == target_fp:
            return {"id": rid, "stem": row["stem"], "similarity": 1.0}
        cand_soft = soft_normalize(row["stem"] or "")
        if not cand_soft:
            continue
        if cand_soft == target_soft:
            return {"id": rid, "stem": row["stem"], "similarity": 1.0}
        ratio = difflib.SequenceMatcher(None, target_soft, cand_soft).ratio()
        contain = containment(target_soft, cand_soft)
        smaller = min(tlen, len(cand_soft))
        score = 0.0
        if ratio >= threshold:
            score = ratio
        elif contain >= 0.85 and smaller >= 18:
            score = contain
        if score >= threshold and (best is None or score > best["similarity"]):
            best = {"id": rid, "stem": row["stem"], "similarity": round(score, 3)}
    return best


def normalize_tags(value: Any, fallback: bool = True) -> list[str]:
    if isinstance(value, str):
        parts = re.split(r"[,，、;；]", value)
    elif isinstance(value, list):
        parts = [str(v) for v in value]
    else:
        parts = []
    tags: list[str] = []
    for part in parts:
        tag = part.strip()
        if tag and tag not in tags:
            tags.append(tag[:24])
    return tags or (list(DEFAULT_TAGS) if fallback else [])


def serialize_question(row: sqlite3.Row, include_answer: bool = True) -> dict[str, Any]:
    try:
        options = json.loads(row["options"] or "{}")
    except json.JSONDecodeError:
        options = {}
    try:
        tags = json.loads(row["tags"] or "[]")
    except json.JSONDecodeError:
        tags = list(DEFAULT_TAGS)
    data = {
        "id": row["id"],
        "qno": row["qno"],
        "stem": row["stem"],
        "qtype": row["qtype"],
        "options": options,
        "tags": tags,
        "source_image": row["source_image"],
        "note": row["note"],
        "wrong_count": row["wrong_count"],
        "correct_count": row["correct_count"],
        "streak": row["streak"],
        "mastery": row["mastery"],
        "last_practiced_at": row["last_practiced_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "attempts": row["wrong_count"] + row["correct_count"],
    }
    if include_answer:
        data["answer"] = row["answer"]
        data["explanation"] = row["explanation"]
        data["source_text"] = row["source_text"]
    return data


def get_question(conn: sqlite3.Connection, question_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM questions WHERE id=? AND archived=0", (question_id,)
    ).fetchone()


def practice_mode_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """各练习模式当前还能练多少题。

    口径必须与 /api/practice/start 的取题条件严格一致：
    archived=0 且有答案；错题还需 wrong_count>0 且 mastery<3；新题需从未作答。
    前端据此决定默认模式（没有待攻克的错题了就落到随机练习），
    并在模式卡片上标注还剩多少题可练。
    """
    return {
        "wrong": conn.execute(
            "SELECT COUNT(*) AS n FROM questions"
            " WHERE archived=0 AND answer<>'' AND wrong_count>0 AND mastery<3"
        ).fetchone()["n"],
        "random": conn.execute(
            "SELECT COUNT(*) AS n FROM questions WHERE archived=0 AND answer<>''"
        ).fetchone()["n"],
        "unseen": conn.execute(
            "SELECT COUNT(*) AS n FROM questions"
            " WHERE archived=0 AND answer<>'' AND wrong_count=0 AND correct_count=0"
        ).fetchone()["n"],
    }


def overview(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE archived=0"
    ).fetchone()["n"]
    wrong = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE archived=0 AND wrong_count>0 AND mastery<3"
    ).fetchone()["n"]
    mastered = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE archived=0 AND mastery>=3"
    ).fetchone()["n"]
    unseen = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE archived=0 AND wrong_count=0 AND correct_count=0"
    ).fetchone()["n"]
    ready = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE archived=0 AND answer<>''"
    ).fetchone()["n"]

    # 各练习模式的可用题量（与 /api/practice/start 取题口径一致）
    practice_counts = practice_mode_counts(conn)

    today_row = conn.execute(
        """
        SELECT COUNT(*) AS n, COALESCE(SUM(is_correct), 0) AS c
        FROM attempts WHERE mode<>'import' AND created_at >= ?
        """,
        (today(),),
    ).fetchone()
    total_row = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(is_correct), 0) AS c FROM attempts WHERE mode<>'import'"
    ).fetchone()

    seven_days_ago = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
    daily_rows = conn.execute(
        """
        SELECT substr(created_at, 1, 10) AS day,
               COUNT(*) AS total,
               COALESCE(SUM(is_correct), 0) AS correct
        FROM attempts
        WHERE mode<>'import' AND created_at >= ?
        GROUP BY day
        """,
        (seven_days_ago,),
    ).fetchall()
    daily_map = {
        row["day"]: {"total": row["total"], "correct": row["correct"]}
        for row in daily_rows
    }
    daily = []
    for offset in range(6, -1, -1):
        d = (datetime.now() - timedelta(days=offset)).strftime("%Y-%m-%d")
        item = daily_map.get(d, {"total": 0, "correct": 0})
        daily.append({"date": d, **item})

    recent = conn.execute(
        """
        SELECT a.*, q.stem, q.qtype, q.tags, q.explanation
        FROM attempts a JOIN questions q ON q.id=a.question_id
        WHERE q.archived=0 AND a.mode<>'import'
        ORDER BY a.id DESC LIMIT 6
        """
    ).fetchall()
    recent_attempts = []
    for row in recent:
        try:
            tags = json.loads(row["tags"] or "[]")
        except json.JSONDecodeError:
            tags = []
        recent_attempts.append(
            {
                "id": row["id"],
                "question_id": row["question_id"],
                "stem": row["stem"],
                "qtype": row["qtype"],
                "tags": tags,
                "explanation": row["explanation"],
                "is_correct": bool(row["is_correct"]),
                "user_answer": row["user_answer"],
                "correct_answer": row["correct_answer"],
                "created_at": row["created_at"],
            }
        )

    weakest = conn.execute(
        """
        SELECT * FROM questions
        WHERE archived=0 AND wrong_count>0
        ORDER BY wrong_count DESC, mastery ASC, updated_at DESC
        LIMIT 5
        """
    ).fetchall()

    return {
        "total": total,
        "wrong": wrong,
        "mastered": mastered,
        "unseen": unseen,
        "ready": ready,
        "practice_counts": practice_counts,
        "today_total": today_row["n"],
        "today_correct": today_row["c"],
        "today_accuracy": round(today_row["c"] / today_row["n"] * 100)
        if today_row["n"]
        else None,
        "total_attempts": total_row["n"],
        "total_correct": total_row["c"],
        "accuracy": round(total_row["c"] / total_row["n"] * 100)
        if total_row["n"]
        else None,
        "daily": daily,
        "recent_attempts": recent_attempts,
        "weakest": [serialize_question(row) for row in weakest],
    }


def stats(conn: sqlite3.Connection) -> dict[str, Any]:
    base = overview(conn)
    fourteen_days_ago = (datetime.now() - timedelta(days=13)).strftime("%Y-%m-%d")
    daily_rows = conn.execute(
        """
        SELECT substr(created_at, 1, 10) AS day,
               COUNT(*) AS total,
               COALESCE(SUM(is_correct), 0) AS correct
        FROM attempts
        WHERE mode<>'import' AND created_at >= ?
        GROUP BY day
        """,
        (fourteen_days_ago,),
    ).fetchall()
    daily_map = {
        row["day"]: {"total": row["total"], "correct": row["correct"]}
        for row in daily_rows
    }
    daily14 = []
    for offset in range(13, -1, -1):
        d = (datetime.now() - timedelta(days=offset)).strftime("%Y-%m-%d")
        item = daily_map.get(d, {"total": 0, "correct": 0})
        daily14.append({"date": d, **item})

    tag_map: dict[str, dict[str, int]] = {}
    for row in conn.execute(
        "SELECT tags, wrong_count, mastery FROM questions WHERE archived=0"
    ).fetchall():
        try:
            tags = json.loads(row["tags"] or "[]")
        except json.JSONDecodeError:
            tags = []
        for tag in tags:
            entry = tag_map.setdefault(tag, {"total": 0, "wrong": 0, "mastered": 0})
            entry["total"] += 1
            if row["wrong_count"] > 0 and row["mastery"] < 3:
                entry["wrong"] += 1
            if row["mastery"] >= 3:
                entry["mastered"] += 1

    tag_stats = [
        {"tag": tag, **values}
        for tag, values in sorted(
            tag_map.items(), key=lambda item: (-item[1]["total"], item[0])
        )
    ]

    hardest = conn.execute(
        """
        SELECT * FROM questions
        WHERE archived=0 AND wrong_count > 0
        ORDER BY wrong_count DESC, correct_count ASC
        """.replace("attempts_total", "(wrong_count + correct_count)")
    ).fetchall()

    return {
        **base,
        "daily14": daily14,
        "tag_stats": tag_stats[:12],
        "hardest": [serialize_question(row) for row in hardest[:8]],
    }


# ---------------------------------------------------------------------------
# OCR correction dictionary (user-curated, persisted)
# ---------------------------------------------------------------------------
def list_corrections() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, wrong, right_text, created_at FROM ocr_corrections ORDER BY id DESC"
        ).fetchall()
    return [
        {
            "id": row["id"],
            "wrong": row["wrong"],
            "right": row["right_text"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def add_correction(wrong: str, right: str) -> int:
    wrong = (wrong or "").strip()
    right = (right or "").strip()
    if not wrong or not right:
        raise ValueError("误识文本和正确文本都不能为空")
    if wrong == right:
        raise ValueError("误识文本与正确文本不能相同")
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO ocr_corrections(wrong, right_text, created_at) VALUES (?, ?, ?)",
            (wrong, right, now()),
        )
        conn.commit()
        return cur.lastrowid


def delete_correction(cid: int) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM ocr_corrections WHERE id=?", (cid,))
        conn.commit()
        return cur.rowcount > 0


def get_correction_pairs() -> list[tuple[str, str]]:
    """Flat list of (wrong, right) pairs for the OCR engine to apply."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT wrong, right_text FROM ocr_corrections"
        ).fetchall()
    return [(row["wrong"], row["right_text"]) for row in rows]


# ---------------------------------------------------------------------------
# Uploaded image fingerprints (duplicate detection across batches)
# ---------------------------------------------------------------------------
def known_image_digests(conn: sqlite3.Connection | None = None) -> dict[str, str]:
    """Map digest -> image path for every image that has already been imported."""
    if conn is None:
        with connect() as own:
            rows = own.execute("SELECT digest, image_path FROM image_hashes").fetchall()
    else:
        rows = conn.execute("SELECT digest, image_path FROM image_hashes").fetchall()
    return {row["digest"]: row["image_path"] for row in rows}


def record_image_digest(conn: sqlite3.Connection, digest: str, image_path: str = "") -> None:
    """Remember an imported image so the same upload can be flagged later."""
    if not digest:
        return
    conn.execute(
        "INSERT OR IGNORE INTO image_hashes(digest, image_path, created_at) VALUES (?, ?, ?)",
        (digest, image_path, now()),
    )


def replace_image_digest(conn: sqlite3.Connection, digest: str, image_path: str = "") -> None:
    """Replace an existing digest mapping.

    Used when an image was uploaded before but never saved as a question and is
    now re-uploaded: the old (unused) record is replaced by the new upload so it
    is not treated as a duplicate, and the orphaned old file is removed.
    """
    if not digest:
        return
    row = conn.execute("SELECT image_path FROM image_hashes WHERE digest=?", (digest,)).fetchone()
    if row and row["image_path"] and row["image_path"] != image_path:
        old_rel = row["image_path"] or ""
        name = _image_name(old_rel)
        # 只清理 uploads/ 里没有生成题目的旧副本；已归档的题目原图绝不删
        old_file = UPLOAD_DIR / name if name else None
        if old_file and old_file.is_file():
            try:
                old_file.unlink()
            except OSError:
                pass
    conn.execute("DELETE FROM image_hashes WHERE digest=?", (digest,))
    conn.execute(
        "INSERT INTO image_hashes(digest, image_path, created_at) VALUES (?, ?, ?)",
        (digest, image_path, now()),
    )
