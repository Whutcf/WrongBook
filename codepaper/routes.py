"""codepaper 的 Web 接口与复核页。

这是完全独立的旁路：不注册到现有 /api/ocr、/api/questions 等链路，
也不改动它们的任何行为。
"""
from __future__ import annotations

import json
import re
import threading
import time
import types
import uuid
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, redirect, request, Response

import db
from . import core, ingest, store
from .model import VERSION, NormDoc
from .selftest import ANSWER_SAMPLE, PAPER_SAMPLE

codepaper_bp = Blueprint("codepaper", __name__)


# —— 解析结果短时缓存：试卷上传后先做「区段定位」（dry_run 解析），用户确认区段后再
# 「确认并入库」。解析大体积多区段答案 PDF 很慢（数十秒到数分钟），若确认时再完整重解一遍
# 会因浏览器 / webview 的 fetch 超时把连接掐断，表现为「入库失败：Failed to fetch」。
# 这里把首次解析得到的 PaperResult 对象连同落库所需的元数据缓存起来，确认入库时直接落库，
# 避免二次重解。缓存带 TTL，过期即作废，要求用户重新上传解析，不会静默写入过期数据。
_PARSE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_PARSE_CACHE_TTL = 30 * 60  # 30 分钟
_PARSE_CACHE_LOCK = None  # 延迟到首次使用时创建，避免导入期副作用


def _cache_lock():
    global _PARSE_CACHE_LOCK
    if _PARSE_CACHE_LOCK is None:
        import threading

        _PARSE_CACHE_LOCK = threading.Lock()
    return _PARSE_CACHE_LOCK


def _cache_put(entry: dict[str, Any]) -> str:
    import time

    token = uuid.uuid4().hex
    with _cache_lock():
        _PARSE_CACHE[token] = (time.time(), entry)
    return token


def _cache_get(token: str) -> dict[str, Any] | None:
    import time

    with _cache_lock():
        item = _PARSE_CACHE.pop(token, None)
    if item is None:
        return None
    ts, entry = item
    if time.time() - ts > _PARSE_CACHE_TTL:
        return None
    return entry


def _cache_sweep() -> None:
    cutoff = time.time() - _PARSE_CACHE_TTL
    with _cache_lock():
        dead = [k for k, v in _PARSE_CACHE.items() if v[0] < cutoff]
        for k in dead:
            del _PARSE_CACHE[k]


# —— 异步解析任务：把「PDF 拆分 / 区段对齐 / 大模型复核」这类重活放到后台线程跑，
# 前端轮询取结果。这样长解析不再占用单一 HTTP 连接，从根本上消除「网络超时 / 连接被关闭」
# （代理或 webview 把长请求掐断）导致的入库失败；大体积多区段答案 PDF + 大模型也不再受
# 单次请求时长限制。任务带 TTL，过期即作废。 ——
_PARSE_JOBS: dict[str, dict[str, Any]] = {}
_PARSE_JOBS_TTL = 60 * 60  # 1 小时
_PARSE_JOBS_LOCK = None


def _jobs_lock():
    global _PARSE_JOBS_LOCK
    if _PARSE_JOBS_LOCK is None:
        _PARSE_JOBS_LOCK = threading.Lock()
    return _PARSE_JOBS_LOCK


def _job_put(job_id: str, data: dict[str, Any]) -> None:
    with _jobs_lock():
        _PARSE_JOBS[job_id] = data


def _job_get(job_id: str) -> dict[str, Any]:
    with _jobs_lock():
        return dict(_PARSE_JOBS.get(job_id, {}))


def _job_update(job_id: str, **kw) -> None:
    with _jobs_lock():
        d = _PARSE_JOBS.get(job_id)
        if d is None:
            d = {}
            _PARSE_JOBS[job_id] = d
        d.update(kw)


def _job_sweep() -> None:
    cutoff = time.time() - _PARSE_JOBS_TTL
    with _jobs_lock():
        dead = [k for k, v in _PARSE_JOBS.items() if (v.get("created") or 0) < cutoff]
        for k in dead:
            del _PARSE_JOBS[k]


def _is_good_title(s: str, stem: str) -> bool:
    """像样的试卷名：含汉字/字母，且长度明显超过编号（排除「参考答案」等弱信号）。"""
    return bool(s) and bool(re.search(r"[\u4e00-\u9fffA-Za-z]", s)) and len(s) > max(len(stem or ""), 6)


# 单级编号 + 方法/步骤描述（如「1. 方法一 下载环境…」）通常不是整卷试卷名，而是题内步骤，
# 解析标题时不应把它误当成试卷名称。
_STEP_NOISE_RE = re.compile(
    r"(方法|步骤|如图|点击|进入|打开|双击|选择|下一步|注册|登录|安装包|下载地址|官网|右键|拖拽|拖动)"
)


def _looks_like_real_name(s: str) -> bool:
    """是否像「真实试卷名」（而非编号 / 代码行 / 单级编号+方法步骤）。

    用于从「答案文件名 / 文档标题行 / 区段标题」等多个候选里筛掉噪音：
      - 必须含汉字；
      - 不能是纯编号；
      - 不能是「单级编号 + 名称」（如 ``1. 方法一 …``），这种通常是题内步骤；
      - 不能含方法 / 步骤 / 操作类噪音词。
    """
    if not s:
        return False
    if not re.search(r"[\u4e00-\u9fff]", s):
        return False
    if re.fullmatch(r"\s*\d+(?:\.\d+)*\s*", s):
        return False
    # 仅单级编号开头（1. / 1、），排除 1.1.4 这种多级编号（多级编号开头的才是真标题）
    if re.match(r"^\s*\d+(?!\.\d)\s*[.、]\s*", s):
        return False
    if _STEP_NOISE_RE.search(s):
        return False
    return True


_PURE_NUM_RE = re.compile(r"^\s*\d+(?:\.\d+)*\s*$")


def _is_degenerate_title(t: str) -> bool:
    """标题是否退化（空 / 纯编号，如「1.1.5」）。

    退化标题来自文件名编号兜底，不是真实试卷名。覆盖更新既有卷时若派生出这种标题，
    不应拿它覆盖掉已有的正确名称（否则会触发「仅识别到编号，未在答案文件中匹配到完整名称」）。"""
    t = (t or "").strip()
    return (not t) or bool(_PURE_NUM_RE.match(t))


def _derive_paper_title(split_secs: list, matched_section: int, paper_doc: Any, stem: str,
                        title_index: dict | None = None, answer_doc: Any = None) -> str:
    """从答案内容里挑出最像试卷名的标题，优先级：

    ① 命中区段的标题（多级编号+名称，如 1.1.4 电商平台…）
    ② 各区段 / 答案全文前几行里「无编号的文档标题行」
       （如「AI训练师三级考试虚机安装下载说明教程」——来自答案内容第一行，非文件名）
    ③ 编号→全名索引（对 1.1.4 这类多级编号仍有效）

    **文件名（试卷 / 答案）一律不作为名称来源**：用户确认文件名不可靠
    （试卷文件名只是编号，答案文件名也不是试卷名）。名称只能从答案内容推断，
    且必须可由用户在界面编辑订正。
    """
    cands: list[str] = []
    docs = list(split_secs or [])
    if answer_doc is not None and answer_doc not in docs:
        docs = [answer_doc] + docs
    # 精确候选（最高优先级）：按「试卷自身编号」从全文索引里查到的完整题目名
    # （如 1.1.5 智能交通系统的数据采集、处理和审核流程设计）。
    # 多套答案混排时，命中的代码段往往只是「参考答案」块（不带题目名），而真正的题目名
    # 在它前面的题干段；若退而求其次去扫「整本文档首行标题」，会抽到封面/整本书的标题，
    # 所以用编号精确查索引最可靠，优先级必须高于整本文档标题。
    key = re.sub(r"\s+", "", (paper_doc.meta.get("source_stem") or paper_doc.meta.get("notebook_title") or ""))
    # 兜底：调用方若漏传 source_stem（如改版后异步解析路径一度丢失），用 stem 参数再试一次，
    # 保证「编号→全名」精确索引命中，避免退回整本书标题这类退化（1.1.5 回归的根源）。
    if not key and stem:
        key = re.sub(r"\s+", "", stem)
    if key and title_index and key in title_index and _looks_like_real_name(title_index[key]):
        cands.append(title_index[key])
    # ① 命中区段标题（多级编号+名称，如 1.1.4 电商平台…）
    if split_secs:
        chosen = split_secs[matched_section] if 0 <= matched_section < len(split_secs) else split_secs[0]
        cand = (chosen.meta.get("section_title_display") or chosen.meta.get("section_title") or "")
        if _looks_like_real_name(cand):
            cands.append(cand)
    # ② 整本文档首行标题（如封面「人工智能训练师（三级）操作技能复习题」）——仅作兜底，
    #    优先级最低，避免多套答案书里整本书的标题盖过当前试卷的精确题目名。
    for d in docs:
        sd = (d.meta.get("section_title_display") or "")
        if sd and _looks_like_real_name(sd) and not re.match(r"^\s*\d+(?:\.\d+){1,}", sd):
            cands.append(sd)
        for ln in d.lines()[:6]:
            t = (ln.text or "").strip()
            if t and _looks_like_real_name(t) and not re.match(r"^\s*\d+(?:\.\d+){1,}", t):
                cands.append(t)
    for c in cands:
        if _is_good_title(c, stem):
            return c
    if cands:
        return cands[0]
    return ""


