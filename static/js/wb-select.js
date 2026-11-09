/* ==================================================================
   统一下拉控件 / WB Select —— 行为层
   ------------------------------------------------------------------
   目标：把全站所有原生 <select> 变成与「整卷历史」同款的浮层控件，
   且不改任何一行业务代码。

   做法：原生 select 保留在 DOM / 表单里，只做视觉隐藏，继续充当唯一
   的「值容器」。点选时写回 select.value 并派发 input/change，业务侧
   原有的 .value 读取、change 监听、options 重建全部照旧。

   为了兼容本项目大量「程序性赋值 / 动态重建选项」的历史代码，做了
   三件事：
     1) 在实例上重写 value 的 setter，任何 sel.value = x 都即时同步显示；
     2) MutationObserver 盯着 select 的 options / class / disabled；
     3) 全局 MutationObserver 自动接管弹窗、表格里后插入的 select，
        并回收已被移除的实例（含挂在 body 上的浮层）。

   浮层一律 portal 到 <body> 并 fixed 定位：.library-toolbar 有
   overflow-x:auto，.page 切页动画带 transform，两者都会裁切或偏移
   绝对 / 固定定位的面板。
   ================================================================== */
(function () {
  "use strict";

  var SEARCH_THRESHOLD = 8;      // 选项达到这个数才出现模糊搜索框
  var PANEL_MAX = 280;           // 与 .ch-combo-list 一致的最大高度
  var instances = [];
  var uid = 0;
  var active = null;             // 当前展开的实例，全站同时只允许一个
  var valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* 与 app.js 的 fuzzyMatch 同算法：子串优先，其次顺序子序列 */
  function fuzzy(q, text) {
    q = (q || "").trim().toLowerCase();
    if (!q) return 2;
    text = (text || "").toLowerCase();
    if (text.indexOf(q) >= 0) return 3;
    var i = 0;
    for (var k = 0; k < text.length; k++) {
      if (text[k] === q[i]) i++;
      if (i === q.length) return 1;
    }
    return -1;
  }

  function eligible(sel) {
    if (!sel || sel.dataset.wbSelect) return false;
    if (sel.multiple || sel.size > 1) return false;
    if (sel.hasAttribute("data-wb-native")) return false;
    if (sel.closest("template")) return false;
    return true;
  }

  function findLabels(sel) {
    if (!sel.id) return [];
    return Array.prototype.filter.call(
      document.getElementsByTagName("label"),
      function (l) { return l.getAttribute("for") === sel.id; }
    );
  }

  function enhance(sel) {
    if (!eligible(sel)) return;
    sel.dataset.wbSelect = "1";

    /* 必须在隐藏之前量：加上 .wb-select-native 后 select 变成 1x1 的
       绝对定位元素，且不再是 .library-filters > select 这类上下文选择器
       的直接子元素，原始尺寸 / 字号 / 内边距就再也读不到了。 */
    var r0 = sel.getBoundingClientRect();
    var c0 = getComputedStyle(sel);
    var base = {
      width: r0.width,
      height: c0.height,
      fontSize: c0.fontSize,
      fontFamily: c0.fontFamily,
      fontWeight: c0.fontWeight,
      lineHeight: c0.lineHeight,
      borderRadius: c0.borderRadius,
      padTop: c0.paddingTop,
      padRight: c0.paddingRight,
      padBottom: c0.paddingBottom,
      padLeft: c0.paddingLeft
    };
    var origParent = sel.parentNode;
    var origNext = sel.nextSibling;

    var id = "wb-select-" + (++uid);
    var host;

    /* 「每页条数」原本就有一层自定义外观壳，直接借壳，不套第二层 */
    if (sel.parentElement && sel.parentElement.classList.contains("per-page-select")) {
      host = sel.parentElement;
      host.classList.add("wb-select-host");
      host.insertBefore(makeTrigger(id), sel);
    } else {
      host = document.createElement("span");
      host.className = "wb-select-host";
      sel.parentNode.insertBefore(host, sel);
      host.appendChild(sel);
      host.insertBefore(makeTrigger(id), sel);
    }
    sel.classList.add("wb-select-native");   // 视觉隐藏，但仍是唯一的值容器

    var trigger = host.querySelector(".wb-select-trigger");
    var valueEl = trigger.querySelector(".wb-select-value");

    var panel = document.createElement("div");
    panel.className = "wb-select-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<label class="wb-select-search">' +
        '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>' +
        '<input type="text" autocomplete="off" spellcheck="false" placeholder="搜索选项…" aria-label="筛选选项">' +
      "</label>" +
      '<ul class="wb-select-list" role="listbox"></ul>';
    var searchWrap = panel.querySelector(".wb-select-search");
    var searchInput = panel.querySelector("input");
    var list = panel.querySelector(".wb-select-list");
    list.id = id + "-list";
    document.body.appendChild(panel);

    /* 语义：aria-label / title 从原控件继承 */
    var labelText = sel.getAttribute("aria-label") || "";
    if (!labelText) {
      var ls = findLabels(sel);
      if (ls.length) labelText = (ls[0].textContent || "").trim();
    }
    if (!labelText) labelText = "下拉选择";
    trigger.setAttribute("aria-label", labelText);
    trigger.setAttribute("aria-controls", list.id);
    searchInput.setAttribute("aria-controls", list.id);
    list.setAttribute("aria-label", labelText);
    if (sel.getAttribute("title")) trigger.setAttribute("title", sel.getAttribute("title"));

    /* 外部 label[for] 指向触发器；嵌套 label（如 .cp-field）保持原样，
       否则 label 的代理点击会和按钮自身的 click 叠加成双开关。 */
    if (sel.id) {
      trigger.id = id + "-trigger";
      findLabels(sel).forEach(function (l) {
        if (!l.contains(trigger)) {
          l.setAttribute("for", trigger.id);
        } else {
          /* 嵌套 label（整卷「试卷类型」等）仍指向隐藏的原生 select，
             点文字不会开面板。补一个代理点击，并排除按钮自身避免双开关。 */
          l.addEventListener("click", function (e) {
            if (e.target && e.target.closest && e.target.closest(".wb-select-trigger")) return;
            e.preventDefault();
            trigger.click();
          });
        }
      });
    }

    var inst = {
      sel: sel, host: host, trigger: trigger, panel: panel, list: list,
      searchWrap: searchWrap, searchInput: searchInput, valueEl: valueEl,
      open: false, cursor: -1, labelText: labelText, mo: null
    };

    /* ---- 尺寸继承：用隐藏前捕获的 base，写成 CSS 变量 -------- */
    function setVar(el, name, value) {
      if (el.style.getPropertyValue(name) !== String(value)) el.style.setProperty(name, value);
    }

    inst.applyBase = function () {
      /* 页面初始隐藏：不写任何内联变量，全部交给 wb-select.css 的
         上下文兜底；等 measure() 首次见到可见控件时再补宽度。 */
      if (base.width < 8) return;
      inst.baseWidth = Math.round(base.width);
      setVar(host, "--wb-w", inst.baseWidth + "px");
      /* display:none 的元素 computed height 会是 auto：跳过，交给
         wb-select.css 里按上下文定义的 --wb-h 兜底。 */
      if (base.height && base.height !== "auto") setVar(trigger, "--wb-h", base.height);
      setVar(trigger, "--wb-fs", base.fontSize);
      setVar(trigger, "--wb-ff", base.fontFamily);
      setVar(trigger, "--wb-fw", base.fontWeight);
      setVar(trigger, "--wb-lh", base.lineHeight);
      setVar(trigger, "--wb-radius", base.borderRadius);
      setVar(trigger, "--wb-pad", [
        base.padTop,
        Math.max(parseFloat(base.padRight) || 0, 28) + "px",  // 给统一 caret 留位
        base.padBottom,
        base.padLeft
      ].join(" "));
    };

    /* 页面初始隐藏时量不到宽度：等控件可见后，把 select 临时放回原父级
       （原有上下文 CSS 规则才会重新匹配），同步量一次再放回宿主。
       同一帧内完成，不产生可见闪烁；量到后缓存，不再重复。 */
    inst.measure = function () {
      if (inst.baseWidth) return;
      if (trigger.getBoundingClientRect().width < 8) return;
      sel.classList.remove("wb-select-native");
      if (origParent && origParent.isConnected) {
        var next = (origNext && origNext.parentNode === origParent) ? origNext : null;
        origParent.insertBefore(sel, next);
      }
      var w = sel.getBoundingClientRect().width;
      host.appendChild(sel);
      sel.classList.add("wb-select-native");
      if (w >= 8) {
        inst.baseWidth = Math.round(w);
        setVar(host, "--wb-w", inst.baseWidth + "px");
      }
    };

    /* ---- 显示同步：标签、生效态、语义色、禁用态 ------------------ */
    inst.sync = function () {
      var opt = sel.selectedOptions && sel.selectedOptions[0];
      valueEl.textContent = opt ? (opt.textContent || "").trim() : (sel.value || "请选择");
      trigger.disabled = sel.disabled;

      var classes = ["wb-select-trigger"];
      Array.prototype.forEach.call(sel.classList, function (c) {
        if (c !== "wb-select-native" && c.indexOf("wb-select") !== 0) classes.push(c);
      });
      /* 只给「占位首项 + 已选具体值」的筛选器加生效态；
         排序 / 每页条数 / 判断题答案不算筛选，避免整屏发亮。 */
      var first = sel.options[0];
      var isFilter = first && first.value === "" && sel.value !== "" &&
                     !sel.classList.contains("tf-select");
      if (isFilter) classes.push("has-value");
      var nextClass = classes.join(" ");
      if (trigger.className !== nextClass) trigger.className = nextClass;
      if (inst.open) inst.render();
    };

    /* ---- 选项渲染 ------------------------------------------------ */
    inst.render = function () {
      var q = searchInput.value.trim();
      var rows = [];
      var visible = [];
      var lastGroup = null;
      Array.prototype.forEach.call(sel.options, function (o, idx) {
        var text = (o.textContent || o.value || "").trim();
        if (q && fuzzy(q, text) < 1) return;
        var g = o.parentElement && o.parentElement.tagName === "OPTGROUP"
          ? (o.parentElement.label || "") : "";
        if (g && g !== lastGroup) {
          rows.push('<li class="wb-select-group" role="presentation">' + esc(g) + "</li>");
          lastGroup = g;
        }
        visible.push(idx);
        var cls = "wb-select-opt";
        if (String(o.value) === String(sel.value)) cls += " is-selected";
        if (o.disabled) cls += " is-disabled";
        rows.push(
          '<li class="' + cls + '" role="option" data-idx="' + idx + '"' +
          ' aria-selected="' + (String(o.value) === String(sel.value) ? "true" : "false") + '"' +
          ' tabindex="-1"><span class="wb-select-opt-text">' + esc(text) + "</span>" +
          '<svg class="wb-select-check" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-check"></use></svg>' +
          "</li>"
        );
      });
      list.innerHTML = rows.length
        ? rows.join("")
        : '<li class="wb-select-empty" role="presentation">没有匹配的选项</li>';
      inst.indices = visible;
      var selectedAt = visible.findIndex(function (i) {
        return String(sel.options[i].value) === String(sel.value);
      });
      inst.cursor = selectedAt >= 0 ? selectedAt : (visible.length ? 0 : -1);
      inst.updateCursor();
    };

    inst.updateCursor = function () {
      var opts = list.querySelectorAll(".wb-select-opt");
      Array.prototype.forEach.call(opts, function (li, i) {
        li.classList.toggle("is-cursor", i === inst.cursor);
        if (i === inst.cursor) {
          li.id = list.id + "-cursor";
          li.setAttribute("aria-selected", li.classList.contains("is-selected") ? "true" : "false");
          trigger.setAttribute("aria-activedescendant", li.id);
          searchInput.setAttribute("aria-activedescendant", li.id);
          if (li.scrollIntoView) {
            var lr = li.getBoundingClientRect(), pr = panel.getBoundingClientRect();
            if (lr.bottom > pr.bottom || lr.top < pr.top) li.scrollIntoView({ block: "nearest" });
          }
        } else if (li.id === list.id + "-cursor") {
          li.removeAttribute("id");
        }
      });
      if (!opts.length) {
        trigger.removeAttribute("aria-activedescendant");
        searchInput.removeAttribute("aria-activedescendant");
      }
    };

    /* ---- 定位：fixed + 上下/左右空间裁决 --------------------------- */
    inst.place = function () {
      var r = trigger.getBoundingClientRect();
      if (!r.width) return;
      var wanted = Math.min(360, Math.max(168, r.width));
      var maxW = Math.min(360, window.innerWidth - 16);
      panel.style.width = Math.min(wanted, maxW) + "px";
      var need = Math.min(PANEL_MAX, Math.max(96, panel.scrollHeight || 180));
      var below = window.innerHeight - r.bottom - 10;
      var above = r.top - 10;
      var top, maxH;
      if (below >= Math.min(need, 140) || below >= above) {
        top = r.bottom + 6;
        maxH = Math.max(120, Math.min(PANEL_MAX, below));
      } else {
        maxH = Math.max(120, Math.min(PANEL_MAX, above));
        top = Math.max(8, r.top - 6 - Math.min(need, maxH));
      }
      var pw = panel.offsetWidth || Math.min(wanted, maxW);
      var left = r.left;
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - pw);
      panel.style.left = Math.round(left) + "px";
      panel.style.top = Math.round(top) + "px";
      panel.style.maxHeight = Math.round(maxH) + "px";
    };

    inst.openPanel = function () {
      if (active && active !== inst) active.close();
      inst.measure();
      inst.sync();
      searchWrap.hidden = sel.options.length < SEARCH_THRESHOLD;
      searchInput.value = "";
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      inst.open = true;
      active = inst;
      inst.render();
      inst.place();
      if (!searchWrap.hidden) {
        try { searchInput.focus({ preventScroll: true }); }
        catch (_e) { searchInput.focus(); }
      }
    };

    inst.close = function () {
      if (!inst.open) return;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      inst.open = false;
      if (active === inst) active = null;
    };

    inst.choose = function (idx) {
      var o = sel.options[idx];
      if (!o || o.disabled) return;
      var changed = String(sel.value) !== String(o.value);
      sel.value = o.value;                       // 走拦截后的 setter，即时同步
      if (changed) {
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      inst.sync();
      inst.close();
      try { trigger.focus({ preventScroll: true }); }
      catch (_e) { trigger.focus(); }
    };

    inst.move = function (delta) {
      var n = inst.indices ? inst.indices.length : 0;
      if (!n) return;
      inst.cursor = (inst.cursor + delta + n) % n;
      inst.updateCursor();
    };

    inst.destroy = function () {
      inst.close();
      if (inst.mo) inst.mo.disconnect();
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      /* 还原被拦截的 value 属性，避免游离引用持有闭包 */
      try { delete sel.value; } catch (_e) { /* 不可配置时忽略 */ }
      delete sel.dataset.wbSelect;
    };

    /* ---- 事件 ---------------------------------------------------- */
    trigger.addEventListener("click", function () {
      if (inst.open) inst.close(); else inst.openPanel();
    });
    trigger.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!inst.open) inst.openPanel();
        else inst.move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        if (!inst.open) inst.openPanel();
        else if (inst.cursor >= 0 && inst.indices) inst.choose(inst.indices[inst.cursor]);
      } else if (e.key === "Escape") {
        inst.close();
      } else if (e.key === "Tab") {
        inst.close();
      } else if ((e.key === "Home" || e.key === "End") && inst.open && inst.indices) {
        e.preventDefault();
        inst.cursor = e.key === "Home" ? 0 : (inst.indices.length - 1);
        inst.updateCursor();
      }
    });

    searchInput.addEventListener("input", function () { inst.render(); });
    /* 阻止点击选项时抢走焦点，保证连选与键盘一致 */
    list.addEventListener("mousedown", function (e) { e.preventDefault(); });
    list.addEventListener("click", function (e) {
      var li = e.target.closest(".wb-select-opt");
      if (!li || li.classList.contains("is-disabled")) return;
      inst.choose(Number(li.dataset.idx));
    });

    panel.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); inst.move(e.key === "ArrowDown" ? 1 : -1);
      } else if ((e.key === "Home" || e.key === "End") && inst.indices && inst.indices.length) {
        e.preventDefault();
        inst.cursor = e.key === "Home" ? 0 : (inst.indices.length - 1);
        inst.updateCursor();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (inst.cursor >= 0 && inst.indices) inst.choose(inst.indices[inst.cursor]);
      } else if (e.key === "Escape") {
        e.preventDefault(); inst.close();
        try { trigger.focus({ preventScroll: true }); } catch (_e) { trigger.focus(); }
      } else if (e.key === "Tab") {
        inst.close();
      }
    });

    /* select 的 options / class / disabled 变了都要同步。
       attributeFilter 不含 value：value 是 property，由下面的 setter 负责。 */
    inst.mo = new MutationObserver(function () {
      /* 业务若用 className = "..." 整体重写，会抹掉隐藏用的 class，
         这里立刻补回，避免原生 select 重新露出来。 */
      if (!sel.classList.contains("wb-select-native")) sel.classList.add("wb-select-native");
      inst.sync();
    });
    inst.mo.observe(sel, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["class", "disabled", "title", "aria-label", "hidden"]
    });

    /* 程序性 sel.value = x（编辑器回填、卷子切换、每页偏好）即时同步 */
    if (valueDesc && valueDesc.get && valueDesc.set) {
      Object.defineProperty(sel, "value", {
        configurable: true,
        get: function () { return valueDesc.get.call(this); },
        set: function (v) { valueDesc.set.call(this, v); inst.sync(); }
      });
    }
    sel.addEventListener("change", inst.sync);
    sel.addEventListener("input", inst.sync);

    inst.applyBase();
    inst.measure();
    inst.sync();
    instances.push(inst);
  }

  function makeTrigger(id) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-select-trigger";
    btn.setAttribute("role", "combobox");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("data-wb-trigger", id);
    btn.innerHTML =
      '<span class="wb-select-value"></span>' +
      '<svg class="wb-select-caret" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
    return btn;
  }

  /* ---- 全局：自动接管动态插入的 select，回收已移除实例 ------------- */
  var pending = new Set();
  var scheduled = false;

  /* 切页（.page 的 hidden / class 变化）会让原本隐藏页里的控件变可见。
     用微任务合并全量重测量：MutationObserver 回调本身已在微任务里，
     再排一个微任务足以合并同批变化，且不依赖 rAF（切页动画、无头
     浏览器或后台标签页里 rAF 可能根本不推进）。 */
  var remeasureScheduled = false;
  function remeasureAll() {
    if (remeasureScheduled) return;
    remeasureScheduled = true;
    (window.queueMicrotask || function (fn) { Promise.resolve().then(fn); })(function () {
      remeasureScheduled = false;
      instances.forEach(function (i) { i.measure(); });
      if (active) active.place();
    });
  }

  function flush() {
    scheduled = false;
    var add = Array.from(pending);
    pending.clear();
    add.forEach(function (sel) {
      if (document.contains(sel)) enhance(sel);
    });
    for (var i = instances.length - 1; i >= 0; i--) {
      if (!document.contains(instances[i].sel)) {
        instances[i].destroy();
        instances.splice(i, 1);
      }
    }
    remeasureAll();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.queueMicrotask || function (fn) { Promise.resolve().then(fn); })(flush);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.tagName === "SELECT") pending.add(root);
    if (root.querySelectorAll) {
      Array.prototype.forEach.call(root.querySelectorAll("select"), function (s) { pending.add(s); });
    }
  }

  function boot() {
    scan(document);
    flush();

    var docMo = new MutationObserver(function (records) {
      var needFlush = false;
      var needMeasure = false;
      records.forEach(function (rec) {
        if (rec.type === "attributes") { needMeasure = true; return; }
        Array.prototype.forEach.call(rec.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          scan(n);
          needFlush = true;
        });
        /* 弹窗 / 表格重渲染会整块替换 DOM：借 removedNodes 触发一次 flush，
           回收已脱离文档的浮层，避免 panel 在 body 里越堆越多。 */
        Array.prototype.forEach.call(rec.removedNodes, function (n) {
          if (n.nodeType === 1) needFlush = true;
        });
      });
      if (needFlush) schedule();       // flush 内部已包含 remeasureAll
      else if (needMeasure) remeasureAll();
    });
    /* 只观察 hidden / class：切页用 page.hidden + body.view-fixed，
       足够覆盖显示状态变化。绝不观察 style —— measure() 自己会写
       CSS 变量，观察它会形成「重测量 → 属性变化 → 再重测量」死循环。 */
    docMo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "class"]
    });

    /* 点击空白处收起；capture 阶段处理，避免与 trigger 的 click 抢顺序 */
    document.addEventListener("pointerdown", function (e) {
      if (!active) return;
      if (active.panel.contains(e.target) || active.host.contains(e.target)) return;
      active.close();
    }, true);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && active) active.close();
    });

    var raf = 0;
    function reposition() {
      if (!active) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () {
        if (!active) return;
        active.measure();
        active.place();
      });
    }
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", function () {
      instances.forEach(function (i) { i.measure(); });
      reposition();
    });

    /* 供排查 / 手动刷新用，不参与业务逻辑 */
    window.wbSelect = {
      refresh: function (root) { scan(root || document); flush(); },
      count: function () { return instances.length; }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
