/* ==================================================================
   整卷考试 / EXAM HALL —— 主站内嵌视图的交互脚本（v1.4.3 修订）
   ------------------------------------------------------------------
   产品链路：录入封卷 → 卷库 → 选卷开考 → 交卷判分 → 成绩留档 / 整卷错题组。
   v1.4.1 硬规则：一份卷 = 一组填空题，绝不拆成单题；有任意一空错整卷进
   错题本，全卷全对整卷才移出。原「对照检查」降级为第 02 页签「入库质检」；考场不再作为页签，改由「我的题库 / 错题本」的「整卷考试」深链进入。

   约束：所有 id 带 cp 前缀、动态类名带 cp 前缀，不与 app.js 的全局事件委托
   （[data-view] / [data-action] / [data-anchor]）冲突；样式全部在
   codepaper.css 的 .cp-embed 作用域内。答案只在服务端，取卷接口不下发。
   ================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("cpEmbed");
  if (!root) return; /* 视图未渲染时静默退出，不抛错影响主站其它页面 */

  /* 把三个模态 portal 到 body：本视图整卷页嵌在 .page 内，而 .page 的切页
     动画 pageIn 带 transform，会让 position:fixed 相对「页面内容」而非视口定位，
     导致「参考答案原文」等弹窗锚定在页面右上角、整体偏上、顶部露出页头、内容区被挤出可视范围。
     移到 body 后脱离一切 transform 祖先，fixed 重新相对视口居中（app.js 库标签面板已用同样手法）。
     模态 CSS 本就无 .cp-embed 前缀、属 body 层安全；内部的 var(--cp-accent) 已在 codepaper.css 补了
     var(--primary) 兜底，移植到 body 后令牌仍有效。 */
  ["cpSliceModal", "cpAnsEditModal", "cpEditAnsModal"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode !== document.body) document.body.appendChild(el);
  });

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, ctx) {
    return Array.prototype.slice.call((ctx || root).querySelectorAll(sel));
  };

  var S = {
    tab: "shelf",
    papers: [],
    runId: null,          /* 当前质检 run，供人工复核按钮使用 */
    intakePaperId: null,  /* 最近一次封卷入库的卷子 */
    editingPaperId: null, /* 正在编辑（改原文重解析）的卷子；null 表示录入新卷 */
    editAnswersId: null,  /* 正在逐空改答案的卷子 */
    examPaper: null,      /* 取卷结果：模板 + 空位，不含答案 */
    examMode: "exam",     /* 当前答题模式：exam=考试（必须填满）/ practice=刷题（允许空答） */
    examRetry: false,     /* 当前是否「整卷重考」模式（已答对部分已预填锁定） */
    examPrefill: {},      /* 整卷重考：{ 空号: 标准答案 } 已预填的部分 */
    examStartedAt: 0,
    timer: null,
    lastElapsed: 0,
    pendingTab: null,     /* 外部深链：切页后要落在哪个页签 */
    pendingPaperId: null, /* 外部深链：错题本「整卷重考」指定的卷子 */
    pendingRetry: false,  /* 外部深链：是否为整卷重考（预填已答对部分） */
    parseAC: null,        /* 进行中的封卷请求控制器（用于主动终止大模型调用） */
    parseBtn: null,       /* 发起封卷的那个按钮，终止时用于还原文案 */
    parseRestore: null,   /* 终止 / 完成后按钮应还原成的文案 */
    currentConds: null,   /* 当前质检 run 的条件字典，供人工复核按钮判断是否需要 force */
    hardFail: [],         /* 当前 run 中除「低置信度已复核」外的未通过项 */
    langAuto: false,      /* 上传探针是否已自动回填试卷类型：用户手动改过 cpLang 即置 false */
    parseJobId: null,     /* 异步解析任务 ID：上传走「先异步算、再快速提交」，轮询此任务取结果 */
    parseAborted: false,  /* 异步解析是否被用户取消：轮询循环据此停止，不影响后台任务本身 */
    probeResult: null,    /* 探针 / 异步解析返回的完整回执（含 result、paper_type、cache_token） */
    probeToken: null,     /* /persist 凭此 token 直接落库，免去二次重解 */
    probeMatched: null    /* 自动匹配的区段下标，用于「接受自动匹配」时走快速提交通道 */
  };
  var CURRENT_RUN_ID = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function pad2(n) { return ("0" + Number(n)).slice(-2); }
  function fmtDate(s) { return String(s || "").replace("T", " ").slice(0, 16); }
  function fmtDuration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
  }

  function api(path, opts, signal) {
    opts = opts || {};
    if (signal) opts.signal = signal;
    /* 字符串 body 一律按 JSON 发：曾因漏 Content-Type 让后端 get_json() 拿到
       空 dict，「定向重解析」提交直接 400。FormData 不受影响。 */
    if (typeof opts.body === "string" && !opts.headers) {
      opts.headers = { "Content-Type": "application/json" };
    }
    return fetch(path, opts)
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
      })
      .then(function (d) {
        if (!d || d.ok === false) {
          var err = new Error((d && d.error) || "请求失败");
          err.data = d || {};   /* 保留 review_required 等业务标记，供调用方分流 */
          throw err;
        }
        return d;
      });
  }

  function setTip(msg, kind) {
    ["cpTip", "cpNote"].forEach(function (id) {
      var node = $(id);
      if (!node) return;
      node.textContent = msg;
      node.className = (id === "cpTip" ? "cp-tip" : "cp-note") +
        (kind ? " is-" + kind : "");
    });
  }

  /* 主站 app.js 与本文件是两个独立 IIFE。弹窗 / 全局提示通过 window.appUI
     桥接复用；桥接未就绪时退回本模块自带的 setTip，保证点击永远有可见反馈。 */
  function ui() { return window.appUI || null; }
  /* 醒目提示：优先复用主站 toast（带图标/动画/顶部堆叠/自动消失，与全站一致，
     绝不会被忽略）；桥接未就绪时退回 setTip。用于「保存」等需要强反馈的操作。 */
  function toast(msg, type) {
    var app = ui();
    if (app && typeof app.showToast === "function") {
      try { app.showToast(msg, type || "info"); return; } catch (e) { /* 退回 setTip */ }
    }
    setTip(msg, type === "success" ? "ok" : type === "error" ? "error" : "");
  }
  /* 复用主站「请确认」弹窗（返回 Promise<boolean>）；桥接未就绪时退回原生 confirm。 */
  function uiConfirm(title, message, confirmText, danger) {
    var u = ui();
    if (u && typeof u.confirmDialog === "function") {
      return u.confirmDialog(title, message, confirmText, !!danger);
    }
    return Promise.resolve(window.confirm(title + "\n" + message));
  }
  function showToast(msg, kind) {
    var u = ui();
    /* 主站提示条用 success / error / info；本模块历史代码写的是 ok */
    var t = kind === "ok" ? "success" : (kind === "error" ? "error" : "info");
    if (u && typeof u.showToast === "function") { u.showToast(msg, t); return; }
    setTip(msg, kind === "error" ? "error" : "ok");
  }
  function openModal(opts) {
    var u = ui();
    if (!u || typeof u.openModal !== "function") {
      setTip("弹窗组件未就绪，请刷新页面后重试。", "error");
      return null;
    }
    return u.openModal(opts);
  }
  function closeModal(result) {
    var u = ui();
    if (u && typeof u.closeModal === "function") u.closeModal(result === true);
    /* 主站 closeModal 在存在图片查看器层时只关闭那一层；这里兜底确保
       定向重解析弹窗一定收起，避免遮罩卡住整个页面。 */
    var r = $("modalRoot");
    if (r && !r.hidden) {
      r.hidden = true; r.innerHTML = "";
      document.body.style.overflow = "";
      document.body.classList.remove("modal-open");
    }
  }

  /* 参考答案原文查看器：一次展示这套卷子关联的全部参考答案（可跨页拼接） */
  function openSlice(url, title) {
    var modal = $("cpSliceModal"), img = $("cpSliceImg"), fb = $("cpSliceFallback");
    if (!modal) return;
    $("cpSliceTitle").textContent = title || "参考答案原文";
    var dl = $("cpSliceDownload");
    if (dl) dl.href = url;
    fb.hidden = true;
    img.hidden = false;
    img.onerror = function () { img.hidden = true; fb.hidden = false; };
    // 重新解析后同一 URL 会命中浏览器缓存，给 img 单独加时间戳
    img.src = url + (url.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
    modal.hidden = false;
  }
  function openAnswerBlock(paperId, runId, title, selectId) {
    var pid = paperId;
    if (!pid && selectId) {
      var sel = document.getElementById(selectId);
      pid = sel && sel.value ? Number(sel.value) : null;
    }
    if (!pid) { setTip("请先选择一份卷子，再查看参考答案原文。", "error"); return; }
    var url = "/api/code-papers/papers/" + pid + "/answer-block" +
      (runId ? "?run=" + runId : "");
    openSlice(url, title || "参考答案原文");
  }
  function closeSlice() {
    var modal = $("cpSliceModal");
    if (modal) modal.hidden = true;
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t && t.matches && t.matches("[data-cp-slice-close]")) closeSlice();
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeSlice();
  });

  /* 录入页打开时拉一次「整卷解析大模型」配置：让用户知道辅助解析是否可用。
     注意：读取的是独立于图片识别（OCR）的 parse 通道，两者配置互不相通。 */
  function loadLlmStatus() {
    var hint = $("cpLlmHint");
    if (!hint) return;
    hint.textContent = "读取整卷解析大模型配置中…";
    api("/api/llm/config?scope=parse").then(function (d) {
      if (d && d.enabled && d.active_label && d.active_label !== "--") {
        hint.textContent = "整卷解析大模型已启用：" + d.active_label + " · 仅在规则未找齐答案时补齐缺失空，找齐则零调用（不勾选则完全离线）";
        hint.className = "cp-llm-hint is-on";
      } else {
        hint.textContent = "未单独配置「整卷解析大模型」；可在「设置 → 大模型 → ② 整卷解析大模型」中启用，不影响常规解析";
        hint.className = "cp-llm-hint";
      }
    }).catch(function () {
      hint.textContent = "无法读取模型配置（离线？）；不影响常规解析";
      hint.className = "cp-llm-hint";
    });
  }

  /* ------------------------------------------------------------------
     质检渲染（第 02 页签）：入库前确认答案参考有没有把卷子填对
     ------------------------------------------------------------------ */
  function setVerdict(passed) {
    var badge = $("cpBadge");
    badge.className = "cp-badge " + (passed ? "ok" : "bad");
    badge.textContent = passed ? "封卷可用" : "待人工复核";
    var seal = $("cpSeal");
    seal.className = "cp-seal " + (passed ? "ok" : "bad");
    var txt = $("cpSealText");
    txt.textContent = "";
    txt.appendChild(document.createTextNode(passed ? "质检通过" : "待复核"));
    txt.appendChild(el("small", "", passed ? "ALL VERIFIED" : "REVIEW REQUIRED"));
    $("cpStatusLine").textContent = passed
      ? "每个空都已对齐标准答案，答案已封存，可以开考。"
      : "存在未通过项，请按下方条件与逐空明细复核；人工复核不会放行硬冲突。";
  }

  function renderConds(conds) {
    var box = $("cpConds");
    box.textContent = "";
    Object.keys(conds).forEach(function (key) {
      box.appendChild(el("span", "cp-cond " + (conds[key] ? "y" : "n"),
        (conds[key] ? "✓ " : "✗ ") + key));
    });
  }

  function statBox(value, label) {
    var box = el("div", "cp-stat");
    box.appendChild(el("b", "", value));
    box.appendChild(el("span", "", label));
    return box;
  }

  function renderAnsList(checks) {
    var wrap = $("cpAnsWrap"), list = $("cpAnsList");
    wrap.hidden = true;
    list.textContent = "";
    if (!checks || !checks.length) return;
    checks.forEach(function (c) {
      var item = el("div", "cp-ans-item");
      item.appendChild(el("span", "cp-ans-no", "B" + c.blank_no));
      var v = (c.filled_raw || "").trim();
      var tag = el("span", "cp-ans", v || "—");
      item.appendChild(tag);
      list.appendChild(item);
    });
    wrap.hidden = false;
  }

  function showResult(r, llmNotes) {
    CURRENT_RUN_ID = S.runId;
    var conds = (r.detail || {}).conditions || {};
    setVerdict(!!r.passed);

    /* 大模型复核提示：与图片识别（OCR）相互独立，仅作信息展示 */
    var llmBox = $("cpLlmNote");
    var notes = (llmNotes || []).filter(Boolean);
    if (llmBox) {
      if (notes.length) {
        llmBox.hidden = false;
        llmBox.textContent = "大模型：" + notes.join("；");
      } else {
        llmBox.hidden = true;
        llmBox.textContent = "";
      }
    }

    /* 记录条件字典，供人工复核按钮判断是否需要 force 覆盖硬冲突 */
    S.currentConds = conds;
    S.hardFail = Object.keys(conds).filter(function (key) {
      return key !== "低置信度已复核" && !conds[key];
    });
    /* 只要质检结果已落库，就给一个可操作的人工复核／确认入口：
       未通过时用于「确认通过并封存（可强制覆盖硬冲突）」；已通过时用于「确认并锁定本次结论」。
       不再因 passed 直接隐藏，避免用户在「质检判定」里找不到可点的人工复核按钮。 */
    var reviewBox = $("cpReviewBox");
    reviewBox.hidden = !CURRENT_RUN_ID;
    if (CURRENT_RUN_ID) {
      var reviewCopy = reviewBox.querySelector(".cp-review-copy");
      var reviewBtn = $("cpBtnReview");
      if (!r.passed && S.hardFail.length) {
        reviewCopy.innerHTML = "<strong>存在 " + S.hardFail.length +
          " 项系统分歧</strong><p>系统判定未通过：" + S.hardFail.join("、") +
          "。若你已逐空核对答案无误，可强制确认通过并封存（分歧项会记入卷档供审计）。</p>";
        reviewBtn.textContent = "确认人工审核通过并保存（覆盖 " + S.hardFail.length + " 项分歧）";
        reviewBtn.dataset.force = "1";
      } else if (!r.passed) {
        reviewCopy.innerHTML = "<strong>图片来源需要人工复核</strong><p>空位由几何检测得出，属低置信度证据。请对照原卷逐空确认后提交；人工复核不会覆盖数量不符、未对齐或语法角色不匹配等硬冲突。</p>";
        reviewBtn.textContent = "确认已完成人工复核";
        reviewBtn.dataset.force = "0";
      } else {
        reviewCopy.innerHTML = "<strong>质检已通过</strong><p>系统判定全部条件满足，答案已可封存开考。若你已再次逐空核对无误，可点下方按钮确认并锁定本次质检结论。</p>";
        reviewBtn.textContent = "确认并封存（已通过）";
        reviewBtn.dataset.force = "0";
      }
    }
    renderConds(conds);
    syncIntakeReviewBtn(r.passed);

    $("cpSummary").textContent = "";
    [
      [r.blanks.length, "空位总数"],
      [r.answers.length, "已对齐答案"],
      [(r.detail || {}).passed_count || 0, "通过空数"],
      [r.conflicts.length, "冲突数"]
    ].forEach(function (pair) { $("cpSummary").appendChild(statBox(pair[0], pair[1])); });

    $("cpWarnings").textContent = "";
    (r.warnings || []).concat(r.conflicts || []).forEach(function (msg) {
      $("cpWarnings").appendChild(el("div", "cp-warn", msg));
    });

    renderAnsList(r.checks);

    $("cpRows").textContent = "";
    if (!r.blanks.length) {
      var tr0 = el("tr");
      var td0 = el("td", "cp-empty", "未检测到空位，请检查试卷中的 ____ 或 Word 下划线样式。");
      td0.colSpan = 5; tr0.appendChild(td0); $("cpRows").appendChild(tr0);
    }
    var tpl = r.template || "";
    /* 同一模板行的多个空位归为一组：题干整行跨列显示一次，各空位列于其下 */
    var seenLine = {};
    r.blanks.forEach(function (b, i) {
      var c = r.checks[i] || {};
      var li = tpl ? lineForBlank({ code_template: tpl }, b.no) : null;
      var gkey = li ? ("L" + li.idx) : ("S" + (b.slot_id || b.no));
      if (!seenLine[gkey]) {
        seenLine[gkey] = true;
        var gtr = el("tr", "cp-stem-row");
        var gtd = el("td", "cp-stem-cell");
        gtd.colSpan = 5;
        if (li) {
          gtd.appendChild(el("span", "cp-stem-line-no", "第 " + li.idx + " 行"));
          gtd.appendChild(buildEditStem(li.text));
        } else {
          gtd.appendChild(el("span", "cp-stem-line-no", "片段"));
          gtd.appendChild(el("code", "cp-stem-fallback",
            (b.context_left || "").slice(-30) + " ▢ " + (b.context_right || "").slice(0, 24)));
        }
        gtr.appendChild(gtd);
        $("cpRows").appendChild(gtr);
      }
      /* 该空位单独一行：空号 / 标准答案 / 语法角色 / 结果 / 操作 */
      var tr = el("tr", "cp-b-row");
      var bCell = el("td", "cp-b");
      bCell.appendChild(el("b", "cp-b-no", "B" + b.no));
      if (li) bCell.appendChild(el("span", "cp-b-line", "第 " + li.idx + " 行"));
      else if (b.slot_id) bCell.appendChild(el("span", "cp-b-line", b.slot_id));
      tr.appendChild(bCell);
      /* 标准答案：隐藏的 value 容器（供「保存修改」读取）+ 可点击预览，
         点击预览弹出完整内容编辑窗口，改完写回该空答案 */
      var ansCell = el("td", "cp-ans-edit");
      var input = document.createElement("input");
      input.type = "hidden";          // 仅作数据载体，内容由弹窗编辑
      input.className = "cp-ans-input";
      input.dataset.no = String(b.no);
      var raw = (c.filled_raw || "").trim();
      input.value = raw;
      input.setAttribute("aria-label", "第 " + b.no + " 空的标准答案");
      ansCell.appendChild(input);

      var preview = el("button", "cp-ans-preview");
      preview.type = "button";
      preview.dataset.no = String(b.no);
      preview.setAttribute("aria-label", "第 " + b.no + " 空的标准答案，点击展开完整内容并编辑");
      var previewText = el("span", "cp-ans-text");
      if (raw) {
        previewText.textContent = raw;
      } else {
        preview.classList.add("is-empty");
        previewText.textContent = "（空，待填写）";
      }
      var previewHint = el("span", "cp-ans-edit-hint");
      previewHint.textContent = "✎ 展开编辑";
      preview.appendChild(previewText);
      preview.appendChild(previewHint);
      ansCell.appendChild(preview);
      tr.appendChild(ansCell);
      tr.appendChild(el("td", "cp-role", b.role_expected || "expr"));
      tr.appendChild(el("td", c.result === "pass" ? "cp-pass" : "cp-fail",
        c.result === "pass" ? "通过" : "未通过"));
      var actTd = el("td", "cp-act");
      var reparseBtn = el("button", "cp-reparse-btn");
      reparseBtn.type = "button";
      reparseBtn.textContent = "定向重解析";
      reparseBtn.setAttribute("data-reparse-no", String(b.no));
      reparseBtn.title = "指定该空重新做语义复核，并附提示词回写答案";
      actTd.appendChild(reparseBtn);
      tr.appendChild(actTd);
      $("cpRows").appendChild(tr);
    });

    $("cpFilled").textContent = r.code_filled || "";
    $("cpResultCard").hidden = false;
    /* 逐空明细不再分页：所有空位一次列全，表格区域按视口自适应高度并内部滚动 */
    hideAnsTip();
  }

  function fromParse(r) {
    return {
      passed: !!r.passed,
      detail: r.detail || {},
      template: r.code_template || "",
      blanks: (r.blanks || []).map(function (b) {
        return {
          no: b.no, slot_id: b.slot_id, context_left: b.context_left,
          context_right: b.context_right, role_expected: b.role_expected
        };
      }),
      answers: r.answers || [], checks: r.checks || [],
      conflicts: r.conflicts || [], warnings: r.warnings || [],
      code_filled: r.code_filled || "", raw: r
    };
  }

  function fromRun(run) {
    var detail = run.detail || {};
    return {
      passed: !!run.passed,
      detail: detail,
      template: run.code_template || "",
      blanks: (run.blanks || []).map(function (b) {
        return {
          no: b.global_no, slot_id: b.slot_id, context_left: b.context_left,
          context_right: b.context_right, role_expected: b.role_expected
        };
      }),
      answers: run.answers || [], checks: run.checks || [],
      conflicts: detail.conflicts || [], warnings: [],
      code_filled: run.code_filled || "", raw: run
    };
  }

  /* ------------------------------------------------------------------
     卷库
     ------------------------------------------------------------------ */
  function loadPapers() {
    return api("/api/code-papers/papers").then(function (d) {
      S.papers = d.items || [];
      if ($("cpTabShelfCount")) $("cpTabShelfCount").textContent = S.papers.length;
      if ($("cpShelfList")) renderShelf();
      renderPicker();
      renderAuditSelect();
    }).catch(function (e) { setTip("卷库加载失败：" + e.message, "error"); });
  }

  function actionButton(cls, label, act, title) {
    var b = el("button", cls, label);
    b.type = "button";
    b.dataset.cpAct = act;
    if (title) b.title = title;
    return b;
  }

  /* 整卷错题组的三态：没考过 / 有空错（待攻克）/ 全卷全对（已攻克） */
  function groupState(p) {
    if (!p.attempt_count) return { cls: "idle", text: "尚未开考" };
    return p.in_wrong_book
      ? { cls: "bad", text: "待攻克" }
      : { cls: "ok", text: "已攻克" };
  }

  function renderShelf() {
    var list = $("cpShelfList");
    if (!list) return;
    list.textContent = "";
    if ($("cpShelfEmpty")) $("cpShelfEmpty").hidden = S.papers.length > 0;
    S.papers.forEach(function (p, i) {
      var title = p.title || ("整卷 " + p.id);
      var state = groupState(p);
      var card = el("article", "cp-volume" + (state.cls === "bad" ? " is-wrong" : ""));
      card.dataset.id = String(p.id);

      var spine = el("div", "cp-volume-spine");
      spine.appendChild(el("span", "", "VOL."));
      spine.appendChild(el("b", "", pad2(S.papers.length - i)));
      card.appendChild(spine);

      var body = el("div", "cp-volume-body");
      var top = el("div", "cp-volume-top");
      top.appendChild(el("span", "cp-volume-tag" + (p.verified ? "" : " warn"),
        p.verified ? "已封存" : "待复核"));
      var seal = el("span", "cp-group-seal " + state.cls, state.text);
      seal.title = "整卷为一组：有任意一空错就进错题本，全卷全对才移出";
      top.appendChild(seal);
      top.appendChild(el("h4", "", title));
      body.appendChild(top);
      body.appendChild(el("p", "cp-volume-meta",
        (p.blank_count || 0) + " 个空位一组 · " + (p.language || "通用") + " · " + fmtDate(p.created_at)));

      var stats = el("div", "cp-volume-stats");
      [
        [p.attempt_count || 0, "次考试"],
        [(p.best_score || 0) + " 分", "最好成绩"],
        [p.attempt_count
          ? (p.in_wrong_book ? (p.miss_count || 0) + " 空待复习" : "整卷全对")
          : "—", "错题组"]
      ].forEach(function (pair) {
        var span = el("span", "");
        span.appendChild(el("b", "", pair[0]));
        span.appendChild(document.createTextNode(pair[1]));
        stats.appendChild(span);
      });
      body.appendChild(stats);

      var acts = el("div", "cp-volume-actions");
      acts.appendChild(p.verified === false
        ? actionButton("btn btn-ghost cp-btn", "去质检 · 不可作答", "audit",
          "这份卷子还有答案待复核，考试与刷题都未开放；请先逐空订正并封卷")
        : actionButton("btn btn-primary cp-btn",
          state.cls === "bad" ? "整卷重考" : "开始考试", "exam"));
      acts.appendChild(actionButton("btn btn-ghost cp-btn", "编辑", "edit", "改标题 / 类型 / 两份原文后重新封卷"));
      acts.appendChild(actionButton("btn btn-ghost cp-btn", "重命名", "rename", "仅修改试卷名称，不重新封卷"));
      acts.appendChild(actionButton("btn btn-ghost cp-btn", "改类型", "chgtype", "修改试卷类型（代码 / 数学 / 英语 / 文史 / 通用 / 其它），不重新封卷"));
      acts.appendChild(actionButton("btn btn-ghost cp-btn", "改答案", "edit-answers", "逐空订正某个空的答案"));
      acts.appendChild(actionButton("btn btn-ghost cp-btn", "质检明细", "audit"));
      var del = actionButton("cp-icon-btn", "×", "delete", "删除这份卷子");
      del.setAttribute("aria-label", "删除《" + title + "》");
      acts.appendChild(del);
      body.appendChild(acts);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  function renderPicker() {
    var list = $("cpExamPickerList");
    list.textContent = "";
    $("cpExamPickerEmpty").hidden = S.papers.length > 0;
    S.papers.forEach(function (p, i) {
      var row = el("div", "cp-pick");
      row.appendChild(el("span", "cp-pick-no", pad2(i + 1)));
      var copy = el("div", "cp-pick-copy");
      copy.appendChild(el("h4", "", p.title || ("整卷 " + p.id)));
      var state = groupState(p);
      var locked = p.verified === false;
      copy.appendChild(el("p", "", (p.blank_count || 0) + " 个空位一组 · " + (p.language || "通用") +
        " · 已考 " + (p.attempt_count || 0) + " 次 · 最好 " + (p.best_score || 0) + " 分 · " +
        (locked ? "待复核 · 不可作答" : state.text)));
      row.appendChild(copy);
      var b = el("button", locked ? "btn btn-ghost cp-btn" : "btn btn-primary cp-btn",
        locked ? "去质检" : (state.cls === "bad" ? "整卷重考" : "开考"));
      b.type = "button";
      if (locked) {
        b.dataset.cpAuditId = String(p.id);
        b.title = "这份卷子还有答案待复核，考试与刷题都未开放；请先订正并封卷";
      } else {
        b.dataset.cpExamId = String(p.id);
      }
      row.appendChild(b);
      list.appendChild(row);
    });
  }

  function renderAuditSelect() {
    var sel = $("cpAuditSelect");
    var keep = sel.value;
    sel.textContent = "";
    var empty = el("option", "", "选择一份卷子…");
    empty.value = "";
    sel.appendChild(empty);
    /* 仅列出「需要质检」的卷子（待复核 / 未封存）；已封存的不再出现在质检下拉框 */
    S.papers.filter(function (p) { return p.verified !== true; }).forEach(function (p) {
      var o = el("option", "", (p.title || ("整卷 " + p.id)) + " · " + (p.blank_count || 0) + " 空");
      o.value = String(p.id);
      sel.appendChild(o);
    });
    if (keep) sel.value = keep;
  }

  /* ------------------------------------------------------------------
     录入封卷
     ------------------------------------------------------------------ */
  function showIntakeReport(d) {
    var r = d.result || {};
    var passed = !!r.passed;
    var box = $("cpIntakeReport");
    box.hidden = false;
    box.classList.toggle("is-warn", !passed);
    $("cpIntakeSeal").textContent = passed ? "封" : "核";
    $("cpIntakeTitle").textContent = d.title || "未命名卷子";
    // 名称只应从「答案文件」里匹配（试卷本身通常只有编号）。若只拿到编号，明确提示用户去补全。
    var noteEl = $("cpIntakeNameNote");
    var rawTitle = (d.title || "").trim();
    var onlyNumber = rawTitle && /^[\d.\-]+$/.test(rawTitle);
    if (onlyNumber) {
      noteEl.hidden = false;
      noteEl.textContent = "⚠ 仅识别到编号，未在答案文件中匹配到完整名称。可点右上角「✎ 改名」直接补全试卷名称，无需重新封卷。";
      noteEl.className = "cp-intake-name-note is-warn";
    } else {
      noteEl.hidden = true;
      noteEl.textContent = "";
    }
    $("cpIntakeSummary").textContent =
      "识别 " + (r.blanks || []).length + " 个空位 · 对齐 " + (r.answers || []).length +
      " 个答案 · 类型：" + (d.paper_type || "通用") + " · " + (passed
        ? "入库质检全部通过，答案已封存，随时可以开考。"
        : "质检尚有未通过项，卷子已入库但考试与刷题都未开放，请到「质检判定」逐空订正并封卷。");
    var notes = (d.llm_notes || []).filter(Boolean);
    var llmEl = $("cpIntakeLlm");
    if (notes.length) {
      llmEl.hidden = false;
      llmEl.textContent = "大模型：" + notes.join("；");
    } else {
      llmEl.hidden = true;
      llmEl.textContent = "";
    }
  }

  /* 统一的「封卷入库」请求：大模型调用期间支持实时计时、手动终止与系统自动终止。
     restoreText 可选：调用完成后把按钮还原成指定文案（编辑模式回到「解析并封卷入库」）。 */
  var WATCHDOG_MS = 150000; /* 系统主动终止阈值：超过即判定卡死并终止调用（约 150 秒） */

  function showAbort(show) {
    var b = $("cpBtnAbort");
    if (!b) return;
    b.hidden = !show;
    if (!show) b.textContent = "终止调用";
  }

  function terminateParse(why) {
    var btn = S.parseBtn, restore = S.parseRestore || "解析并封卷入库";
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); btn.textContent = restore; }
    showAbort(false);
    if ($("cpTip")) $("cpTip").classList.remove("is-loading");
    if (S.parseAC) { try { S.parseAC.abort(); } catch (e) {} S.parseAC = null; }
    if (why === "auto") {
      setTip("大模型调用超时，系统已自动终止（已等待约 " + (WATCHDOG_MS / 1000) + " 秒）。若卷子已在后台入库，可在「我的题库」查看；否则请关闭「用大模型辅助解析」后重试。", "error");
    } else {
      setTip("已手动终止大模型调用。若卷子已在后台入库，可在「我的题库」查看；否则请重试或关闭「用大模型辅助解析」。", "error");
    }
  }

  function runParseRequest(path, opts, btn, restoreText, useLLM) {
    var original = btn.textContent;
    S.parseBtn = btn;
    S.parseRestore = restoreText || original;
    useLLM = (useLLM !== undefined) ? !!useLLM : !!($("cpUseLlm") && $("cpUseLlm").checked);
    var ac = new AbortController();
    S.parseAC = ac;
    opts = opts || {};
    opts.signal = ac.signal;

    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = "解析中…";
    showAbort(true);
    setTip(useLLM ? "已提交，正在解析；若有未找齐的空会调用大模型补全……（可随时点「终止调用」）" : "正在识别空位、对齐答案并封卷……（可随时点「终止调用」）");
    if ($("cpTip")) $("cpTip").classList.add("is-loading");

    var start = Date.now();
    var tick = setInterval(function () {
      var s = Math.floor((Date.now() - start) / 1000);
      var ab = $("cpBtnAbort");
      if (ab && !ab.hidden) ab.textContent = "终止调用 · 已等待 " + s + " 秒";
    }, 1000);
    var watchdog = setTimeout(function () {
      if (!ac.signal.aborted) { ac.abort(); terminateParse("auto"); }
    }, WATCHDOG_MS);

    function cleanup() {
      clearInterval(tick);
      clearTimeout(watchdog);
      showAbort(false);
      if ($("cpTip")) $("cpTip").classList.remove("is-loading");
      S.parseAC = null;
      S.parseBtn = null;
    }

    return api(path, opts).then(function (d) {
      cleanup();
      runParseSuccess(d, btn);
      return d;
    }).catch(function (e) {
      if (ac.signal.aborted) { cleanup(); return; } /* 已手动 / 自动终止，提示由 terminateParse 给出 */
      cleanup();
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.textContent = S.parseRestore;
      setTip(parseFailMessage(e), "error");
    });
  }

  /* 解析 / 入库成功后的统一回执：落库成功与「凭 token 直接落库」共用，保证回执一致 */
  function runParseSuccess(d, btn) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.textContent = S.parseRestore || btn.textContent;
    }
    S.intakePaperId = d.paper_id || S.intakePaperId;
    S.runId = d.run_id || null;
    S.editingPaperId = null;
    /* 解析回执携带自动识别出的试卷类型：同步下拉框，保持界面与落库值一致 */
    if (d.paper_type) {
      var lopts = Array.prototype.slice.call($("cpLang").options);
      if (lopts.some(function (o) { return o.value === d.paper_type; })) {
        $("cpLang").value = d.paper_type;
        S.langAuto = true;
      }
    }
    syncUploadBtn();
    /* 上传/编辑重封卷后，文本框按钮文案也要从「保存到这份卷子」复位回「解析并封卷入库」 */
    if ($("cpBtnParse")) $("cpBtnParse").textContent = "解析并封卷入库";
    /* 解析入库完成：已选文件不再需要，自动清空上传区，避免遗留文件名一直停在界面里 */
    clearUploadFiles();
    showIntakeReport(d);
    showResult(fromParse(d.result || {}), d.llm_notes || []);
    loadPapers();
    setTip("已封卷入库，去「我的题库」即可开考。", "ok");
    // 解析完成自动滚到下方「确认 / 考试」回执，免得还要手动滑到底（尊重减弱动效偏好）
    var rep = $("cpIntakeReport");
    if (rep) {
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      rep.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      var goBtn = $("cpBtnIntakeShelf");
      if (goBtn) goBtn.focus({ preventScroll: true });
    }
  }

  /* 把「连接被掐断 / 超时」这类网络层错误翻译成人话，而不是裸抛 "Failed to fetch" */
  function parseFailMessage(e) {
    var msg = (e && e.message) || "未知错误";
    if (/failed to fetch/i.test(msg)) {
      return "解析或入库请求被中断（网络超时 / 连接被关闭）。大体积或多区段答案 PDF 解析较慢，请稍候重试；若反复出现，可减小答案 PDF 体积或分批录入。";
    }
    return "入库失败：" + msg;
  }

  function submitParse(path, opts, btn, restoreText, useLLM) {
    return runParseRequest(path, opts, btn, restoreText, useLLM);
  }

  /* 编辑（改原文重解析）：把已封存卷子的原文载入录入框，保存时走 PUT 重新封卷 */
  function openEditPaper(id) {
    setTip("正在载入这份卷子的原文…");
    api("/api/code-papers/papers/" + id).then(function (d) {
      var p = d.paper || {};
      var run = p.run || {};
      $("cpTitle").value = p.title || "";
      var lang = p.language || "通用";
      var opts = Array.prototype.slice.call($("cpLang").options);
      $("cpLang").value = opts.some(function (o) { return o.value === lang; }) ? lang : "通用";
      $("cpPaper").value = (run.code_template || "").replace(/\{\{\d+\}\}/g, "____");
      $("cpAnswer").value = run.code_filled || "";
      S.editingPaperId = id;
      S.intakePaperId = id;
      syncUploadBtn();
      $("cpBtnParse").textContent = "保存到这份卷子（重新封卷）";
      $("cpIntakeReport").hidden = true;
      $("cpResultCard").hidden = true;
      switchTab("intake");
      $("cpPaper").focus();
      setTip("已载入原文：改标题 / 类型 / 两份内容后点「保存到这份卷子」重新封卷。", "ok");
    }).catch(function (e) { setTip("载入失败：" + e.message, "error"); });
  }

  function submitEditParse(btn) {
    var savedId = S.editingPaperId;   // 先存下：runParseRequest 成功回调里会把它清空
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.textContent = "重新封卷中…";
    setTip("正在按新原文重新解析并封卷…");
    runParseRequest("/api/code-papers/papers/" + savedId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paper_text: $("cpPaper").value.trim(),
        answer_text: $("cpAnswer").value.trim(),
        title: $("cpTitle").value.trim() || "整卷入库",
        language: $("cpLang").value,
        use_llm: !!($("cpUseLlm") && $("cpUseLlm").checked)
      })
    }, btn, "解析并封卷入库", !!($("cpUseLlm") && $("cpUseLlm").checked)).then(function (d) {
      /* 仅当真正保存成功（返回了 paper_id）才跳转；失败保留「入库失败」提示且不跳转 */
      if (!d || !d.paper_id) return;
      if (window.appUI && window.appUI.switchView) {
        window.appUI.switchView("library");          // 自动跳回「我的题库」
        revealPaperInLibrary(savedId);               // 定位并高亮刚编辑的这份试卷
        setTip("已按新原文重新封卷，已返回「我的题库」。", "ok");
      } else {
        setTip("已按新原文重新封卷，卷库与后续开考都采用新答案。", "ok");
      }
    });
  }

  /* 逐空改答案：直接改最新 run 的标准答案，不重新解析整份卷 */
  function openEditAnswers(id) {
    setTip("正在载入这份卷子的答案…");
    api("/api/code-papers/papers/" + id).then(function (d) {
      var p = d.paper || {};
      var run = p.run || {};
      S.editAnswersId = id;
      S.editAnswersRunId = (run && run.id) || p.run_id;
      $("cpEditAnswersPaper").textContent = "正在改：《" + (p.title || ("整卷 " + id)) + "》";
      renderEditAnswers(run);
      switchTab("editAnswers");
      setTip("逐空订正后点「保存答案」。", "ok");
    }).catch(function (e) { setTip("载入失败：" + e.message, "error"); });
  }

  /* 在模板里找到包含指定空位的那一行（原题中的完整一行），返回 {text, idx} */
  function lineForBlank(run, no) {
    var tpl = run && (run.code_template || run.template || "");
    if (!tpl) return null;
    var needle = "{{" + no + "}}";
    var lines = tpl.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(needle) !== -1) return { text: lines[i], idx: i + 1 };
    }
    return null;
  }

  /* 把原题那一行渲染出来：空位 {{n}} 与 [[BLANK]] 统一渲染成方块，其余代码如实呈现。
     不传 focusNo 时全部按普通方块显示（用于「逐空明细」里一行题干的整体预览）。 */
  function buildEditStem(line, focusNo) {
    var stem = el("div", "cp-edit-answer-stem");
    if (line.trim().charAt(0) === "#") {
      stem.appendChild(el("span", "cp-code-comment", line));
      return stem;
    }
    var re = /\{\{(\d+)\}\}|\[\[BLANK\]\]/g, last = 0, m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) stem.appendChild(el("span", "cp-code-text", line.slice(last, m.index)));
      var k = m[1] !== undefined ? Number(m[1]) : -1;
      var focus = (focusNo !== undefined && focusNo !== null && m[1] !== undefined && k === focusNo);
      stem.appendChild(el("span", focus ? "cp-edit-blank-focus" : "cp-edit-blank-other", "▢"));
      last = m.index + m[0].length;
    }
    if (last < line.length) stem.appendChild(el("span", "cp-code-text", line.slice(last)));
    return stem;
  }

  function renderEditAnswers(run) {
    var box = $("cpEditAnswersList");
    box.textContent = "";
    var checks = run.checks || [];
    var blanks = run.blanks || [];
    if (!checks.length) {
      box.appendChild(el("p", "cp-empty", "这份卷子还没有可改的答案。"));
      return;
    }
    checks.forEach(function (c) {
      var no = c.blank_no;
      var blank = blanks.filter(function (b) { return b.global_no === no; })[0] || {};
      var row = el("div", "cp-edit-answer");
      // 头部：空号 + 行号徽标，单独成行，统一对齐
      var head = el("div", "cp-edit-answer-head");
      head.appendChild(el("b", "", "B" + no));
      var lineInfo = lineForBlank(run, no);
      if (lineInfo) head.appendChild(el("span", "cp-edit-answer-line-no", "行 " + lineInfo.idx));
      else if ((blank.context_left || blank.context_right)) head.appendChild(el("span", "cp-edit-answer-line-no", "片段"));
      row.appendChild(head);
      // 主体：左原题行（空位高亮），右答案输入 —— 两列等高拉伸，显示协调统一
      var body = el("div", "cp-edit-answer-body");
      var main = el("div", "cp-edit-answer-main");
      if (lineInfo) {
        main.appendChild(buildEditStem(lineInfo.text, no));
      } else {
        // 兜底：模板缺失时退回到带上下文的片段
        main.appendChild(el("code", "cp-edit-answer-fallback",
          (blank.context_left || "").slice(-22) + " ▢ " + (blank.context_right || "").slice(0, 18)));
      }
      body.appendChild(main);

      // 答案字段：文本域直接编辑（短答案行内即可）；内容过长无法在行内完整展示/填写时，
      // 通过「展开完整编辑」按钮（或聚焦该过长答案）自动弹出对话框，确保数据完整录入与查看
      var ansField = el("div", "cp-edit-answer-field");
      var input = document.createElement("textarea");
      input.className = "cp-edit-answer-input";
      input.dataset.no = String(no);
      input.value = (c.filled_raw || "").trim();
      input.placeholder = "填入该空答案（内容过长时点「展开完整编辑」）";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "第 " + no + " 空答案");
      ansField.appendChild(input);

      var expand = el("button", "cp-edit-ans-expand");
      expand.type = "button";
      expand.dataset.editansOpen = String(no);
      expand.hidden = true;
      expand.textContent = "⤢ 展开完整编辑";
      expand.title = "答案内容过长，点此在弹窗中完整查看与编辑";
      ansField.appendChild(expand);

      body.appendChild(ansField);
      row.appendChild(body);
      box.appendChild(row);
    });
    // 面板已可见后实测：标记过长答案并露出「展开编辑」入口
    requestAnimationFrame(function () {
      Array.prototype.forEach.call(box.querySelectorAll(".cp-edit-answer-input"), resizeAnswer);
    });
  }

  /* 测算答案文本域是否超出可见区：过长则标记 overflow 并露出「展开完整编辑」入口 */
  function resizeAnswer(ta) {
    if (!ta) return;
    var overflow = ta.scrollHeight > ta.clientHeight + 2;
    ta.dataset.overflow = overflow ? "1" : "0";
    ta.classList.toggle("is-overflow", overflow);
    var wrap = ta.parentNode;
    var btn = wrap && wrap.querySelector && wrap.querySelector(".cp-edit-ans-expand");
    if (btn) btn.hidden = !overflow;
  }

  /* 保存成功后回到「我的题库」，并定位 / 高亮刚编辑的那份试卷（loadLibrary 异步渲染，轮询等待卡片出现） */
  function revealPaperInLibrary(id) {
    if (!id) return;
    var tries = 0;
    (function attempt() {
      var card = document.querySelector('.page[data-page="library"] .paper-row[data-paper-id="' + id + '"]');
      if (card) {
        try { card.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
        card.classList.add("is-just-saved");
        setTimeout(function () { card.classList.remove("is-just-saved"); }, 2000);
        return;
      }
      if (tries++ < 60) setTimeout(attempt, 60);   // 最多约 3.6s
    })();
  }

  /* 退出逐空改答案：清空残留内容，并把整卷入库页复位到初始（录入试卷）状态，
     避免「取消 / 保存」后返回整卷入库时仍停留在试题编辑视图、残留上一份卷子的内容。 */
  function resetEditAnswers() {
    S.editAnswersId = null;
    S.editAnswersRunId = null;
    var list = $("cpEditAnswersList");
    if (list) list.textContent = "";
    var paper = $("cpEditAnswersPaper");
    if (paper) paper.textContent = "";
    switchTab("intake");   /* 隐藏编辑面板、复位到默认页签，与「录入试卷 / 入库质检」行为一致 */
  }

  function saveAnswers() {
    if (!S.editAnswersId) return;
    var inputs = $$("#cpEditAnswersList .cp-edit-answer-input");
    var edits = inputs.map(function (i) {
      return { blank_no: Number(i.dataset.no), raw: i.value };
    });
    var btn = $("cpBtnSaveAnswers");
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("/api/code-papers/papers/" + S.editAnswersId + "/blanks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: edits })
    }).then(function (d) {
      btn.disabled = false;
      btn.textContent = "保存答案";
      var savedId = S.editAnswersId;
      // 退出编辑：清空残留内容并把整卷入库页复位到初始（录入试卷）状态，避免返回时仍停在编辑视图
      resetEditAnswers();
      // 用户已在直接改答案，无需再进入质检流程：保存成功后自动返回「我的题库」并定位这份试卷
      if (window.appUI && window.appUI.switchView) {
        window.appUI.switchView("library");
        revealPaperInLibrary(savedId);
      } else { switchTab("audit"); }
      setTip("已保存 " + (d.changed || 0) + " 个空的答案，已返回「我的题库」。", "ok");
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "保存答案";
      setTip("保存失败：" + e.message, "error");
    });
  }

  /* ------------------------------------------------------------------
     考场
     ------------------------------------------------------------------ */
  function stopTimer() { if (S.timer) clearInterval(S.timer); S.timer = null; }
  function tick() {
    var page = root.closest(".page");
    if (page && page.hidden) { stopTimer(); return; }
    $("cpExamClock").textContent = fmtDuration(Date.now() - S.examStartedAt);
  }
  function startTimer() { stopTimer(); S.timer = setInterval(tick, 1000); tick(); }

  /* 填空题输入框随内容自适应宽度：避免固定宽度截断长答案 */
  var _blankRuler = null;
  function getBlankRuler() {
    if (!_blankRuler) {
      _blankRuler = document.createElement("span");
      _blankRuler.setAttribute("aria-hidden", "true");
      _blankRuler.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;pointer-events:none;";
      (document.body || document.documentElement).appendChild(_blankRuler);
    }
    return _blankRuler;
  }
  function autoSizeBlank(input) {
    if (!input || input.type !== "text") return;
    var cs = getComputedStyle(input);
    var ruler = getBlankRuler();
    ruler.style.fontFamily = cs.fontFamily;
    ruler.style.fontSize = cs.fontSize;
    ruler.style.fontWeight = cs.fontWeight;
    ruler.style.letterSpacing = cs.letterSpacing;
    var text = (input.value && input.value.length) ? input.value : (input.placeholder || "填入答案");
    ruler.textContent = text;
    var w = ruler.getBoundingClientRect().width;
    var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var line = input.closest(".cp-code-line");
    var maxW = (line ? line.clientWidth : 560) - 76;
    if (!isFinite(maxW) || maxW < 120) maxW = 120;
    var next = Math.round(w + pad + 4);
    if (next < 72) next = 72;
    if (next > maxW) next = maxW;
    input.style.width = next + "px";
  }

  function renderExamCode(paper, prefill) {
    var box = $("cpExamCode"), nav = $("cpBlankNav");
    box.textContent = "";
    nav.textContent = "";
    prefill = prefill || {};
    var re = /\{\{(\d+)\}\}/g;
    (paper.template || "").split("\n").forEach(function (line, idx) {
      var row = el("div", "cp-code-line");
      row.appendChild(el("span", "cp-ln", pad2(idx + 1)));
      // 纯注释行（以 # 开头）：原样展示并加上注释样式，不参与空位拆分
      if (line.trim().charAt(0) === "#") {
        row.appendChild(el("span", "cp-code-comment", line));
        box.appendChild(row);
        return;
      }
      var last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        if (m.index > last) {
          row.appendChild(el("span", "cp-code-text", line.slice(last, m.index)));
        }
        var no = Number(m[1]);
        var wrap = el("span", "cp-blank");
        wrap.appendChild(el("i", "", pad2(no)));
        var input = document.createElement("input");
        input.type = "text";
        input.className = "cp-blank-input";
        input.dataset.no = String(no);
        input.autocomplete = "off";
        input.spellcheck = false;
        input.placeholder = "填入答案";
        input.setAttribute("aria-label", "第 " + no + " 空");
        /* 整卷重考：上次答对的空直接预填并锁定，只把答错的部分留给用户重做 */
        var preset = prefill[String(no)];
        if (preset != null && preset !== "") {
          input.value = preset;
          input.readOnly = true;
          input.classList.add("is-prefilled");
          wrap.classList.add("is-prefilled");
          input.title = "上次已答对，已自动填充并锁定";
        }
        wrap.appendChild(input);
        autoSizeBlank(input);
        row.appendChild(wrap);
        var chip = el("button", "cp-blank-chip", pad2(no));
        chip.type = "button";
        chip.dataset.cpBlankNo = String(no);
        chip.setAttribute("aria-label", "跳到第 " + no + " 空");
        nav.appendChild(chip);
        last = m.index + m[0].length;
      }
      if (last < line.length) {
        row.appendChild(el("span", "cp-code-text", line.slice(last)));
      }
      box.appendChild(row);
    });
    $("cpExamTotal").textContent = paper.blank_count || 0;
    updateProgress();
  }

  function getUnfilledBlanks() {
    var out = [];
    $$(".cp-blank-input").forEach(function (i) {
      if (!i.value.trim()) out.push(Number(i.dataset.no));
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* 空答案提示条：考试模式红色必须填满，刷题模式琥珀色允许空交留档 */
  function updateEmptyAlert() {
    var alert = $("cpExamEmptyAlert");
    if (!alert) return;
    var unfilled = getUnfilledBlanks();
    if (!unfilled.length) {
      alert.hidden = true;
      alert.className = "cp-exam-empty-alert";
      return;
    }
    var noseq = unfilled.join("、");
    if (S.examMode === "practice") {
      alert.hidden = false;
      alert.className = "cp-exam-empty-alert is-practice";
      alert.innerHTML = "刷题模式 · 还有 <b>" + unfilled.length +
        "</b> 个空没填（第 " + noseq + " 空），可直接交卷留档，也可继续作答。";
    } else {
      alert.hidden = false;
      alert.className = "cp-exam-empty-alert is-exam";
      alert.innerHTML = "考试模式 · 还有 <b>" + unfilled.length +
        "</b> 个空未填（第 " + noseq + " 空），交卷前必须全部填满。";
    }
  }

  function updateProgress() {
    var inputs = $$(".cp-blank-input");
    var filled = 0;
    var byNo = {};
    inputs.forEach(function (i) {
      var ok = !!i.value.trim();
      if (ok) filled += 1;
      byNo[i.dataset.no] = ok;
      var wrap = i.parentNode;
      if (wrap && wrap.classList) {
        wrap.classList.toggle("is-filled", ok);
        if (ok) wrap.classList.remove("is-empty");
      }
    });
    $("cpExamFilled").textContent = filled;
    $("cpExamProgressBar").style.width =
      (inputs.length ? (filled / inputs.length * 100) : 0) + "%";
    $$(".cp-blank-chip").forEach(function (c) {
      c.classList.toggle("is-filled", !!byNo[c.dataset.cpBlankNo]);
    });
    updateEmptyAlert();
  }

  function setExamMode(mode) {
    S.examMode = mode === "practice" ? "practice" : "exam";
    $$(".cp-mode-btn").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.mode === S.examMode);
    });
    var hint = $("cpExamModeHint");
    var note = $("cpExamFootNote");
    if (S.examMode === "practice") {
      if (hint) hint.textContent = "刷题：允许留空，交卷后记录留档便于复习";
      if (note) note.textContent = "刷题模式：未填的空也可交卷，成绩会自动留档方便日后复习。";
    } else {
      if (hint) hint.textContent = "考试：必须填满所有空才能交卷";
      if (note) note.textContent = "整卷作答，全部填完再交卷；中途离开不会保存本次作答。";
    }
    updateEmptyAlert();
  }

  /* 待复核卷（最后一次入库质检未通过）一律不进考场：考试、刷题都禁止。
     统一收口到这里——不发答题纸、直接把用户送到该卷的质检判定页订正。 */
  function gotoAudit(paperId) {
    switchTab("audit", true);
    var sel = $("cpAuditSelect");
    if (paperId && sel) { sel.value = String(paperId); loadAudit(Number(paperId)); return; }
    if (sel && sel.value) loadAudit(Number(sel.value));
    else { $("cpResultCard").hidden = true; $("cpAuditEmpty").hidden = false; }
  }

  function refuseReviewPaper(paperId, count) {
    var msg = count
      ? "本卷还有 " + count + " 个空待复核，考试与刷题都未开放，请先质检订正。"
      : "本卷质检未通过，考试与刷题都未开放，请先质检订正。";
    S.examPaper = null;
    S.examRetry = false;
    S.examPrefill = {};
    stopTimer();
    $("cpExamSheet").hidden = true;
    $("cpExamReport").hidden = true;
    $("cpExamPicker").hidden = false;
    var note = $("cpExamRetryNote");
    if (note) note.hidden = true;
    gotoAudit(paperId);
    setTip(msg, "error");
    showToast(msg, "error");
  }

  function startExam(paperId, retry) {
    /* 卷库缓存里已知待复核：连取卷请求都不发，直接引导质检 */
    var cached = null;
    (S.papers || []).forEach(function (p) {
      if (String(p.id) === String(paperId)) cached = p;
    });
    if (cached && cached.verified === false) { refuseReviewPaper(paperId, 0); return; }
    setTip("正在启封试卷…");
    var url = "/api/code-papers/papers/" + paperId + "/exam" + (retry ? "?retry=1" : "");
    api(url).then(function (d) {
      /* 取卷接口是权威准入；缓存过期时以它为准 */
      if (d.paper && d.paper.verified === false) {
        refuseReviewPaper(paperId, d.paper.review_count || 0);
        return;
      }
      S.examPaper = d.paper;
      S.examRetry = !!retry && !!d.prefill;
      S.examPrefill = S.examRetry ? (d.prefill || {}) : {};
      switchTab("exam");
      $("cpExamPicker").hidden = true;
      $("cpExamReport").hidden = true;
      $("cpExamSheet").hidden = false;
      $("cpExamTitle").textContent = d.paper.title || ("整卷 " + paperId);
      renderExamCode(d.paper, S.examPrefill);
      setExamMode("exam"); /* 每次开考默认考试模式，由用户在考场内切换 */
      /* 整卷重考提示：已答对部分已自动填充锁定，只需重做答错的部分 */
      if (S.examRetry) {
        var total = d.paper.blank_count || 0;
        var done = S.examPrefill ? Object.keys(S.examPrefill).length : 0;
        var note = $("cpExamRetryNote");
        if (note) {
          note.hidden = false;
          note.textContent = "整卷重考 · 已为你预填上次答对的 " + done +
            " 个空（已锁定），只需重做答错 / 未作答的 " + (total - done) + " 个空。";
        }
        setTip("已自动填好上次答对的空，集中攻克答错的部分即可。", "ok");
      } else {
        var n2 = $("cpExamRetryNote");
        if (n2) n2.hidden = true;
        setTip("答案已封存，填完所有空位后交卷。", "ok");
      }
      S.examStartedAt = Date.now();
      startTimer();
      loadHistory(paperId);
      $("cpExamSheet").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) {
      if (e && e.data && e.data.review_required) {
        refuseReviewPaper(paperId, e.data.review_count || 0);
        return;
      }
      setTip("开考失败：" + e.message, "error");
    });
  }

  function submitExam() {
    if (!S.examPaper) return;
    /* 答题纸打开后卷子被重新解析成待复核的竞态：本地先挡，服务端还会再挡一次 */
    if (S.examPaper.verified === false) {
      refuseReviewPaper(S.examPaper.id, S.examPaper.review_count || 0);
      return;
    }
    var inputs = $$(".cp-blank-input");
    var responses = {};
    inputs.forEach(function (i) { responses[i.dataset.no] = i.value; });
    var unfilled = getUnfilledBlanks();
    /* 考试模式：有空未填则高亮并拦截，必须填满才能交卷 */
    if (S.examMode === "exam" && unfilled.length) {
      $$(".cp-blank-input").forEach(function (i) {
        if (!i.value.trim() && i.parentNode && i.parentNode.classList) {
          i.parentNode.classList.add("is-empty");
        }
      });
      updateEmptyAlert();
      setTip("考试模式必须填满所有空才能交卷（红框为空位）。", "error");
      return;
    }
    /* 刷题模式：允许空答，交卷前给一次确认即可 */
    if (S.examMode === "practice" && unfilled.length) {
      if (!window.confirm("刷题模式：还有 " + unfilled.length +
          " 个空没填，确定交卷并把本次记录留档吗？")) return;
    }
    S.lastElapsed = Date.now() - S.examStartedAt;
    var btn = $("cpBtnSubmit");
    btn.disabled = true;
    btn.textContent = "判分中…";
    api("/api/code-papers/papers/" + S.examPaper.id + "/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        responses: responses,
        elapsed_ms: S.lastElapsed,
        mode: S.examMode
      })
    }).then(function (d) {
      btn.disabled = false;
      btn.textContent = "交卷并判分";
      stopTimer();
      $("cpExamSheet").hidden = true;
      $("cpExamReport").hidden = false;
      renderReport(d);
      loadHistory(S.examPaper.id);
      loadPapers();
      $("cpExamReport").scrollIntoView({ behavior: "smooth", block: "start" });
      setTip((S.examMode === "practice" ? "刷题" : "考试") + "完成，成绩已留档。", "ok");
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "交卷并判分";
      if (e && e.data && e.data.review_required) {
        var pid = S.examPaper && S.examPaper.id;
        refuseReviewPaper(pid, e.data.review_count || 0);
        return;
      }
      setTip("判分失败：" + e.message, "error");
    });
  }

  /* 交卷回执：把「整卷作为一组」的进出结果讲清楚，格阵一眼看出错了哪几个空 */
  function renderWrongState(d) {
    var inBook = !!d.in_wrong_book;
    var box = $("cpWrongState");
    box.hidden = false;
    box.className = "cp-wrong-state " + (inBook ? "is-wrong" : "is-clear");
    $("cpWrongStateSeal").textContent = inBook ? "待启封" : "已启封";
    $("cpWrongStateTitle").textContent = inBook
      ? "整卷已纳入错题本"
      : "整卷已移出错题本";
    var miss = d.miss_count == null ? (d.total - d.correct) : d.miss_count;
    $("cpWrongStateText").textContent = inBook
      ? "这一组 " + d.total + " 个空里有 " + miss + " 个没答对。整卷作为一个整体复习，" +
        "不会拆成单题；所有空全对才会整组移出。"
      : "所有 " + d.total + " 个空全部答对，这一组已攻克，整卷从错题本移出。";
    var grid = $("cpWrongStateGrid");
    grid.textContent = "";
    (d.results || []).forEach(function (r) {
      var label = r.is_correct ? "正确" : (r.answered ? "答错" : "未作答");
      var cell = el("i", "cp-grid-cell " + (r.is_correct ? "ok" : "bad"), "B" + r.no);
      cell.title = "第 " + r.no + " 空 · " + label;
      cell.setAttribute("aria-label", "第 " + r.no + " 空 " + label);
      grid.appendChild(cell);
    });
  }

  /* 通用表格分页：把 tbody 的直接 <tr> 按「题干组」切页，底部分页标签常驻 */
  var _pagerPage = {};
  function applyPager(tbodyId, pagerId, pageSize) {
    var tbody = $(tbodyId), pager = $(pagerId);
    if (!tbody || !pager) return;
    var rows = Array.prototype.slice.call(tbody.children);
    if (!rows.length) { pager.hidden = true; pager.innerHTML = ""; return; }
    var groups = [], cur = null;
    rows.forEach(function (tr) {
      if (tr.classList && tr.classList.contains("cp-stem-row")) { cur = [tr]; groups.push(cur); }
      else if (cur) { cur.push(tr); }
      else { cur = [tr]; groups.push(cur); }
    });
    var totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
    var key = tbodyId;
    if (_pagerPage[key] == null || _pagerPage[key] < 1 || _pagerPage[key] > totalPages) _pagerPage[key] = 1;
    var page = _pagerPage[key];
    rows.forEach(function (tr) { tr.style.display = "none"; });
    var start = (page - 1) * pageSize;
    for (var i = start; i < Math.min(start + pageSize, groups.length); i++) {
      groups[i].forEach(function (tr) { tr.style.display = ""; });
    }
    if (totalPages <= 1) { pager.hidden = true; pager.innerHTML = ""; return; }
    pager.hidden = false; pager.innerHTML = "";
    pager.appendChild(el("span", "cp-page-info", "共 " + groups.length + " 组 · 第 " + page + "/" + totalPages + " 页"));
    var nav = el("span", "cp-page-nav");
    pager.appendChild(nav);
    function go(p) { _pagerPage[key] = p; applyPager(tbodyId, pagerId, pageSize); }
    nav.appendChild(pageBtn("‹", page > 1, function () { go(page - 1); }));
    var shown = {};
    [1, totalPages, page, page - 1, page + 1].forEach(function (p) { if (p >= 1 && p <= totalPages) shown[p] = true; });
    var last = 0;
    for (var p = 1; p <= totalPages; p++) {
      if (shown[p]) {
        if (p - last > 1) nav.appendChild(el("span", "cp-page-ellipsis", "…"));
        (function (pp) { nav.appendChild(pageBtn(String(pp), true, function () { go(pp); }, pp === page)); })(p);
        last = p;
      }
    }
    nav.appendChild(pageBtn("›", page < totalPages, function () { go(page + 1); }));
  }
  function pageBtn(label, enabled, handler, active) {
    var b = el("button", "cp-page-btn" + (active ? " is-active" : ""), label);
    b.type = "button"; b.disabled = !enabled;
    if (enabled) b.addEventListener("click", handler);
    return b;
  }

  function renderReport(d) {
    $("cpScoreValue").textContent = d.score;
    $("cpScoreLabel").textContent = d.correct + " / " + d.total + " 空正确 · " +
      (d.passed ? "全卷全对，整组攻克" : "整卷待攻克，共 " + (d.total - d.correct) + " 空有错") +
      " · 用时 " + fmtDuration(S.lastElapsed);

    var seal = $("cpExamSeal");
    seal.className = "cp-seal " + (d.passed ? "ok" : "bad");
    var txt = $("cpExamSealText");
    txt.textContent = "";
    txt.appendChild(document.createTextNode(d.passed ? "满分" : "已启封"));
    txt.appendChild(el("small", "", d.passed ? "PERFECT SCORE" : "GRADED"));

    $("cpScoreStats").textContent = "";
    [
      [d.total, "空位总数"],
      [d.answered, "已作答"],
      [d.correct, "答对"],
      [d.score + " 分", "本次得分"]
    ].forEach(function (pair) { $("cpScoreStats").appendChild(statBox(pair[0], pair[1])); });

    var rows = $("cpScoreRows");
    rows.textContent = "";
    (d.results || []).forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", "cp-num", "B" + r.no));
      var ctx = el("td");
      ctx.appendChild(el("code", "",
        (r.context_left || "").slice(-20) + " ▢ " + (r.context_right || "").slice(0, 16)));
      tr.appendChild(ctx);
      var mine = el("td");
      mine.appendChild(el("code", "", r.answered ? r.user : "—"));
      tr.appendChild(mine);
      var key = el("td");
      key.appendChild(el("span", "cp-ans", (r.correct_answer || "").trim() || "—"));
      tr.appendChild(key);
      tr.appendChild(el("td", r.is_correct ? "cp-pass" : "cp-fail",
        r.is_correct ? "正确" : (r.answered ? "答错" : "未作答")));
      rows.appendChild(tr);
    });
    _pagerPage.cpScoreRows = 1;
    applyPager("cpScoreRows", "cpScorePager", 10);
    renderWrongState(d);
  }

  function loadHistory(paperId) {
    var box = $("cpHistoryList");
    box.textContent = "";
    api("/api/code-papers/papers/" + paperId + "/attempts").then(function (d) {
      box.textContent = "";
      if (!d.items.length) {
        box.appendChild(el("p", "cp-empty", "还没有考试记录，交卷后会在这里留档。"));
        return;
      }
      d.items.forEach(function (it) {
        var row = el("div", "cp-history-row");
        row.appendChild(el("b", "", it.score + " 分"));
        row.appendChild(el("span", "", fmtDate(it.created_at) + " · " + it.correct + "/" + it.total + " 空"));
        row.appendChild(el("span", it.passed ? "cp-hist-ok" : "cp-hist-bad",
          it.passed ? "全对" : "未全对"));
        row.appendChild(el("span", "", it.mode === "practice" ? "刷题" : "考试"));
        box.appendChild(row);
      });
    }).catch(function (e) {
      box.appendChild(el("p", "cp-empty", "成绩记录加载失败：" + e.message));
    });
  }

  /* ------------------------------------------------------------------
     删除 / 示例卷 / 质检明细（v1.4.1 起没有「拆单题」这一步）
     ------------------------------------------------------------------ */
  function removePaper(id, title) {
    if (!window.confirm("确定删除《" + title + "》？\n\n质检记录、历次成绩与错题本里的整卷组会一并删除。")) return;
    api("/api/code-papers/papers/" + id, { method: "DELETE" })
      .then(function () { loadPapers(); setTip("卷子已删除。", "ok"); })
      .catch(function (e) { setTip("删除失败：" + e.message, "error"); });
  }

  /* 从「我的题库」行内「删除」按钮进入：先取标题再确认删除 */
  function deletePaperDeep(id) {
    if (!id) return;
    api("/api/code-papers/papers/" + id).then(function (d) {
      removePaper(id, (d.paper && d.paper.title) || ("整卷 " + id));
    }).catch(function () { removePaper(id, "整卷 " + id); });
  }

  function seed(autoExam) {
    setTip("正在生成示例卷…");
    api("/api/code-papers/seed", { method: "POST" }).then(function (d) {
      return loadPapers().then(function () {
        setTip(d.reused ? "示例卷已在卷库中。" : "示例卷已入库。", "ok");
        if (autoExam) startExam(d.paper_id);
      });
    }).catch(function (e) { setTip("示例卷生成失败：" + e.message, "error"); });
  }

  function loadAudit(id) {
    S.auditPaperId = id;
    api("/api/code-papers/papers/" + id).then(function (d) {
      var p = d.paper || {};
      if (!p.run) {
        $("cpResultCard").hidden = true;
        $("cpAuditEmpty").hidden = false;
        return;
      }
      $("cpAuditEmpty").hidden = true;
      S.runId = p.run.id;
      showResult(fromRun(p.run));
      $("cpResultCard").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) { setTip("质检明细加载失败：" + e.message, "error"); });
  }

  /* 入库质检页内联订正：直接改最新 run 的标准答案并重算质检判定 */
  function saveAuditEdits() {
    var id = S.auditPaperId;
    if (!id) { toast("请先在上方选择一份卷子。", "error"); return; }
    var inputs = $$("#cpRows .cp-ans-input");
    if (!inputs.length) { toast("本卷没有可保存的空位答案。", "error"); return; }
    var dirty = inputs.filter(function (i) {
      return i.parentNode && i.parentNode.classList &&
        i.parentNode.classList.contains("is-dirty");
    }).length;
    if (!dirty) {
      toast("还没有改动任何答案：请先在「标准答案」列修改，再点「保存修改」。", "info");
      return;
    }
    var edits = inputs.map(function (i) {
      return { no: Number(i.dataset.no), raw: i.value };
    });
    var btn = $("cpBtnSaveAudit");
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("/api/code-papers/papers/" + id + "/blanks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: edits })
    }).then(function (d) {
      btn.disabled = false;
      btn.textContent = "保存修改";
      toast("保存成功，已写入 " + (d.changed || 0) + " 个空的答案，正在重新判定质检结果…", "success");
      loadAudit(id);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "保存修改";
      toast("保存失败：" + (e && e.message ? e.message : e), "error");
    });
  }

  /* ------------------------------------------------------------------
     页签与事件绑定
     ------------------------------------------------------------------ */
  var TAB_NOTE = {
    shelf: "整卷为一组，不拆单题；有空错就进错题本，全对才移出。",
    intake: "录入后系统先做一次入库质检；质检通过即可封卷开考。",
    exam: "答案已封存，考场上只显示空位；交卷后才揭晓标准答案。",
    audit: "这里检查的是答案参考有没有对齐，不是考试分数。"
  };

  function switchTab(name, silentAudit) {
    S.tab = name;
    setTip(TAB_NOTE[name] || "");
    if (name === "intake") loadLlmStatus();
    $$(".cp-tab").forEach(function (b) {
      var on = b.dataset.cpTab === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $$(".cp-panel").forEach(function (p) { p.hidden = p.dataset.cpPanel !== name; });
    if (name === "exam" && $("cpExamSheet").hidden && $("cpExamReport").hidden) {
      $("cpExamPicker").hidden = false;
    }
    /* silentAudit：调用方随后会自己指定卷子并 loadAudit，避免重复请求与竞态 */
    if (name === "audit" && !silentAudit) {
      var sel = $("cpAuditSelect");
      if (sel.value) loadAudit(Number(sel.value));
      else { $("cpResultCard").hidden = true; $("cpAuditEmpty").hidden = false; }
    }
  }

  $$(".cp-tab").forEach(function (b) {
    b.addEventListener("click", function () {
      switchTab(b.dataset.cpTab);
      if (b.dataset.cpTab === "shelf") loadPapers();
    });
  });

  root.addEventListener("click", function (ev) {
    var go = ev.target.closest("[data-cp-go]");
    if (!go) return;
    if (go.dataset.cpGo === "intake") { switchTab("intake"); $("cpTitle").focus(); }
    if (go.dataset.cpGo === "seed") seed(true);
  });

  var shelfList = $("cpShelfList");
  if (shelfList) shelfList.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-cp-act]");
    if (!btn) return;
    var card = btn.closest(".cp-volume");
    if (!card) return;
    var id = Number(card.dataset.id);
    var title = (card.querySelector("h4") || {}).textContent || ("整卷 " + id);
    switch (btn.dataset.cpAct) {
      case "exam": startExam(id); break;
      case "edit": openEditPaper(id); break;
      case "rename": renamePaper(id, card); break;
      case "chgtype": changeTypePaper(id, card); break;
      case "edit-answers": openEditAnswers(id); break;
      case "audit":
        switchTab("audit", true);
        $("cpAuditSelect").value = String(id);
        loadAudit(id);
        break;
      case "delete": removePaper(id, title); break;
      default: break;
    }
  });

  $("cpExamPickerList").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-cp-exam-id]");
    if (b) { startExam(Number(b.dataset.cpExamId)); return; }
    var a = ev.target.closest("[data-cp-audit-id]");
    if (a) gotoAudit(Number(a.dataset.cpAuditId));
  });

  $("cpAuditSelect").addEventListener("change", function () {
    if (this.value) loadAudit(Number(this.value));
    else { $("cpResultCard").hidden = true; $("cpAuditEmpty").hidden = false; }
  });

  /* 入库质检：内联订正标准答案后保存 */
  $("cpBtnSaveAudit").addEventListener("click", saveAuditEdits);

  /* 逐空明细：答案超长时悬停弹出完整内容。
     浮层挂 body + position:fixed，避免被 .cp-table-scroll 的 overflow 裁切；
     编辑中（focus）不弹出以免遮挡输入；输入时给该格打「已修改」标记。 */
  var ansTip = null;
  function getAnsTip() {
    if (!ansTip) {
      ansTip = el("div", "cp-ans-tip");
      ansTip.hidden = true;
      document.body.appendChild(ansTip);
    }
    return ansTip;
  }
  function hideAnsTip() {
    if (ansTip) ansTip.hidden = true;
  }
  function showAnsTip(input) {
    var v = String(input.value || "");
    var overlong = v.indexOf("\n") >= 0 || v.length > 28 ||
      input.scrollWidth > input.clientWidth + 2;
    if (!v || !overlong) { hideAnsTip(); return; }
    var tip = getAnsTip();
    tip.textContent = v;
    tip.hidden = false;
    var r = input.getBoundingClientRect();
    var w = Math.min(520, Math.max(240, window.innerWidth - 24));
    tip.style.maxWidth = w + "px";
    tip.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + "px";
    var h = tip.offsetHeight || 60;
    var below = r.bottom + 8;
    tip.style.top = (below + h > window.innerHeight - 12
      ? Math.max(12, r.top - h - 8) : below) + "px";
  }
  function isAnsInput(node) {
    return !!(node && node.classList && node.classList.contains("cp-ans-input"));
  }
  $("cpRows").addEventListener("mouseover", function (ev) {
    if (!isAnsInput(ev.target) || document.activeElement === ev.target) return;
    showAnsTip(ev.target);
  });
  $("cpRows").addEventListener("mouseout", function (ev) {
    if (isAnsInput(ev.target)) hideAnsTip();
  });
  $("cpRows").addEventListener("focusin", function (ev) {
    if (isAnsInput(ev.target)) hideAnsTip();
  });
  $("cpRows").addEventListener("input", function (ev) {
    var t = ev.target;
    if (!isAnsInput(t)) return;
    var cell = t.parentNode;
    if (cell && cell.classList) cell.classList.add("is-dirty");
  });
  window.addEventListener("scroll", hideAnsTip, true);
  window.addEventListener("resize", hideAnsTip);

  /* 参考答案原文：整卷级入口，一次展示本卷关联的全部参考答案（跨页拼接） */
  $("cpBtnAuditAnswerBlock").addEventListener("click", function () {
    openAnswerBlock(S.auditPaperId, S.runId, "参考答案原文", "cpAuditSelect");
  });
  /* 与「逐空明细」同行的参考答案原文入口（原顶部按钮保留，二者同源） */
  $("cpBtnAuditAnswerBlockInline").addEventListener("click", function () {
    openAnswerBlock(S.auditPaperId, S.runId, "参考答案原文", "cpAuditSelect");
  });
  $("cpBtnEditAnswerBlock").addEventListener("click", function () {
    openAnswerBlock(S.editAnswersId, S.editAnswersRunId, "参考答案原文");
  });

  // 逐空明细表：点击「定向重解析」打开单空重调对话框；点击「标准答案」预览打开编辑弹窗
  $("cpRows").addEventListener("click", function (ev) {
    var reparseBtn = ev.target.closest("[data-reparse-no]");
    if (reparseBtn) {
      openReparseDialog(Number(reparseBtn.getAttribute("data-reparse-no")));
      return;
    }
    var preview = ev.target.closest(".cp-ans-preview");
    if (preview) openAnsEditModal(Number(preview.dataset.no));
  });

  /* 「标准答案」列：点击展开完整内容的可编辑弹窗，保存写回该空答案 */
  var ansEditModal = $("cpAnsEditModal");
  var ansEditText = $("cpAnsEditText");
  var ansEditNo = $("cpAnsEditNo");
  var ansCharCount = $("cpAnsCharCount");
  S.ansEdit = null;   // { input, preview, text }

  function autoSizeAnsText() {
    ansEditText.style.height = "auto";
    ansEditText.style.height = Math.min(ansEditText.scrollHeight, Math.round(window.innerHeight * 0.52)) + "px";
  }
  function syncAnsCharCount() {
    var n = (ansEditText.value || "").length;
    ansCharCount.textContent = n + " 字";
  }
  function openAnsEditModal(no) {
    var input = $$('#cpRows .cp-ans-input[data-no="' + no + '"]')[0];
    var preview = $$('#cpRows .cp-ans-preview[data-no="' + no + '"]')[0];
    if (!input) return;
    S.ansEdit = { input: input, preview: preview, no: no };
    ansEditNo.textContent = "B" + no;
    ansEditText.value = input.value;
    autoSizeAnsText();
    syncAnsCharCount();
    ansEditModal.hidden = false;
    ansEditText.focus();
    try { ansEditText.setSelectionRange(ansEditText.value.length, ansEditText.value.length); } catch (e) {}
  }
  function closeAnsEditModal() {
    ansEditModal.hidden = true;
    S.ansEdit = null;
  }
  function commitAnsEdit() {
    if (!S.ansEdit) return;
    var val = ansEditText.value;
    S.ansEdit.input.value = val;
    if (S.ansEdit.preview) {
      var t = S.ansEdit.preview.querySelector(".cp-ans-text");
      if (t) {
        if (val) { S.ansEdit.preview.classList.remove("is-empty"); t.textContent = val; }
        else { S.ansEdit.preview.classList.add("is-empty"); t.textContent = "（空，待填写）"; }
      }
      S.ansEdit.preview.parentNode.classList.add("is-dirty");
    }
    closeAnsEditModal();
  }
  ansEditText.addEventListener("input", function () { autoSizeAnsText(); syncAnsCharCount(); });
  $("cpAnsEditSave").addEventListener("click", commitAnsEdit);
  ansEditModal.querySelectorAll("[data-cp-ans-close]").forEach(function (node) {
    node.addEventListener("click", closeAnsEditModal);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && ansEditModal && !ansEditModal.hidden) {
      ev.preventDefault();
      closeAnsEditModal();
    }
  });

  /* 逐空改答案：答案过长无法在行内完整展示 / 填写时，弹出完整编辑对话框
     （参考入库质检「标准答案」列的标注答案编辑：自动弹出、可完整录入与查看） */
  var editAnsModal = $("cpEditAnsModal");
  var editAnsText = $("cpEditAnsText");
  var editAnsNo = $("cpEditAnsNo");
  var editAnsCharCount = $("cpEditAnsCharCount");
  S.editAns = null;   // { ta, no }
  function autoSizeEditAns() {
    editAnsText.style.height = "auto";
    editAnsText.style.height = Math.min(editAnsText.scrollHeight, Math.round(window.innerHeight * 0.52)) + "px";
  }
  function syncEditAnsCount() {
    editAnsCharCount.textContent = (editAnsText.value || "").length + " 字";
  }
  function openEditAnsModal(no) {
    var ta = $$('#cpEditAnswersList .cp-edit-answer-input[data-no="' + no + '"]')[0];
    if (!ta) return;
    S.editAns = { ta: ta, no: no };
    editAnsNo.textContent = "B" + no;
    editAnsText.value = ta.value;
    autoSizeEditAns();
    syncEditAnsCount();
    editAnsModal.hidden = false;
    editAnsText.focus();
    try { editAnsText.setSelectionRange(editAnsText.value.length, editAnsText.value.length); } catch (e) {}
  }
  function closeEditAnsModal() {
    editAnsModal.hidden = true;
    S.editAns = null;
  }
  function commitEditAns() {
    if (!S.editAns) return;
    S.editAns.ta.value = editAnsText.value;
    resizeAnswer(S.editAns.ta);
    closeEditAnsModal();
  }
  editAnsText.addEventListener("input", function () { autoSizeEditAns(); syncEditAnsCount(); });
  $("cpEditAnsSave").addEventListener("click", commitEditAns);
  editAnsModal.querySelectorAll("[data-cp-editans-close]").forEach(function (node) {
    node.addEventListener("click", closeEditAnsModal);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && editAnsModal && !editAnsModal.hidden) {
      ev.preventDefault();
      closeEditAnsModal();
    }
  });
  /* 点击「展开完整编辑」按钮 → 弹窗；聚焦到过长答案 → 自动弹窗 */
  var editAnsList = $("cpEditAnswersList");
  editAnsList.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-editans-open]");
    if (btn) openEditAnsModal(Number(btn.getAttribute("data-editans-open")));
  });
  editAnsList.addEventListener("focusin", function (ev) {
    var ta = ev.target.closest && ev.target.closest(".cp-edit-answer-input");
    if (!ta) return;
    resizeAnswer(ta);  // 聚焦时复测一次，确保面板可见后判定准确
    if (ta.dataset.overflow === "1") openEditAnsModal(Number(ta.dataset.no));
  });

  /* 轻量重命名：行内编辑试卷名称，只改展示标题，不重新封卷 */
  function renamePaper(id, card) {
    var h4 = card.querySelector(".cp-volume-top h4") || card.querySelector("h4");
    if (!h4 || card.querySelector(".cp-rename-row")) return;
    var oldTitle = h4.textContent;
    var input = el("input", "cp-rename-input");
    input.type = "text";
    input.value = oldTitle;
    input.maxLength = 200;
    var saveBtn = el("button", "btn btn-primary btn-sm cp-btn", "保存");
    var cancelBtn = el("button", "btn btn-ghost btn-sm cp-btn", "取消");
    var row = el("div", "cp-rename-row");
    row.appendChild(input);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    h4.replaceWith(row);
    input.focus();
    input.select();

    function revert() { if (row.parentNode) row.replaceWith(h4); }
    function commit() {
      var v = input.value.trim();
      if (!v) { revert(); return; }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      api("/api/code-papers/papers/" + id + "/title", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: v }),
      }).then(function () {
        h4.textContent = v;
        revert();
        setTip("试卷名称已更新为：" + v, "ok");
        loadPapers();
      }).catch(function (e) {
        setTip("重命名失败：" + e.message, "error");
        revert();
      });
    }
    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", revert);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") revert();
    });
  }

  /* 轻量改试卷类型：行内下拉选择，只改 language（试卷类型），不重新封卷。
     仿照 renamePaper 的行内编辑模式：把类型文案所在的 <p class="cp-volume-meta"> 临时换成
     一个 select + 保存/取消，提交走轻量 PUT /papers/<id>/language。 */
  var PAPER_TYPE_OPTIONS = ["通用", "代码", "数学", "英语", "文史", "其它"];
  function changeTypePaper(id, card) {
    var meta = card.querySelector(".cp-volume-meta");
    if (!meta || card.querySelector(".cp-chgtype-row")) return;
    var p = null;
    for (var i = 0; i < S.papers.length; i++) { if (S.papers[i].id === id) { p = S.papers[i]; break; } }
    var cur = (p && p.language) || "通用";
    var sel = el("select", "cp-chgtype-select");
    PAPER_TYPE_OPTIONS.forEach(function (t) {
      var o = el("option", "", t);
      o.value = t;
      if (t === cur) o.selected = true;
      sel.appendChild(o);
    });
    var saveBtn = el("button", "btn btn-primary btn-sm cp-btn", "保存");
    var cancelBtn = el("button", "btn btn-ghost btn-sm cp-btn", "取消");
    var row = el("div", "cp-chgtype-row");
    row.appendChild(sel);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    meta.replaceWith(row);
    sel.focus();

    function revert() { if (row.parentNode) row.replaceWith(meta); }
    function commit() {
      var v = sel.value;
      if (v === cur) { revert(); return; }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      api("/api/code-papers/papers/" + id + "/language", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: v }),
      }).then(function () {
        if (p) p.language = v;
        revert();
        setTip("试卷类型已更新为：" + v, "ok");
        loadPapers();
      }).catch(function (e) {
        setTip("改类型失败：" + e.message, "error");
        revert();
      });
    }
    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", revert);
    sel.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") revert();
    });
  }

  /* 解析回执内联改名：解析完成后直接在回执里订正试卷名称，走轻量重命名接口，不重新封卷。
     与卷库卡片里的 renamePaper 共用后端 PUT /papers/<id>/title。 */
  function renameIntakeTitle() {
    var box = $("cpIntakeReport");
    var titleEl = $("cpIntakeTitle");
    var btn = $("cpBtnIntakeRename");
    if (!box || !titleEl) return;
    if (box.querySelector(".cp-rename-row")) return; /* 已经在编辑中 */
    var id = S.intakePaperId;
    if (!id) { setTip("这份结果尚未入库，无法改名；请先完成封卷。", "error"); return; }
    var oldTitle = titleEl.textContent === "未命名卷子" ? "" : titleEl.textContent;
    var input = el("input", "cp-rename-input");
    input.type = "text";
    input.value = oldTitle;
    input.maxLength = 200;
    var saveBtn = el("button", "btn btn-primary btn-sm cp-btn", "保存");
    var cancelBtn = el("button", "btn btn-ghost btn-sm cp-btn", "取消");
    var row = el("div", "cp-rename-row");
    row.appendChild(input);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    titleEl.replaceWith(row);
    if (btn) btn.hidden = true;
    input.focus();
    input.select();

    function revert() {
      if (row.parentNode) row.replaceWith(titleEl);
      if (btn) btn.hidden = false;
      titleEl.textContent = oldTitle || "未命名卷子";
    }
    function commit() {
      var v = input.value.trim();
      if (!v) { revert(); return; }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      api("/api/code-papers/papers/" + id + "/title", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: v }),
      }).then(function () {
        oldTitle = v;
        titleEl.textContent = v;
        revert();
        var note = $("cpIntakeNameNote");
        if (note) { note.hidden = true; note.textContent = ""; }
        loadPapers();
        setTip("试卷名称已更新为：" + v, "ok");
      }).catch(function (e) {
        setTip("改名失败：" + e.message, "error");
        revert();
      });
    }
    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", revert);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") revert();
    });
  }

  function openReparseDialog(no) {
    var sel = $("cpAuditSelect");
    /* loadAudit 才是权威来源：质检下拉在部分入口下可能没同步选中值 */
    var paperId = S.auditPaperId || (sel && sel.value);
    if (!paperId) { showToast("请先在上方选择一份卷子，再对某一空做定向重解析。", "error"); return; }

    var cur = $$('#cpRows .cp-ans-input[data-no="' + no + '"]')[0];
    var curAnswer = cur ? cur.value : "";
    var body =
      '<div class="cp-reparse-form">' +
      '<label class="cp-field"><span>指定对象</span>' +
      '<div class="cp-reparse-target">' +
      '<select id="rpType" class="rp-type"><option value="no">按空号 B</option><option value="line">按原卷行号</option></select>' +
      '<input id="rpValue" type="number" min="1" value="' + (no || 1) + '" class="rp-val" aria-label="空号或原卷行号"></div></label>' +
      '<div class="cp-reparse-current"><span>当前标准答案 · B' + (no || 1) + '</span><code id="rpCurrent"></code></div>' +
      '<label class="cp-field"><span>补充提示词（可选）</span>' +
      '<textarea id="rpPrompt" rows="4" placeholder="例如：这个空应填变量名 data，不是类型 DataFrame；或参考答案里写的是 (0,1440) 而不是 (1,1440)"></textarea></label>' +
      '<p class="cp-reparse-hint">让「整卷解析大模型」对照本卷参考答案原件，只复核这一个空：判断答案是否被截断、夹带无关代码或串行抽错，明显有误才回写。其它空不动；改完立即重新判定质检。需已启用「设置 → 大模型 → ② 整卷解析大模型」。</p>' +
      '<p class="cp-reparse-error" data-rp-error hidden></p>' +
      '</div>';
    var footer =
      '<button class="btn btn-ghost cp-btn" data-rp-cancel type="button">取消</button>' +
      '<button class="btn btn-primary cp-btn" data-rp-go type="button">重调并回写</button>';
    var modal = openModal({ title: "定向重解析", subtitle: "单空二次核对", body: body, footer: footer, small: true });
    if (!modal) return;
    modal.querySelector("#rpCurrent").textContent = curAnswer || "（该空暂无答案）";

    var go = modal.querySelector("[data-rp-go]");
    var errBox = modal.querySelector("[data-rp-error]");
    var typeSel = modal.querySelector("#rpType");
    var valInput = modal.querySelector("#rpValue");
    var promptBox = modal.querySelector("#rpPrompt");

    modal.querySelector("[data-rp-cancel]").addEventListener("click", function () { closeModal(false); });
    typeSel.addEventListener("change", function () {
      if (typeSel.value === "line") { valInput.value = ""; valInput.placeholder = "原卷行号"; }
      else { valInput.value = no || 1; valInput.placeholder = "空号"; }
    });

    function fail(msg) {
      go.disabled = false; go.textContent = "重调并回写";
      errBox.textContent = msg; errBox.hidden = false;
    }
    function done(msg, kind) {
      closeModal(false);
      showToast(msg, kind || "ok");
      loadAudit(Number(paperId));
    }

    go.addEventListener("click", function () {
      if (go.disabled) return;
      var val = valInput.value;
      if (!val) { fail("请填写空号或原卷行号。"); return; }
      errBox.hidden = true;
      go.disabled = true; go.textContent = "重调中…";
      var payload = {
        target: { type: typeSel.value, value: parseInt(val, 10) },
        prompt: (promptBox.value || "").trim()
      };
      api("/api/code-papers/papers/" + paperId + "/reparse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (d) {
          var note = (d.notes && d.notes.join("；")) || "";
          if (!d.applied) {
            fail("未生效：" + (note || "模型未参与") + "。可检查「设置 → 大模型 → ② 整卷解析大模型」，或直接在「标准答案」列手动订正。");
            return;
          }
          if (d.changed === false) {
            done("B" + d.target_no + " 复核完成：原答案保持不变", "ok");
            return;
          }
          /* 提示条超过 80 字会另开详情弹窗，这里只报结论；新答案刷新后在表格里可见 */
          done("B" + d.target_no + " 已按模型建议回写并重新判定质检", "ok");
        })
        .catch(function (e) {
          fail("重调失败：" + (e && e.message ? e.message : e) + "。可直接关闭本窗口，在「标准答案」列手动订正。");
        });
    });
  }

  $("cpExamCode").addEventListener("input", function (ev) {
    if (ev.target.classList && ev.target.classList.contains("cp-blank-input")) {
      if (ev.target.parentNode && ev.target.parentNode.classList) ev.target.parentNode.classList.remove("is-empty");
      updateProgress(); autoSizeBlank(ev.target);
    }
  });

  $$(".cp-mode-btn").forEach(function (b) {
    b.addEventListener("click", function () { setExamMode(b.dataset.mode); });
  });
  $("cpExamCode").addEventListener("focusin", function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains("cp-blank-input")) return;
    $$(".cp-blank-chip").forEach(function (c) {
      c.classList.toggle("is-current", c.dataset.cpBlankNo === ev.target.dataset.no);
    });
  });
  $("cpBlankNav").addEventListener("click", function (ev) {
    var chip = ev.target.closest("[data-cp-blank-no]");
    if (!chip) return;
    var input = root.querySelector('.cp-blank-input[data-no="' + chip.dataset.cpBlankNo + '"]');
    if (input) input.focus();
  });

  /* cpBtnGoShelf / cpBtnIntakeShelf 现在用 data-view="library" 由 app.js 统一切页 */
  function goIntake() { switchTab("intake"); $("cpTitle").focus(); }
  $("cpBtnGoIntake").addEventListener("click", goIntake);

  function doParse(btn, useLLM) {
    var paper = $("cpPaper").value.trim(), answer = $("cpAnswer").value.trim();
    if (!paper || !answer) { setTip("请先填写两侧内容。", "error"); return; }
    if (S.editingPaperId) { submitEditParse(btn); return; }
    submitParse("/api/code-papers/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paper_text: paper,
        answer_text: answer,
        title: $("cpTitle").value.trim() || ("整卷练习 " + new Date().toLocaleDateString("zh-CN")),
        language: $("cpLang").value,
        use_llm: !!useLLM,
        persist: true
      })
    }, btn, undefined, useLLM);
  }
  $("cpBtnParse").addEventListener("click", function () { doParse($("cpBtnParse"), false); });
  /* 用模型辅助解析（可选）：仅在「启用大模型」开关打开时可见；走 LLM 二次核对 */
  $("cpBtnLlmAssist").addEventListener("click", function () { doParse($("cpBtnLlmAssist"), true); });
  /* 启用大模型开关控制「用模型辅助解析（可选）」按钮的显隐：关则不显示 */
  function syncLlmAssistBtn() {
    var b = $("cpBtnLlmAssist");
    if (b) b.hidden = !($("cpUseLlm") && $("cpUseLlm").checked);
  }
  if ($("cpUseLlm")) {
    $("cpUseLlm").addEventListener("change", syncLlmAssistBtn);
    syncLlmAssistBtn();
  }
  /* 用户手动改过试卷类型下拉框，视为显式选择，覆盖上传自动识别的标记 */
  if ($("cpLang")) $("cpLang").addEventListener("change", function () { S.langAuto = false; });

  $("cpBtnUpload").addEventListener("click", function () {
    var p = $("cpFpaper").files[0], a = $("cpFanswer").files[0];
    if (!p || !a) { setTip("请同时选择试卷文件与答案文件。", "error"); return; }
    /* 每次上传都按「实际选中的两份文件」重新查重，并以查重结果决定目标卷——
       不再沿用之前编辑遗留的 S.editingPaperId。否则若上一次编辑的卷子已变动 / 删除，
       会盲目把旧 id 当 paper_id 传给 /persist，导致「要更新的卷子不存在」，
       或在 id 仍指向别的卷时静默覆盖错卷。 */
    S.editingPaperId = null;
    S.intakePaperId = null;
    syncUploadBtn();
    // 先按上传文件名查重，若已存在则提示「是否重新解析并更新」
    setTip("正在核对上传文件是否重复…", "info");
    api("/api/code-papers/papers/by-file?paper_file=" + encodeURIComponent(p.name) +
        "&answer_file=" + encodeURIComponent(a.name))
      .then(function (d) {
        if (d && d.found && d.paper) {
          var title = d.paper.title || ("整卷 " + d.paper.id);
          uiConfirm(
            "该文件已上传过",
            "《" + title + "》已存在（试卷文件：" + p.name + "）。是否用本次上传的内容重新解析并更新这份卷子？选择「重新解析并更新」会覆盖原卷、不会新增一份；选择「取消」则不做任何改动。",
            "重新解析并更新", false
          ).then(function (yes) {
            if (!yes) { setTip("已取消：保留原卷，未做任何改动。", "ok"); return; }
            S.editingPaperId = d.paper.id;
            S.intakePaperId = d.paper.id;
            syncUploadBtn();
            startUploadPersist(p, a);
          });
        } else {
          startUploadPersist(p, a);
        }
      })
      .catch(function () { startUploadPersist(p, a); });
  });

  /* 上传流程 Step 1：在答案 PDF 中依据试卷定位对应区段（dry_run，不落库）。
     editingPaperId 非空时会自动走「更新」通道（PUT 覆盖原卷），否则走「新增」通道。
     同时带 cache=1，让后端把本次完整解析结果缓存并返回 token；「确认并入库」凭 token
     直接落库，避免对大体积多区段答案 PDF 再做一遍完整重解（否则会因 fetch 超时被掐断，
     表现为「入库失败：Failed to fetch」）。 */
  /* 异步解析任务：提交到 /parse-async 后立即拿到 job_id，随后轮询 /parse-job/<id>。
     重活（PDF 拆分 / 区段对齐 / 大模型复核）在服务器后台线程跑，前端只做轻量轮询，
     因此长解析绝不会占用单条 HTTP 连接——从根本上消除「网络超时 / 连接被关闭」
     导致的入库失败（旧「更新卷子」把整段解析塞进单个 PUT 即为此病的根因）。 */
  function startParseJob(formData, onDone, onError) {
    S.parseAborted = false;
    S.parseJobId = null;
    S.parseAC = new AbortController();
    api("/api/code-papers/parse-async", { method: "POST", body: formData, signal: S.parseAC.signal })
      .then(function (d) {
        if (!d || !d.job_id) { onError(new Error("未返回任务 ID，请重试")); return; }
        S.parseJobId = d.job_id;
        pollParseJob(d.job_id, onDone, onError);
      })
      .catch(function (e) {
        if (S.parseAborted) return;
        onError(e);
      });
  }

  /* 轮询解析任务：running 时每 2s 再问一次；即便某次轮询连接被掐断（网络抖动），
     也只是重试轮询、不报错中断——后台任务照常推进，结果最终会被取到。 */
  function pollParseJob(jobId, onDone, onError) {
    if (S.parseAborted) return;
    api("/api/code-papers/parse-job/" + jobId, { method: "GET" })
      .then(function (d) {
        if (S.parseAborted) return;
        if (d.status === "running") {
          setTip(d.progress || "正在解析试卷与答案（大模型处理中，请稍候，勿关闭页面）…", "info");
          if ($("cpTip")) $("cpTip").classList.add("is-loading");
          setTimeout(function () { pollParseJob(jobId, onDone, onError); }, 2000);
          return;
        }
        if (d.status === "done") { onDone(d.result); return; }
        onError(new Error(d.error || "解析失败"));
      })
      .catch(function () {
        /* 轮询连接被掐断不影响后台任务，直接重试轮询即可，不向用户报错 */
        if (S.parseAborted) return;
        setTimeout(function () { pollParseJob(jobId, onDone, onError); }, 1500);
      });
  }

  function startUploadPersist(p, a) {
    $("cpSectionLocator").hidden = true;
    S.probeToken = null; S.probeMatched = null; S.probeResult = null;
    var probe = new FormData();
    probe.append("paper", p);
    probe.append("answer", a);
    var upTitle = pickUploadTitle(p);
    if (upTitle) probe.append("title", upTitle);
    probe.append("language", $("cpLang").value);
    probe.append("dry_run", "1");
    probe.append("cache", "1");
    if ($("cpUseLlm") && $("cpUseLlm").checked) probe.append("use_llm", "1");
    setTip("正在依据试卷在答案 PDF 中定位对应区段（大模型处理中，请稍候，勿关闭页面）…", "info");
    if ($("cpTip")) $("cpTip").classList.add("is-loading");
    showAbort(true);
    startParseJob(
      probe,
      function (res) {
        showAbort(false);
        if ($("cpTip")) $("cpTip").classList.remove("is-loading");
        /* 缓存本次解析结果，供「确认并入库」凭 token 直接落库（无需二次重解） */
        S.probeResult = res;
        /* 上传时自动识别试卷类型：探针返回 paper_type 后回填下拉框，避免默认一律「通用」 */
        if (res.paper_type) {
          var lopts = Array.prototype.slice.call($("cpLang").options);
          if (lopts.some(function (o) { return o.value === res.paper_type; })) {
            $("cpLang").value = res.paper_type;
            S.langAuto = true;
          }
        }
        S.probeToken = res.cache_token || null;
        S.probeMatched = (res.matched_section != null) ? Number(res.matched_section) : null;
        if (res.ok && res.answer_sections && res.answer_sections.length > 1) {
          showSectionLocator(res.answer_sections, res.matched_section, p, a, !!S.editingPaperId);
        } else {
          doUploadPersist(p, a, null, S.editingPaperId);
        }
      },
      function (e) {
        showAbort(false);
        if ($("cpTip")) $("cpTip").classList.remove("is-loading");
        /* 探针失败（含网络 / 超时）不要静默重试：会让大文件两次叠加必超时。
           这里直接报错，由用户决定重试。 */
        setTip(parseFailMessage(e), "error");
      }
    );
  }

  /* 上传按钮联动：选齐「试卷」+「答案」两份文件才可点，否则置灰并给出提示。
     编辑模式下变为「更新这份卷子」——用新上传的文件重新解析并覆盖原卷，不新增卷子。 */
  function syncUploadBtn() {
    var btn = $("cpBtnUpload");
    if (!btn) return;
    var p = $("cpFpaper") && $("cpFpaper").files && $("cpFpaper").files[0];
    var a = $("cpFanswer") && $("cpFanswer").files && $("cpFanswer").files[0];
    var hint = $("cpUploadHint");
    var editing = !!S.editingPaperId;
    var msg, ok;
    if (editing) {
      if (p && a) {
        msg = "已选齐两份文件，点此「更新这份卷子」重新封卷（覆盖原卷，不新增）。";
        ok = true;
      } else if (p && !a) {
        msg = "已选试卷文件，还差「答案文件」即可更新这份卷子。";
        ok = false;
      } else if (!p && a) {
        msg = "已选答案文件，还差「试卷文件」即可更新这份卷子。";
        ok = false;
      } else {
        msg = "重新选好两份文件后点「更新这份卷子」（覆盖原卷，不新增）。";
        ok = false;
      }
    } else if (p && a) {
      msg = "已选齐两份文件，可上传解析并封卷入库。";
      ok = true;
    } else if (p && !a) {
      msg = "已选试卷文件，还差「答案文件」。";
      ok = false;
    } else if (!p && a) {
      msg = "已选答案文件，还差「试卷文件」。";
      ok = false;
    } else {
      msg = "请先选择「试卷文件」与「答案文件」（两份都要）。";
      ok = false;
    }
    btn.disabled = !ok;
    btn.textContent = editing ? "更新这份卷子（重新封卷）" : "上传解析并入库";
    btn.title = editing
      ? "用新上传的两份文件重新解析并覆盖这份卷子，不会新增一份卷子。"
      : "点此把两份文件解析并封卷入库，答案随即封存进卷库。";
    if (hint) {
      hint.textContent = msg;
      hint.classList.toggle("is-ready", ok);
      hint.classList.toggle("is-warn", !ok);
    }
    /* 「清空已选文件」按钮：选齐或只选了一份时都允许清掉，方便重选 */
    var clr = $("cpBtnClearUpload");
    if (clr) clr.disabled = !(p || a);
  }
  /* 显示已选文件名，让上传状态更直观 */
  function syncFileNames() {
    ["cpFpaper", "cpFanswer"].forEach(function (id) {
      var inp = $(id), lab = $(id + "Name");
      if (!lab) return;
      var f = inp && inp.files && inp.files[0];
      lab.textContent = f ? "✓ " + f.name : "";
    });
  }
  /* 清空调已选的「试卷 / 答案」文件：解析入库后文件已不再需要，
     避免它们一直停留在上传区（见截图里的遗留文件名问题）。解析成功会自动调用；
     用户也可点「清空已选文件」手动清除。 */
  function clearUploadFiles() {
    ["cpFpaper", "cpFanswer"].forEach(function (id) {
      var inp = $(id);
      if (inp) inp.value = "";
    });
    var loc = $("cpSectionLocator");
    if (loc) loc.hidden = true;
    syncFileNames();
    syncUploadBtn();
  }
  function setInputFile(input, file) {
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (e) { /* 个别浏览器不支持，忽略，走点选 */ }
  }
  /* 拖拽上传：把两份文件拖入上传区，依据扩展名分配到「试卷 / 答案」两个输入框 */
  (function bindDropzone() {
    var dz = $("cpDropzone");
    if (!dz) return;
    var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
    dz.addEventListener("dragover", function (e) { stop(e); dz.classList.add("is-drag"); });
    dz.addEventListener("dragleave", function (e) { stop(e); dz.classList.remove("is-drag"); });
    dz.addEventListener("drop", function (e) {
      stop(e); dz.classList.remove("is-drag");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      assignDroppedFiles(files);
    });
  })();
  function assignDroppedFiles(fileList) {
    var arr = Array.prototype.slice.call(fileList);
    var paper = $("cpFpaper"), answer = $("cpFanswer");
    if (!paper || !answer) return;
    var isPaperExt = function (n) { return /\.ipynb$/i.test(n); };
    arr.forEach(function (f) {
      if (isPaperExt(f.name)) {
        if (!paper.files.length) setInputFile(paper, f);
        else if (!answer.files.length) setInputFile(answer, f);
      } else {
        if (!answer.files.length) setInputFile(answer, f);
        else if (!paper.files.length) setInputFile(paper, f);
      }
    });
    syncFileNames();
    syncUploadBtn();
  }

  if ($("cpFpaper")) $("cpFpaper").addEventListener("change", function () { syncFileNames(); syncUploadBtn(); });
  if ($("cpFanswer")) $("cpFanswer").addEventListener("change", function () { syncFileNames(); syncUploadBtn(); });
  if ($("cpBtnClearUpload")) $("cpBtnClearUpload").addEventListener("click", function () {
    clearUploadFiles();
    setTip("已清空已选文件，可重新选择两份文件。", "info");
    if ($("cpFpaper")) $("cpFpaper").focus();
  });
  syncFileNames();
  syncUploadBtn();

  /* 答案 PDF 含多套答案时展示区段选择器：预选系统自动匹配项，可改选后入库 */
  function showSectionLocator(sections, matched, p, a, editing) {
    var sel = $("cpSectionSelect");
    sel.textContent = "";
    sections.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = String(s.index);
      var pct = Math.round((s.score || 0) * 100);
      opt.textContent = (s.title || ("区段 " + (s.index + 1))) + "（匹配度 " + pct + "%）";
      if (s.index === matched) opt.selected = true;
      sel.appendChild(opt);
    });
    $("cpSectionLocatorText").textContent = editing
      ? "在答案 PDF 中找到 " + sections.length + " 个试卷区段，已自动匹配下方高亮项；如不符请改选后点「确认并更新这份卷子」（覆盖原卷，不新增）。"
      : "在答案 PDF 中找到 " + sections.length + " 个试卷区段，已自动匹配下方高亮项；如不符请改选后点「确认并入库」。";
    var loc = $("cpSectionLocator");
    loc.hidden = false;
    loc._p = p; loc._a = a; loc._editing = !!editing;
  }

  $("cpBtnConfirmSection").addEventListener("click", function () {
    var loc = $("cpSectionLocator");
    if (loc.hidden) return;
    var idx = $("cpSectionSelect").value;
    loc.hidden = true;
    doUploadPersist(loc._p, loc._a, idx, loc._editing);
  });
  $("cpBtnCancelSection").addEventListener("click", function () {
    $("cpSectionLocator").hidden = true;
    setTip("已取消上传。", "info");
  });

  /* Step 2：把选中的区段（或自动匹配段）正式解析并封卷入库 */
  /* 上传时决定传给后端的标题：
     - 用户在「试卷名称」里手填了 → 用用户的；
     - 否则，若文件名本身含真实名称（不只是 1.1.4 这类编号）→ 用文件名；
     - 若文件名只是编号 → 不传 title，交给后端从答案文件推导完整名称（避免题库里只剩编号）。 */
  function pickUploadTitle(file) {
    var typed = $("cpTitle") && $("cpTitle").value.trim();
    if (typed) return typed;
    var name = (file && file.name ? file.name : "").replace(/\.[^.]+$/, "");
    if (name && !/^[\d.\-_\s]+$/.test(name)) return name;
    return "";
  }

  /* editingPaperId 非空 → PUT 覆盖更新该卷（重新上传文件重封卷）；否则 POST 新增。
     优化：非编辑且所选区段 == 探针自动匹配区段（用户未改选）时，直接凭缓存 token 落库，
     跳过对大体积多区段答案 PDF 的二次完整重解——那正是「入库失败：Failed to fetch」
     （浏览器 / webview 把长请求掐断）的根因。仅当用户改选不同区段、或处于编辑覆盖时才重解。 */
  function doUploadPersist(p, a, chosenIndex, editingPaperId) {
    /* 接受自动匹配区段（用户未改选）→ 凭缓存 token 直接落库，无需二次重解。
       关键点：编辑覆盖（更新已有卷子）与新增走完全相同的「快速提交」通道——
       只是 persist 多带一个 paper_id 表示覆盖，而不再像旧逻辑那样对编辑模式
       强制跑一遍完整 PUT 重解析（那正是把长连接掐断、报「网络超时」的根因）。 */
    if (S.probeToken && S.probeMatched != null) {
      var chosenNum = (chosenIndex === null || chosenIndex === undefined ||
        chosenIndex === "" || chosenIndex === "auto")
        ? S.probeMatched
        : Number(chosenIndex);
      if (chosenNum === S.probeMatched) {
        persistCached(S.probeToken, editingPaperId);
        return;
      }
    }
    /* 用户改选了不同区段：针对该区段再发起一次异步重解（仍是「先异步算、再快速提交」，
       不在单条请求里同步跑完），完成后同样凭 token 落库（带 paper_id 即覆盖）。 */
    var form = new FormData();
    form.append("paper", p);
    form.append("answer", a);
    var upTitle = pickUploadTitle(p);
    if (upTitle) form.append("title", upTitle);
    form.append("language", $("cpLang").value);
    if (chosenIndex !== null && chosenIndex !== undefined && chosenIndex !== "" && chosenIndex !== "auto") {
      form.append("answer_section", String(chosenIndex));
    }
    if ($("cpUseLlm") && $("cpUseLlm").checked) form.append("use_llm", "1");
    setTip("正在按所选区段重新解析（大模型处理中，请稍候）…", "info");
    if ($("cpTip")) $("cpTip").classList.add("is-loading");
    showAbort(true);
    startParseJob(
      form,
      function (res) {
        showAbort(false);
        if ($("cpTip")) $("cpTip").classList.remove("is-loading");
        S.probeToken = res.cache_token || null;
        S.probeResult = res;
        S.probeMatched = (res.matched_section != null) ? Number(res.matched_section) : null;
        persistCached(S.probeToken, editingPaperId);
      },
      function (e) {
        showAbort(false);
        if ($("cpTip")) $("cpTip").classList.remove("is-loading");
        setTip(parseFailMessage(e), "error");
      }
    );
  }

  /* 凭探针缓存 token 直接落库：复用 runParseSuccess 展示回执，但不再重解 PDF。
     这是「确认并入库」在「接受自动匹配区段」时的快速通道，把一次大体积解析从「两次」降到「一次」，
     从根本上规避长请求被浏览器 / webview 超时掐断（表现成「入库失败：Failed to fetch」）。
     editingPaperId 非空时把解析结果覆盖到已有卷子（更新而非新增）。 */
  function persistCached(token, editingPaperId) {
    var btn = $("cpBtnUpload");
    S.parseRestore = editingPaperId ? "更新这份卷子（重新封卷）" : "上传解析并入库";
    if (btn) { btn.disabled = true; btn.classList.add("is-loading"); btn.textContent = "入库中…"; }
    setTip(editingPaperId ? "正在用新解析结果覆盖这份卷子…" : "正在把已解析结果封卷入库…", "info");
    var payload = { token: token };
    if (editingPaperId) payload.paper_id = editingPaperId;
    api("/api/code-papers/persist", { method: "POST", body: JSON.stringify(payload) })
      .then(function (d) {
        S.probeToken = null; /* token 已被服务端消费，避免误复用 */
        /* 用探针已解析结果拼出完整回执（补上落库后的 paper_id / run_id） */
        var full = Object.assign({}, S.probeResult || {}, { paper_id: d.paper_id, run_id: d.run_id });
        runParseSuccess(full, btn);
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); btn.textContent = S.parseRestore; }
        setTip(parseFailMessage(e), "error");
      });
  }

  $("cpBtnClear").addEventListener("click", function () {
    $("cpPaper").value = "";
    $("cpAnswer").value = "";
    $("cpTitle").value = "";
    clearUploadFiles();
    S.editingPaperId = null;
    $("cpBtnParse").textContent = "解析并封卷入库";
    $("cpIntakeReport").hidden = true;
    $("cpResultCard").hidden = true;
    setTip("已清空，可重新输入。");    $("cpPaper").focus();
  });

  /* 终止调用：大模型卡死时由用户主动中止；系统也会在超时后自动触发。
     区分两条路径：
     - 上传异步解析（S.parseJobId 非空）：置位取消标记、掐断当前轮询 fetch，
       并 DELETE 后台任务，轮询即将收到 cancelled；不依赖单条请求的 watchdog。
     - 文本录入同步解析（粘贴通道）：维持原 terminateParse 行为。 */
  $("cpBtnAbort").addEventListener("click", function () {
    if (S.parseJobId) {
      S.parseAborted = true;
      if (S.parseAC) { try { S.parseAC.abort(); } catch (e) {} }
      api("/api/code-papers/parse-job/" + S.parseJobId, { method: "DELETE" });
      showAbort(false);
      if ($("cpTip")) $("cpTip").classList.remove("is-loading");
      setTip("已取消解析。若卷子已在后台入库，可在「我的题库」查看；否则请重试。", "error");
      return;
    }
    if (S.parseAC) { S.parseAC.abort(); terminateParse("manual"); }
  });

  $("cpBtnSaveAnswers").addEventListener("click", saveAnswers);
  $("cpBtnCancelAnswers").addEventListener("click", function () {
    // 先复位整卷入库页（清空残留 + 回到初始「录入试卷」状态），再返回「我的题库」，
    // 确保下次进入整卷入库不会停留在试题编辑视图、残留上一份卷子的内容
    resetEditAnswers();
    if (window.appUI && window.appUI.switchView) window.appUI.switchView("library");
    else switchTab("audit");
    setTip("已取消，未改动任何答案。");
  });

  /* cpBtnIntakeShelf 现在用 data-view="library" 由 app.js 统一切页（整卷入库只录入+质检，开考在题库/错题本发起） */
  $("cpBtnIntakeAudit").addEventListener("click", function () {
    if (!S.intakePaperId) { setTip("这份结果未入库，无法查看质检明细。", "error"); return; }
    switchTab("audit", true);
    $("cpAuditSelect").value = String(S.intakePaperId);
    loadAudit(S.intakePaperId);
  });

  $("cpBtnSubmit").addEventListener("click", submitExam);
  $("cpBtnLeaveExam").addEventListener("click", function () {
    stopTimer();
    $("cpExamSheet").hidden = true;
    $("cpExamReport").hidden = true;
    // 离开考场直接回「我的题库」：考试入口只来自题库 / 练习 / 错题本，不应再停在整卷入库界面
    $("cpExamPicker").hidden = true;
    if (window.appUI && window.appUI.switchView) window.appUI.switchView("library");
    setTip("已离开考场，本次作答未保存。");
  });
  $("cpBtnRetry").addEventListener("click", function () {
    if (S.examPaper) startExam(S.examPaper.id);
  });
  $("cpBtnBackShelf").addEventListener("click", function () {
    $("cpExamReport").hidden = true;
    $("cpExamSheet").hidden = true;
    $("cpExamPicker").hidden = true;
    // 成绩单里的「返回卷库」也回「我的题库」，保持与离开考场一致
    if (window.appUI && window.appUI.switchView) window.appUI.switchView("library");
  });

  $("cpBtnCopy").addEventListener("click", function () {
    var text = $("cpFilled").textContent || "";
    var btn = $("cpBtnCopy");
    function done(ok) {
      btn.textContent = ok ? "已复制" : "复制失败";
      setTimeout(function () { btn.textContent = "复制"; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
  });

  $("cpBtnReview").addEventListener("click", function () {
    if (!CURRENT_RUN_ID) { setTip("本次结果未落库，无法提交人工复核。", "error"); return; }
    var force = this.dataset.force === "1";
    var btn = $("cpBtnReview");
    var restore = force ? "确认人工审核通过并保存（覆盖分歧）" : "确认已完成人工复核";
    btn.disabled = true;
    btn.textContent = "提交中…";
    api("/api/code-papers/runs/" + CURRENT_RUN_ID + "/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: force })
    }).then(function (d) {
      btn.disabled = false;
      btn.textContent = restore;
      if (S.currentConds) S.currentConds = d.conditions || S.currentConds;
      renderConds(d.conditions || {});
      setVerdict(!!d.passed);
      $("cpReviewBox").hidden = !!d.passed;
      syncIntakeReviewBtn(!!d.passed);
      loadPapers();
      setTip(d.passed
        ? (d.forced ? "已人工复核通过：覆盖系统分歧并封存，已返回「我的题库」。" : "人工复核完成，质检通过，已返回「我的题库」。")
        : "复核已记录，但仍有硬冲突。",
        d.passed ? "ok" : "error");
      /* 复核提交后回到「我的题库」，让用户立刻看到这份卷子的状态更新 */
      var lib = document.querySelector('[data-view="library"]');
      if (lib) { lib.click(); }
      else if (window.appUI && window.appUI.switchView) { window.appUI.switchView("library"); }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = restore;
      setTip("复核请求失败：" + e.message, "error");
    });
  });

  /* 录入页（整卷入库）的人工复核入口：解析未通过时直接在录入回执里给一个
     「确认通过并保存」按钮，不必切到「入库质检」页签。存在硬冲突时传 force=true
     覆盖，覆盖项在后端记入 detail.human_override 留痕。 */
  function syncIntakeReviewBtn(passed) {
    var btn = $("cpBtnIntakeReview");
    var note = $("cpIntakeReviewNote");
    if (!btn) return;
    var show = !!S.runId; /* 只要结果已落库就给人工复核入口，不再受 passed 影响 */
    btn.hidden = !show;
    if (note) note.hidden = !show;
    if (!show) return;
    if (!passed && S.hardFail.length) {
      btn.textContent = "确认人工审核通过并保存（覆盖 " + S.hardFail.length + " 项分歧）";
      btn.dataset.force = "1";
      if (note) note.textContent = "质检未完全通过（" + S.hardFail.join("、") +
        "）。若你已逐空核对答案无误，可强制确认通过并封存。";
    } else if (!passed) {
      btn.textContent = "确认人工审核通过并保存";
      btn.dataset.force = "0";
      if (note) note.textContent = "质检尚有低置信度项，确认已逐空核对后点下方按钮存档。";
    } else {
      btn.textContent = "确认并封存（已通过）";
      btn.dataset.force = "0";
      if (note) note.textContent = "质检已通过，答案已可封存开考；点下方按钮确认并锁定本次结论。";
    }
  }

  var intakeRenameBtn = $("cpBtnIntakeRename");
  if (intakeRenameBtn) intakeRenameBtn.addEventListener("click", renameIntakeTitle);

  $("cpBtnIntakeReview").addEventListener("click", function () {
    if (!S.runId) { setTip("本次结果未入库，请重新解析一次。", "error"); return; }
    var force = this.dataset.force === "1";
    var btn = this;
    var restore = force ? "确认人工审核通过并保存（覆盖分歧）" : "确认人工审核通过并保存";
    btn.disabled = true;
    btn.textContent = "提交中…";
    api("/api/code-papers/runs/" + S.runId + "/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: force })
    }).then(function (d) {
      btn.disabled = false;
      btn.hidden = true;
      if ($("cpIntakeReviewNote")) $("cpIntakeReviewNote").hidden = true;
      var report = $("cpIntakeReport");
      if (report) {
        report.classList.remove("is-warn");
        if ($("cpIntakeSeal")) $("cpIntakeSeal").textContent = "封";
        if ($("cpIntakeSummary")) $("cpIntakeSummary").textContent =
          "人工复核已通过，答案已封存，随时可以开考。";
      }
      loadPapers();
      setTip(d.passed
        ? (d.forced ? "已人工审核通过并封存（覆盖系统分歧），已在「我的题库」开考。" : "人工审核通过，已封存。")
        : "复核已记录，但仍有硬冲突。", d.passed ? "ok" : "error");
      // 检验确认后直接跳转到「我的题库」，让用户立刻看到这份刚封卷的试卷
      var lib = document.querySelector('[data-view="library"]');
      if (lib) { lib.click(); }
      else if (window.appUI && window.appUI.switchView) { window.appUI.switchView("library"); }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = restore;
      setTip("复核请求失败：" + e.message, "error");
    });
  });

  /* ------------------------------------------------------------------
     外部深链：概览 / 手册的「去开考」按钮带 data-cp-open="exam"；
     错题本的「整卷重考」额外带 data-cp-paper="<id>"，直接开考那一份卷，
     不让用户在考场里再找一遍。app.js 的 [data-view] 委托负责切页，
     这里在页面显示后把用户送进对应页签。
     ------------------------------------------------------------------ */
  var pageEl = root.closest(".page");
  function openFromOutside(tab, paperId, retry) {
    /* 从「我的题库 / 错题本」的行内按钮进入（试卷现在以一行呈现在题库里）：
       edit         → 进整卷入库的录入面板，改这份卷的标题 / 类型 / 两份原文后重新封卷
       edit-answers → 进逐空改答案面板，只订正被抽错的那几个空
       delete       → 确认后删除这份卷
       exam-pick    → 只把用户送进考场选卷页，不自动开考某一份
       exam         → 直接开考（指定 paperId 开那一份；未指定则开第一份，没有则先放示例卷） */
    if (tab === "edit") { openEditPaper(paperId); return; }
    if (tab === "edit-answers") { openEditAnswers(paperId); return; }
    if (tab === "delete") { deletePaperDeep(paperId); return; }
    /* 待复核卷的「去质检」深链：直接落在质检页并选中这份卷 */
    if (tab === "audit") { gotoAudit(paperId); return; }
    var realTab = tab === "exam-pick" ? "exam" : tab;
    switchTab(realTab);
    if (realTab !== "exam") return;
    if (tab === "exam-pick") {
      /* 重置到选卷页，避免残留的答题纸 / 成绩单挡住选卷列表 */
      $("cpExamPicker").hidden = false;
      $("cpExamSheet").hidden = true;
      $("cpExamReport").hidden = true;
      if (typeof renderPicker === "function") renderPicker();
      return;
    }
    if (paperId) { startExam(paperId, retry); return; }
    /* 未指定卷子时，只从已封存的卷里挑；全是待复核卷就引导去质检 */
    var usable = (S.papers || []).filter(function (p) { return p.verified !== false; });
    if (usable.length) startExam(usable[0].id);
    else if (S.papers.length) refuseReviewPaper(S.papers[0].id, 0);
    else seed(true);
  }
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest) return;
    var b = ev.target.closest("[data-cp-open]");
    if (!b) return;
    var tab = b.dataset.cpOpen;
    var pid = Number(b.dataset.cpPaper || 0) || null;
    var retry = b.dataset.cpRetry === "1";
    if (pageEl && !pageEl.hidden) { openFromOutside(tab, pid, retry); return; }
    S.pendingTab = tab;
    S.pendingPaperId = pid;
    S.pendingRetry = retry;
  }, true);
  if (pageEl && window.MutationObserver) {
    new MutationObserver(function () {
      if (pageEl.hidden || !S.pendingTab) return;
      var tab = S.pendingTab;
      var pid = S.pendingPaperId;
      var retry = S.pendingRetry;
      S.pendingTab = null;
      S.pendingPaperId = null;
      S.pendingRetry = null;
      openFromOutside(tab, pid, retry);
    }).observe(pageEl, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* 首次进入：拉卷库；页面本来就是 shelf 页签，不重复切换 */
  loadPapers();

  /* ------------------------------------------------------------------
     外部入口：随机抽一份整卷开考（供「开始练习 → 随机练习试卷」模式卡调用）。
     复用现有整卷判分 / 历史成绩逻辑；页面未显示时借 pending + MutationObserver
     等页面可见后再开考，与 data-cp-open="exam" 深链行为一致。
     ------------------------------------------------------------------ */
  function cpOpenRandomPaperExam() {
    function open(pid) {
      if (pageEl && !pageEl.hidden) { openFromOutside("exam", pid, false); return; }
      S.pendingTab = "exam";
      S.pendingPaperId = pid;
      S.pendingRetry = false;
    }
    function pick() {
      var list = S.papers || [];
      if (!list.length) { seed(true); return; } /* 卷库为空，先放一份示例卷并开考 */
      /* 随机开考只在已封存的卷里抽，待复核卷不参与 */
      var usable = list.filter(function (p) { return p.verified !== false; });
      if (!usable.length) {
        showToast("现有卷子都待复核，不能作答；请先到质检判定订正封卷。", "error");
        return;
      }
      var p = usable[Math.floor(Math.random() * usable.length)];
      open(p.id);
    }
    if (!S.papers || !S.papers.length) { loadPapers().then(pick); } else { pick(); }
  }
  window.cpStartRandomPaperExam = cpOpenRandomPaperExam;
  /* 让「开始练习」页能读到整卷数量，给模式卡显示「N 份卷可随机」 */
  window.cpPaperCount = function () { return (S.papers || []).length; };
})();