def _conn():
    conn = db.connect()
    store.ensure_schema(conn)
    return conn


def _save_upload(file_storage: Any) -> str:
    suffix = Path(file_storage.filename or "").suffix.lower() or ".txt"
    folder = db.DATA_DIR / "uploads" / "codepaper"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{uuid.uuid4().hex}{suffix}"
    file_storage.save(str(target))
    return str(target)


def _align_and_assist(
    paper_doc,
    answer_doc,
    red_spans,
    *,
    reviewed_all,
    use_llm,
    base_result=None,
    region_sink=None,
):
    """对齐 + 可选大模型二次核对，返回 (result, llm_applied, llm_notes)。

    录入（POST /parse）与改卷重解析（PUT /papers/<id>）共用同一管线。
    ``base_result`` 由答案区段搜索预先算好，避免重复对齐；``region_sink``
    仅在本次真正调用 align 时收集原文坐标。
    """
    result = base_result
    if result is None:
        result = core.align(
            paper_doc, answer_doc, red_spans,
            reviewed_all=reviewed_all, region_sink=region_sink,
        )
    llm_applied, llm_notes = False, []
    if use_llm:
        try:
            result, llm_applied, llm_notes = core.llm_assist(result, paper_doc, answer_doc)
            if llm_applied:
                passed, detail = core.verify(result, reviewed_all=reviewed_all)
                result.passed = passed
                result.status = "passed" if passed else "reviewing"
                result.detail = detail
        except Exception as exc:  # noqa: BLE001 - 大模型异常不应让整次解析失败
            llm_notes = [f"大模型复核异常：{type(exc).__name__}: {exc}"]
            llm_applied = False
    return result, llm_applied, llm_notes


def _build_answer_candidates(
    answer_full: NormDoc,
    split_secs: list[NormDoc] | None,
    matched_section: int,
    answer_sections: list[dict[str, Any]] | None,
) -> list[tuple[str, NormDoc]]:
    """列出「值得试一遍」的答案文档。

    整本答案 PDF 里同名「参考答案」会出现几十次，单靠试卷代码骨架的指纹
    覆盖率很容易打平（2.1.1 与 2.1.2 是同一套代码模板），从而选错上一套的
    答案。这里同时准备三类候选：命中区段、其它高分区段、以及**向下跨页 /
    跨区段扩展**的窗口；最终由实际对齐结果裁决。

    所有候选都直接切 ``answer_full.lines()``，复用原 CodeLine 对象，
    因此页码与 bbox 不会丢失。
    """
    all_lines = answer_full.lines()
    total = len(all_lines)
    out: list[tuple[str, NormDoc]] = []

    def add(label: str, lo: int, hi: int) -> None:
        lo, hi = max(0, lo), min(total, hi)
        if hi - lo < 2:
            return
        out.append(
            (
                label,
                NormDoc(
                    doc_id=f"{answer_full.doc_id}-cand{len(out)}",
                    kind="answer",
                    source_type=answer_full.source_type,
                    language=answer_full.language,
                    pages=[all_lines[lo:hi]],
                    warnings=list(answer_full.warnings),
                    meta={**answer_full.meta},
                ),
            )
        )

    if not split_secs or len(split_secs) <= 1:
        add("全文", 0, total)
        return out

    def bounds(sec: NormDoc) -> tuple[int, int]:
        return (
            int(sec.meta.get("line_start") or 0),
            int(sec.meta.get("line_end") or 0),
        )

    bases = [matched_section]
    if answer_sections:
        ranked = sorted(
            answer_sections,
            key=lambda c: (-float(c.get("combined") or 0), int(c.get("code_lines") or 0)),
        )
        for c in ranked[:4]:
            if c["index"] not in bases:
                bases.append(c["index"])

    for bi in bases:
        if not (0 <= bi < len(split_secs)):
            continue
        st, en = bounds(split_secs[bi])
        add(f"区段{bi}", st, en)
        # 向下多探索：答案常在下一页 / 下一个边界之后才写完
        for extra in (1, 2, 3):
            j = bi + extra
            if j >= len(split_secs):
                break
            add(f"区段{bi}+{extra}", st, bounds(split_secs[j])[1])
    add("全文", 0, total)
    return out


def _select_answer_doc(
    paper_doc: NormDoc,
    answer_full: NormDoc,
    split_secs: list[NormDoc] | None,
    matched_section: int,
    answer_sections: list[dict[str, Any]] | None,
    region_sink: list[dict[str, Any]],
    *,
    lock_section: bool = False,
) -> tuple[NormDoc | None, Any, dict[str, Any]]:
    """以「实际能填满多少空」为准裁决答案区段，返回 (doc, result, 诊断)。

    打分优先级：答案数 → 通过数 → 未对齐数少 → 文档更短（避免为了凑数直接
    用整本 227 页答案）。选中的候选会把它关联的全部答案行坐标写进 region_sink。
    """
    candidates = _build_answer_candidates(
        # 用户手动指定了区段时，只在这段上做向下扩展，不去改选别的套
        answer_full, split_secs, matched_section,
        None if lock_section else answer_sections,
    )
    best: tuple[tuple[int, int, int, int], NormDoc, Any, list[dict], str] | None = None
    tried: list[dict[str, Any]] = []
    for label, doc in candidates:
        reg: list[dict[str, Any]] = []
        try:
            r = core.align(
                paper_doc, doc, ingest.red_spans_from_doc(doc), region_sink=reg
            )
        except Exception:  # noqa: BLE001 - 单个候选异常不影响其它候选
            continue
        passed = sum(1 for c in r.checks if c.result == "pass")
        missing = sum(1 for c in r.conflicts if "未找到" in c)
        key = (len(r.answers), passed, -missing, -len(doc.lines()))
        tried.append(
            {
                "label": label,
                "answers": len(r.answers),
                "passed": passed,
                "missing": missing,
                "lines": len(doc.lines()),
            }
        )
        if best is None or key > best[0]:
            best = (key, doc, r, reg, label)
    if best is None:
        return None, None, {"ok": False, "tried": len(tried)}
    _key, doc, r, reg, label = best
    region_sink.extend(reg)
    info = {
        "ok": True,
        "selected": label,
        "tried": len(tried),
        "answers": len(r.answers),
        "blanks": len(r.blanks),
        "extended": "+" in label,
        "candidates": sorted(
            tried, key=lambda t: (-t["answers"], -t["passed"], t["lines"])
        )[:8],
    }
    return doc, r, info


@codepaper_bp.route("/codepaper")
def review_page():
    """兼容旧书签 / 外部链接：整卷入库已内嵌主站，统一走 SPA 的 #codepaper 视图。

    v1.3.0 这里渲染一份独立 HTML 文档，侧栏用整页链接跳出去，导致用户
    「进去了回不来」。现在改为 302 到带 hash 的主站地址，app.js 在启动时
    读 location.hash 自动 switchView("codepaper")，侧栏 / 顶栏全程常驻。
    """
    return redirect("/#codepaper", code=302)


@codepaper_bp.route("/api/code-papers/health")
def health():
    return jsonify(
        {
            "ok": True,
            "module": "codepaper",
            "version": VERSION,
            "render_mode": "strict",
            "formats": ["docx", "pdf", "ipynb(jupyter)", "image(P1 几何横线 + 红色分割)", "text"],
            "features": ["入库质检", "卷库", "考场判分", "成绩记录", "整卷错题组"],
        }
    )


@codepaper_bp.route("/api/code-papers/demo")
def demo():
    """用内置样例跑通全链路，不落库，便于快速验证部署是否完整。"""
    paper_doc = ingest.from_text(PAPER_SAMPLE, "paper", "text", "demo-paper")
    answer_doc = ingest.from_text(ANSWER_SAMPLE, "answer", "text", "demo-answer")
    result = core.align(paper_doc, answer_doc, [], reviewed_all=True)
    return jsonify({"ok": True, "version": VERSION, "result": result.to_dict()})


