"""Extract one default tag keyword from a question stem.

Jieba handles general Chinese segmentation; a small domain dictionary keeps
technical compounds (数据可视化, 推荐系统, ...) together. The final fallback is
"其他" so a new question never lands in a meaningless "未分类" bucket.
"""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path

import db

TERMS = [
    "数据可视化", "推荐系统", "协同过滤", "基于内容", "数据清洗", "数据预处理",
    "数据校验", "异常检测", "特征选择", "容器化技术", "数据处理", "数据分析",
    "数据采集", "数据存储", "数据安全", "数据质量", "数据挖掘", "特征工程",
    "机器学习", "深度学习", "人工智能", "神经网络", "自然语言处理", "计算机视觉",
    "前端技术", "浏览器内核", "编程语言", "面向对象", "数据库", "操作系统",
    "计算机网络", "数据结构", "条件判断", "微服务", "云计算", "大数据",
    "可视化", "统计分析", "线性代数", "微积分",
]

STOPWORDS = {
    "以下", "下列", "哪些", "哪个", "什么", "主要", "作用", "目的", "方法", "技术",
    "工具", "系统", "功能", "模块", "流程", "环节", "优势", "特点", "正确", "错误",
    "判断", "题目", "选项", "答案", "解析", "用户", "可能", "用于", "用来", "通常",
    "一般", "第一", "第一步", "可以", "包括", "不包括", "属于", "不属于", "关于",
    "根据", "进行", "通过", "一个", "这种", "这个", "这些", "那些", "我们", "他们",
    "中", "的", "是", "和", "与", "在", "了", "为", "对", "从", "到", "把", "被",
    "有", "无", "不", "也", "都", "就", "而", "或", "及", "等", "并", "但",
}

_lock = threading.Lock()
_jieba = None


def _load_jieba():
    global _jieba
    if _jieba is not None:
        return _jieba
    import jieba
    import jieba.analyse

    jieba.setLogLevel(logging.WARNING)
    cache_dir = db.DATA_DIR / ".jieba_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    jieba.dt.tmp_dir = str(cache_dir)
    jieba.dt.cache_file = "jieba.cache"
    for term in TERMS:
        jieba.add_word(term, freq=200000)
    _jieba = jieba
    return jieba


def _clean(text: str) -> str:
    text = re.sub(r"\s+", "", str(text or ""))
    text = re.sub(r"^(?:第\s*)?\d{1,3}\s*[.、．)）:：]?", "", text)
    text = re.sub(r"^(?:判断题|单选题|多选题|填空题|选择题)\s*[:：]?", "", text)
    return text.strip()


def _meaningful(token: str) -> bool:
    token = token.strip()
    if not token or token.lower() in STOPWORDS:
        return False
    if len(token) < 2:
        return False
    if re.fullmatch(r"[\d\W_]+", token):
        return False
    if token.isdigit():
        return False
    return True


def extract_tag(stem: str) -> str:
    text = _clean(stem)
    if not text:
        return "其他"

    matches = [term for term in TERMS if term in text]
    if matches:
        matches.sort(key=lambda term: (-len(term), text.find(term)))
        return matches[0][:24]

    try:
        jieba = _load_jieba()
        with _lock:
            tokens = jieba.analyse.extract_tags(text, topK=12)
        for token in tokens:
            if _meaningful(token):
                return token[:24]
    except Exception:
        logging.getLogger(__name__).exception("keyword extraction failed")

    # Last resort: a short Chinese phrase / English technical word.
    candidates = re.findall(r"[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9.+#_-]{1,20}", text)
    for candidate in candidates:
        if _meaningful(candidate):
            return candidate[:24]
    return "其他"
