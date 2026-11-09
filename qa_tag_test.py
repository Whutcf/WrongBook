import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

tmp = Path(r"D:\Develop\Software\dshWorkSpace\WrongBook\data_test_tag")
if tmp.exists():
    shutil.rmtree(tmp)
os.environ["WRONGBOOK_DATA"] = str(tmp)
sys.path.insert(0, r"D:\Develop\Software\dshWorkSpace\WrongBook")
import app
import db
import parser

db.init_db()
lines = [
    {"text": "1. 数据可视化工具的主要作用是（ ）", "score": 0.99},
    {"text": "A. 展示数据", "score": 0.99},
    {"text": "B. 分析数据", "score": 0.99},
    {"text": "C. 存储数据", "score": 0.99},
    {"text": "D. 清洗数据", "score": 0.99},
    {"text": "正确答案是 A", "score": 0.99},
]
draft = parser.parse_lines(lines)[0]
print("parser tag", draft["tags"], "qno", draft["qno"])

with app.app.test_client() as client:
    questions = [
        {
            "stem": "以下哪些是前端技术？",
            "qtype": "multiple",
            "options": {"A": "HTML", "B": "CSS", "C": "Java", "D": "JavaScript"},
            "answer": "ABD",
        },
        {"stem": "Python 中用于定义函数的关键字是？", "qtype": "fill", "answer": "def"},
        {
            "stem": "在数据清洗与预处理流程中，第一步是什么？",
            "qtype": "fill",
            "answer": "数据清洗",
            "tags": ["我的标签"],
        },
    ]
    for question in questions:
        response = client.post("/api/questions", json=question)
        item = response.json().get("item", {})
        print(response.status_code, item.get("tags"), item.get("qno"))

conn = sqlite3.connect(tmp / "wrongbook.db")
conn.execute(
    "INSERT INTO questions(qno,stem,qtype,options,answer,explanation,tags,fingerprint,"
    "wrong_count,correct_count,streak,mastery,created_at,updated_at) "
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (
        "x",
        "关于地球的形状，以下说法正确的是？",
        "single",
        "{}",
        "A",
        "",
        json.dumps(["未分类"], ensure_ascii=False),
        "legacy-tag-test",
        0,
        0,
        0,
        0,
        "2026-01-01",
        "2026-01-01",
    ),
)
conn.commit()
conn.close()
app._backfill_default_tags()
conn = sqlite3.connect(tmp / "wrongbook.db")
conn.row_factory = sqlite3.Row
print(
    "backfill",
    [dict(row) for row in conn.execute("SELECT stem,tags FROM questions WHERE fingerprint=?", ("legacy-tag-test",))],
)
conn.close()
shutil.rmtree(tmp, ignore_errors=True)