def _resolve_answer(paper_doc, answer_doc, title, stem, request, payload, red_spans_init=None):
    """在 paper_doc 与整本答案 answer_doc 之间定位匹配区段并跑对齐。

    录入（POST /parse）与改卷重解析（PUT /papers/<id> 上传文件通道）共用同一管线，
    避免两份逻辑各写一遍、行为漂移。返回 (result, llm_applied, llm_notes, ctx)，
    ``ctx`` 含 title / answer_regions / answer_sections / matched_section /
    answer_search / visual 等，供调用方拼响应与持久化。
    """
    answer_sections = None
    matched_section = 0
    split_secs = None
    title_index: dict = {}
    red_spans = list(red_spans_init or [])
    # —— 整本答案 PDF（含多套试卷的答案）：按当前试卷定位对应区段 ——
    if (answer_doc.source_type or "").startswith("pdf"):
        try:
            title_index.update(ingest.build_title_index(answer_doc))
            title_index.update(ingest.build_title_index(paper_doc))
            split_secs = ingest.split_answer_book(
                answer_doc,
                paper_title=paper_doc.meta.get("notebook_title") or "",
                title_index=title_index,
            )
        except Exception:  # noqa: BLE001 - 切分异常不应阻断录入
            split_secs = [answer_doc]

    # —— 大模型不参与拆卷 / 标题解析（总闸：不勾选则本次绝不发起模型调用）——
    use_llm = bool(payload.get("use_llm") or request.form.get("use_llm"))
    answer_full = answer_doc  # 保留原始整本答案，供标题派生扫描文档标题行

    if split_secs and len(split_secs) > 1:
        try:
            matched_section, answer_sections = core.match_section(paper_doc, split_secs)
        except Exception:  # noqa: BLE001
            matched_section = 0
            answer_sections = None
        chosen = matched_section
        answer_section = request.form.get("answer_section") or payload.get("answer_section")
        if answer_section not in (None, "", "auto"):
            try:
                v = int(answer_section)
                if 0 <= v < len(split_secs):
                    chosen = v
            except (ValueError, TypeError):
                pass
        answer_doc = split_secs[chosen]
        red_spans = ingest.red_spans_from_doc(answer_doc)
        matched_section = chosen

    # —— 往下多探索：以「实际填满多少空」裁决答案区段 ——
    answer_regions: list[dict[str, Any]] = []
    answer_search: dict[str, Any] = {}
    base_result = None
    explicit_section = (
        (request.form.get("answer_section") or payload.get("answer_section"))
        not in (None, "", "auto")
    )
    if split_secs:
        best_doc, base_result, answer_search = _select_answer_doc(
            paper_doc, answer_full, split_secs, matched_section, answer_sections,
            answer_regions, lock_section=explicit_section,
        )
        if best_doc is not None:
            answer_doc = best_doc
            red_spans = ingest.red_spans_from_doc(answer_doc)

    # 未显式填写标题时，从答案区段提取完整标题。
    title_explicit = (payload.get("title") or request.form.get("title") or "").strip()
    if not title_explicit and split_secs:
        title = _derive_paper_title(split_secs, matched_section, paper_doc, stem, title_index,
                                    answer_doc=answer_full) or title

    reviewed_all = bool(payload.get("reviewed_all") or request.form.get("reviewed_all"))
    result, llm_applied, llm_notes = _align_and_assist(
        paper_doc, answer_doc, red_spans, reviewed_all=reviewed_all, use_llm=use_llm,
        base_result=base_result, region_sink=answer_regions if base_result is None else None,
    )
    if answer_search.get("extended"):
        result.warnings.append(
            f"答案跨页/跨区段：已向下合并「{answer_search.get('selected')}」完成对齐"
        )
    visual = None
    if paper_doc.meta.get("visual") or answer_doc.meta.get("visual"):
        visual = {
            "paper": paper_doc.meta.get("visual", {}),
            "answer": answer_doc.meta.get("visual", {}),
        }
    ctx = {
        "title": title,
        "answer_doc": answer_doc,
        "red_spans": red_spans,
        "answer_regions": answer_regions,
        "answer_sections": answer_sections,
        "matched_section": matched_section,
        "answer_search": answer_search,
        "visual": visual,
    }
    return result, llm_applied, llm_notes, ctx


def _parse_compute(
    paper_doc,
    answer_doc,
    paper_file: str,
    answer_file: str,
    answer_rel: str,
    stem: str,
    title_explicit: str,
    params: dict[str, Any],
    red_spans,
):
    """公共解析计算：试卷类型识别 + 区段定位 + 对齐 + 可选大模型复核 + 拼响应 + 可选缓存。

    供同步 /parse 与异步 /parse-async 共用，避免两套逻辑各写一遍、行为漂移。
    由于后台线程无法访问 request 上下文，这里统一从 ``params`` 读参数，并用一个
    只暴露 ``.form`` 的轻量 shim 满足 _resolve_answer 对 request.form 的读取。
    """
    # —— 把文件名编号注入 paper_doc.meta，供 _derive_paper_title 按编号精确查标题索引 ——
    # 这是异步解析路径（大体积答案 PDF 走这里）此前漏掉的关键一步：后台 worker 线程收到的
    # paper_doc 只带内容、没有 source_stem，导致标题派生退回整本书封面标题（即 1.1.5 回归：
    # 上传答案原件后识别成「人工智能训练师（三级）操作技能复习题」整本书名而非区段全名）。
    # 同步 parse() 路径在调用前已注入 source_stem，此处补齐以保证两条路径行为完全一致。
    if stem and paper_doc is not None:
        paper_doc.meta = {**paper_doc.meta, "source_stem": stem}
    # —— 试卷类型自动识别：仅当用户显式选了具体类型（非默认「通用」）时用其选择，否则粗判 ——
    req_lang = params.get("language") or ""
    if req_lang in ingest.PAPER_TYPES and req_lang != "通用":
        paper_type = req_lang
    else:
        try:
            paper_type = ingest.detect_paper_type(
                "\n".join(ln.text for ln in paper_doc.lines())
            )
        except Exception:
            paper_type = "通用"
    if paper_type not in ingest.PAPER_TYPES:
        paper_type = "通用"

    req_shim = types.SimpleNamespace(form=params)
    result, llm_applied, llm_notes, ctx = _resolve_answer(
        paper_doc, answer_doc, title_explicit or "整卷入库", stem,
        req_shim, params, red_spans,
    )
    title = ctx["title"]
    answer_regions = ctx["answer_regions"]
    answer_sections = ctx["answer_sections"]
    matched_section = ctx["matched_section"]
    answer_search = ctx["answer_search"]

    response: dict[str, Any] = {
        "ok": True,
        "version": VERSION,
        "title": title,
        "paper_type": paper_type,
        "blank_count": len(result.blanks),
        "llm_applied": llm_applied,
        "llm_notes": llm_notes,
        "result": result.to_dict(),
    }
    if ctx.get("visual"):
        response["visual"] = ctx["visual"]
    if answer_sections is not None:
        response["answer_sections"] = answer_sections
        response["matched_section"] = matched_section
    if answer_search:
        response["answer_search"] = answer_search
    # 异步解析必带 cache：把完整解析结果连同落库元数据缓存，后续 /persist 直接落库，
    # 既省掉二次重解，又让「更新已有卷子」复用同一份结果覆盖写入。
    if params.get("cache"):
        token = _cache_put({
            "result": result,
            "answer_regions": answer_regions,
            "title": title,
            "language": paper_type,
            "paper_file": paper_file,
            "answer_file": answer_file,
            "answer_path": answer_rel,
        })
        response["cache_token"] = token
    return response


@codepaper_bp.route("/api/code-papers/parse", methods=["POST"])
def parse():
    """解析整卷：支持 JSON 文本通道与 multipart 文件上传通道。"""
    payload: dict[str, Any] = {}
    try:
        if request.is_json:
            payload = request.get_json(silent=True) or {}
            paper_text = (payload.get("paper_text") or "").strip()
            answer_text = (payload.get("answer_text") or "").strip()
            if not paper_text or not answer_text:
                return jsonify({"ok": False, "error": "paper_text / answer_text 不能为空"}), 400
            paper_doc = ingest.from_text(paper_text, "paper", "text", "paper-text")
            answer_doc = ingest.from_text(answer_text, "answer", "text", "answer-text")
            red_spans = payload.get("red_spans") or []
            paper_file = answer_file = ""
            answer_rel = ""
            stem = ""
            title_explicit = (payload.get("title") or "").strip()
            title = title_explicit or "整卷入库"
        else:
            paper = request.files.get("paper")
            answer = request.files.get("answer")
            if paper is None or answer is None:
                return jsonify({"ok": False, "error": "请同时上传 paper 与 answer 两个文件"}), 400
            paper_path = _save_upload(paper)
            answer_path = _save_upload(answer)
            paper_doc, _ = ingest.load_file(paper_path, "paper")
            answer_doc, red_spans = ingest.load_file(answer_path, "answer")
            paper_file = paper.filename or ""
            answer_file = answer.filename or ""
            answer_rel = Path(answer_path).name  # 仅存文件名，渲染切片时再拼 uploads 目录
            stem = Path(paper_file).stem if paper_file else ""
            title_explicit = (request.form.get("title") or "").strip()
            # 带上文件名编号，供答案区段按编号 / 标题匹配（即便 ipynb 没有 # 标题）
            if stem:
                paper_doc.meta = {**paper_doc.meta, "source_stem": stem}
            title = title_explicit or paper_doc.meta.get("notebook_title") or stem or "整卷入库"

        # —— 试卷类型自动识别：仅当用户未显式选具体类型（留空或仍是默认「通用」）时，
        # 依据试卷文本粗判；识别结果一并返回前端，供录入面板回填与「改类型」入口使用。 ——
        req_lang = (payload.get("language") if request.is_json
                    else request.form.get("language")) or ""
        if req_lang in ingest.PAPER_TYPES and req_lang != "通用":
            paper_type = req_lang
        else:
            try:
                paper_type = ingest.detect_paper_type(
                    "\n".join(ln.text for ln in paper_doc.lines())
                )
            except Exception:
                paper_type = "通用"
        if paper_type not in ingest.PAPER_TYPES:
            paper_type = "通用"

        # —— 整本答案 PDF 区段定位 + 对齐 + 可选大模型复核，录入与改卷重解析共用管线 ——
        result, llm_applied, llm_notes, ctx = _resolve_answer(
            paper_doc, answer_doc, title, stem, request, payload, red_spans,
        )
        title = ctx["title"]
        answer_regions = ctx["answer_regions"]
        answer_sections = ctx["answer_sections"]
        matched_section = ctx["matched_section"]
        answer_search = ctx["answer_search"]
        dry_run = bool(payload.get("dry_run") or request.form.get("dry_run"))

        response: dict[str, Any] = {
            "ok": True,
            "version": VERSION,
            "title": title,
            "paper_type": paper_type,
            "blank_count": len(result.blanks),
            "llm_applied": llm_applied,
            "llm_notes": llm_notes,
            "result": result.to_dict(),
        }
        # 图片通道的视觉证据统计（横线数 / 红区数 / OCR box 数），供复核页展示
        if ctx.get("visual"):
            response["visual"] = ctx["visual"]
        # 整本答案 PDF 的分段定位结果：供前端「区段定位」下拉框展示
        if answer_sections is not None:
            response["answer_sections"] = answer_sections
            response["matched_section"] = matched_section
        if answer_search:
            response["answer_search"] = answer_search
        # 区段定位（dry_run）探针：把完整解析结果连同落库元数据缓存起来，
        # 「确认并入库」时凭 token 直接落库，省掉二次完整重解（避免大体积多区段答案
        # PDF 重解超时导致「入库失败：Failed to fetch」）。
        if request.form.get("cache") or payload.get("cache"):
            token = _cache_put({
                "result": result,
                "answer_regions": answer_regions,
                "title": title,
                "language": paper_type,
                "paper_file": paper_file,
                "answer_file": answer_file,
                "answer_path": answer_rel,
            })
            response["cache_token"] = token
        if (not dry_run) and payload.get("persist", True):
            conn = _conn()
            try:
                paper_id = store.create_paper(
                    conn,
                    title=title,
                    paper_file=paper_file,
                    answer_file=answer_file,
                    answer_path=answer_rel,
                    answer_regions=json.dumps(answer_regions, ensure_ascii=False),
                    language=paper_type,
                )
                run_id = store.save_result(conn, paper_id, result)
                response["paper_id"] = paper_id
                response["run_id"] = run_id
                response["answer_path"] = answer_rel
            finally:
                conn.close()
        return jsonify(response)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001 - 给前端明确错误而不是 500 空响应
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


@codepaper_bp.route("/api/code-papers/persist", methods=["POST"])
def persist_cached():
    """凭区段定位探针返回的 cache_token，把已解析结果直接落库，省掉二次完整重解。

    大体积多区段答案 PDF 的完整解析很慢，若「确认并入库」时再完整跑一遍 /parse，
    极易被浏览器 / webview 的 fetch 超时掐断（表现成「入库失败：Failed to fetch」）。
    探针（dry_run + cache=1）已把 PaperResult 与落库元数据缓存好，这里只做落库。
    缓存带 TTL：token 过期返回明确错误，要求用户重新上传解析，绝不静默写入过期数据。
    """
    _cache_sweep()
    data = request.get_json(silent=True) or {}
    token = data.get("token") or (request.form.get("token") if request.form else None)
    entry = _cache_get(token) if token else None
    if entry is None:
        return jsonify(
            {"ok": False, "error": "解析结果已过期或不存在，请重新上传并解析后再确认入库。"}
        ), 400
    # 更新已有卷子：传入 paper_id 时覆盖该卷（重封卷），不新增一份；
    # 否则走原新增通道。二者都复用同一条已解析缓存，彻底避免二次重解。
    paper_id_field = data.get("paper_id")
    conn = _conn()
    try:
        if paper_id_field:
            pid = int(paper_id_field)
            paper = store.get_paper(conn, pid)
            if paper is None:
                # 自愈：前端可能传入失效 / 错误的 paper_id（如旧编辑态遗留的 id、
                # 或该卷已被删除）。按解析缓存里的真实试卷文件名回退查重，命中则覆盖该卷；
                # 仍找不到则降级为「新增」，绝不直接 404 让用户卡死在「卷子不存在」。
                fb = None
                fb_pf = entry.get("paper_file") or ""
                if fb_pf:
                    fb = store.find_paper_by_file(
                        conn, fb_pf, entry.get("answer_file") or ""
                    )
                if fb:
                    pid = int(fb["id"])
                    paper = store.get_paper(conn, pid)
            if paper is None:
                # 降级新增：无法定位到任何既有卷，作为新卷入库
                target_id = store.create_paper(
                    conn,
                    title=entry.get("title") or "整卷入库",
                    paper_file=entry.get("paper_file") or "",
                    answer_file=entry.get("answer_file") or "",
                    answer_path=entry.get("answer_path") or "",
                    answer_regions=json.dumps(entry.get("answer_regions") or [], ensure_ascii=False),
                    language=entry.get("language") or "python",
                )
                run_id = store.save_result(conn, target_id, entry["result"])
                return jsonify({"ok": True, "paper_id": target_id, "run_id": run_id, "auto_new": True})
            # 覆盖更新既有卷：若本次派生出的标题退化成纯编号/空（如重新上传时编号兜底），
            # 不要拿它覆盖掉卷子已有的正确名称，避免名称回退成「1.1.5」并触发匹配不到的警告。
            _incoming_title = entry.get("title") or ""
            _existing_title = (paper.get("title") or "") if paper else ""
            if paper and _is_degenerate_title(_incoming_title) and _existing_title:
                _final_title = _existing_title
            else:
                _final_title = _incoming_title or _existing_title or "整卷入库"
            store.update_paper_full(
                conn, pid,
                title=_final_title,
                language=entry.get("language") or "python",
                paper_file=entry.get("paper_file") or "",
                answer_file=entry.get("answer_file") or "",
                answer_path=entry.get("answer_path") or "",
                answer_regions=json.dumps(entry.get("answer_regions") or [], ensure_ascii=False),
            )
            run_id = store.save_result(conn, pid, entry["result"])
            target_id = pid
        else:
            target_id = store.create_paper(
                conn,
                title=entry.get("title") or "整卷入库",
                paper_file=entry.get("paper_file") or "",
                answer_file=entry.get("answer_file") or "",
                answer_path=entry.get("answer_path") or "",
                answer_regions=json.dumps(entry.get("answer_regions") or [], ensure_ascii=False),
                language=entry.get("language") or "python",
            )
            run_id = store.save_result(conn, target_id, entry["result"])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()
    return jsonify({"ok": True, "paper_id": target_id, "run_id": run_id})


@codepaper_bp.route("/api/code-papers/parse-async", methods=["POST"])
def parse_async():
    """异步解析：立即返回 job_id，重活（PDF 拆分 / 区段对齐 / 大模型复核）在后台线程跑，
    前端轮询 /parse-job/<id> 取结果。

    为什么需要它：大体积多区段答案 PDF 的完整解析 + 大模型复核很慢（数十秒到数分钟），
    若像旧「更新卷子」那样把整段解析塞进单个 PUT 请求，浏览器 / webview / 代理会把这条
    长连接掐断（表现成「入库失败：Failed to fetch」）。改为「先异步算、再快速提交」后，
    长解析不再占用任何单一 HTTP 连接，从根本上消除连接被关闭导致的入库失败。
    """
    _job_sweep()
    # 请求线程内先把上传文件存盘（后台线程无法访问 request 上下文）
    try:
        if request.is_json:
            params = dict(request.get_json(silent=True) or {})
            paper_text = (params.get("paper_text") or "").strip()
            answer_text = (params.get("answer_text") or "").strip()
            if not paper_text or not answer_text:
                return jsonify({"ok": False, "error": "paper_text / answer_text 不能为空"}), 400
            paper_doc = ingest.from_text(paper_text, "paper", "text", "paper-text")
            answer_doc = ingest.from_text(answer_text, "answer", "text", "answer-text")
            red_spans = params.get("red_spans") or []
            paper_file = answer_file = answer_rel = stem = ""
        else:
            pf = request.files.get("paper")
            af = request.files.get("answer")
            if pf is None or af is None:
                return jsonify({"ok": False, "error": "请同时上传 paper 与 answer 两个文件"}), 400
            paper_path = _save_upload(pf)
            answer_path = _save_upload(af)
            paper_doc, _ = ingest.load_file(paper_path, "paper")
            answer_doc, red_spans = ingest.load_file(answer_path, "answer")
            paper_file = pf.filename or ""
            answer_file = af.filename or ""
            answer_rel = Path(answer_path).name
            stem = Path(paper_file).stem if paper_file else ""
        # 统一参数：异步解析默认既算又缓存，落库交给 /persist
        params = params if request.is_json else dict(request.form)
        params.setdefault("cache", "1")
        params.setdefault("dry_run", "1")
        params["_paper_file"] = paper_file
        params["_answer_file"] = answer_file
        params["_answer_rel"] = answer_rel
        params["_stem"] = stem
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 400

    job_id = uuid.uuid4().hex
    _job_put(job_id, {"status": "running", "created": time.time(),
                      "progress": "正在解析试卷与答案…"})
    threading.Thread(
        target=_parse_job_worker,
        args=(job_id, paper_doc, answer_doc, red_spans, params),
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job_id": job_id, "status": "running"})


@codepaper_bp.route("/api/code-papers/parse-job/<job_id>", methods=["GET"])
def parse_job_status(job_id: str):
    """轮询解析任务状态；done 时把完整结果（含 cache_token）一并返回。"""
    _job_sweep()
    job = _job_get(job_id)
    if not job:
        return jsonify(
            {"ok": False, "status": "gone", "error": "任务不存在或已过期，请重新上传并解析。"}
        ), 404
    status = job.get("status")
    if status == "done":
        return jsonify({"ok": True, "status": "done", "result": job["result"]})
    if status == "error":
        return jsonify({"ok": False, "status": "error", "error": job.get("error", "解析失败")})
    if status == "cancelled":
        return jsonify({"ok": False, "status": "cancelled", "error": "已取消。"})
    return jsonify({"ok": True, "status": "running",
                    "progress": job.get("progress", "正在解析…（大模型处理中，请稍候）")})


@codepaper_bp.route("/api/code-papers/parse-job/<job_id>", methods=["DELETE"])
def parse_job_cancel(job_id: str):
    """取消解析任务：置位取消标记，后台线程在长步骤后会让出；前端轮询将收到 cancelled。"""
    _job_update(job_id, status="cancelled", cancelled=True)
    return jsonify({"ok": True, "status": "cancelled"})


def _parse_job_worker(job_id, paper_doc, answer_doc, red_spans, params):
    """后台解析线程：跑完整解析管线并缓存结果，把状态/结果写回任务表。"""
    try:
        if _job_get(job_id).get("cancelled"):
            return
        title_explicit = (params.get("title") or "").strip()
        resp = _parse_compute(
            paper_doc, answer_doc,
            params.get("_paper_file", ""), params.get("_answer_file", ""),
            params.get("_answer_rel", ""), params.get("_stem", ""),
            title_explicit, params, red_spans,
        )
        _job_update(job_id, status="done", result=resp,
                    created=_job_get(job_id).get("created", time.time()))
    except Exception as exc:  # noqa: BLE001
        _job_update(job_id, status="error",
                    error=f"{type(exc).__name__}: {exc}")


@codepaper_bp.route("/api/code-papers/papers")
def papers():
    conn = _conn()
    try:
        return jsonify({"ok": True, "items": store.list_papers(conn)})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 原文切片：按答案在源 PDF 中的页码 + 坐标，裁出对应区域 PNG，方便对照订正
# ---------------------------------------------------------------------------
def _slice_png(file_rel: str, page_no: int, bbox) -> Response:
    """把答案原件（上传时保留）指定页的 bbox 区域渲染成 PNG 返回。"""
    base = db.DATA_DIR / "uploads" / "codepaper"
    path = base / file_rel
    if not path.exists():
        return Response("答案原件不存在", status=404)
    try:
        import fitz
    except ImportError:
        return Response("服务器未安装 PyMuPDF", status=500)
    try:
        doc = fitz.open(str(path))
    except Exception as exc:  # noqa: BLE001
        return Response(f"无法打开答案原件：{exc}", status=400)
    if page_no < 1 or page_no > doc.page_count:
        doc.close()
        return Response("页码越界", status=400)
    page = doc[page_no - 1]
    if not bbox or len(bbox) != 4:
        doc.close()
        return Response("该答案无有效坐标", status=400)
    rect = fitz.Rect(*bbox)
    pad = max(4.0, rect.height * 0.25)
    rect = fitz.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad)
    # 仅裁到当前页范围内，避免外扩越界
    rect &= page.rect
    try:
        pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(3.0, 3.0))
        png = pix.tobytes("png")
    except Exception as exc:  # noqa: BLE001
        doc.close()
        return Response(f"渲染切片失败：{exc}", status=500)
    doc.close()
    return Response(png, mimetype="image/png")


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/answer-slice")
def paper_answer_slice(paper_id: int):
    """按答案序号渲染其源 PDF 切片：?answer_no=N&run=R（run 缺省取最新）。"""
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return Response("卷子不存在", status=404)
        answer_rel = paper.get("answer_path") or ""
        if not answer_rel:
            return Response("该卷未保留答案原件（仅支持上传 PDF 入库的卷子）", status=404)
        run_id = request.args.get("run", type=int) or paper.get("run_id")
        if not run_id:
            return Response("无质检记录", status=404)
        answer_no = request.args.get("answer_no", type=int)
        row = conn.execute(
            "SELECT page_no, bbox FROM answers WHERE run_id=? AND seq=?",
            (run_id, answer_no),
        ).fetchone()
        if not row or not row["page_no"]:
            return Response("该答案无页面坐标（文本/文档来源无法切片）", status=404)
        return _slice_png(answer_rel, int(row["page_no"]), store.str_to_bbox(row["bbox"]))
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/answer-slice")
def answer_slice_file():
    """通用切片：?file=<上传文件名>&page=N&bbox=x0,y0,x1,y1（入库前预览用）。"""
    file_rel = request.args.get("file") or ""
    page_no = request.args.get("page", type=int) or 0
    bbox = store.str_to_bbox(request.args.get("bbox"))
    if not file_rel or not page_no or not bbox:
        return Response("缺少 file / page / bbox 参数", status=400)
    return _slice_png(file_rel, page_no, bbox)


def _answer_block_regions(conn, paper: dict[str, Any], run_id: int | None) -> list[dict[str, Any]]:
    """取本卷「关联的全部参考答案」坐标。

    优先用解析时落库的连续答案行区间（覆盖所有空，包括解析失败但落在
    同一代码块里的空）；旧卷没有该数据时，退回用已入库答案的逐空坐标拼出
    一个最小外包框，保证升级前的卷子也能看到原文。
    """
    raw = paper.get("answer_regions") or ""
    if raw:
        try:
            items = json.loads(raw)
            if isinstance(items, list) and items:
                return [x for x in items if x.get("page_no") and x.get("bbox")]
        except (ValueError, TypeError):
            pass
    if not run_id:
        return []
    rows = conn.execute(
        "SELECT page_no, bbox FROM answers WHERE run_id=? AND page_no>0 AND bbox IS NOT NULL",
        (run_id,),
    ).fetchall()
    out = []
    for row in rows:
        bbox = store.str_to_bbox(row["bbox"])
        if bbox:
            out.append({"page_no": int(row["page_no"]), "bbox": list(bbox), "line_no": 0})
    return out


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/answer-block")
def paper_answer_block(paper_id: int):
    """整卷级「参考答案原文」：把本卷关联的全部答案区域（可跨页）拼成一张 PNG。

    与旧的 answer-slice（单行裁剪）不同：这里输出的是这一套卷子的**完整
    参考答案代码块**，供人工对照订正未解析成功的空，而不是某一行文字。
    """
    import io

    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return Response("卷子不存在", status=404)
        answer_rel = paper.get("answer_path") or ""
        if not answer_rel:
            return Response("该卷未保留答案原件（仅支持上传 PDF 入库的卷子）", status=404)
        run_id = request.args.get("run", type=int) or paper.get("run_id")
        regions = _answer_block_regions(conn, paper, run_id)
        if not regions:
            return Response("该卷没有可用的原文坐标（纯文本粘贴来源无法切片）", status=404)
    finally:
        conn.close()

    by_page: dict[int, list[float]] = {}
    for item in regions:
        b = item.get("bbox") or []
        if len(b) != 4:
            continue
        pg = int(item["page_no"])
        box = by_page.get(pg)
        if box is None:
            by_page[pg] = [float(b[0]), float(b[1]), float(b[2]), float(b[3])]
        else:
            box[0] = min(box[0], float(b[0]))
            box[1] = min(box[1], float(b[1]))
            box[2] = max(box[2], float(b[2]))
            box[3] = max(box[3], float(b[3]))

    path = db.DATA_DIR / "uploads" / "codepaper" / answer_rel
    if not path.exists():
        return Response("答案原件不存在", status=404)
    try:
        import fitz
        from PIL import Image, ImageDraw
    except ImportError:
        return Response("服务器未安装 PyMuPDF / Pillow", status=500)
    try:
        doc = fitz.open(str(path))
    except Exception as exc:  # noqa: BLE001
        return Response(f"无法打开答案原件：{exc}", status=400)

    shots: list[tuple[int, Image.Image]] = []
    try:
        for pg in sorted(by_page)[:8]:  # 单套答案一般 1~3 页，8 页足够兜底
            if pg < 1 or pg > doc.page_count:
                continue
            page = doc[pg - 1]
            x0, y0, x1, y1 = by_page[pg]
            pad = 12.0
            rect = fitz.Rect(x0 - pad, y0 - pad, x1 + pad, y1 + pad) & page.rect
            if rect.is_empty:
                continue
            pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(2.2, 2.2))
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            shots.append((pg, img))
    except Exception as exc:  # noqa: BLE001
        doc.close()
        return Response(f"渲染参考答案原文失败：{exc}", status=500)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    if not shots:
        return Response("参考答案区域为空", status=404)

    try:
        label_h, gap = 28, 10
        width = max(img.width for _, img in shots)
        height = sum(label_h + img.height for _, img in shots) + gap * (len(shots) - 1)
        canvas = Image.new("RGB", (width, height), (250, 246, 238))
        draw = ImageDraw.Draw(canvas)
        y = 0
        for pg, img in shots:
            draw.rectangle((0, y, width, y + label_h), fill=(238, 230, 217))
            draw.text((10, y + 8), f"P.{pg}  /  ANSWER KEY", fill=(120, 78, 55))
            draw.line((0, y + label_h, width, y + label_h), fill=(222, 210, 192), width=1)
            canvas.paste(img, (0, y + label_h))
            y += label_h + img.height + gap
        # 太长的图等比缩小，避免浏览器里加载一张几万像素高的 PNG
        max_h = 7200
        if canvas.height > max_h:
            ratio = max_h / canvas.height
            canvas = canvas.resize(
                (max(1, int(canvas.width * ratio)), max_h), Image.LANCZOS
            )
        buf = io.BytesIO()
        canvas.save(buf, format="PNG", optimize=True)
        png = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        return Response(f"拼接参考答案原文失败：{exc}", status=500)
    return Response(png, mimetype="image/png")


# ---------------------------------------------------------------------------
# v1.4.0：卷库 / 考场 —— 录入一次，随时开考
# ---------------------------------------------------------------------------
@codepaper_bp.route("/api/code-papers/seed", methods=["POST"])
def seed_demo_paper():
    """一键造一份示例卷并入库，让「开始考试」第一次点就有卷可考。"""
    conn = _conn()
    try:
        existing = store.find_paper_by_title(conn, "示例卷 · 数据预处理填空练习")
        if existing:
            return jsonify({"ok": True, "paper_id": existing["id"], "reused": True})
        paper_doc = ingest.from_text(PAPER_SAMPLE, "paper", "text", "seed-paper")
        answer_doc = ingest.from_text(ANSWER_SAMPLE, "answer", "text", "seed-answer")
        result = core.align(paper_doc, answer_doc, [], reviewed_all=True)
        paper_id = store.create_paper(
            conn,
            title="示例卷 · 数据预处理填空练习",
            paper_file="内置样例",
            answer_file="内置样例",
        )
        run_id = store.save_result(conn, paper_id, result)
        return jsonify(
            {
                "ok": True,
                "paper_id": paper_id,
                "run_id": run_id,
                "blank_count": len(result.blanks),
                "reused": False,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>")
def paper_detail(paper_id: int):
    """管理端详情：含完整答案与逐空质检结果，仅供「校验」页使用。"""
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在"}), 404
        return jsonify({"ok": True, "paper": paper})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>", methods=["DELETE"])
def paper_delete(paper_id: int):
    conn = _conn()
    try:
        if not store.delete_paper(conn, paper_id):
            return jsonify({"ok": False, "error": "卷子不存在"}), 404
        return jsonify({"ok": True})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/by-file")
def papers_by_file():
    """按上传文件名查重：同名试卷文件极可能是同一份卷子的二次上传。

    供录入页在「重新上传」时提示用户「该文件已上传过，是否重新解析并更新」，
    把操作从「新增一份卷子」纠正为「更新已有卷子」。
    """
    pf = (request.args.get("paper_file") or "").strip()
    af = (request.args.get("answer_file") or "").strip()
    if not pf:
        return jsonify({"ok": True, "found": False})
    conn = _conn()
    try:
        p = store.find_paper_by_file(conn, pf, af)
        if p is None:
            return jsonify({"ok": True, "found": False})
        return jsonify({
            "ok": True, "found": True,
            "paper": {"id": int(p["id"]), "title": p.get("title") or ("整卷 " + str(p["id"]))},
        })
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>", methods=["PUT"])
def paper_update(paper_id: int):
    """改「空白试卷 + 答案参考」原文后重新解析封卷（覆盖最新 run，不新建卷子）。

    同时支持两条通道：
    - JSON：paper_text / answer_text（文本框改原文重封卷）
    - multipart 文件：paper / answer 两份文件（重新上传文件重封卷，连文件名 /
      答案原件路径一起刷新）。文件通道走与录入完全相同的对齐管线。

    重解析后考试立即采用新封卷的答案；同名文件查重也据此保持准确。
    """
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在"}), 404

        if request.is_json:
            payload = request.get_json(silent=True) or {}
            paper_text = (payload.get("paper_text") or "").strip()
            answer_text = (payload.get("answer_text") or "").strip()
            if not paper_text or not answer_text:
                return jsonify({"ok": False, "error": "paper_text / answer_text 不能为空"}), 400
            title = payload.get("title") or paper.get("title") or "整卷入库"
            language = payload.get("language") or paper.get("language") or "python"
            reviewed_all = bool(payload.get("reviewed_all"))
            use_llm = bool(payload.get("use_llm"))
            paper_doc = ingest.from_text(paper_text, "paper", "text", "paper-text")
            answer_doc = ingest.from_text(answer_text, "answer", "text", "answer-text")
            result, llm_applied, llm_notes = _align_and_assist(
                paper_doc, answer_doc, [], reviewed_all=reviewed_all, use_llm=use_llm
            )
            store.update_paper_meta(conn, paper_id, title=title, language=language)
            run_id = store.save_result(conn, paper_id, result)
            updated = store.get_paper(conn, paper_id)
            return jsonify({
                "ok": True, "version": VERSION, "paper_id": paper_id, "run_id": run_id,
                "title": title, "blank_count": len(result.blanks),
                "llm_applied": llm_applied, "llm_notes": llm_notes, "paper": updated,
            })

        # —— 文件通道：重新上传试卷 / 答案文件重封卷（连文件元信息一起刷新）——
        pf = request.files.get("paper")
        af = request.files.get("answer")
        if pf is None or af is None:
            return jsonify({"ok": False, "error": "请同时上传 paper 与 answer 两个文件"}), 400
        paper_path = _save_upload(pf)
        answer_path = _save_upload(af)
        paper_doc, _ = ingest.load_file(paper_path, "paper")
        answer_doc, red_spans = ingest.load_file(answer_path, "answer")
        pf_name = pf.filename or ""
        af_name = af.filename or ""
        answer_rel = Path(answer_path).name
        stem = Path(pf_name).stem if pf_name else ""
        title_explicit = (request.form.get("title") or "").strip()
        if stem:
            paper_doc.meta = {**paper_doc.meta, "source_stem": stem}
        title = title_explicit or paper.get("title") or paper_doc.meta.get("notebook_title") or stem or "整卷入库"
        language = (request.form.get("language") or paper.get("language") or "python")
        result, llm_applied, llm_notes, ctx = _resolve_answer(
            paper_doc, answer_doc, title, stem, request, request.form, red_spans,
        )
        title = ctx["title"]
        answer_regions = ctx["answer_regions"]
        answer_sections = ctx["answer_sections"]
        matched_section = ctx["matched_section"]
        answer_search = ctx["answer_search"]
        store.update_paper_full(
            conn, paper_id,
            title=title, language=language, paper_file=pf_name, answer_file=af_name,
            answer_path=answer_rel, answer_regions=json.dumps(answer_regions, ensure_ascii=False),
        )
        run_id = store.save_result(conn, paper_id, result)
        updated = store.get_paper(conn, paper_id)
        response = {
            "ok": True, "version": VERSION, "paper_id": paper_id, "run_id": run_id,
            "title": title, "blank_count": len(result.blanks),
            "llm_applied": llm_applied, "llm_notes": llm_notes, "paper": updated,
        }
        if ctx.get("visual"):
            response["visual"] = ctx["visual"]
        if answer_sections is not None:
            response["answer_sections"] = answer_sections
            response["matched_section"] = matched_section
        if answer_search:
            response["answer_search"] = answer_search
        return jsonify(response)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/title", methods=["PUT"])
def paper_rename(paper_id: int):
    """轻量重命名：只改展示标题，不动已封存空位与答案、不重新解析。

    与 paper_update（改原文重封卷）区分：用户只想订正试卷名称时使用，
    例如自动解析出的名称不对（误把方法步骤当名称）时，可在此直接修正。
    """
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在"}), 404
        payload = request.get_json(silent=True) or {}
        title = (payload.get("title") or "").strip()
        if not title:
            return jsonify({"ok": False, "error": "标题不能为空"}), 400
        if len(title) > 200:
            title = title[:200]
        store.update_paper_meta(conn, paper_id, title=title, language=paper.get("language") or "python")
        return jsonify({"ok": True, "paper": store.get_paper(conn, paper_id)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/language", methods=["PUT"])
def paper_change_language(paper_id: int):
    """轻量改试卷类型：只改 ``language``（试卷类型），不动已封存空位与答案、不重新解析。

    与 paper_rename（只改标题）、paper_update（改原文重封卷）并列：用户只想调整归类
    （如自动识别不准、或一份卷想从「通用」改到「代码」）时使用，点一下即可生效。
    """
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在"}), 404
        payload = request.get_json(silent=True) or {}
        lang = (payload.get("language") or "").strip()
        if lang not in ingest.PAPER_TYPES:
            return jsonify({"ok": False, "error": "无效的试卷类型：" + lang}), 400
        store.update_paper_meta(conn, paper_id, title=paper.get("title") or "", language=lang)
        return jsonify({"ok": True, "paper": store.get_paper(conn, paper_id)})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/blanks", methods=["PUT"])
def paper_update_blanks(paper_id: int):
    """逐空改答案：直接改最新 run 的标准答案，不重新解析整份卷。

    与「改原文重解析」是两种并列的改卷方式：这里只动答案文本，适合「某一空抽错了，
    手动订正」的场景。改完立即对后续开考生效。
    """
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在"}), 404
        payload = request.get_json(silent=True) or {}
        edits = payload.get("edits") or []
        if not edits:
            return jsonify({"ok": False, "error": "edits 不能为空"}), 400
        changed, updated = store.update_blank_answers(conn, paper_id, edits)
        return jsonify(
            {"ok": True, "paper_id": paper_id, "changed": changed, "paper": updated}
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


def _answer_excerpt_for_reparse(paper: dict[str, Any], limit: int = 60000) -> str:
    """读取该卷入库时保留的答案原件，展平成文本供「定向重解析」对照。

    旧卷 / 纯文本粘贴入库的卷子没有 ``answer_path``，或原件已损坏时返回空串；
    此时 core.llm_assist_targeted 会退化成「只凭上下文判断、没把握不改」，
    不会让人工复核按钮报错。
    """
    rel = paper.get("answer_path") or ""
    if not rel:
        return ""
    path = db.DATA_DIR / "uploads" / "codepaper" / Path(rel).name
    try:
        if not path.exists() or path.stat().st_size > 20 * 1024 * 1024:
            return ""
        doc, _ = ingest.load_file(str(path), "answer")
    except Exception:  # noqa: BLE001 - 原件损坏不该阻断人工复核
        return ""
    return "\n".join((ln.text or "") for ln in doc.code_lines())[:limit]


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/reparse", methods=["POST"])
def paper_reparse_targeted(paper_id: int):
    """定向重解析：指定第几空（no）/ 第几行（line），附加提示词，只对该空重新做
    语义级二次核对并回写答案，不影响其它空。需启用「整卷解析大模型」通道。"""
    conn = _conn()
    try:
        paper = store.get_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在或尚未解析"}), 404
        run_row = conn.execute(
            "SELECT id FROM verify_runs WHERE paper_id = ? ORDER BY id DESC LIMIT 1", (paper_id,)
        ).fetchone()
        if run_row is None:
            return jsonify({"ok": False, "error": "这份卷子还没有可重调的解析结果"}), 404
        run = store.get_run(conn, int(run_row["id"]))
        payload = request.get_json(silent=True) or {}
        target = payload.get("target") or {}
        extra_prompt = (payload.get("prompt") or "").strip()
        if target.get("value") in (None, ""):
            return jsonify({"ok": False, "error": "target.value 不能为空（指定第几空 no 或第几行 line）"}), 400
        result = core.result_from_run(run)
        ttype = target.get("type") or "no"
        tval = target.get("value")
        target_no = None
        if ttype == "line":
            for a in result.answers:
                if str(a.source_line) == str(tval):
                    target_no = a.no
                    break
        else:
            target_no = int(tval) if str(tval).isdigit() else None
        before_raw = next(
            (a.raw for a in result.answers if a.no == target_no), ""
        ) if target_no is not None else ""

        # 单空复核也要有据可依：把本卷答案原件交给模型对照，而不是只凭语法猜。
        excerpt = _answer_excerpt_for_reparse(paper)
        result, applied, notes = core.llm_assist_targeted(
            result, target=target, extra_prompt=extra_prompt, answer_excerpt=excerpt
        )
        ans = next((a for a in result.answers if a.no == target_no), None) if target_no is not None else None
        changed = bool(ans is not None and ans.raw != before_raw)
        # 只有答案真的变了才写库：避免「无需修正」也无谓重算整卷质检状态。
        if applied and changed and ans is not None:
            store.update_blank_answers(conn, paper_id, [{"no": target_no, "raw": ans.raw}])
        updated = store.get_paper(conn, paper_id)
        return jsonify(
            {
                "ok": True,
                "paper_id": paper_id,
                "applied": applied,
                "changed": changed,
                "target_no": target_no,
                "answer": ans.raw if ans else None,
                "has_answer_source": bool(excerpt),
                "notes": notes,
                "paper": updated,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/exam")
def exam_paper(paper_id: int):
    """考场取卷：模板 + 空位，**不含任何答案**。

    ``?retry=1``（整卷重考）：额外返回 ``prefill`` —— 上次考试中已答对的空位及其
    标准答案，前端据此自动填好这些空并锁定，只把答错 / 未作答的空留出来重做。
    """
    conn = _conn()
    try:
        paper = store.exam_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在或尚未解析"}), 404
        if not paper["blanks"]:
            return jsonify({"ok": False, "error": "这份卷子没有可作答的空位"}), 400
        # 待复核卷（最后一次入库质检未通过）一律不准进考场：考试与刷题都禁止。
        # 答案尚未定稿时拿它作答，无论算不算成绩都会误导复习，必须先质检封卷。
        if not paper["verified"]:
            return jsonify(
                {
                    "ok": False,
                    "review_required": True,
                    "review_count": int(paper.get("review_count") or 0),
                    "error": "这份卷子还有答案待复核，考试与刷题都未开放；请先在质检判定订正并封卷。",
                }
            ), 409
        resp = {"ok": True, "paper": paper}
        if request.args.get("retry") == "1":
            prefill = store.exam_prefill(conn, paper_id)
            resp["retry"] = True
            resp["prefill"] = prefill
            resp["prefill_count"] = len(prefill)
        return jsonify(resp)
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/grade", methods=["POST"])
def exam_grade(paper_id: int):
    """交卷判分：答案只在服务端，交卷后才随批改结果下发。"""
    payload = request.get_json(silent=True) or {}
    # 不能用 `or {}`：空数组 / 空字符串会被吞成合法空字典，进而写出一条
    # 全空 0 分的考试记录，污染历史、统计和错题本。
    responses = payload.get("responses")
    if not isinstance(responses, dict):
        return jsonify({"ok": False, "error": "responses 格式不正确"}), 400
    try:
        elapsed_ms = max(0, min(int(payload.get("elapsed_ms") or 0), 86_400_000))
    except (TypeError, ValueError):
        elapsed_ms = 0
    mode = "practice" if payload.get("mode") == "practice" else "exam"
    conn = _conn()
    try:
        paper = store.exam_paper(conn, paper_id)
        if paper is None:
            return jsonify({"ok": False, "error": "卷子不存在或尚未解析"}), 404
        # 权威兜底：待复核卷不允许以任何模式交卷（考试 / 刷题都不行）。
        # 正常情况下 /exam 已经挡住、拿不到答题纸；这里防止直接构造请求绕过，
        # 也防止「答题纸已打开、卷子随后被重新解析成待复核」的竞态。
        if not paper["verified"]:
            return jsonify(
                {
                    "ok": False,
                    "review_required": True,
                    "review_count": int(paper.get("review_count") or 0),
                    "error": "这份卷子还有答案待复核，考试与刷题都未开放；请先在质检判定订正并封卷。",
                }
            ), 409
        grade = core.grade_exam(
            paper["blanks"], store.answer_key(conn, paper["run_id"]), responses
        )
        attempt_id = store.save_exam_attempt(
            conn,
            paper_id,
            paper["run_id"],
            grade,
            mode=mode,
            elapsed_ms=elapsed_ms,
        )
        return jsonify(
            {
                "ok": True,
                "attempt_id": attempt_id,
                "paper_id": paper_id,
                "title": paper["title"],
                # 整卷错题组：有任意一空错就进组，全卷全对才移出。
                "in_wrong_book": not bool(grade["passed"]),
                "cleared": bool(grade["passed"]),
                "miss_count": grade["total"] - grade["correct"],
                **grade,
            }
        )
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/papers/<int:paper_id>/attempts")
def exam_attempts(paper_id: int):
    conn = _conn()
    try:
        return jsonify({"ok": True, "items": store.list_exam_attempts(conn, paper_id)})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/attempts")
def exam_attempts_all():
    """整卷历史总表：跨卷聚合，支持 ?mode=exam|practice 与 ?paper_id= 过滤。"""
    mode = request.args.get("mode")
    if mode not in ("exam", "practice"):
        mode = None
    paper_id = request.args.get("paper_id", type=int)
    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 1000))
    except (TypeError, ValueError):
        limit = 200
    conn = _conn()
    try:
        items = store.list_all_attempts(
            conn, mode=mode, paper_id=paper_id, limit=limit
        )
        return jsonify({"ok": True, "items": items})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/attempts/<int:attempt_id>")
def exam_attempt_detail(attempt_id: int):
    """单条考试记录的完整试卷明细：每空的上下文、学生答案、标准答案与对错。

    供「学习统计 → 最近考试」点击弹出完整试卷使用；只读，不改动任何数据。

    刷新语义：标准答案以「当前卷库最新 run」为准（用户修正试卷后即生效），
    逐空按 global_no 覆盖旧快照的 correct_answer 并重判 is_correct / 计分，
    保证「考过的试题」在修正后能看到最新答案，而非陈旧快照。
    """
    conn = _conn()
    try:
        row = conn.execute(
            """SELECT a.id, a.paper_id, a.created_at, a.score, a.passed,
                      a.total, a.correct, a.detail, a.mode, p.title
               FROM code_exam_attempts a LEFT JOIN code_papers p ON p.id = a.paper_id
               WHERE a.id = ?""",
            (attempt_id,),
        ).fetchone()
        if row is None:
            return jsonify({"ok": False, "error": "考试记录不存在"}), 404
        detail = json.loads(row["detail"] or "{}")
        results = detail.get("results") or []

        # 取当前卷库最新 run 的标准答案键，按 blank_no(=global_no) 覆盖旧答案
        refreshed = False
        key_by_no: dict[int, str] = {}
        paper = store.get_paper(conn, int(row["paper_id"])) if row["paper_id"] else None
        if paper and paper.get("run_id"):
            key_by_no = store.answer_key(conn, int(paper["run_id"]))

        if key_by_no:
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
                    user_norm == core.squash(a) for a in alts
                )
                ni = dict(it)
                ni["correct_answer"] = alts[0]
                ni["is_correct"] = is_correct
                new_results.append(ni)
                refreshed = True
            results = new_results
            total = len(results)
            correct = sum(1 for x in results if x.get("is_correct"))
            score = round(correct / total * 100) if total else 0
            passed = total > 0 and correct == total
        else:
            total = int(row["total"])
            correct = int(row["correct"])
            score = int(row["score"])
            passed = bool(row["passed"])

        return jsonify(
            {
                "ok": True,
                "attempt_id": int(row["id"]),
                "paper_id": int(row["paper_id"]),
                "title": row["title"] or ("整卷 " + str(row["paper_id"])),
                "created_at": row["created_at"],
                "mode": row["mode"] or "exam",
                "score": score,
                "passed": passed,
                "total": total,
                "correct": correct,
                "refreshed": refreshed,
                "code_template": ((paper.get("run") or {}).get("code_template") or "") if paper else "",
                "results": results,
            }
        )
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/summary")
def paper_summary_route():
    """整卷考试的全局统计：卷数、考试次数、平均最好分、攻克 / 待攻克、最近考试。

    供「学习统计」页的整卷模块使用；只读聚合，不改动任何数据。
    """
    conn = _conn()
    try:
        return jsonify({"ok": True, **store.paper_summary(conn)})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/wrong-papers")
def wrong_papers():
    """错题本取待攻克的「整卷组」：一份卷 = 一组填空题，不拆单题。

    返回每空的「对 / 错 / 未作答」三态供格阵展示，但**绝不下发标准答案**；
    只有全卷全对的卷子才会从这个列表里消失。
    """
    conn = _conn()
    try:
        return jsonify({"ok": True, **store.wrong_papers(conn)})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/runs/<int:run_id>")
def run_detail(run_id: int):
    conn = _conn()
    try:
        run = store.get_run(conn, run_id)
        if run is None:
            return jsonify({"ok": False, "error": "run 不存在"}), 404
        return jsonify({"ok": True, "run": run})
    finally:
        conn.close()


@codepaper_bp.route("/api/code-papers/runs/<int:run_id>/review", methods=["POST"])
def confirm_review(run_id: int):
    """人工复核完成：清除低置信标记并重算通过判定。

    低置信度（如图片几何检测）只需常规确认即可通过。若同时存在硬冲突
    （数量不等 / 未对齐 / 角色不匹配等），系统仍会拦截；此时若用户已逐空
    核对答案、明确要放行，可在前端传 ``force=true`` 人工覆盖——覆盖项会写入
    ``detail.human_override`` 留痕，供后续审计，但不会悄悄污染判定。
    """
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force", False))
    conn = _conn()
    try:
        run = store.get_run(conn, run_id)
        if run is None:
            return jsonify({"ok": False, "error": "run 不存在"}), 404
        conn.execute("UPDATE blank_checks SET needs_review = 0 WHERE run_id = ?", (run_id,))
        detail = dict(run.get("detail") or {})
        conditions = dict(detail.get("conditions") or {})
        conditions["低置信度已复核"] = True
        hard_fail = [k for k, v in conditions.items() if not v and k != "低置信度已复核"]
        if hard_fail and not force:
            passed = False
            detail.pop("human_override", None)
        else:
            passed = True
            if hard_fail:
                detail["human_override"] = hard_fail
        detail["reviewed_by_human"] = True
        detail["conditions"] = conditions
        store.save_review_result(conn, run_id, passed, detail)
        return jsonify({
            "ok": True,
            "passed": passed,
            "forced": bool(hard_fail and force),
            "overridden": hard_fail,
            "conditions": conditions,
        })
    finally:
        conn.close()
