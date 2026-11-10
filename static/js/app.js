/* global fetch, FormData, location, history */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const svg = (name, cls = "") =>
    `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  // ---------------------------------------------------------------------
  // 公式（LaTeX）
  // KaTeX 已本地化安装（static/vendor/katex），渲染完全离线可用。
  // 公式先摘出来占位再走 escapeHtml —— LaTeX 里的 & < > 不能被转义打坏。
  // 占位哨兵用私有区字符：用户文本里不会出现，也不受 escapeHtml 影响。
  // ---------------------------------------------------------------------
  const MATH_OPEN = "\uE002";
  const MATH_CLOSE = "\uE003";
  // 整行只有一个公式占位符（独占一行的块级公式）
  const MATH_SOLO_RE = new RegExp(`^${MATH_OPEN}(\\d+)${MATH_CLOSE}$`);

  // 把 Markdown 里的公式摘出来占位：
  //   块级 $$...$$：整段独占一行（或前后只有空白）
  //   行内 $...$：$ 两侧不能是空白、不能跨行
  // 这样正文里的「$100」「$200」不会被误当成公式。
  function extractMath(src) {
    const store = [];
    const put = (tex, display) => {
      store.push({ tex, display });
      return `${MATH_OPEN}${store.length - 1}${MATH_CLOSE}`;
    };
    // 独占一行的块级公式
    let text = src.replace(/^[ \t]*\$\$([\s\S]+?)\$\$[ \t]*$/gm, (m, tex) => put(tex.trim(), true));
    // 行内公式：内容里带中文的多半是金额（「$100 和 $200」），不当公式
    text = text.replace(/(^|[^\\$])\$([^\s$][^\n$]*?)\$/g, (m, pre, tex) => {
      if (/[\u4e00-\u9fa5]/.test(tex)) return m;
      return pre + put(tex, false);
    });
    // 剩下的 $$...$$（没独占行）也按块级处理
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => put(tex.trim(), true));
    return { text, store };
  }

  // 用 KaTeX 渲染公式。KaTeX 没就绪时退回成等宽源码 —— 宁可原样显示，也别把内容弄丢。
  function renderMath(tex, display) {
    const katex = window.katex;
    if (!katex || typeof katex.renderToString !== "function") {
      return `<code class="md-math-fallback">${escapeHtml(tex)}</code>`;
    }
    try {
      return katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,       // 公式写错时把原文标红，而不是整段渲染失败
        strict: "ignore",          // 容忍不严谨的写法
        trust: false,              // 不放行 \href / \includegraphics 之类的命令
        output: "htmlAndMathml",  // HTML + MathML，屏幕阅读器也能读
      });
    } catch (error) {
      return `<code class="md-math-fallback">${escapeHtml(tex)}</code>`;
    }
  }

  function restoreMath(html, store) {
    if (!store.length) return html;
    return html.replace(
      new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, "g"),
      (_, n) => {
        const item = store[Number(n)];
        return item ? renderMath(item.tex, item.display) : "";
      }
    );
  }

  // 轻量、安全的 Markdown 渲染：整段先 HTML 转义，再生成有限的安全标签，
  // 不解析原始 HTML，因此天然避免 XSS。支持标题、加粗、斜体、行内代码、代码块、
  // 有序/无序列表、引用、链接、分割线、换行，以及 LaTeX 公式。
  // inline 模式只渲染行内格式，用于紧凑场景。
  function renderMarkdown(md, opts = {}) {
    if (md == null) return "";
    const src = String(md).replace(/\r\n?/g, "\n");
    if (!src.trim()) return "";
    // 公式先摘出来占位，别让 escapeHtml 把 LaTeX 里的 & < > 打坏
    const math = extractMath(src);
    if (opts.inline) return restoreMath(mdInline(escapeHtml(math.text)), math.store);
    const lines = escapeHtml(math.text).split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const t = line.trim();
      // 整行只有一个块级公式：直接成块，别塞进 <p>（段落里放块级元素不合法）
      const solo = t.match(MATH_SOLO_RE);
      if (solo) {
        const item = math.store[Number(solo[1])];
        if (item && item.display) {
          out.push(renderMath(item.tex, true));
          i++;
          continue;
        }
      }
      if (t.startsWith("```")) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<pre class="md-pre"><code>${buf.join("\n")}</code></pre>`);
        continue;
      }
      const m = t.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const lv = m[1].length;
        out.push(`<h${lv} class="md-h md-h${lv}">${mdInline(m[2].trim())}</h${lv}>`);
        i++;
        continue;
      }
      if (/^([-*_])(\s*\1){2,}\s*$/.test(t)) { out.push(`<hr class="md-hr">`); i++; continue; }
      if (t.startsWith("&gt;")) {
        const buf = [];
        while (i < lines.length && lines[i].trim().startsWith("&gt;")) { buf.push(lines[i].trim().replace(/^&gt;\s?/, "")); i++; }
        out.push(`<blockquote class="md-quote">${mdInline(buf.join(" "))}</blockquote>`);
        continue;
      }
      if (/^[-*+]\s+/.test(t)) {
        const buf = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^[-*+]\s+/, "")); i++; }
        out.push(`<ul class="md-ul">${buf.map((x) => `<li>${mdInline(x)}</li>`).join("")}</ul>`);
        continue;
      }
      if (/^\d+\.\s+/.test(t)) {
        const buf = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^\d+\.\s+/, "")); i++; }
        out.push(`<ol class="md-ol">${buf.map((x) => `<li>${mdInline(x)}</li>`).join("")}</ol>`);
        continue;
      }
      const buf = [line];
      i++;
      while (
        i < lines.length && lines[i].trim() &&
        !/^(#{1,6}\s|&gt;|```|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
        !/^([-*_])(\s*\1){2,}\s*$/.test(lines[i].trim())
      ) {
        buf.push(lines[i]); i++;
      }
      out.push(`<p class="md-p">${mdInline(buf.join("<br>"))}</p>`);
    }
    return restoreMath(out.join("\n"), math.store);
  }
  function mdInline(text) {
    const codeStore = [];
    text = text.replace(/`([^`]+?)`/g, (_, c) => { codeStore.push(c); return `${codeStore.length - 1}`; });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_mm, label, url) => {
      const safe = safeMdUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });
    text = text.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
    text = text.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
    text = text.replace(/(\d+)/g, (_, n) => `<code>${codeStore[Number(n)]}</code>`);
    return text;
  }
  function safeMdUrl(url) {
    const u = url.trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^(mailto:|\/|#|\.{1,2}\/)/.test(u)) return u;
    return "";
  }

  // ---------------------------------------------------------------------
  // 解析输入框的 Markdown 预览
  // 识别出来的解析经常是 Markdown（**加粗**、- 列表、`代码`、小标题），
  // 光看一堆符号很难核对。输入框下面跟一块渲染后的样子，边写边看。
  // 只在「确实是 Markdown」时才出现 —— 普通文本下面挂一块空白反而添乱。
  // ---------------------------------------------------------------------
  function looksLikeMarkdown(text) {
    const s = String(text || "");
    if (!s.trim()) return false;
    // 公式也算 Markdown —— 判据与渲染时用的规则保持一致，别出现「渲染了却没预览」
    if (extractMath(s).store.length) return true;
    return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(s)          // 标题
      || /\*\*[^*\n]+\*\*/.test(s)                     // 加粗
      || /(^|\n)\s{0,3}[-*+]\s+\S/.test(s)             // 无序列表
      || /(^|\n)\s{0,3}\d+\.\s+\S/.test(s)             // 有序列表
      || /(^|\n)\s{0,3}>/.test(s)                      // 引用
      || /```/.test(s)                                 // 代码块
      || /`[^`\n]+`/.test(s)                           // 行内代码
      || /\[[^\]\n]+\]\([^)\s]+\)/.test(s)             // 链接
      || /(^|\n)\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s); // 分割线
  }

  // 预览容器：与 textarea 同处一个 .field 里，排在输入框下方
  function mdPreviewHtml() {
    return `<div class="md-preview" hidden><span class="md-preview-tag">预览</span><div class="md-preview-body md"></div></div>`;
  }

  // 按当前内容刷新预览：不是 Markdown 就整块收起来
  function syncMdPreview(textarea) {
    if (!textarea) return;
    const box = textarea.parentElement?.querySelector(".md-preview");
    if (!box) return;
    const body = box.querySelector(".md-preview-body");
    const text = textarea.value || "";
    if (!text.trim() || !looksLikeMarkdown(text)) {
      box.hidden = true;
      if (body) body.innerHTML = "";
      return;
    }
    box.hidden = false;
    if (body) body.innerHTML = renderMarkdown(text);
  }

  // 给解析框装上预览：先渲染一次（识别出的内容当场就能看到效果），之后随输入更新
  function attachMdPreview(textarea) {
    if (!textarea || textarea.dataset.mdPreview === "1") return;
    textarea.dataset.mdPreview = "1";
    let timer = null;
    textarea.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => syncMdPreview(textarea), 160);
    });
    syncMdPreview(textarea);
  }

  // ---------------------------------------------------------------------
  // 题目的「解析」按需展开
  // 设计意图：解析不是每题都有，也不该默认占版面。给有解析的题一个低调的
  // 书签式开关，点一下纸页就地翻开；本身没有解析的题，连按钮都不出现。
  // 多个列表共用这一套，展开逻辑统一走 document 级事件委托。
  // ---------------------------------------------------------------------
  function explanationText(item) {
    return String((item && item.explanation) || "").trim();
  }
  // 展开块靠 id 与按钮配对，key 里可能混进文件名等非标识符字符，先洗一遍
  function expDomId(key) {
    return "exp-" + String(key).replace(/[^\w-]/g, "");
  }
  function expToggleHtml(item, key) {
    if (!explanationText(item)) return "";
    const id = expDomId(key);
    return `<button type="button" class="q-exp-btn" data-exp-toggle="${id}" aria-expanded="false" aria-controls="${id}" title="查看解析">${svg("book")}<span class="q-exp-txt">解析</span>${svg("chevron", "q-exp-caret")}</button>`;
  }
  function expBlockHtml(item, key) {
    if (!explanationText(item)) return "";
    return `<div class="q-exp" id="${expDomId(key)}" hidden><div class="q-exp-inner md">${renderMarkdown(explanationText(item))}</div></div>`;
  }
  // 按钮与展开块一起输出，整段在「没有解析」时消失
  function expHtml(item, key) {
    if (!explanationText(item)) return "";
    return `<div class="q-exp-row">${expToggleHtml(item, key)}${expBlockHtml(item, key)}</div>`;
  }
  // 题库 / 错题本里的解析开关：做成与元信息并列的一枚文字式链接。
  // 之前那个带边框的小方块夹在答案行和元信息行中间，又大又突兀；
  // 现在视觉收进元信息行，触摸热区另用伪元素撑开，不占地方也好点。
  function expInlineBtnHtml(item, key) {
    if (!explanationText(item)) return "";
    const id = expDomId(key);
    return `<button type="button" class="q-exp-link" data-exp-toggle="${id}" aria-expanded="false" aria-controls="${id}" title="查看解析">${svg("book")}<span class="q-exp-txt">解析</span>${svg("chevron", "q-exp-caret")}</button>`;
  }
  function toggleExplanation(btn) {
    const id = btn.getAttribute("data-exp-toggle");
    const block = id ? document.getElementById(id) : null;
    if (!block) return;
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    btn.classList.toggle("is-open", !open);
    const label = btn.querySelector(".q-exp-txt");
    if (label) label.textContent = open ? "解析" : "收起";
    block.classList.remove("is-open");
    block.hidden = open;
    if (!open) {
      // 重新显示时重放一次进场动画
      void block.offsetWidth;
      block.classList.add("is-open");
      // 手机端题卡变高，展开的解析常常整块落在视口之外 ——
      // 点了却「什么都没看到」。把它滚到视口中央：底部 sticky 的分页条
      // 也不会压住内容（用 nearest 时刚好会被那条压住一截）。
      if (isPhoneLayout()) {
        requestAnimationFrame(() => {
          block.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      }
    }
    // 展开后题卡变高，标记出来，别让它污染列表行高自适应基准
    const row = block.closest(".question-row");
    if (row) row.classList.toggle("is-expanded", !open);
  }
  // 手机/平板：既看宽度也看触摸能力（鸿蒙浏览器横屏时宽度会大于 680）
  const isPhoneLayout = () => window.matchMedia("(max-width: 680px), (pointer: coarse)").matches;

  // ---------------------------------------------------------------------
  // 手机本地题库：电脑端「一键同步」发布快照，手机保存一份，随时可看可练
  // 只在局域网地址打开的页面上启用；电脑 127.0.0.1 完全走原来的在线逻辑
  // ---------------------------------------------------------------------
  const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
  const SYNC_ENABLED = !LOOPBACK.includes(location.hostname);
  const SYNC_KEY = "wrongbook.sync.bundle";
  const QUEUE_KEY = "wrongbook.sync.queue";
  // 最近一次实时读到的标签，单独存一份：离线时用它，而不是退回到旧的发布快照
  const TAG_KEY = "wrongbook.tags.cache";

  const sync = {
    bundle: null,
    version: 0,
    generatedAt: "",
    offline: false,
    serverOk: false,
    refreshing: false,
    probing: false,
    sessions: new Map(),
    timer: null,
    flushTimer: null,
    stream: null,
  };

  function lsGet(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function localStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function rawJson(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options });
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    return response.json();
  }

  // 手机离线时连不上电脑，原生 fetch 会一直等 TCP 超时（常达 20~30 秒）。
  // 同步类请求统一带短超时，失败立刻切「离线模式」，不再拖住界面。
  function fetchWithTimeout(path, options = {}, ms = 3000) {
    if (typeof AbortController === "undefined") return fetch(path, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(path, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function rawJsonTimed(path, options = {}, ms = 3000) {
    const response = await fetchWithTimeout(path, { cache: "no-store", ...options }, ms);
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    return response.json();
  }

  function markServerDown() {
    sync.offline = true;
    sync.serverOk = false;
    // 关掉 SSE，避免离线时浏览器不停重连占满连接池
    if (sync.stream) {
      try { sync.stream.close(); } catch (_error) { /* 已关闭 */ }
      sync.stream = null;
    }
    updateSyncBadge();
  }

  function noteServerUp() {
    sync.offline = false;
    sync.serverOk = true;
    updateSyncBadge();
    if (!sync.stream) startSyncStream();
  }

  // 轻量探测：离线时定期试一次，重新连上电脑就自动回传作答记录
  async function probeServer() {
    if (!SYNC_ENABLED || sync.probing) return;
    sync.probing = true;
    try {
      await fetchWithTimeout("/api/sync/manifest", { cache: "no-store" }, 1200);
      noteServerUp();
      syncNow(true);
      flushAttemptQueue();
    } catch (_error) {
      markServerDown();
    } finally {
      sync.probing = false;
    }
  }

  // 判题会改内存里的题目统计；合并成一次写入，避免每题都序列化整份快照
  let localPersistTimer = null;
  function scheduleLocalPersist() {
    if (localPersistTimer !== null) return;
    localPersistTimer = setTimeout(() => {
      localPersistTimer = null;
      if (sync.bundle) lsSet(SYNC_KEY, sync.bundle);
    }, 400);
  }

  function flushLocalPersist() {
    if (localPersistTimer !== null) {
      clearTimeout(localPersistTimer);
      localPersistTimer = null;
    }
    if (SYNC_ENABLED && sync.bundle) lsSet(SYNC_KEY, sync.bundle);
  }

  // 判题结果立即返回；只有确认服务器可达时才后台回传，离线时不做无效请求
  function flushAttemptQueueSoon() {
    if (!sync.serverOk) return;
    clearTimeout(sync.flushTimer);
    sync.flushTimer = setTimeout(() => flushAttemptQueue(), 300);
  }

  function syncQuestions() {
    return sync.bundle && Array.isArray(sync.bundle.questions) ? sync.bundle.questions : null;
  }

  function renderSyncMeta(info) {
    const meta = $("#syncMeta");
    if (!meta) return;
    const papers = sync.papers || 0;
    if (SYNC_ENABLED) {
      const count = syncQuestions() ? syncQuestions().length : 0;
      meta.textContent = count
        ? `本地已存 ${count} 道题${papers ? ` · ${papers} 份整卷` : ""}${sync.generatedAt ? ` · 同步于 ${sync.generatedAt}` : ""}；断开 Wi-Fi 也能查看和练习`
        : "还没有本地题库，连上电脑后点「立即更新本地题库」";
    } else {
      const data = info || {};
      const q = (data.counts && data.counts.questions) || 0;
      const p = (data.counts && data.counts.papers) || 0;
      meta.textContent = data.version
        ? `上次同步：${data.generated_at || "--"} · ${q} 道题${p ? ` · ${p} 份整卷` : ""}`
        : "还没有同步过；上传完题目后点上面的按钮";
    }
  }

  function updateSyncBadge() {
    const badge = $("#syncBadge");
    if (!badge) return;
    const count = syncQuestions() ? syncQuestions().length : 0;
    const papers = sync.papers || 0;
    const offline = sync.offline || !navigator.onLine;
    badge.classList.toggle("offline", offline);
    const scope = papers ? ` · ${papers} 卷` : "";
    badge.textContent = !count
      ? "等待同步"
      : offline
        ? `离线 · 本地 ${count} 题`
        : `已同步 ${count} 题${scope}`;
    badge.title = (sync.generatedAt ? `上次同步：${sync.generatedAt}` : "") + (papers ? ` · 整卷 ${papers} 份在电脑端` : "");
    renderSyncMeta();
  }

  function adoptBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.questions)) return;
    sync.bundle = bundle;
    sync.version = Number(bundle.version) || 0;
    sync.generatedAt = bundle.generated_at || "";
    sync.papers = (bundle.counts && bundle.counts.papers) || 0;
    // 冷启动从 localStorage 读缓存也走这里，不能因此判定「服务器可达」
    lsSet(SYNC_KEY, bundle);
    updateSyncBadge();
    // 快照换了，标签缓存也要重新校验（手机端在线时会读实时标签）
    invalidateTags(state.view === "library" || state.view === "practice");
    // 静默刷新只读视图，不打断正在进行的练习
    try {
      if (state.view === "library") loadLibrary();
      else if (state.view === "wrong") loadWrongBook();
      else if (state.view === "stats") loadStats();
      else if (state.view === "dashboard") loadDashboard();
    } catch (_error) {
      /* 视图还没初始化时忽略 */
    }
  }

  async function syncNow(force = false) {
    if (!SYNC_ENABLED || sync.refreshing) return;
    sync.refreshing = true;
    try {
      const local = sync.bundle || lsGet(SYNC_KEY);
      if (!sync.bundle && local) adoptBundle(local);
      const manifest = await rawJsonTimed("/api/sync/manifest", {}, 1500);
      noteServerUp();
      if (!force && local && Array.isArray(local.questions) && local.version === manifest.version) return;
      const bundle = await rawJsonTimed("/api/sync/bundle?live=1", {}, 6000);
      adoptBundle(bundle);
    } catch (_error) {
      if (!sync.bundle) {
        const cached = lsGet(SYNC_KEY);
        if (cached) adoptBundle(cached);
      }
      markServerDown();
    } finally {
      sync.refreshing = false;
      flushAttemptQueue();
    }
  }

  async function flushAttemptQueue() {
    if (!SYNC_ENABLED || !navigator.onLine || sync.offline || !sync.serverOk) return;
    const queue = lsGet(QUEUE_KEY, []);
    if (!queue.length) return;
    try {
      const result = await rawJsonTimed("/api/sync/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempts: queue }),
      }, 2500);
      if (result && result.ok) {
        lsSet(QUEUE_KEY, []);
        // 在线练习每题立即回传一条，别每题弹提示、每题拉一次全量快照
        if (queue.length > 1) {
          showToast(`已回传 ${result.accepted || queue.length} 条离线练习记录`, "success");
          syncNow(true);
        }
      }
    } catch (_error) {
      /* 服务器仍不可达，标记离线，下次探测成功再回传 */
      markServerDown();
    }
  }

  function scheduleSnapshotRefresh() {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => {
      // 离线时不要发起注定超时的同步请求，只把本地改动落盘
      if (sync.offline || !navigator.onLine) flushLocalPersist();
      else syncNow(true);
    }, 700);
  }

  function startSyncStream() {
    if (!SYNC_ENABLED || sync.offline || sync.stream || typeof EventSource === "undefined") return;
    try {
      const stream = new EventSource("/api/sync/stream");
      sync.stream = stream;
      stream.addEventListener("sync", () => {
        syncNow(true);
        invalidateTags(true);
        showToast("电脑端已同步最新题库", "success");
      });
      stream.onmessage = (event) => {
        try {
          if (JSON.parse(event.data).type === "hello") syncNow(false);
        } catch (_error) {
          /* 忽略心跳 */
        }
      };
    } catch (_error) {
      /* EventSource 不可用时退化为定时检查 */
    }
  }

  async function loadSyncMeta() {
    try {
      renderSyncMeta(await rawJson("/api/sync/manifest"));
    } catch (_error) {
      renderSyncMeta();
    }
  }

  // --- 本地快照：复刻服务端的题库筛选 / 排序 / 分页 -------------------
  function offlineQuestions(search) {
    const all = syncQuestions();
    if (!all) return undefined;
    const p = new URLSearchParams(search || "");
    const keyword = (p.get("q") || "").trim().toLowerCase();
    const qtype = p.get("type") || "";
    const tag = p.get("tag") || "";
    const status = p.get("status") || "";
    const sort = p.get("sort") || "recent";
    // 与服务端 /api/questions 的 scope 保持一致：默认只搜题干 / 编号 / 标签
    const scope = p.get("scope") || "stem";
    const page = Math.max(1, parseInt(p.get("page"), 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(p.get("per_page"), 10) || 12));
    let items = all.filter((item) => {
      if (keyword) {
        const hay = [
          item.stem, item.qno, (item.tags || []).join(" "),
          ...(scope === "all" ? [item.explanation, item.source_text, JSON.stringify(item.options || {})] : []),
        ].join(" ").toLowerCase();
        if (!hay.includes(keyword)) return false;
      }
      if (["single", "multiple", "truefalse", "fill"].includes(qtype) && item.qtype !== qtype) return false;
      if (tag && !(item.tags || []).includes(tag)) return false;
      if (status === "wrong" && !(item.wrong_count > 0 && item.mastery < 3)) return false;
      if (status === "mastered" && !(item.mastery >= 3)) return false;
      if (status === "new" && !(item.wrong_count === 0 && item.correct_count === 0)) return false;
      if (status === "ready" && !item.answer) return false;
      return true;
    });
    const comparators = {
      recent: (a, b) => b.id - a.id,
      oldest: (a, b) => a.id - b.id,
      wrong: (a, b) => (b.wrong_count - a.wrong_count) || (a.mastery - b.mastery) || (b.id - a.id),
      mastery: (a, b) => (a.mastery - b.mastery) || (b.wrong_count - a.wrong_count) || (b.id - a.id),
    };
    items.sort(comparators[sort] || comparators.recent);
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, pages);
    return {
      items: items.slice((safePage - 1) * perPage, safePage * perPage),
      total, page: safePage, per_page: perPage, pages,
    };
  }

  function offlineGet(path) {
    const bundle = sync.bundle;
    if (!bundle) return undefined;
    let url;
    try {
      url = new URL(path, location.origin);
    } catch (_error) {
      return undefined;
    }
    const name = url.pathname;
    if (name === "/api/overview") return bundle.overview;
    if (name === "/api/stats") return bundle.stats;
    if (name === "/api/tags") return bundle.tags;
    if (name === "/api/questions") return offlineQuestions(url.search);
    const match = name.match(/^\/api\/questions\/(\d+)$/);
    // 服务端返回 { item: 题目 }，本地快照也要包一层，否则编辑器会误判为「手动添加」
    if (match) {
      const found = bundle.questions.find((item) => item.id === Number(match[1]));
      if (found) return { item: found };
    }
    return undefined;
  }

  // --- 离线练习：本地判分 + 记录队列，联网后自动回传 -------------------
  const offLetters = (value) =>
    Array.from(new Set(String(value || "").toUpperCase().match(/[A-H]/g) || [])).sort().join("");

  function offTf(raw, options) {
    let text = String(raw || "").trim();
    const upper = text.toUpperCase();
    if (options && options[upper] && ["正确", "错误"].includes(String(options[upper]).trim())) {
      text = String(options[upper]).trim();
    }
    const n = text.toLowerCase();
    if (["对", "正确", "true", "t", "√", "1", "yes"].includes(n)) return "正确";
    if (["错", "错误", "false", "f", "×", "0", "no"].includes(n)) return "错误";
    if (n === "a") return "正确";
    if (n === "b") return "错误";
    return "";
  }

  function offNormalizeUser(qtype, options, raw) {
    let text = Array.isArray(raw) ? raw.join("") : String(raw == null ? "" : raw).trim();
    if (!text) return "";
    if (qtype === "fill") return text.slice(0, 1000);
    if (qtype === "truefalse") return offTf(text, options) || text;
    let letters = offLetters(text);
    if (!letters) {
      for (const [letter, content] of Object.entries(options || {})) {
        if (text === String(content).trim()) { letters = letter; break; }
      }
    }
    if (qtype === "single") return (letters || text).slice(0, 1).toUpperCase();
    return offLetters(letters || text) || text.toUpperCase();
  }

  const offFillNorm = (value) => String(value || "").trim().toLowerCase()
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/\s+/g, "")
    .replace(/^[。．.，,；;：:、!！?？"'“”‘’]+|[。．.，,；;：:、!！?？"'“”‘’]+$/g, "");

  function offGrade(qtype, options, correctRaw, userRaw) {
    const correct = String(correctRaw || "").trim();
    const user = String(userRaw || "").trim();
    if (!correct || !user) return [false, correct];
    if (qtype === "truefalse") {
      const c = offTf(correct, options);
      return [Boolean(c) && c === offTf(user, options), c || correct];
    }
    if (qtype === "fill") {
      const parts = correct.split(/\|\||｜｜/).filter((part) => offFillNorm(part));
      const alternatives = parts.length > 1 ? parts : correct.includes("|") ? correct.split("|").filter(Boolean) : [correct];
      return [alternatives.some((part) => offFillNorm(part) === offFillNorm(user)), correct];
    }
    let cl = offLetters(correct);
    let ul = offLetters(user);
    if (!cl) {
      for (const [letter, content] of Object.entries(options || {})) {
        if (correct === String(content).trim()) { cl = letter; break; }
      }
    }
    if (!ul) {
      for (const [letter, content] of Object.entries(options || {})) {
        if (user === String(content).trim()) { ul = letter; break; }
      }
    }
    if (!cl) return [false, correct];
    if (qtype === "single") return [cl[0] === ul[0], cl[0]];
    return [cl === ul, cl];
  }

  function offPublic(item) {
    const copy = { ...item };
    delete copy.answer;
    delete copy.explanation;
    delete copy.source_text;
    delete copy.note;
    return copy;
  }

  function offlinePractice(path, init) {
    const payload = (() => {
      try { return JSON.parse(init.body || "{}"); } catch (_error) { return {}; }
    })();
    if (path.indexOf("/api/practice/start") === 0) {
      const all = syncQuestions();
      if (!all) return undefined;
      const mode = payload.mode || "random";
      const count = Math.min(100, Math.max(1, Number(payload.count) || 10));
      let pool = all.filter((item) => item.answer);
      if (mode === "wrong") pool = pool.filter((item) => item.wrong_count > 0 && item.mastery < 3);
      else if (mode === "unseen") pool = pool.filter((item) => !item.wrong_count && !item.correct_count);
      else if (mode === "tag") pool = pool.filter((item) => (item.tags || []).includes(payload.tag));
      else if (mode === "custom") {
        const order = new Map((payload.question_ids || []).map((id, i) => [Number(id), i]));
        pool = pool.filter((item) => order.has(item.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
      }
      if (mode !== "custom") {
        // Fisher–Yates 线性洗牌：比 sort(() => Math.random() - .5) 更快也更均匀
        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        pool = shuffled;
      }
      const chosen = pool.slice(0, count);
      if (!chosen.length) throw new Error("本地题库里没有符合条件的题目，请先同步新题");
      const sid = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sync.sessions.set(sid, { mode, ids: chosen.map((item) => item.id), results: {}, started: Date.now() });
      return { session_id: sid, mode, total: chosen.length, questions: chosen.map(offPublic) };
    }
    if (path.indexOf("/api/practice/answer") === 0) {
      const all = syncQuestions();
      if (!all) return undefined;
      const session = sync.sessions.get(payload.session_id);
      if (!session) throw new Error("离线练习会话已失效，请重新开始");
      if (session.results[payload.question_id]) {
        return { ...session.results[payload.question_id], duplicate: true };
      }
      const item = all.find((q) => q.id === Number(payload.question_id));
      if (!item) throw new Error("本地题库中找不到这道题");
      const options = item.options || {};
      const userAnswer = offNormalizeUser(item.qtype, options, payload.answer);
      const [correct, correctAnswer] = offGrade(item.qtype, options, item.answer, userAnswer);
      if (correct) {
        item.streak = (item.streak || 0) + 1;
        item.correct_count = (item.correct_count || 0) + 1;
        item.mastery = item.streak >= 3 ? 3 : Math.max(2, item.mastery || 0);
      } else {
        item.wrong_count = (item.wrong_count || 0) + 1;
        item.streak = 0;
        item.mastery = 1;
      }
      const result = {
        question_id: item.id, is_correct: correct, user_answer: userAnswer,
        correct_answer: correctAnswer, explanation: item.explanation || "",
        mastery: item.mastery, streak: item.streak,
        wrong_count: item.wrong_count, correct_count: item.correct_count, duplicate: false,
      };
      session.results[item.id] = result;
      const queue = lsGet(QUEUE_KEY, []);
      queue.push({
        client_key: `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        question_id: item.id, user_answer: userAnswer, correct_answer: correctAnswer,
        is_correct: correct ? 1 : 0, mode: session.mode,
        duration_ms: Number(payload.duration_ms) || 0, created_at: localStamp(),
      });
      lsSet(QUEUE_KEY, queue);
      scheduleLocalPersist();
      return result;
    }
    if (path.indexOf("/api/practice/finish") === 0) {
      const session = sync.sessions.get(payload.session_id);
      if (!session) throw new Error("离线练习会话已失效");
      const results = Object.values(session.results);
      const byId = new Map((syncQuestions() || []).map((item) => [item.id, item]));
      const details = results.map((result) => {
        const item = byId.get(result.question_id) || {};
        return {
          ...result, stem: item.stem || "", qno: item.qno || "", qtype: item.qtype || "",
          options: item.options || {}, tags: item.tags || [],
        };
      });
      const correct = results.filter((item) => item.is_correct).length;
      return {
        total: session.ids.length, answered: results.length, correct,
        accuracy: results.length ? Math.round((correct / results.length) * 100) : 0,
        elapsed: Math.round((Date.now() - session.started) / 1000),
        details, wrong_ids: results.filter((item) => !item.is_correct).map((item) => item.question_id),
      };
    }
    return undefined;
  }

  async function offlineFallback(path, init) {
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET") return offlineGet(path);
    if (path.indexOf("/api/practice/") === 0) return offlinePractice(path, init);
    return undefined;
  }

  function bindSyncUi() {
    const button = $("#syncAction");
    if (!button) return;
    button.innerHTML = SYNC_ENABLED
      ? `${svg("refresh")}立即更新本地题库`
      : `${svg("refresh")}一键同步到手机`;
    button.addEventListener("click", async () => {
      const label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>${SYNC_ENABLED ? "正在更新..." : "正在同步..."}`;
      try {
        if (SYNC_ENABLED) {
          await syncNow(true);
          showToast(`本地题库已更新（${syncQuestions() ? syncQuestions().length : 0} 题）`, "success");
        } else {
          const info = await api("/api/sync/publish", { method: "POST", body: {} });
          const counts = info.counts || {};
          showToast(`已同步 ${counts.questions || 0} 道题到手机（错题 ${counts.wrong || 0}）`, "success");
          renderSyncMeta(info);
        }
      } catch (error) {
        showToast(error.message || "同步失败", "error");
      } finally {
        button.disabled = false;
        button.innerHTML = label;
      }
    });
    if (!SYNC_ENABLED) loadSyncMeta();
  }

  function initSync() {
    bindSyncUi();
    if (!SYNC_ENABLED) return;
    document.body.classList.add("sync-phone");
    const cached = lsGet(SYNC_KEY);
    if (cached) adoptBundle(cached);
    updateSyncBadge();
    syncNow(false);
    startSyncStream();
    window.addEventListener("online", () => {
      // 手机「online」只代表有网络，不代表电脑上的服务可达，先探测再恢复
      probeServer();
    });
    window.addEventListener("offline", markServerDown);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushLocalPersist();
      else { syncNow(false); flushAttemptQueue(); }
    });
    window.addEventListener("pagehide", flushLocalPersist);
    // 离线时轻量探测恢复；在线时照常检查题库版本
    setInterval(() => {
      if (document.hidden) return;
      if (sync.offline) probeServer();
      else syncNow(false);
    }, 15000);
  }

  // 把 OCR 识别出来的多行文本合并成一段连续文字。
  // 中文之间直接相连；中西文交界处补一个空格；编号列表项之间也补空格，
  // 避免 "1. 数据" 和 "2. 存储" 被粘成 "1. 数据2. 存储"。
  const CJK_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
  const LATIN_CHAR = /[A-Za-z0-9]/;
  const LIST_START = /^(\d+[.、．)）]|[A-Za-z][.、．)）]|[①-⑳]|[（(【\[]|[•▪◆※·])/;
  const LIST_END = /(\d+[.、．)）]|[A-Za-z][.、．)）]|[①-⑳]|[（(【\[]|[•▪◆※])$/;
  function mergeLines(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return "";
    let out = lines[0];
    for (let i = 1; i < lines.length; i += 1) {
      const prevLine = lines[i - 1];
      const cur = lines[i];
      const prevChar = out.charAt(out.length - 1);
      const curChar = cur.charAt(0);
      const needsSpace =
        LIST_START.test(cur) ||
        LIST_END.test(prevLine) ||
        (LATIN_CHAR.test(prevChar) && LATIN_CHAR.test(curChar)) ||
        (CJK_CHAR.test(prevChar) && LATIN_CHAR.test(curChar)) ||
        (LATIN_CHAR.test(prevChar) && CJK_CHAR.test(curChar));
      out += (needsSpace ? " " : "") + cur;
    }
    return out;
  }

  const TYPE_LABELS = { single: "单选题", multiple: "多选题", truefalse: "判断题", fill: "填空题" };
  const TYPE_MARKS = { single: "单", multiple: "多", truefalse: "判", fill: "填" };
  const MASTERY_LABELS = { 0: "未练习", 1: "待攻克", 2: "巩固中", 3: "已掌握" };

  const VIEW_META = {
    dashboard: { title: "概览", subtitle: "把每一道错题，都变成下一次的分数。" },
    capture: { title: "图片识题", subtitle: "上传截图或手机拍照，自动识别题目，校对后收进题库。" },
    codepaper: { title: "整卷入库", subtitle: "录入卷子与答案封存进卷库，随时整卷开考；有空错整卷成组进错题本。" },
    library: { title: "我的题库", subtitle: "所有采集的题目都在这里，可随时编辑和筛选。" },
    practice: { title: "开始练习", subtitle: "自动判分，即时解析，把不会的题练到会。" },
    wrong: { title: "错题本", subtitle: "集中攻克薄弱题，连续答对 3 次自动掌握。" },
    stats: { title: "学习统计", subtitle: "用数据看见自己的进步。" },
    codeHistory: { title: "整卷历史", subtitle: "所有整卷刷题与考试记录，随时回看复习。" },
    guide: { title: "使用手册", subtitle: "单题五步、整卷录入到开考，按菜单从头走一遍。" },
    settings: { title: "设置", subtitle: "本地数据、识别引擎与手机同步。" },
    dev: { title: "系统架构", subtitle: "面向开发人员的模块分工、两条流水线与接口说明。" },
  };

  const state = {
    view: "dashboard",
    overview: null,
    tags: [],
    capture: {
      queue: [],
      previewUrls: [],
      drafts: [],
      results: [],
      duplicates: [],
      busy: false,
      mobile: { available: false, url: "", pending: 0 },
    },
    library: {
      page: 1,
      perPage: 10,
      perPageMode: "auto",
      q: "",
      scope: "stem",
      type: "",
      status: "",
      tags: [],
      sort: "recent",
      total: 0,
      pages: 1,
      items: [],
      rowHeight: 0,
      tried: new Set(),
      fitDepth: 0,
    },
    practice: {
      // 首屏默认选错题重练；若系统里没有待攻克的错题，
      // 概览数据到达后会自动切到随机练习（见 applyPracticeModeAvailability）
      mode: "wrong",
      // 用户手动点过模式卡片后就不再自动切换（避免把已选模式抢走）
      modePinned: false,
      count: 10,
      tag: "",
      session: null,
      index: 0,
      answers: {},
      submitted: false,
      selected: [],
      timer: null,
      startedAt: 0,
      questionStartedAt: 0,
    },
    wrong: { items: [], sort: "wrong", tab: "single" },
    settings: null,
  };

  let searchTimer = null;
  let ocrProgressTimer = null;
  let modalResolve = null;
  let modalOnClose = null;

  // ---------------------------------------------------------------------
  // 标签缓存
  // 下拉里的「全部标签 / 练习标签」不是每次都全量重查：服务端给标签内容算出
  // 一个 revision 指纹，前端只在指纹变化时重新拉全量。任何会改动题库的写操作、
  // 手机端快照更新、切页面、回到前台、定时轮询都会强制校验一次（绕过节流和
  // 离线短路），因此「出现新标签」时缓存会被自动重置，界面上不需要刷新按钮。
  // ---------------------------------------------------------------------
  const tagCache = {
    revision: "",
    items: null,
    pending: null,
    dirty: true,
    source: "",
    updatedAt: "",
    lastCheck: 0,
  };

  function invalidateTags(refresh = false) {
    tagCache.dirty = true;
    // force 会绕过 5 秒节流与「已离线」短路，保证切回页面时一定能校验到最新指纹
    if (refresh && !document.hidden) loadTags(true);
  }

  function renderTags(items) {
    const list = Array.isArray(items) ? items : [];
    state.tags = list;
    const options = list
      .map((tag) => `<option value="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}（${tag.count}）</option>`)
      .join("");
    const practiceTag = $("#practiceTag");
    if (practiceTag) {
      const currentPractice = practiceTag.value;
      practiceTag.innerHTML = `<option value="">请选择标签</option>` + options;
      if (list.some((tag) => tag.name === currentPractice)) practiceTag.value = currentPractice;
    }
    const live = tagCache.source === "live";
    renderTagFilterOptions();
    syncTagFilterUI(live, list.length);
  }

  // ---- 题库筛选：标签多选 + 模糊搜索 ------------------------------------
  // 命中规则：所选标签之间是「或」关系 —— 题目只要带任一所选标签即算命中。
  function fuzzyTagMatch(query, name) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return true;
    const n = (name || "").toLowerCase();
    if (n.includes(q)) return true;
    // 子序列匹配：容忍漏字 / 跳字（例如「概率」匹配「概 率」「高概率」）
    let i = 0;
    for (const ch of n) {
      if (ch === q[i]) i++;
      if (i === q.length) return true;
    }
    return false;
  }

  function highlightTag(name, query) {
    const q = (query || "").trim();
    if (!q) return escapeHtml(name);
    const lower = name.toLowerCase();
    const ql = q.toLowerCase();
    const idx = lower.indexOf(ql);
    if (idx === -1) return escapeHtml(name);
    return (
      escapeHtml(name.slice(0, idx)) +
      `<mark class="tms-hl">${escapeHtml(name.slice(idx, idx + q.length))}</mark>` +
      escapeHtml(name.slice(idx + q.length))
    );
  }

  function renderTagFilterOptions() {
    const list = $("#libTagList");
    if (!list) return;
    const query = ($("#libTagSearch") && $("#libTagSearch").value) || "";
    const selected = state.library.tags;
    const matched = (state.tags || []).filter((tag) => fuzzyTagMatch(query, tag.name));
    if (!matched.length) {
      list.innerHTML = `<div class="tms-empty">没有匹配的标签</div>`;
      return;
    }
    list.innerHTML = matched
      .map((tag) => {
        const on = selected.includes(tag.name);
        return `<div class="tms-option ${on ? "on" : ""}" role="option" aria-selected="${on}" data-tag="${escapeHtml(tag.name)}" tabindex="0">
            <span class="tms-check" aria-hidden="true">${on ? svg("check") : ""}</span>
            <span class="tms-name">${highlightTag(tag.name, query)}</span>
            <span class="tms-count-num">${tag.count}</span>
          </div>`;
      })
      .join("");
  }

  function syncTagFilterUI(live, total) {
    const label = $("#libTagLabel");
    const badge = $("#libTagBadge");
    const chips = $("#libTagChips");
    const info = $("#libTagInfo");
    const trigger = $("#libTagTrigger");
    const selected = state.library.tags;
    const n = selected.length;
    if (label) {
      label.textContent = n ? (n === 1 ? selected[0] : `已选 ${n} 个标签`) : "全部标签";
    }
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
    if (trigger) {
      trigger.title = n
        ? `已筛选标签：${selected.join("、")}`
        : live
          ? "标签来自题库实时统计 · 新增或修改后会自动更新"
          : "标签来自上次联网结果 · 联网后自动更新";
      trigger.classList.toggle("has-filter", n > 0);
    }
    if (chips) {
      if (n) {
        chips.hidden = false;
        chips.innerHTML = selected
          .map((name) => `<button type="button" class="tms-chip" data-chip="${escapeHtml(name)}">${escapeHtml(name)}<svg aria-hidden="true"><use href="#i-close"></use></svg></button>`)
          .join("");
      } else {
        chips.hidden = true;
        chips.innerHTML = "";
      }
    }
    if (info) {
      info.textContent = total != null ? `共 ${total} 个标签 · 已选 ${n} 个` : `已选 ${n} 个`;
    }
    updateLibFilterCount();
  }

  let tagSheetCloseTimer = null;
  let tagSheetOnEnd = null;

  function isSheetMode() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 680px)").matches);
  }

  // 桌面端：面板是 fixed，按触发按钮实时算坐标，绕开 .library-toolbar 的滚动容器。
  // 同时限制最大高度，避免小窗口下面板底部超出视口。
  function placeTagPanel() {
    const panel = $("#libTagPanel");
    const trigger = $("#libTagTrigger");
    if (!panel || !trigger || panel.hidden) return;
    // 窗口缩到手机宽度时还原成 CSS 底部抽屉，清掉桌面定位留下的内联坐标
    if (isSheetMode()) {
      ["top", "left", "right", "bottom", "width", "maxHeight"].forEach((k) => panel.style.removeProperty(k));
      return;
    }
    const r = trigger.getBoundingClientRect();
    const width = Math.min(320, Math.max(240, Math.round(panel.getBoundingClientRect().width || 280)));
    const top = r.bottom + 6;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    panel.style.top = top + "px";
    panel.style.left = left + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = width + "px";
    panel.style.maxHeight = Math.max(180, window.innerHeight - top - 10) + "px";
  }

  function setTagFilterOpen(open) {
    const panel = $("#libTagPanel");
    const trigger = $("#libTagTrigger");
    const backdrop = $("#libTagBackdrop");
    if (!panel || !trigger) return;
    // 取消上一次关闭的待执行动作，避免快速切换时互相打架
    if (tagSheetCloseTimer) { clearTimeout(tagSheetCloseTimer); tagSheetCloseTimer = null; }
    if (tagSheetOnEnd) { panel.removeEventListener("transitionend", tagSheetOnEnd); tagSheetOnEnd = null; }
    if (open) {
      renderTagFilterOptions();
      panel.hidden = false;
      if (backdrop) backdrop.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.classList.add("open");
      if (isSheetMode()) {
        document.body.classList.add("tag-sheet-open");
        // 强制回流：先让起始 translateY(101%) 落地，下一帧再加 .open 触发上滑过渡
        void panel.offsetHeight;
        requestAnimationFrame(() => {
          panel.classList.add("open");
          if (backdrop) backdrop.classList.add("show");
        });
      } else {
        panel.classList.add("open");
        if (backdrop) backdrop.classList.add("show");
      }
      const search = $("#libTagSearch");
      if (search) search.focus();
      // 桌面端按触发按钮定位浮层；手机端由 CSS bottom sheet 接管，清掉内联坐标
      if (isSheetMode()) {
        ["top", "left", "right", "bottom", "width", "maxHeight"].forEach((k) => panel.style.removeProperty(k));
      } else {
        placeTagPanel();
      }
    } else {
      trigger.setAttribute("aria-expanded", "false");
      trigger.classList.remove("open");
      panel.classList.remove("open");
      if (backdrop) backdrop.classList.remove("show");
      document.body.classList.remove("tag-sheet-open");
      const finish = () => {
        panel.hidden = true;
        if (backdrop) backdrop.hidden = true;
        tagSheetCloseTimer = null;
        tagSheetOnEnd = null;
      };
      if (isSheetMode()) {
        // 等上滑过渡结束再真正隐藏；过渡事件未触发时由定时器兜底
        tagSheetOnEnd = (e) => { if (e && e.propertyName && e.propertyName !== "transform") return; finish(); };
        panel.addEventListener("transitionend", tagSheetOnEnd);
        tagSheetCloseTimer = setTimeout(finish, 400);
      } else {
        finish();
      }
    }
  }

  function toggleTagFilter() {
    const panel = $("#libTagPanel");
    setTagFilterOpen(panel ? panel.hidden : true);
  }

  function toggleTagSelection(name) {
    if (!name) return;
    const selected = state.library.tags;
    const at = selected.indexOf(name);
    if (at === -1) selected.push(name);
    else selected.splice(at, 1);
    renderTagFilterOptions();
    syncTagFilterUI();
    state.library.page = 1;
    loadLibrary();
  }

  function clearTagFilter() {
    state.library.tags = [];
    const search = $("#libTagSearch");
    if (search) search.value = "";
    renderTagFilterOptions();
    syncTagFilterUI();
    state.library.page = 1;
    loadLibrary();
  }

  let tagFilterBound = false;
  function bindTagFilter() {
    if (tagFilterBound) return;
    tagFilterBound = true;
    const trigger = $("#libTagTrigger");
    const panel = $("#libTagPanel");
    const search = $("#libTagSearch");
    // 浮层挂到 body：.library-toolbar 的 overflow-x:auto 会裁掉绝对定位面板，
    // .page 的切页动画含 transform，会让 fixed 相对页面定位而偏移。
    const backdrop = $("#libTagBackdrop");
    if (panel && panel.parentNode !== document.body) document.body.appendChild(panel);
    if (backdrop && backdrop.parentNode !== document.body) document.body.appendChild(backdrop);
    const list = $("#libTagList");
    const chips = $("#libTagChips");
    const clearBtn = $("#libTagClear");
    if (!trigger || !panel) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTagFilter();
    });
    if (search) search.addEventListener("input", () => renderTagFilterOptions());
    if (list) {
      list.addEventListener("click", (e) => {
        const opt = e.target.closest(".tms-option");
        if (opt) toggleTagSelection(opt.dataset.tag);
      });
      list.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          const opt = e.target.closest(".tms-option");
          if (opt) {
            e.preventDefault();
            toggleTagSelection(opt.dataset.tag);
          }
        }
      });
    }
    if (chips) {
      chips.addEventListener("click", (e) => {
        const chip = e.target.closest(".tms-chip");
        if (chip) toggleTagSelection(chip.dataset.chip);
      });
    }
    if (clearBtn) clearBtn.addEventListener("click", clearTagFilter);
    const closeBtn = $("#libTagClose");
    if (closeBtn) closeBtn.addEventListener("click", () => setTagFilterOpen(false));
    const doneBtn = $("#libTagDone");
    if (doneBtn) doneBtn.addEventListener("click", () => setTagFilterOpen(false));
    // 点击面板内部不关闭；点击外部（含触发按钮之外的区域）关闭
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", (e) => {
      if (panel.hidden) return;
      if (!panel.contains(e.target) && !trigger.contains(e.target)) setTagFilterOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) setTagFilterOpen(false);
    });
    // 视口变化时保持浮层贴着触发按钮（捕获阶段覆盖列表等内部滚动）
    window.addEventListener("resize", placeTagPanel);
    window.addEventListener("scroll", placeTagPanel, true);
  }

  function localTagItems() {
    const cached = lsGet(TAG_KEY);
    if (cached && Array.isArray(cached.items)) return cached.items;
    if (!SYNC_ENABLED) return null;
    // 从未联网成功过才退回手机同步快照（可能是上次「一键同步」时的旧标签）
    const local = sync.bundle || lsGet(SYNC_KEY);
    const items = local && local.tags && local.tags.items;
    return Array.isArray(items) ? items : null;
  }

  async function fetchTags(force = false) {
    // 手机端已确认离线且缓存可用：直接用缓存，不发注定失败的请求。
    // force（切页 / 回到前台 / 写完题目 / 定时校验）会强行试一次，服务器恢复后立即补上最新标签
    if (SYNC_ENABLED && sync.offline && tagCache.items && !force) {
      tagCache.source = "snapshot";
      renderTags(tagCache.items);
      return;
    }
    // 冷启动先拿本地快照即时填好下拉，联网成功后再换成实时数据
    if (!tagCache.items) {
      const local = localTagItems();
      if (local) {
        tagCache.items = local;
        tagCache.source = "snapshot";
        renderTags(local);
      }
    }
    // 5 秒内的重复调用直接命中缓存，避免刷出一串相同请求；force 例外
    if (!force && !tagCache.dirty && tagCache.revision && Date.now() - tagCache.lastCheck < 5000) {
      if (tagCache.items) renderTags(tagCache.items);
      return;
    }
    const since = tagCache.revision ? `?since=${encodeURIComponent(tagCache.revision)}` : "";
    try {
      const data = await api(`/api/tags${since}`, { bypassOffline: true, cache: "no-store" });
      tagCache.lastCheck = Date.now();
      if (data && data.revision) {
        // 服务端响应：指纹没变就继续用缓存，变了才拿新的 items
        tagCache.revision = data.revision;
        tagCache.dirty = false;
        if (!data.unchanged && Array.isArray(data.items)) {
          tagCache.items = data.items;
          tagCache.updatedAt = localStamp();
        }
        tagCache.source = "live";
        if (tagCache.items) {
          // 记下最近一次实时结果，断网 / 电脑关机时下拉仍显示这份，而不是旧快照
          lsSet(TAG_KEY, { items: tagCache.items, revision: tagCache.revision, savedAt: localStamp() });
          renderTags(tagCache.items);
        }
      } else if (Array.isArray(data && data.items) && !tagCache.items) {
        // 离线兜底返回的是本地快照，只在完全没有缓存时采用
        tagCache.items = data.items;
        tagCache.source = "snapshot";
        renderTags(tagCache.items);
      }
    } catch (_error) {
      const local = localTagItems();
      if (!tagCache.items && local) tagCache.items = local;
      tagCache.source = "snapshot";
      renderTags(tagCache.items || []);
    }
  }

  // force=true：忽略节流与离线短路，立即按 revision 向服务端校验一次。
  // revision 是标签「名称 + 计数」的内容指纹，内容变了服务端才会回全量，
  // 因此既能保证始终最新，又没有手动刷新按钮的负担。
  function loadTags(force = false) {
    if (force) tagCache.lastCheck = 0;
    if (tagCache.pending) {
      return force ? tagCache.pending.then(() => loadTags(true)) : tagCache.pending;
    }
    tagCache.pending = fetchTags(force).finally(() => { tagCache.pending = null; });
    return tagCache.pending;
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  async function api(path, options = {}) {
    const init = { ...options };
    // bypassOffline：标签校验要在手机端「在线」时读实时接口，而不是本地快照
    const bypassOffline = init.bypassOffline === true;
    delete init.bypassOffline;
    if (init.body && !(init.body instanceof FormData)) {
      init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
      init.body = JSON.stringify(init.body);
    }
    const isRead = !init.method || init.method.toUpperCase() === "GET";
    // 手机端只读请求直接读本地快照：电脑关机 / 不在同一 Wi-Fi 也能看题
    if (SYNC_ENABLED && isRead && !bypassOffline) {
      const local = offlineGet(path);
      if (local !== undefined) return local;
    }
    const isPractice = path.indexOf("/api/practice/") === 0;
    const isLlm = path.indexOf("/api/llm/") === 0;
    // 识别类接口（含题库原图重新识别）都要跑 OCR，冷启动常超 20s，同样放宽；
    // 大模型重新识别还要再等模型返回，手机端尤其不能按普通请求超时
    const isRecognize = path.indexOf("/recognize") !== -1 || path.indexOf("/rerecognize") !== -1;
    // 练习出题 / 判题 / 结算一律在本地完成：离线不用等 TCP 超时，在线也不用等服务器往返。
    // 作答记录进本地队列，联网后幂等回传，因此不存在服务器与本地双写。
    if (SYNC_ENABLED && isPractice) {
      const local = offlinePractice(path, init);
      if (local !== undefined) {
        if (path.indexOf("/api/practice/answer") === 0) flushAttemptQueueSoon();
        return local;
      }
    }
    // 已确认离线：未被本地快照覆盖的只读请求立即返回，不发注定失败的连接
    if (SYNC_ENABLED && sync.offline && isRead) {
      const offlineError = new Error("当前是离线模式，连接电脑后可继续使用在线功能");
      offlineError.offline = true; // 设置页等只读视图不该为此弹红色错误提示
      throw offlineError;
    }
    let response;
    try {
      // 桌面端保持原行为；手机端普通请求加超时（FormData 可能是 OCR 上传，不设限）
      const timed = SYNC_ENABLED && !(init.body instanceof FormData);
      // 大模型解析要传图片 + 长提示，免费模型冷启动常超 20s，单独放宽到 90s 避免误报超时
      // 标签校验要足够轻：手机离线时也别让启动卡在 6 秒超时上
      const timeout = isPractice ? 2500 : isRead ? (path.indexOf("/api/tags") === 0 ? 2500 : 6000) : isLlm ? 90000 : isRecognize ? 120000 : 20000;
      response = timed
        ? await fetchWithTimeout(path, init, timeout)
        : await fetch(path, init);
    } catch (error) {
      const fallback = SYNC_ENABLED ? await offlineFallback(path, init) : undefined;
      if (fallback !== undefined) {
        markServerDown();
        return fallback;
      }
      if (SYNC_ENABLED) markServerDown();
      if (error && error.name === "AbortError") {
        throw new Error("连接电脑超时，已切换为离线模式");
      }
      throw error;
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      data = { error: text || "服务器返回异常" };
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || `请求失败（${response.status}）`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    // 手机端写操作成功后刷新本地快照，避免本地视图落后
    if (SYNC_ENABLED && !isRead && path.indexOf("/api/sync/") !== 0) scheduleSnapshotRefresh();
    // 任何改动题库的写操作都让标签缓存失效；练习判题只标脏，不额外发请求
    if (!isRead && path.indexOf("/api/sync/") !== 0) {
      invalidateTags(
        path.indexOf("/api/practice/") !== 0 &&
        ["library", "practice", "capture", "stats", "wrong"].includes(state.view)
      );
    }
    return data;
  }

  // 常见 HTTP 错误码的中文解读（前端兜底：服务未重启时后端新文案尚未生效）
  const HTTP_HINTS = {
    400: "请求被服务方拒绝（400），常见原因：模型名称写错、不支持该参数",
    401: "密钥无效或未授权（401），请检查 API Key 是否复制完整、是否正确",
    403: "无权限访问（403），可能是账号未开通该模型或地区受限",
    404: "地址不存在（404），请检查 Base URL，OpenAI 兼容地址通常要以 /v1 结尾",
    429: "请求过于频繁或额度不足（429），请稍后重试或检查账户余额",
    500: "服务方内部错误（500），稍后重试",
    502: "服务方网关错误（502），稍后重试",
    503: "服务暂不可用（503），稍后重试",
    504: "服务方网关超时（504），可尝试调大超时时间",
  };

  // 长报错不再塞进提示条：弹一个可滚动、可完整复制的详情弹窗
  function showErrorDetail(message, title = "操作失败") {
    let text = String(message || "").trim();
    if (!text) return;
    // 旧版后端文案形如 "HTTP 401: ..."，前端补上解读
    const legacy = text.match(/^HTTP (\d{3}):\s*/);
    if (legacy && HTTP_HINTS[legacy[1]]) {
      text = `${HTTP_HINTS[legacy[1]]}\n服务方原始返回：${text.slice(legacy[0].length)}`;
    }
    openModal({
      title,
      subtitle: "完整错误信息如下，文字可全选复制，便于排查。",
      body: `<div class="error-detail">${escapeHtml(text)}</div>`,
      footer: `<button class="btn btn-primary" data-close-modal>知道了</button>`,
      wide: true,
    });
  }

  function showToast(message, type = "info") {
    const text = String(message || "");
    // 提示条放不下的长报错直接走详情弹窗，避免被截断
    if (text.length > 80) {
      showErrorDetail(text, type === "error" ? "操作失败" : "提示");
      return;
    }
    const stack = $("#toastStack");
    const item = document.createElement("div");
    item.className = `toast ${type === "success" ? "ok" : type === "error" ? "error" : ""}`;
    // 错误提示对读屏软件立即播报，其余作为状态更新
    item.setAttribute("role", type === "error" ? "alert" : "status");
    item.innerHTML = `${svg(type === "error" ? "alert" : type === "success" ? "check" : "spark")}<span>${escapeHtml(text)}</span>`;
    stack.appendChild(item);
    // 停留时长：错误留更久（7s），普通提示 5.2s，成功 4.2s
    const hold = type === "error" ? 7000 : type === "success" ? 4200 : 5200;
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      item.style.opacity = "0";
      item.style.transform = "translateY(-10px)";
      item.style.transition = ".24s";
      setTimeout(() => item.remove(), 260);
    };
    timer = setTimeout(dismiss, hold);
    // 悬停时暂停自动消失，方便阅读稍长的提示；移开后再停留 1.6s 收起
    item.addEventListener("mouseenter", () => clearTimeout(timer));
    item.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 1600); });
  }

  // 非遮挡的持续提示：解析大模型期间显示，不形成遮罩，可继续看其它题
  let aiBusyCount = 0;
  function showBusy(message) {
    aiBusyCount++;
    const el = document.getElementById("aiBusy");
    if (!el) return null;
    el.hidden = false;
    const text = aiBusyCount > 1 ? `正在用大模型重新解析 ${aiBusyCount} 道题…` : message;
    el.innerHTML = `<span class="spinner"></span><span class="ai-busy-text">${escapeHtml(text)}</span>`;
    return el;
  }
  function clearBusy() {
    aiBusyCount = Math.max(0, aiBusyCount - 1);
    const el = document.getElementById("aiBusy");
    if (!el) return;
    if (aiBusyCount === 0) {
      el.hidden = true;
      el.innerHTML = "";
    } else {
      el.innerHTML = `<span class="spinner"></span><span class="ai-busy-text">正在用大模型重新解析 ${aiBusyCount} 道题…</span>`;
    }
  }

  // ---------------------------------------------------------------------
  // Format helpers
  // ---------------------------------------------------------------------
  function formatCount(value) {
    const number = Number(value || 0);
    return number >= 10000 ? `${(number / 10000).toFixed(1)}w` : String(number);
  }

  function formatDate(iso) {
    if (!iso) return "--";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "--";
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function weekdayLabel(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  }

  function todayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] || "题目";
  }

  function masteryText(mastery) {
    return MASTERY_LABELS[mastery] ?? "未练习";
  }

  function masteryPercent(mastery) {
    return Math.min(100, Math.max(0, (Number(mastery) || 0) / 3 * 100));
  }

  function normalizeLetters(value) {
    return Array.from(new Set(String(value || "").toUpperCase().match(/[A-H]/g) || [])).sort().join("");
  }

  function simpleAnswersEqual(answer, user, qtype) {
    if (!answer || !user) return false;
    if (qtype === "fill") {
      return String(answer).replace(/\s+/g, "") === String(user).replace(/\s+/g, "");
    }
    if (qtype === "truefalse") return normalizeTrueFalse(answer) === normalizeTrueFalse(user);
    return normalizeLetters(answer) === normalizeLetters(user);
  }

  // 一道题是否「原图答错」：始终由图片中的作答与正确答案对比得出，
  // 这样重新识别、手动改答案后，错题判断不会跟实际作答对不上。
  function draftWasWrong(draft) {
    const answer = String(draft.answer || "").trim();
    const user = String(draft.user_answer || "").trim();
    return Boolean(answer && user && !simpleAnswersEqual(answer, user, draft.qtype));
  }

  function normalizeTrueFalse(value) {
    const text = String(value || "").trim().toLowerCase();
    if (["a", "对", "正确", "true", "t", "√", "1", "yes"].includes(text)) return "正确";
    if (["b", "错", "错误", "false", "f", "×", "0", "no"].includes(text)) return "错误";
    return "";
  }

  // 判断题答案的语义色：正确 → 绿，错误 → 红。
  // 必须限定题型，否则选择题答案里的 A / B 会被误判成「正确 / 错误」。
  function tfTone(value, qtype) {
    if (qtype && qtype !== "truefalse") return "";
    const tf = normalizeTrueFalse(value);
    return tf === "正确" ? "tf-true" : tf === "错误" ? "tf-false" : "";
  }

  // 表单控件（下拉 / 输入框）值变化时实时刷新语义色
  function syncTfTone(el, qtype) {
    if (!el) return;
    el.classList.remove("tf-true", "tf-false");
    const tone = tfTone(el.value, qtype);
    if (tone) el.classList.add(tone);
  }

  function emptyState(title, subtitle = "", icon = "book") {
    return `<div class="empty">${svg(icon)}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></div>`;
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------
  // 开发者文档页：区块滚动到视口时依次显现，避免整页一次性铺开；
  // 浏览器不支持观察器时直接全部显示，保证内容永远可读。
  let devObserver = null;
  function initDevPage() {
    const blocks = $$(".dev-page .dev-reveal");
    if (!blocks.length) return;
    if (!("IntersectionObserver" in window)) {
      blocks.forEach((el) => el.classList.add("in"));
      return;
    }
    if (devObserver) devObserver.disconnect();
    devObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.06, rootMargin: "0px 0px -30px 0px" });
    requestAnimationFrame(() => {
      blocks.forEach((el) => { if (!el.classList.contains("in")) devObserver.observe(el); });
    });
  }

  function topActionsFor(view) {
    if (view === "dashboard") {
      return `<button class="btn btn-ghost" data-action="go-capture">${svg("camera")}<span>上传截图</span></button><button class="btn btn-primary" data-action="start-practice">${svg("play")}<span>开始练习</span></button>`;
    }
    if (view === "capture") {
      return `<button class="btn btn-ghost" data-action="go-library">${svg("library")}<span>打开题库</span></button>`;
    }
    if (view === "library") {
      return `<button class="btn btn-ghost" data-action="go-capture">${svg("camera")}<span>图片添加</span></button><button class="btn btn-ghost" data-action="open-add-question">${svg("plus")}<span>添加题目</span></button><button class="btn btn-primary" data-view="codepaper">${svg("code")}<span>添加试卷</span></button>`;
    }
    if (view === "wrong") {
      return `<button class="btn btn-ghost" data-action="go-library">${svg("library")}<span>全部题目</span></button>`;
    }
    if (view === "stats") {
      return `<button class="btn btn-ghost" data-action="reload-stats">${svg("refresh")}<span>刷新数据</span></button>`;
    }
    if (view === "guide") {
      // 手册很长，顶部常驻一个「回到顶部」
      return `<button class="btn btn-ghost" data-action="scroll-top">${svg("up")}<span>回到顶部</span></button>`;
    }
    if (view === "codepaper") {
      // 整卷入库录入后试卷进入「我的题库」，顶部直接给去题库的入口（侧栏仍常驻，无需返回概览）
      return `<button class="btn btn-ghost" data-view="library">${svg("library")}<span>去「我的题库」</span></button>`;
    }
    return "";
  }

  function switchView(view, options = {}) {
    if (!VIEW_META[view]) view = "dashboard";
    // 「整卷历史」的返回目标统一在这里、以「切换前」的视图为准记录。
    // 以前放在全局点击委托里：统计表「历史」按钮自己先调了一次 switchView，
    // 等事件冒泡到委托时 state.view 已变成 codeHistory，返回目标被记成自身，
    // 于是「返回」原地不动、回不到学习统计。题库按钮没有自有监听，所以一直正常。
    if (view === "codeHistory" && state.view !== "codeHistory" && VIEW_META[state.view]) {
      codeHistoryReturnView = state.view;
    }
    // 换页面时把还开着的弹窗收干净：否则上一页的列表会留在屏幕上，
    // 原图查看器的「返回列表」也会指回一个早就过期的列表。
    if (view !== state.view) closeAllModals();
    if (state.view === "practice" && view !== "practice") stopPracticeTimer();
    state.view = view;
    // 题库页整页不滚动、分页条常驻底部；识题页题目区内部滚动、词典常驻
    document.body.classList.toggle("view-fixed", view === "library");
    document.body.classList.toggle("capture-fixed", view === "capture");
    $$(".page").forEach((page) => {
      page.hidden = page.dataset.page !== view;
    });
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    $("#pageTitle").textContent = VIEW_META[view].title;
    $("#pageSubtitle").textContent = VIEW_META[view].subtitle;
    $("#pageActions").innerHTML = topActionsFor(view);
    if (!options.keepHash) history.replaceState(null, "", `#${view}`);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

    // 进这些页面时强制校验一次标签指纹：服务端有新标签就会立刻换掉缓存
    if (["library", "practice", "stats", "wrong"].includes(view)) loadTags(true);
    // 切回整卷录入时通知独立模块重拉一次 parse 通道配置（兜底）
    if (view === "codepaper") window.dispatchEvent(new CustomEvent("cp:view-enter"));
    if (view === "dashboard") loadDashboard();
    if (view === "capture") {
      renderCaptureQueue();
      updateOcrButton();
      if (!isPhoneLayout()) loadMobileInfo();
      pollMobileInbox();
      loadCorrections();
      // 窄屏下词典默认收起，避免挡住题目；宽屏保持展开常驻
      const card = $(".correct-card");
      const toggle = $("#toggleCorrect");
      const narrow = window.matchMedia("(max-width: 1120px)").matches;
      if (card) card.classList.toggle("collapsed", narrow);
      if (toggle) toggle.setAttribute("aria-expanded", String(!narrow));
    }
    if (view === "library") {
      const lp = document.querySelector('.page[data-page="library"]');
      if (lp) lp.dataset.libm = "home";
      loadLibrary();
    }
    if (view === "practice") preparePracticeView();
    if (view === "wrong") loadWrongBook();
    if (view === "stats") loadStats();
    if (view === "codeHistory") loadCodeHistory({ reset: true, paperId: options.chPaper });
    if (view === "settings") loadSettings();
    if (view === "guide") initGuideToc();
    if (view === "dev") initDevPage();
    if (!["dashboard", "wrong", "stats"].includes(view)) refreshOverview();
  }

  // 手册目录：跟着滚动高亮当前章节
  function initGuideToc() {
    const toc = document.querySelector(".guide-toc");
    if (!toc) return;
    // 顶栏是 sticky 的，目录条也是 sticky 的 —— 两者都吸顶，目录条必须落在顶栏下面，
    // 否则会被盖住。顶栏高度随窗口变，实测后写进 CSS 变量。
    const topbar = document.querySelector(".topbar");
    const syncTop = () => {
      const h = topbar ? Math.round(topbar.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--guide-toc-top", `${h}px`);
    };
    syncTop();
    if (toc.dataset.guideBound !== "1") {
      toc.dataset.guideBound = "1";
      window.addEventListener("resize", syncTop);
    }
    const links = Array.from(toc.querySelectorAll("[data-anchor]"));
    const sections = links.map((a) => document.getElementById(a.dataset.anchor)).filter(Boolean);
    if (!sections.length) return;
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.toggle("is-current", a.dataset.anchor === entry.target.id));
      });
    }, { rootMargin: "-96px 0px -62% 0px", threshold: 0 });
    sections.forEach((section) => spy.observe(section));
  }

  async function refreshOverview() {
    try {
      const data = await api("/api/overview");
      state.overview = data;
      applyOverview(data);
    } catch (_error) {
      /* A failed chrome refresh should not interrupt the current page. */
    }
  }

  // ---------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------
  async function loadDashboard() {
    try {
      const data = await api("/api/overview");
      state.overview = data;
      applyOverview(data);
      renderWeeklyChart(data.daily || []);
      renderMastery(data);
      renderWeakList(data.weakest || []);
      renderRecentList(data.recent_attempts || []);
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function applyOverview(data) {
    $("#statTotal").textContent = formatCount(data.total);
    $("#statTotalSub").textContent = `${data.ready || 0} 道可练习`;
    $("#statWrong").textContent = formatCount(data.wrong);
    $("#statWrongSub").textContent = data.wrong ? "连续答对 3 次可掌握" : "没有待攻克错题";
    $("#statMastered").textContent = formatCount(data.mastered);
    $("#statMasteredSub").textContent = data.total
      ? `掌握率 ${Math.round((data.mastered / data.total) * 100)}%`
      : "继续保持";
    $("#statAccuracy").textContent = data.today_accuracy == null ? "--" : `${data.today_accuracy}%`;
    $("#statAccuracySub").textContent = data.today_total
      ? `今日已练 ${data.today_total} 题`
      : "还没有练习记录";

    $("#heroAccuracy").textContent = data.today_accuracy == null ? "--" : `${data.today_accuracy}%`;
    $("#heroAccuracySub").textContent = data.today_total
      ? `今天完成 ${data.today_total} 题`
      : "完成练习后显示";
    $("#heroBar").style.width = `${data.today_accuracy || 0}%`;
    $("#heroMastered").textContent = data.mastered || 0;

    const wrongNav = $("#wrongNavCount");
    wrongNav.hidden = !data.wrong;
    wrongNav.textContent = data.wrong > 99 ? "99+" : data.wrong;
    // 折叠后数字徽标变成小红点，把数量补进悬停/聚焦气泡，信息不丢
    const wrongItem = wrongNav.closest(".nav-item");
    if (wrongItem) {
      const label = data.wrong ? `错题本 · ${wrongNav.textContent}` : "错题本";
      wrongItem.dataset.label = label;
      wrongItem.setAttribute("aria-label", label);
    }
    $("#captureDot").hidden = true;

    $("#sideTodayText").textContent = data.today_total ? `今天已练 ${data.today_total} 题` : "今天还没练习";
    $("#sideTodaySub").textContent = data.today_total
      ? `正确率 ${data.today_accuracy == null ? "--" : data.today_accuracy + "%"}`
      : "从一道错题开始吧";
    $("#sideProgress").style.width = `${Math.min(100, (data.today_total / 10) * 100)}%`;

    // 概览数据一变，练习模式的可用题量跟着变（练完一轮错题清零时尤其明显）
    applyPracticeModeAvailability();
  }

  function renderWeeklyChart(daily) {
    const container = $("#weeklyChart");
    if (!container) return;
    const max = Math.max(1, ...daily.map((item) => item.total));
    container.innerHTML = daily
      .map((item) => {
        const totalPct = Math.round((item.total / max) * 100);
        const correctPct = Math.round((item.correct / max) * 100);
        const isToday = item.date === todayString();
        return `<div class="bar-col ${isToday ? "is-today" : ""}" title="${item.date}：练习 ${item.total} 题，答对 ${item.correct} 题">
          <div class="bar-stack">
            <i class="bar-total" style="height:${item.total ? Math.max(totalPct, 8) : 0}%"></i>
            <i class="bar-correct" style="height:${item.correct ? Math.max(correctPct, 4) : 0}%"></i>
          </div>
          <span class="bar-label">${isToday ? "今天" : `周${weekdayLabel(item.date)}`}</span>
        </div>`;
      })
      .join("");
  }

  function renderMastery(data) {
    const total = Math.max(1, data.total || 0);
    const percent = data.total ? Math.round((data.mastered / total) * 100) : 0;
    const ring = $("#masteryRing");
    ring.style.setProperty("--p", percent);
    $("#masteryPercent").textContent = `${percent}%`;
    $("#mLemMastered").textContent = data.mastered || 0;
    $("#mLemWrong").textContent = Math.max(0, (data.total || 0) - (data.mastered || 0) - (data.unseen || 0));
    $("#mLemUnseen").textContent = data.unseen || 0;
  }

  function renderWeakList(items) {
    const container = $("#weakList");
    if (!items.length) {
      container.innerHTML = emptyState("还没有错题", "去上传第一道题，或者开始一次练习吧。", "check");
      return;
    }
    container.innerHTML = items
      .map(
        (item, index) => `<div class="weak-item" role="button" tabindex="0" data-detail-id="${item.id}" title="点击查看题目详情">
          <span class="weak-index">${String(index + 1).padStart(2, "0")}</span>
          <div class="weak-body"><p>${escapeHtml(item.stem)}</p><span>${typeLabel(item.qtype)} · ${escapeHtml((item.tags || []).join(" / ") || "未分类")}</span></div>
          <span class="weak-count">错 ${item.wrong_count} 次</span>
        </div>`
      )
      .join("");
  }

  function renderRecentList(items) {
    const container = $("#recentList");
    if (!items.length) {
      container.innerHTML = emptyState("还没有练习记录", "完成一次练习后，这里会显示你的答题轨迹。", "clock");
      return;
    }
    container.innerHTML = items
      .map(
        (item) => {
          // 「最近练习」与「最需要关注的题」一致：点条目看题目详情。
          // 题目若已被删（question_id 缺失），就退回成纯展示，不可点。
          const qid = Number(item.question_id) || 0;
          const clickable = qid
            ? ` role="button" tabindex="0" data-detail-id="${qid}" title="点击查看题目详情"`
            : "";
          return `<div class="recent-item${clickable ? " is-clickable" : ""}"${clickable}>
            <span class="recent-mark ${item.is_correct ? "ok" : "bad"}">${svg(item.is_correct ? "check" : "close")}</span>
            <div class="recent-body"><p>${escapeHtml(item.stem)}</p><span>${formatDate(item.created_at)} · ${item.is_correct ? "答对" : "答错"}</span></div>
            <span class="recent-answer">${escapeHtml(item.user_answer || "--")} / ${escapeHtml(item.correct_answer || "--")}</span>
          </div>`;
        }
      )
      .join("");
  }

  // ---------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------
  function bindCapture() {
    const input = $("#fileInput");
    const dropzone = $("#dropzone");

    // 只认「选择图片」这一个入口：点拖拽区的空白处不再弹文件框。
    // 之前整块区域都能点，用户只是想看一句说明文字也会被弹窗打断。
    // 拖拽放置、粘贴截图照旧可用。
    $("#pickImages").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      addFiles(Array.from(input.files || []));
      input.value = "";
    });
    // 手机端：直接调用后置摄像头，不需要 HTTPS / getUserMedia
    const cameraInput = $("#cameraInput");
    const takePhoto = () => cameraInput?.click();
    $("#takePhoto")?.addEventListener("click", takePhoto);
    $("#takePhotoDirect")?.addEventListener("click", takePhoto);
    cameraInput?.addEventListener("change", () => {
      addFiles(Array.from(cameraInput.files || []));
      cameraInput.value = "";
    });
    ["dragenter", "dragover"].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", (event) => {
      addFiles(Array.from(event.dataTransfer.files || []));
    });
    document.addEventListener("paste", (event) => {
      if (state.view !== "capture") return;
      const target = event.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const files = Array.from(event.clipboardData?.files || []).filter((file) =>
        file.type.startsWith("image/")
      );
      if (files.length) {
        event.preventDefault();
        addFiles(files);
        showToast(`已粘贴 ${files.length} 张截图`, "success");
      }
    });
    $("#clearQueue").addEventListener("click", clearQueue);
    $("#startOcr").addEventListener("click", runOcr);
    $("#viewUploads").addEventListener("click", openUploadsModal);
    $("#viewQuestionImages").addEventListener("click", openQuestionImagesModal);
    $("#toggleUpload").addEventListener("click", toggleUploadPanel);
    $("#discardDrafts").addEventListener("click", discardDrafts);
    $("#saveDrafts").addEventListener("click", saveDrafts);
    $("#draftList").addEventListener("click", handleDraftClick);
    $("#dupDeleteAll").addEventListener("click", () => deleteDuplicateImages(state.capture.duplicates || []));
    $("#dupDismiss").addEventListener("click", () => {
      state.capture.duplicates = [];
      renderDupBanner();
    });
    $("#draftList").addEventListener("input", handleDraftInput);
    $("#draftList").addEventListener("change", handleDraftChange);
    $("#copyMobileUrl").addEventListener("click", copyMobileUrl);
    $("#mobileHelp").addEventListener("click", showMobileHelp);
  }

  function showMobileHelp() {
    openModal({
      title: "手机扫码打不开？",
      subtitle: "按顺序检查这几项，通常 1 分钟就能解决。",
      body: `<div class="rule-list">
        <div><span>01</span><p>确认手机和电脑连接的是<strong>同一个 Wi-Fi</strong>，手机不要使用流量，也不要连接访客网络。</p></div>
        <div><span>02</span><p>在 Windows「Windows Defender 防火墙 → 允许应用通过防火墙」中，允许 <strong>Python</strong> 访问<strong>专用网络</strong>。</p></div>
        <div><span>03</span><p>如果电脑开着 VPN 或虚拟网卡，二维码可能显示了错误网段；关闭 VPN 后刷新「图片识题」页面重新扫码。</p></div>
        <div><span>04</span><p>先复制链接到手机系统浏览器打开；部分微信内置浏览器不允许直接调用相机。</p></div>
      </div>`,
      footer: `<button class="btn btn-primary" data-close-modal>知道了</button>`,
      wide: true,
    });
  }

  async function loadMobileInfo() {
    const qr = $("#mobileQr");
    const placeholder = $("#mobileQrPlaceholder");
    const status = $("#mobileStatus");
    try {
      const data = await api("/api/mobile/info");
      state.capture.mobile = { ...data, polledAt: Date.now() };
      if (data.available) {
        qr.hidden = false;
        qr.src = `${data.qr_url}?v=${Date.now()}`;
        qr.onerror = () => {
          qr.hidden = true;
          placeholder.hidden = false;
          placeholder.innerHTML = `${svg("alert")}<span>二维码加载失败</span>`;
        };
        placeholder.hidden = true;
        status.className = "mobile-live on";
        status.innerHTML = "<i></i>同一 Wi-Fi 可用";
        $("#mobileUrl").textContent = data.url;
        $("#copyMobileUrl").disabled = false;
        $("#mobilePending").textContent = data.pending ? `待接收 ${data.pending} 张` : "电脑端已就绪";
      } else {
        qr.hidden = true;
        placeholder.hidden = false;
        placeholder.innerHTML = `${svg("camera")}<span>未检测到局域网</span>`;
        status.className = "mobile-live warn";
        status.innerHTML = "<i></i>仅本机可用";
        $("#mobileUrl").textContent = data.message || "未检测到局域网地址";
        $("#copyMobileUrl").disabled = true;
        $("#mobilePending").textContent = "";
      }
    } catch (_error) {
      status.className = "mobile-live warn";
      status.innerHTML = "<i></i>无法获取地址";
      $("#mobileUrl").textContent = "请确认本地服务运行正常";
      qr.hidden = true;
      placeholder.hidden = false;
      placeholder.innerHTML = `${svg("alert")}<span>暂时不可用</span>`;
    }
  }

  async function pollMobileInbox() {
    // 手机自己就在拍照，不抢电脑端「扫码拍照页」上传的待收照片
    if (isPhoneLayout()) return;
    if (state.view !== "capture" || state.capture.busy || document.hidden) return;
    if (state.capture.queue.length >= 12) return;
    try {
      const data = await api("/api/mobile/inbox/take", { method: "POST" });
      const items = data.items || [];
      if (!items.length) return;
      let added = 0;
      for (const item of items) {
        if (state.capture.queue.length >= 12) break;
        try {
          const response = await fetch(`/${String(item.image_url).replace(/^\/+/, "")}`);
          if (!response.ok) continue;
          const blob = await response.blob();
          const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
          const file = new File(
            [blob],
            item.filename || `手机拍照_${Date.now()}.${ext}`,
            { type: blob.type || "image/jpeg" }
          );
          addFiles([file]);
          added += 1;
        } catch (_error) {
          /* Skip one bad photo and keep the rest. */
        }
      }
      if (added) {
        $("#mobilePending").textContent = `已接收 ${added} 张`;
        showToast(`已接收手机照片 ${added} 张，点击「开始识别」`, "success");
      }
      const info = await api("/api/mobile/info");
      state.capture.mobile = info;
      $("#mobilePending").textContent = info.pending ? `待接收 ${info.pending} 张` : "电脑端已就绪";
    } catch (_error) {
      /* The service may be restarting; try again on the next poll. */
    }
  }

  async function copyMobileUrl() {
    const url = state.capture.mobile?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast("手机拍照链接已复制", "success");
    } catch (_error) {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      showToast("手机拍照链接已复制", "success");
    }
  }

  function addFiles(files) {
    const valid = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 25 * 1024 * 1024) {
        showToast(`${file.name} 超过 25MB，已跳过`, "error");
        continue;
      }
      valid.push(file);
    }
    const space = Math.max(0, 12 - state.capture.queue.length);
    if (valid.length > space) showToast("一次最多识别 12 张图片", "error");
    state.capture.queue.push(...valid.slice(0, space));
    renderCaptureQueue();
    updateOcrButton();
  }

  // 设备是否真正支持悬停（鼠标/触控板）；手机等触屏设备不挂悬停预览，改走点击查看大图
  const CAN_HOVER = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // 待识别缩略图悬停时弹出的放大浮窗（仅桌面端）
  let thumbPeekEl = null;
  function getThumbPeek() {
    if (!thumbPeekEl) {
      thumbPeekEl = document.createElement("div");
      thumbPeekEl.className = "thumb-peek";
      thumbPeekEl.setAttribute("aria-hidden", "true");
      thumbPeekEl.hidden = true;
      document.body.appendChild(thumbPeekEl);
    }
    return thumbPeekEl;
  }
  function showThumbPeek(thumb) {
    const url = thumb.dataset.peekSrc;
    if (!url) return;
    const peek = getThumbPeek();
    peek.hidden = false;
    const img = new Image();
    img.alt = "";
    img.onload = () => {
      peek.innerHTML = "";
      peek.appendChild(img);
      positionThumbPeek(thumb, peek);
    };
    img.src = url;
  }
  function positionThumbPeek(thumb, peek) {
    const r = thumb.getBoundingClientRect();
    const pr = peek.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pr.width - 10));
    let top = r.top - pr.height - 12;
    let below = false;
    if (top < 10) { top = r.bottom + 12; below = true; }
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
    peek.classList.toggle("below", below);
  }
  function hideThumbPeek() {
    if (thumbPeekEl) thumbPeekEl.hidden = true;
  }

  // 点击缩略图打开的整图查看器（支持多图左右切换 / 触屏滑动），用于桌面点击与手机端
  function openQueueImageViewer(startIndex) {
    const queue = state.capture.queue;
    if (!queue.length) return;
    const list = queue.map((file, i) => ({
      url: state.capture.previewUrls[i],
      name: file.name || `粘贴的截图 ${i + 1}`,
    }));
    let pos = Math.max(0, Math.min(startIndex || 0, list.length - 1));
    const layer = mountViewerLayer();
    hideTip();
    let x0 = 0, y0 = 0, tracking = false;
    const render = () => {
      const item = list[pos];
      layer.innerHTML = `<div class="modal-backdrop"></div>
        <div class="modal wide viewer queue-viewer" role="dialog" aria-modal="true" aria-label="预览待识别图片">
          <div class="modal-head">
            <div><h3>待识别图片预览</h3><p>${escapeHtml(item.name)}</p></div>
            <button class="icon-btn" data-close-modal aria-label="关闭">${svg("close")}</button>
          </div>
          <div class="modal-body"><div class="img-view"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}"></div></div>
          <div class="modal-foot viewer-foot">
            ${list.length > 1 ? `<div class="img-nav">
              <button class="btn btn-ghost btn-sm" data-img-prev ${pos <= 0 ? "disabled" : ""}>上一张</button>
              <button class="btn btn-ghost btn-sm" data-img-next ${pos >= list.length - 1 ? "disabled" : ""}>下一张</button>
              <span class="img-counter">${pos + 1} / ${list.length}</span>
            </div>` : ""}
            <button class="btn btn-primary" data-close-modal>关闭</button>
          </div>
        </div>`;
      layer.querySelector(".modal-backdrop").addEventListener("click", () => closeModal(false));
      layer.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", () => closeModal(false)));
      const prev = layer.querySelector("[data-img-prev]");
      const next = layer.querySelector("[data-img-next]");
      if (prev) prev.addEventListener("click", () => { if (pos > 0) { pos -= 1; render(); } });
      if (next) next.addEventListener("click", () => { if (pos < list.length - 1) { pos += 1; render(); } });
      // 触屏左右滑动切换图片
      const body = layer.querySelector(".modal-body");
      body.addEventListener("touchstart", (e) => { tracking = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      body.addEventListener("touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.changedTouches[0].clientX - x0;
        const dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0 && pos < list.length - 1) { pos += 1; render(); }
          else if (dx > 0 && pos > 0) { pos -= 1; render(); }
        }
      }, { passive: true });
    };
    const root = $("#modalRoot");
    root.hidden = false;
    document.body.style.overflow = "hidden";
    document.body.classList.add("modal-open");
    render();
  }

  function renderCaptureQueue() {
    const strip = $("#previewStrip");
    const head = $("#queueHead");
    const queue = state.capture.queue;
    state.capture.previewUrls.forEach((url) => URL.revokeObjectURL(url));
    state.capture.previewUrls = queue.map((file) => URL.createObjectURL(file));
    head.hidden = !queue.length;
    strip.hidden = !queue.length;
    $("#queueMeta").textContent = `${queue.length} 张 · ${(queue.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MB`;
    strip.innerHTML = queue
      .map((file, index) => {
        const url = state.capture.previewUrls[index];
        const name = file.name || `粘贴的截图 ${index + 1}`;
        return `<div class="preview-thumb" data-queue-index="${index}" data-peek-src="${escapeHtml(url)}" tabindex="0" role="button" aria-label="预览 ${escapeHtml(name)}">
          <img src="${url}" alt="${escapeHtml(name)}">
          <button type="button" data-remove-queue="${index}" aria-label="移除">${svg("close")}</button>
          <span>${escapeHtml(name)}</span>
        </div>`;
      })
      .join("");
    $$("[data-remove-queue]", strip).forEach((button) => {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        state.capture.queue.splice(Number(button.dataset.removeQueue), 1);
        renderCaptureQueue();
        updateOcrButton();
      });
    });
    $$(".preview-thumb", strip).forEach((thumb) => {
      const idx = Number(thumb.dataset.queueIndex);
      thumb.addEventListener("click", (e) => {
        if (e.target.closest("[data-remove-queue]")) return;
        openQueueImageViewer(idx);
      });
      thumb.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openQueueImageViewer(idx); }
      });
      if (CAN_HOVER) {
        thumb.addEventListener("mouseenter", () => showThumbPeek(thumb));
        thumb.addEventListener("mouseleave", hideThumbPeek);
      }
    });
  }

  function clearQueue() {
    state.capture.queue = [];
    renderCaptureQueue();
    updateOcrButton();
    $("#ocrProgress").hidden = true;
  }

  // 上传区折叠 / 展开：识别结果出来后自动收起，把屏幕空间让给题目
  function setUploadPanelCollapsed(collapsed) {
    const panel = $("#capturePanel");
    const button = $("#toggleUpload");
    if (!panel) return;
    panel.classList.toggle("collapsed", collapsed);
    if (button) button.textContent = collapsed ? "展开" : "收起";
  }

  function toggleUploadPanel() {
    const panel = $("#capturePanel");
    if (!panel) return;
    setUploadPanelCollapsed(!panel.classList.contains("collapsed"));
  }

  function updateOcrButton() {
    const busy = state.capture.busy;
    const button = $("#startOcr");
    button.disabled = busy || !state.capture.queue.length;
    button.innerHTML = busy
      ? `<span class="spinner"></span><span>正在识别...</span>`
      : `${svg("spark")}<span>开始识别${state.capture.queue.length ? ` · ${state.capture.queue.length} 张` : ""}</span>`;
    const status = $("#ocrStatus");
    if (busy) {
      status.innerHTML = `<span class="status-dot"></span>正在读取图片并识别文字...`;
    } else if (state.capture.queue.length) {
      status.innerHTML = `<span class="status-dot"></span>${state.capture.queue.length} 张图片等待识别`;
    } else {
      status.innerHTML = `<span class="status-dot"></span>识别引擎已就绪`;
    }
  }

  async function runOcr() {
    if (state.capture.busy || !state.capture.queue.length) return;
    state.capture.busy = true;
    $("#ocrProgress").hidden = false;
    $("#ocrProgressBar").style.width = "8%";
    $("#ocrProgressText").textContent = "正在上传并读取图片...";
    updateOcrButton();
    let progress = 8;
    clearInterval(ocrProgressTimer);
    ocrProgressTimer = setInterval(() => {
      progress = Math.min(86, progress + Math.random() * 7);
      $("#ocrProgressBar").style.width = `${progress}%`;
      const messages = ["正在定位文字区域...", "正在识别中文与选项...", "正在整理题目结构..."];
      $("#ocrProgressText").textContent = messages[Math.min(messages.length - 1, Math.floor(progress / 30))];
    }, 550);

    const form = new FormData();
    state.capture.queue.forEach((file) => form.append("images", file, file.name || "pasted.png"));
    try {
      const data = await api("/api/ocr", { method: "POST", body: form });
      state.capture.drafts = (data.drafts || []).map((draft) => ({
        ...draft,
        uid: `d-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        include: !draft.duplicate && !draft.image_duplicate,
        options: { ...(draft.options || {}) },
        tags: Array.isArray(draft.tags) ? draft.tags : ["未分类"],
      }));
      state.capture.results = data.results || [];
      state.capture.duplicates = data.duplicates || [];
      state.capture.queue = [];
      renderCaptureQueue();
      $("#ocrProgressBar").style.width = "100%";
      $("#ocrProgressText").textContent = `识别完成，共发现 ${state.capture.drafts.length} 道题`;
      renderDrafts();
      renderOcrRaw();
      if (data.errors?.length) {
        showToast(`${data.errors.length} 张图片识别失败，可重新上传`, "error");
      }
      if (state.capture.duplicates.length) {
        const count = state.capture.duplicates.length;
        showToast(`检测到 ${count} 张重复图片，已标记并默认不加入题库`, "error");
      }
      if (!state.capture.drafts.length) {
        showToast("没有识别到题目，请确认截图包含完整题干", "error");
      } else {
        showToast(`识别完成，共 ${state.capture.drafts.length} 道题，请核对`, "success");
        // 收起上传区，把屏幕空间让给识别结果
        setUploadPanelCollapsed(true);
        const list = $("#draftList");
        if (list) list.scrollTop = 0;
      }
    } catch (error) {
      $("#ocrProgressBar").style.width = "100%";
      $("#ocrProgressText").textContent = "识别失败，请重试";
      showToast(error.message, "error");
    } finally {
      clearInterval(ocrProgressTimer);
      state.capture.busy = false;
      updateOcrButton();
      setTimeout(() => {
        if (!state.capture.busy) $("#ocrProgress").hidden = true;
      }, 1200);
    }
  }

  function draftOptions(draft) {
    const options = { ...(draft.options || {}) };
    ["A", "B", "C", "D"].forEach((letter) => {
      if (options[letter] === undefined) options[letter] = "";
    });
    return options;
  }

  // “合并行”按钮：只在内容确实有多行时显示
  function mergeButtonHtml(field) {
    return `<button type="button" class="text-btn merge-btn" data-merge-lines="${field}" hidden title="把多行内容合并成一行">合并行</button>`;
  }

  function syncMergeButtons(scope) {
    if (!scope) return;
    $$("[data-merge-lines]", scope).forEach((button) => {
      const field = button.closest(".field");
      const area = field && field.querySelector("textarea");
      if (!area) return;
      button.hidden = !area.value.includes("\n");
    });
  }

  function applyMergeLines(button) {
    const field = button.closest(".field");
    const area = field && field.querySelector("textarea");
    if (!area) return;
    const merged = mergeLines(area.value);
    if (!area.value.includes("\n")) {
      showToast("当前内容已经是一行", "success");
      return;
    }
    area.value = merged;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    showToast("已合并为一行", "success");
  }

  function renderDrafts() {
    const area = $("#draftArea");
    const list = $("#draftList");
    renderDupBanner();
    if (!state.capture.drafts.length) {
      area.hidden = true;
      list.innerHTML = "";
      setUploadPanelCollapsed(false);
      return;
    }
    area.hidden = false;
    const included = state.capture.drafts.filter((draft) => draft.include).length;
    $("#draftMeta").textContent = `共识别 ${state.capture.drafts.length} 道题，已选择 ${included} 道。请核对题干、选项和答案。`;
    list.innerHTML = state.capture.drafts.map(renderDraftCard).join("");
    syncMergeButtons(list);
    // 识别出的解析常常是 Markdown：给每个解析框配一块实时预览，当场就能看到效果
    $$("textarea[data-field='explanation']", list).forEach(attachMdPreview);
  }

  // 重复图片提示条：告诉用户哪些图是重复上传的，并提供一键删除
  function renderDupBanner() {
    const banner = $("#dupBanner");
    const list = state.capture.duplicates || [];
    if (!banner) return;
    if (!list.length) {
      banner.hidden = true;
      return;
    }
    const images = list.length;
    const questions = list.reduce((sum, item) => sum + (item.questions || 0), 0);
    const names = list.map((item) => item.filename || "图片").join("、");
    $("#dupBannerTitle").textContent = `检测到 ${images} 张重复图片`;
    $("#dupBannerText").textContent =
      `「${names}」与之前上传的图片内容相同，解析出的 ${questions} 道题已标记为重复并默认不加入题库。` +
      `可点击「全部删除」移除这些重复图片。`;
    banner.hidden = false;
  }

  // 删除重复图片：同时移除本地文件、imports 记录和对应的草稿卡
  async function deleteDuplicateImages(items) {
    const targets = Array.isArray(items) ? items : [];
    if (!targets.length) return;
    const ok = await confirmDialog(
      `删除 ${targets.length} 张重复图片？`,
      "会删除本地图片文件并移除对应的识别结果。若图片已被题库题目引用，则会跳过。",
      "删除",
      true
    );
    if (!ok) return;
    let removed = 0;
    const failed = [];
    const removedUrls = new Set();
    for (const item of targets) {
      const url = item.image_url || "";
      const name = url.split("/").pop() || "";
      try {
        await api(`/api/uploads/${encodeURIComponent(name)}`, { method: "DELETE" });
        removed += 1;
        removedUrls.add(url);
      } catch (error) {
        failed.push(`${item.filename || name}：${error.message}`);
      }
    }
    state.capture.duplicates = (state.capture.duplicates || []).filter((item) => !removedUrls.has(item.image_url));
    state.capture.drafts = state.capture.drafts.filter((draft) => !removedUrls.has(draft.image_url || draft.source_image));
    state.capture.results = (state.capture.results || []).filter((item) => !removedUrls.has(item.image_url));
    renderDrafts();
    if (failed.length) {
      showToast(`已删除 ${removed} 张，${failed.length} 张未能删除`, "error");
    } else {
      showToast(`已删除 ${removed} 张重复图片`, "success");
    }
  }

  function renderDraftCard(draft) {
    const qtype = draft.qtype || "single";
    const showOptions = !["fill", "truefalse"].includes(qtype);
    const options = draftOptions(draft);
    const answerField = qtype === "truefalse"
      ? `<select data-field="answer" class="tf-select ${tfTone(draft.answer, "truefalse")}">
          <option value="" ${!draft.answer ? "selected" : ""}>请选择</option>
          <option value="正确" ${draft.answer === "正确" ? "selected" : ""}>正确</option>
          <option value="错误" ${draft.answer === "错误" ? "selected" : ""}>错误</option>
        </select>`
      : `<input data-field="answer" value="${escapeHtml(draft.answer || "")}" placeholder="如 A / ABD / 填空答案">`;
    const warnings = (draft.warnings || []).filter(Boolean);
    const duplicate = draft.duplicate;
    const imageDup = !!draft.image_duplicate;
    const source = draft.source_image || "";
    return `<article class="draft-card ${draft.include ? "" : "excluded"} ${imageDup ? "image-dup" : ""}" data-uid="${draft.uid}">
      <div class="draft-top">
        <label class="checkbox"><input type="checkbox" data-field="include" ${draft.include ? "checked" : ""}>加入题库</label>
        <div class="draft-title">编号 <span class="draft-auto">保存后按题型自动生成</span></div>
        <div class="draft-badges">
          ${imageDup ? `<span class="badge image-dup">${svg("alert")}图片重复</span>` : ""}
          ${duplicate ? `<button type="button" class="badge duplicate link" data-view-question="${draft.duplicate_question_id || ""}" title="点击查看题库中已存在的原题">${svg("alert")}题库中已存在${draft.duplicate_question_id ? ` #${draft.duplicate_question_id}` : ""}</button>` : ""}
          ${duplicate && draft.duplicate_question_id ? `
            <button type="button" class="mark-wrong-btn${draft.markedWrong ? " done" : ""}" data-mark-wrong="${draft.duplicate_question_id}" ${draft.markedWrong ? "disabled" : ""} title="将题库中已存在的原题 #${draft.duplicate_question_id} 标记为回答错误（错误次数 +1，掌握度降为待攻克）">
              ${svg("close")}<span>${draft.markedWrong ? "已标记回答错误" : "再次标记回答错误"}</span>
            </button>` : ""}
          <span class="badge red wrong-badge" ${draftWasWrong(draft) ? "" : "hidden"}>原图答错</span>
          <span class="badge ${duplicate || imageDup ? "gray" : "green"}">识别置信度 ${Math.round((draft.confidence || 0) * 100)}%</span>
        </div>
        <div class="draft-controls">
          ${source ? `<button type="button" class="icon-btn" data-ai-enhance="${draft.uid}" title="用大模型重新解析此题（AI 增强识别）">${svg("spark")}</button>` : ""}
          <button type="button" class="icon-btn fix" data-add-correction="${draft.uid}" title="纠错：把误识别的字词改正并加入纠错词典">${svg("fix")}</button>
          ${source ? `<button type="button" class="icon-btn" data-view-image="${escapeHtml(source)}" title="查看原图">${svg("image")}</button>` : ""}
          ${imageDup ? `<button type="button" class="icon-btn dup" data-delete-dup-image="${escapeHtml(source)}" title="删除这张重复图片">${svg("trash")}</button>` : ""}
          <button type="button" class="icon-btn" data-remove-draft="${draft.uid}" title="移除这道题">${svg("trash")}</button>
        </div>
      </div>
      <div class="ai-note-row">
        <label class="ai-note-label">${svg("comment")}给大模型的纠正说明<span class="opt">（可选）</span></label>
        <input class="ai-note" data-ai-note placeholder="告诉大模型哪里识别错了，如：答案应为 B；第 3 空填「圆周率」；选项顺序有误" value="${escapeHtml(draft.ai_note || "")}">
      </div>
      <div class="draft-body">
        <div class="draft-main">
          <div class="field">
            <div class="field-head"><label>题干</label>${mergeButtonHtml("stem")}</div>
            <textarea data-field="stem" rows="4" class="draft-stem" placeholder="请补充题干">${escapeHtml(draft.stem || "")}</textarea>
          </div>
          <div class="field-row">
            <div class="field"><label>题型</label><select data-field="qtype">
              ${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${qtype === value ? "selected" : ""}>${label}</option>`).join("")}
            </select></div>
            <div class="field"><label>标签（用逗号分隔）</label><input data-field="tags" value="${escapeHtml((draft.tags || []).join("，"))}" placeholder="留空自动提取关键词"></div>
          </div>
          ${showOptions ? `<div class="field"><label>选项</label><div class="option-editor">
            ${Object.entries(options).map(([letter, text]) => `<div class="option-edit-row">
              <span class="option-letter">${letter}</span>
              <input data-option="${letter}" value="${escapeHtml(text)}" placeholder="选项 ${letter} 的内容">
              <button type="button" class="icon-btn" data-remove-option="${letter}" title="删除选项">${svg("close")}</button>
            </div>`).join("")}
            ${Object.keys(options).length < 8 ? `<button type="button" class="add-option" data-add-option="1">+ 添加选项</button>` : ""}
          </div></div>` : qtype === "truefalse"
            ? `<div class="draft-warning tf-note">判断题不需要 A/B/C/D 选项，练习时直接选择「正确 / 错误」。</div>`
            : `<div class="draft-warning">填空题不需要选项，直接填写答案即可。</div>`}
          <div class="field-row">
            <div class="field"><label>正确答案</label>${answerField}</div>
            <div class="field"><label>图片中的作答（可选）</label><input data-field="user_answer" value="${escapeHtml(draft.user_answer || "")}" placeholder="${qtype === "truefalse" ? "如 正确 / 错误" : "如 B"}"></div>
          </div>
          <div class="field">
            <div class="field-head"><label>解析</label>${mergeButtonHtml("explanation")}</div>
            <textarea data-field="explanation" rows="5" class="draft-explain" placeholder="可留空，之后在题库中补充">${escapeHtml(draft.explanation || "")}</textarea>
            ${mdPreviewHtml()}
          </div>
          ${warnings.length ? `<div class="draft-warning"><strong>请重点核对</strong>${warnings.map(escapeHtml).join("；")}</div>` : ""}
        </div>
        <aside class="draft-side">
          ${source ? `<img src="/${escapeHtml(source)}" alt="题目原图" data-view-image="${escapeHtml(source)}">` : `<div class="empty">${svg("image")}无原图</div>`}
          <div class="source-meta">${source ? "点击图片可查看原图" : "粘贴或上传截图后会保留原图"}<br>OCR 结果仅供参考，保存前请确认答案。</div>
        </aside>
      </div>
    </article>`;
  }

  function findDraft(uid) {
    return state.capture.drafts.find((draft) => draft.uid === uid);
  }

  function handleDraftClick(event) {
    const mergeBtn = event.target.closest("[data-merge-lines]");
    if (mergeBtn) {
      applyMergeLines(mergeBtn);
      return;
    }
    const deleteDup = event.target.closest("[data-delete-dup-image]");
    if (deleteDup) {
      const url = deleteDup.dataset.deleteDupImage;
      const item = (state.capture.duplicates || []).find((dup) => dup.image_url === url);
      deleteDuplicateImages([item || { image_url: url, filename: url.split("/").pop() }]);
      return;
    }
    const removeDraft = event.target.closest("[data-remove-draft]");
    if (removeDraft) {
      state.capture.drafts = state.capture.drafts.filter((draft) => draft.uid !== removeDraft.dataset.removeDraft);
      renderDrafts();
      return;
    }
    const aiEnhance = event.target.closest("[data-ai-enhance]");
    if (aiEnhance) {
      aiEnhanceDraft(aiEnhance.dataset.aiEnhance);
      return;
    }
    const viewImage = event.target.closest("[data-view-image]");
    if (viewImage) {
      openImageModal(viewImage.dataset.viewImage);
      return;
    }
    const viewQuestion = event.target.closest("[data-view-question]");
    if (viewQuestion && viewQuestion.dataset.viewQuestion) {
      const duplicateId = Number(viewQuestion.dataset.viewQuestion);
      openQuestionDetail(duplicateId, {
        title: `题库中已存在的原题 #${duplicateId}`,
        subtitle: "当前识别结果与它高度相似，确认无误可勾掉「加入题库」避免重复。",
        showEdit: false,
        showStats: false,
      });
      return;
    }
    const markWrong = event.target.closest("[data-mark-wrong]");
    if (markWrong && !markWrong.disabled) {
      markDuplicateQuestionWrong(Number(markWrong.dataset.markWrong), markWrong);
      return;
    }
    const addCorrection = event.target.closest("[data-add-correction]");
    if (addCorrection) {
      openCorrectionModal(addCorrection.dataset.addCorrection);
      return;
    }
    const addOption = event.target.closest("[data-add-option]");
    if (addOption) {
      const card = addOption.closest(".draft-card");
      const draft = findDraft(card.dataset.uid);
      const next = "ABCDEFGH".split("").find((letter) => draft.options[letter] === undefined);
      if (next) {
        draft.options[next] = "";
        renderDrafts();
      }
      return;
    }
    const removeOption = event.target.closest("[data-remove-option]");
    if (removeOption) {
      const card = removeOption.closest(".draft-card");
      const draft = findDraft(card.dataset.uid);
      delete draft.options[removeOption.dataset.removeOption];
      renderDrafts();
    }
  }

  // 把题库中已存在的原题再次标记为「回答错误」。
  // 触发场景：图片识题时上传了与题库某题高度相似的截图，除标记重复外，
  // 用户希望直接给该题记一次错误（错误次数 +1、掌握度降为待攻克）。
  async function markDuplicateQuestionWrong(questionId, button) {
    if (!questionId) return;
    const prevHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span><span>标记中…</span>`;
    try {
      const res = await api(`/api/questions/${encodeURIComponent(questionId)}/mark-wrong`, { method: "POST" });
      const draft = state.capture.drafts.find((item) => item.duplicate_question_id === questionId);
      if (draft) draft.markedWrong = true;
      // 直接更新按钮状态，避免整页重渲丢失其它草稿的编辑内容
      button.classList.add("done");
      button.innerHTML = `${svg("check")}<span>已标记回答错误</span>`;
      showToast(`已把原题 #${questionId} 标记为回答错误（错误次数 ${res.wrong_count}）`, "success");
      // 刷新错题/统计概览，让掌握度变化在其它视图即时体现
      refreshOverview();
    } catch (error) {
      button.disabled = false;
      button.innerHTML = prevHtml;
      showToast(`标记失败：${error.message}`, "error");
    }
  }

  function handleDraftInput(event) {
    const card = event.target.closest(".draft-card");
    if (!card) return;
    const draft = findDraft(card.dataset.uid);
    if (!draft) return;
    if (event.target.matches("[data-ai-note]")) {
      draft.ai_note = event.target.value;
      return;
    }
    if (event.target.matches("[data-field]")) {
      const field = event.target.dataset.field;
      if (field === "include") {
        draft.include = event.target.checked;
        card.classList.toggle("excluded", !draft.include);
        const included = state.capture.drafts.filter((item) => item.include).length;
        $("#draftMeta").textContent = `共识别 ${state.capture.drafts.length} 道题，已选择 ${included} 道。请核对题干、选项和答案。`;
      } else if (field === "tags") {
        draft.tags = event.target.value.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean);
      } else {
        draft[field] = event.target.value;
      }
      if (field === "answer") syncTfTone(event.target, draft.qtype);
      if (field === "answer" || field === "user_answer") {
        draft.was_wrong = draftWasWrong(draft);
        const badge = card.querySelector(".wrong-badge");
        if (badge) badge.hidden = !draft.was_wrong;
      }
      const mergeBtn = card.querySelector(`[data-merge-lines="${field}"]`);
      if (mergeBtn) mergeBtn.hidden = !event.target.value.includes("\n");
    }
    if (event.target.matches("[data-option]")) {
      draft.options[event.target.dataset.option] = event.target.value;
    }
  }

  function handleDraftChange(event) {
    const card = event.target.closest(".draft-card");
    if (!card) return;
    const draft = findDraft(card.dataset.uid);
    if (!draft) return;
    if (event.target.matches('[data-field="qtype"]')) {
      const previous = draft.qtype;
      draft.qtype = event.target.value;
      if (["fill", "truefalse"].includes(draft.qtype)) draft.options = {};
      if (draft.qtype === "truefalse") {
        const tf = normalizeTrueFalse(draft.answer);
        draft.answer = tf || "正确";
        draft.user_answer = normalizeTrueFalse(draft.user_answer) || "";
      } else if (previous === "truefalse") {
        if (!/^[A-H]+$/i.test(draft.answer || "")) draft.answer = "";
        if (!/^[A-H]+$/i.test(draft.user_answer || "")) draft.user_answer = "";
      }
      renderDrafts();
    }
    if (event.target.matches('[data-field="answer"]')) {
      draft.answer = event.target.value;
      syncTfTone(event.target, draft.qtype);
    }
    if (event.target.matches('[data-field="include"]')) {
      draft.include = event.target.checked;
      card.classList.toggle("excluded", !draft.include);
    }
  }

  function renderOcrRaw() {
    const container = $("#ocrRaw");
    const content = $("#ocrRawContent");
    const results = state.capture.results || [];
    if (!results.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    content.innerHTML = results
      .map(
        (result) => `<div style="padding:10px 0;border-top:1px solid #f0e7d6">
          <strong style="font-size:10px;color:#6d5b47">${escapeHtml(result.filename || "截图")} · ${result.line_count || 0} 行 · ${result.elapsed || 0}s</strong>
          <pre>${escapeHtml(result.raw_text || "")}</pre>
        </div>`
      )
      .join("");
  }

  function collectDrafts() {
    const selected = state.capture.drafts.filter((draft) => draft.include);
    if (!selected.length) {
      showToast("请至少选择一道题目", "error");
      return null;
    }
    const problems = [];
    selected.forEach((draft, index) => {
      const label = `第 ${index + 1} 道`;
      if (!draft.stem.trim()) problems.push(`${label}缺少题干`);
      if (!draft.answer.trim()) problems.push(`${label}缺少正确答案`);
      if (["single", "multiple"].includes(draft.qtype) && Object.values(draft.options).filter((value) => value.trim()).length < 2) {
        problems.push(`${label}选项不足 2 个`);
      }
      if (draft.qtype === "multiple" && normalizeLetters(draft.answer).length < 2) {
        problems.push(`${label}是多选题，但答案只有 1 个选项`);
      }
    });
    if (problems.length) {
      showToast(`${problems[0]}，请补充后再保存`, "error");
      return null;
    }
    return selected.map((draft) => ({
      stem: draft.stem.trim(),
      qtype: draft.qtype,
      options: ["fill", "truefalse"].includes(draft.qtype)
        ? {}
        : Object.fromEntries(Object.entries(draft.options).filter(([, value]) => value.trim())),
      answer: draft.answer.trim(),
      explanation: (draft.explanation || "").trim(),
      tags: draft.tags,
      source_image: draft.source_image,
      source_text: draft.source_text,
      user_answer: draft.user_answer || "",
      was_wrong: draftWasWrong(draft),
    }));
  }

  async function saveDrafts() {
    const questions = collectDrafts();
    if (!questions) return;
    const button = $("#saveDrafts");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>正在保存...`;
    try {
      const result = await api("/api/questions/bulk", { method: "POST", body: { questions } });
      const skipped = result.skipped?.length || 0;
      showToast(`已加入 ${result.created} 道题${skipped ? `，跳过 ${skipped} 道重复题` : ""}，可继续上传图片`, "success");
      state.capture.drafts = [];
      state.capture.results = [];
      state.capture.duplicates = [];
      state.capture.queue = [];
      renderDrafts();
      renderOcrRaw();
      renderCaptureQueue();
      $("#ocrProgress").hidden = true;
      await loadTags(true);
      // 保存后停留在图片识题页，方便继续添加题目（右上角「打开题库」可随时切走）
      loadDashboard();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      button.disabled = false;
      button.innerHTML = `${svg("check")}全部加入题库`;
    }
  }

  async function discardDrafts() {
    if (!state.capture.drafts.length) return;
    const ok = await confirmDialog("放弃本次识别结果？", "已识别的草稿将被清空，原图仍会保留在数据目录中。", "放弃", true);
    if (!ok) return;
    state.capture.drafts = [];
    state.capture.results = [];
    state.capture.duplicates = [];
    renderDrafts();
    renderOcrRaw();
  }

  // ---------------------------------------------------------------------
  // Tags / library
  // ---------------------------------------------------------------------
  // loadTags() / renderTags() 已上移到「标签缓存」模块：统一按服务端 revision 失效

  // 搜索范围决定 placeholder 文案：让用户一眼看出当前搜的是哪些内容
  function syncSearchScopeHint() {
    const scope = state.library.scope === "all" ? "all" : "stem";
    const select = $("#libSearchScope");
    if (select) select.value = scope;
    const input = $("#libSearch");
    if (input) {
      input.placeholder = scope === "all"
        ? "搜索题干、选项、解析或原图文字..."
        : "搜索题干、编号或标签...";
    }
    updateLibFilterCount();
  }

  // 手机端筛选栏：默认折叠，角标显示当前生效的筛选项数量
  function updateLibFilterCount() {
    const button = $("#libFilterToggle");
    if (!button) return;
    const selectActive = ["libType", "libStatus"]
      .filter((id) => $(`#${id}`) && $(`#${id}`).value).length;
    const tagActive = state.library.tags.length;
    const active = selectActive + tagActive + (state.library.scope === "all" ? 1 : 0);
    const count = $("#libFilterCount");
    if (count) {
      count.textContent = String(active);
      count.hidden = active === 0;
    }
    button.classList.toggle("has-filter", active > 0);
    button.title = active ? `已启用 ${active} 项筛选，点开可调整` : "展开筛选条件";
  }

  function bindLibrary() {
    syncSearchScopeHint();
    // 手机端下钻：两个入口卡片 → 进入对应区块；返回条 → 回到两入口首页
    $("#libMobileBack")?.addEventListener("click", exitLibMobile);
    $$('[data-libm-enter]').forEach((card) =>
      card.addEventListener("click", () => enterLibMobile(card.dataset.libmEnter))
    );
    // 桌面端子菜单：整卷考试 / 单题题库 分页切换（窄屏隐藏，沿用卡片下钻）
    $$('.lib-tab').forEach((tabEl) =>
      tabEl.addEventListener("click", () => setLibTab(tabEl.dataset.libTab))
    );
    $("#libSearchScope")?.addEventListener("change", () => {
      state.library.scope = $("#libSearchScope").value === "all" ? "all" : "stem";
      state.library.page = 1;
      syncSearchScopeHint();
      loadLibrary();
    });
    $("#libFilterToggle")?.addEventListener("click", () => {
      const bar = $(".library-toolbar");
      const open = bar.classList.toggle("filters-open");
      const button = $("#libFilterToggle");
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.classList.toggle("on", open);
      if (open) fitLibraryRows();
    });
    $("#libSearch").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.library.q = $("#libSearch").value.trim();
        state.library.page = 1;
        loadLibrary();
      }, 280);
    });
    ["libType", "libStatus", "libSort"].forEach((id) => {
      $(`#${id}`).addEventListener("change", () => {
        state.library.type = $("#libType").value;
        state.library.status = $("#libStatus").value;
        state.library.sort = $("#libSort").value;
        state.library.page = 1;
        updateLibFilterCount();
        loadLibrary();
      });
    });
    bindTagFilter();
    updateLibFilterCount();
    initLibraryPerPage();
    syncPerPageLabels();
    let customTimer = null;
    $("#libPerPage").addEventListener("change", () => {
      syncPerPageLabels();
      const value = $("#libPerPage").value;
      clearTimeout(customTimer);
      if (value === "custom") {
        setCustomPerPageVisible(true);
        const input = $("#libPerPageInput");
        if (!(Number(input.value) >= 1)) input.value = String(state.library.perPage);
        input.focus();
        input.select();
        applyCustomPerPage({ resetInvalid: true });
      } else {
        setCustomPerPageVisible(false);
        applyLibraryPerPage(value === "auto" ? "auto" : "fixed", value === "auto" ? 0 : Number(value));
      }
    });
    $("#libPerPageInput").addEventListener("input", () => {
      clearTimeout(customTimer);
      customTimer = setTimeout(applyCustomPerPage, 320);
    });
    $("#libPerPageInput").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      clearTimeout(customTimer);
      applyCustomPerPage({ resetInvalid: true });
      $("#libPerPageInput").blur();
    });
    $("#libPerPageInput").addEventListener("blur", () => {
      clearTimeout(customTimer);
      applyCustomPerPage({ resetInvalid: true });
    });
    $("#questionList").addEventListener("scroll", () => {
      if (state.view === "library") updateLibraryScrollHint();
    }, { passive: true });
    $("#questionList").addEventListener("click", handleQuestionListClick);
    $("#wrongList").addEventListener("click", handleQuestionListClick);
    // 窗口尺寸变化后重新计算每页行数 / 刷新滚动提示
    let fitTimer = null;
    window.addEventListener("resize", () => {
      if (state.view !== "library") return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        state.library.tried = new Set();
        state.library.fitDepth = 0;
        // 断点切换（手机 ↔ 桌面）后页码排布、统计文案和每页档位标签也要跟着换
        syncPerPageLabels();
        renderPager({ page: state.library.page, pages: state.library.pages });
        $("#libSummary").textContent = isPhoneLayout()
          ? `共 ${state.library.total} 题`
          : `共 ${state.library.total} 道题 · ${state.library.page} / ${state.library.pages} 页`;
        fitLibraryRows();
        updateLibraryScrollHint();
      }, 220);
    });
  }

  // ---------------------------------------------------------------------
  // 每页条数：预设档位 / 自定义数字 / 自适应，选择会记在浏览器本地
  // ---------------------------------------------------------------------
  const LIB_PER_PAGE_KEY = "wrongbook.library.perPage";
  const LIB_PER_PAGE_MAX = 100; // 与后端 /api/questions 的 per_page 上限一致

  // 手机端分页栏只有一行：下拉换成短标签，配合左侧「每页」前缀既不被
  // 原生箭头裁字，也读得懂；桌面仍显示「自适应 / 10 条 / 自定义…」。
  const PER_PAGE_COMPACT_LABEL = { auto: "自动", custom: "自定义" };
  function syncPerPageLabels() {
    const select = $("#libPerPage");
    if (!select) return;
    const compact = isPhoneLayout();
    Array.from(select.options).forEach((option) => {
      if (option.dataset.fullLabel === undefined) option.dataset.fullLabel = option.textContent;
      option.textContent = compact
        ? (PER_PAGE_COMPACT_LABEL[option.value] || option.value)
        : option.dataset.fullLabel;
    });
    const valueLabel = $("#libPerPageValue");
    if (valueLabel && select.selectedOptions[0]) valueLabel.textContent = select.selectedOptions[0].textContent;
  }

  function readLibraryPerPagePref() {
    try {
      const pref = JSON.parse(localStorage.getItem(LIB_PER_PAGE_KEY) || "null");
      if (!pref || typeof pref !== "object") return null;
      if (pref.mode === "auto") return { mode: "auto", value: 10 };
      const value = Math.max(1, Math.min(LIB_PER_PAGE_MAX, Math.round(Number(pref.value) || 10)));
      return { mode: pref.mode === "custom" ? "custom" : "fixed", value };
    } catch (_error) {
      return null;
    }
  }

  function saveLibraryPerPagePref(mode, value) {
    try {
      localStorage.setItem(LIB_PER_PAGE_KEY, JSON.stringify({ mode, value }));
    } catch (_error) {
      /* 隐私模式下可能不可用，忽略即可 */
    }
  }

  function setCustomPerPageVisible(visible) {
    const box = $("#libPerPageCustom");
    if (box) box.hidden = !visible;
  }

  function initLibraryPerPage() {
    const pref = readLibraryPerPagePref();
    // 手机屏幕高度有限，自适应容易收敛成「每页 1 条」；
    // 首次在手机上使用改为固定 10 条 + 列表内滚动，可随时切回自适应
    if (!pref && isPhoneLayout()) {
      state.library.perPageMode = "fixed";
      state.library.perPage = 10;
      const phoneSelect = $("#libPerPage");
      if (phoneSelect) phoneSelect.value = "10";
      setCustomPerPageVisible(false);
      return;
    }
    if (!pref || pref.mode === "auto") return;
    const select = $("#libPerPage");
    const input = $("#libPerPageInput");
    const presets = Array.from(select.options).map((option) => option.value);
    state.library.perPageMode = pref.mode;
    state.library.perPage = pref.value;
    input.value = String(pref.value);
    if (pref.mode === "custom" || !presets.includes(String(pref.value))) {
      select.value = "custom";
      setCustomPerPageVisible(true);
    } else {
      select.value = String(pref.value);
      setCustomPerPageVisible(false);
    }
  }

  function applyLibraryPerPage(mode, value) {
    const library = state.library;
    if (mode === "auto") {
      library.perPageMode = "auto";
      library.perPage = 10;
      library.rowHeight = 0;
      library.page = 1;
      document.body.classList.remove("lib-scroll");
      saveLibraryPerPagePref("auto", 0);
    } else {
      const n = Math.max(1, Math.min(LIB_PER_PAGE_MAX, Math.round(Number(value) || 10)));
      library.perPageMode = mode;
      library.perPage = n;
      library.page = 1;
      saveLibraryPerPagePref(mode, n);
    }
    library.tried = new Set();
    library.fitDepth = 0;
    loadLibrary();
  }

  function applyCustomPerPage(options = {}) {
    if ($("#libPerPage").value !== "custom") return;
    const input = $("#libPerPageInput");
    const raw = Number(input.value);
    if (!Number.isFinite(raw) || raw < 1) {
      // 失焦 / 回车时把非法输入还原成当前生效值，避免显示与列表不一致
      if (options.resetInvalid) input.value = String(state.library.perPage);
      return;
    }
    const n = Math.max(1, Math.min(LIB_PER_PAGE_MAX, Math.round(raw)));
    if (String(n) !== input.value.trim()) input.value = String(n);
    if (state.library.perPageMode === "custom" && state.library.perPage === n) return;
    applyLibraryPerPage("custom", n);
  }

  // 手动指定条数时，超出一屏的题目用列表内滚动条查看，并给出剩余条数提示
  function updateLibraryScrollHint() {
    const list = $("#questionList");
    const hint = $("#libScrollHint");
    const meta = $("#libListMeta");
    if (!list || !hint) return;
    const manual = state.library.perPageMode !== "auto";
    const overflow = list.scrollHeight > list.clientHeight + 2;
    document.body.classList.toggle("lib-scroll", manual && overflow);
    // 没有滚动提示时整行收起，避免列表上方多出一条空白
    if (meta) meta.hidden = !(manual && overflow);
    if (!manual || !overflow) {
      hint.hidden = true;
      hint.textContent = "";
      return;
    }
    const bottom = list.getBoundingClientRect().bottom;
    let below = 0;
    list.querySelectorAll(".question-row").forEach((row) => {
      if (row.getBoundingClientRect().bottom > bottom + 1) below += 1;
    });
    const count = state.library.items.length;
    hint.hidden = false;
    hint.textContent = below > 0
      ? `本页 ${count} 条 · 下方还有 ${below} 条，滚动查看 ↓`
      : `本页 ${count} 条已看完 · 用下方分页继续`;
  }

  const LIB_ROW_GAP = 10;

  // 记录列表里实际渲染出来的平均行高（题干长短会影响行高，所以要实测）
  // 注意：必须按子元素真实高度求平均，不能用 list.scrollHeight。
  // scrollHeight 在内容不满容器时会等于容器高度，末页只有一两条时会把
  // 「平均行高」算成整个容器的高度，进而把每页条数错误地压成 1。
  function measureLibraryRowHeight() {
    const list = $("#questionList");
    const items = state.library.items;
    if (!list || !items.length) return;
    // 展开解析的题卡高度异常，不参与行高基准的计算
    const rows = list.querySelectorAll(".question-row:not(.is-expanded)");
    if (!rows.length) return;
    let total = 0;
    rows.forEach((row) => {
      total += row.getBoundingClientRect().height;
    });
    const avg = total / rows.length;
    // 只在「满页」时更新行高基准，残页的样本不具代表性；
    // 并且只保留观测到的最大平均值，让基准单调稳定，自适应不会来回震荡。
    // 样本少于 3 条时也不采信 —— 一两条的偶然高度不该左右基准。
    if (avg > 24 && items.length >= state.library.perPage && rows.length >= 3) {
      state.library.rowHeight = Math.max(state.library.rowHeight || 0, avg);
    }
  }

  // 让每页行数自适应可视高度。
  // 目标条数由「可视高度 ÷ 实测平均行高」直接算出，与当前页实际渲染了几条
  // 无关 —— 这一点很关键：末页往往只有一两条，若拿它参与决策，末页那条
  // 长题会把每页条数错误地压到 1，结果每一页都只剩一条。
  // tried 记录试过的条数，避免「加一行又超界」来回震荡。
  function fitLibraryRows() {
    const list = $("#questionList");
    const items = state.library.items;
    const library = state.library;
    if (!list || !items.length) return;
    // 用户手动指定每页条数时，不再自动调整
    if (library.perPageMode !== "auto") return;
    if (library.fitDepth >= 4) return;
    const avail = list.clientHeight;
    if (avail <= 0) return;
    // 只有满页才会刷新行高基准；残页样本不具代表性，保持旧值
    measureLibraryRowHeight();
    const rowH = library.rowHeight || 118;
    const fit = Math.max(1, Math.min(40, Math.floor((avail + LIB_ROW_GAP) / (rowH + LIB_ROW_GAP))));
    const isFullPage = items.length >= library.perPage;
    const overflow = isFullPage && list.scrollHeight > avail + 1;
    let next = library.perPage;
    let shrinking = false;
    if (fit < library.perPage) {
      // 目标条数更少 → 直接收敛过去（减少永远不会造成内容被裁）
      next = fit;
      shrinking = true;
    } else if (fit > library.perPage && isFullPage && !overflow && library.total > items.length) {
      // 想变多，但必须确认当前满页确实放得下、且后面还有下一页
      next = fit;
    }
    if (next === library.perPage) return;
    // 缩减必须无条件生效（否则内容会被裁掉）；放大则要避开试过的值，防止来回震荡
    if (!shrinking && library.tried.has(next)) return;
    library.tried.add(next);
    library.perPage = next;
    library.fitDepth += 1;
    loadLibrary().finally(() => {
      library.fitDepth -= 1;
    });
  }

  async function loadLibrary() {
    const library = state.library;
    const params = new URLSearchParams();
    params.set("page", library.page);
    params.set("per_page", library.perPage);
    params.set("q", library.q);
    params.set("scope", library.scope);
    params.set("type", library.type);
    params.set("status", library.status);
    library.tags.forEach((tag) => params.append("tag", tag));
    params.set("sort", library.sort);
    $("#libSummary").textContent = "正在加载...";
    try {
      const data = await api(`/api/questions?${params.toString()}`);
      library.items = data.items || [];
      library.total = data.total || 0;
      library.pages = data.pages || 1;
      // 每页条数变化后，当前页可能已经越界（例如最后一页只剩 1 条时
      // 把 perPage 改大，页数会变少），需要把页码拉回有效范围
      if (library.page > library.pages) {
        library.page = library.pages;
        return loadLibrary();
      }
      const list = $("#questionList");
      renderQuestionList(list, library.items);
      // 换页、改每页条数、改筛选后一律回到本页顶部，避免停在上页滚到底的位置
      list.scrollTop = 0;
      renderPager(data);
      // 手机端统计只留总题数，页码信息已在分页区显示，避免挤占一行宽度
      $("#libSummary").textContent = isPhoneLayout()
        ? `共 ${data.total} 题`
        : `共 ${data.total} 道题 · ${data.page} / ${data.pages} 页`;
      // 单题数量：与整卷「N 份」并列的醒目标题计数（筛选后实时跟随）
      const qCount = $("#libQuestionsCount");
      if (qCount) qCount.textContent = data.total || 0;
      const libmQuestions = $("#libmCountQuestions");
      if (libmQuestions) libmQuestions.textContent = data.total || 0;
      fitLibraryRows();
      updateLibraryScrollHint();
      loadLibraryPapers();
    } catch (error) {
      $("#libSummary").textContent = "加载失败";
      showToast(error.message, "error");
    }
  }

  function renderQuestionList(container, items) {
    if (!items.length) {
      const searching = state.view === "library" && !!state.library.q;
      container.innerHTML = searching
        ? emptyState(
            "没有匹配的题目",
            `题干、编号和标签里没有「${state.library.q}」。可在「筛选」里把搜索范围切到「含选项解析」再找一次。`,
            "library",
          )
        : emptyState("这里还没有题目", "上传一张错题截图，或手动添加一道题。", "library");
      container.classList.add("q-empty");
      return;
    }
    container.classList.remove("q-empty");
    container.innerHTML = items.map((item, index) => renderQuestionRow(item, index)).join("");
  }

  // 找出正确答案对应的选项字母：答案通常是 "A" / "ACD" / "A、C"，
  // 也兼容历史上把选项全文当成答案的情况（按文本反查）。
  function correctOptionLetters(item) {
    const raw = String(item.answer || "").trim();
    if (!raw || !["single", "multiple"].includes(item.qtype)) return new Set();
    const upper = raw.toUpperCase();
    if (/^[A-H][A-H,，、\s]*$/.test(upper)) {
      return new Set(upper.replace(/[^A-H]/g, "").split(""));
    }
    const hit = Object.entries(item.options || {}).find(([, text]) => {
      const value = String(text || "").trim();
      return value && (value === raw || raw.includes(value));
    });
    return new Set(hit ? [hit[0]] : []);
  }

  // 「含选项解析」模式下，题干里没有关键词的题目必须说明「为什么会出现」，
  // 否则看起来就像筛选结果和题目无关（例如干扰项恰好带了这个关键词）。
  function matchHintFor(item) {
    if (state.view !== "library" || state.library.scope !== "all") return "";
    const keyword = (state.library.q || "").trim().toLowerCase();
    if (!keyword) return "";
    const main = `${item.stem || ""} ${item.qno || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
    if (main.includes(keyword)) return "";
    // 选项只展示真正命中的那一项，别把四个干扰项一起铺出来
    const optionHit = Object.entries(item.options || {})
      .find(([, text]) => String(text).toLowerCase().includes(keyword));
    const fields = [
      ["选项", optionHit ? `${optionHit[0]}. ${optionHit[1]}` : ""],
      ["解析", item.explanation || ""],
      ["原图文字", item.source_text || ""],
    ];
    const hit = fields.find(([, text]) => text && String(text).toLowerCase().includes(keyword));
    if (!hit) return "";
    const [label, raw] = hit;
    const text = String(raw).replace(/\s+/g, " ").trim();
    let snippet = text;
    if (label !== "选项") {
      const at = text.toLowerCase().indexOf(keyword);
      const start = Math.max(0, at - 10);
      const end = at + keyword.length + 22;
      snippet = (start ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    }
    return `<div class="q-match-hint" title="关键词命中在${label}"><span>命中${label}</span><i class="q-match-text">${escapeHtml(snippet)}</i></div>`;
  }

  function renderQuestionRow(item, index = 0) {
    const options = Object.entries(item.options || {});
    const correct = correctOptionLetters(item);
    const preview = options
      .slice(0, 8)
      .map(([letter, text]) => `<span class="${correct.has(letter) ? "is-correct" : ""}" title="${escapeHtml(text)}">${letter}. ${escapeHtml(text)}</span>`)
      .join("");
    // 窄屏只留这一行：至少让「正确答案对应哪个选项」看得见，不占篇幅
    const correctOptions = options.filter(([letter]) => correct.has(letter));
    // 单选时角标已写了字母，正文只放选项内容；多选才保留字母前缀避免混淆
    const correctText = correctOptions
      .map(([letter, text]) => (correctOptions.length === 1 ? text : `${letter}. ${text}`))
      .join("；");
    const correctLine = correctText
      ? `<div class="q-correct-line"><span class="q-correct-badge">${svg("check")}答案 ${escapeHtml(item.answer || "")}</span><span class="q-correct-text">${escapeHtml(correctText)}</span></div>`
      : "";
    const tags = (item.tags || []).map((tag) => `<span class="badge gray">${escapeHtml(tag)}</span>`).join("");
    const mastered = item.mastery >= 3;
    return `<article class="question-row" data-qid="${item.id}" style="--i:${index}">
      <div class="q-type-mark ${item.qtype}">${TYPE_MARKS[item.qtype] || "题"}</div>
      <div class="q-body">
        <div class="q-top">
          <span class="q-no">${escapeHtml(item.qno || "未编号")}</span>
          <span class="badge ${item.qtype === "single" ? "purple" : item.qtype === "multiple" ? "purple" : item.qtype === "truefalse" ? "green" : "amber"}">${typeLabel(item.qtype)}</span>
          ${tags}
        </div>
        <h3 class="q-stem">${escapeHtml(item.stem)}</h3>
        ${matchHintFor(item)}
        ${preview ? `<div class="q-options-preview">${preview}</div>` : ""}
        ${correctLine}
        <div class="q-meta">
          <span class="${item.wrong_count ? "warn" : ""}">错 ${item.wrong_count || 0} 次</span>
          <span>对 ${item.correct_count || 0} 次</span>
          <span>${masteryText(item.mastery)}</span>
          ${item.source_image ? `<span>有原图</span>` : ""}
          <span>${formatDate(item.created_at)}</span>
          ${expInlineBtnHtml(item, `q${item.id}`)}
        </div>
        ${expBlockHtml(item, `q${item.id}`)}
      </div>
      <div class="q-side">
        <div class="q-answer"><span>答案</span><strong class="${tfTone(item.answer, item.qtype)}" title="${escapeHtml(correctText || item.answer || "待补充")}">${escapeHtml(item.answer || "待补充")}</strong></div>
        <div class="q-mastery" title="掌握度 ${Math.round(masteryPercent(item.mastery))}%">
          <div class="mastery-bar"><i class="${item.mastery < 2 ? "low" : ""}" style="width:${masteryPercent(item.mastery)}%"></i></div>
        </div>
        <div class="q-actions">
          ${item.source_image ? `<button class="icon-btn" data-source="${escapeHtml(item.source_image)}" title="查看原图">${svg("image")}</button>` : ""}
          ${!mastered && item.wrong_count ? `<button class="icon-btn" data-master="${item.id}" title="标记已掌握">${svg("check")}</button>` : ""}
          <button class="icon-btn" data-edit="${item.id}" title="编辑">${svg("edit")}</button>
          <button class="icon-btn" data-delete="${item.id}" title="删除">${svg("trash")}</button>
        </div>
      </div>
    </article>`;
  }

  // ---------------------------------------------------------------------
  // 整卷考试：录入的整卷以「一行」呈现在「我的题库」里，与单题并列但不拆题。
  // 行内即可开考 / 编辑 / 改答案 / 删除，全部通过整卷入库的深链完成。
  // ---------------------------------------------------------------------
  function paperGroupState(p) {
    if (!p.attempt_count) return { cls: "idle", text: "尚未开考" };
    return p.in_wrong_book
      ? { cls: "bad", text: "待攻克" }
      : { cls: "ok", text: "已攻克" };
  }

  function renderPaperRow(p) {
    const state = paperGroupState(p);
    const title = p.title || ("整卷 " + p.id);
    const locked = p.verified === false;
    const examLabel = state.cls === "bad" ? "整卷重考" : "开考";
    const when = p.last_exam_at ? String(p.last_exam_at).replace("T", " ").slice(0, 16) : "";
    const reviewHint = "这份卷子的答案还没通过入库质检，考试与刷题都未开放；请先逐空订正并封卷。";
    return `
      <article class="question-row paper-row${locked ? " is-review" : ""}" data-paper-id="${p.id}">
        <div class="q-type-mark paper" title="整卷">卷</div>
        <div class="q-body">
          <div class="q-top">
            <span class="badge amber">${escapeHtml(p.language || "通用")}</span>
            <span class="paper-state ${state.cls}">${state.text}</span>
            ${locked
              ? '<span class="badge gray warn" title="' + reviewHint + '">待复核 · 不可作答</span>'
              : '<span class="badge gray">已封存</span>'}
          </div>
          <h3 class="q-stem">${escapeHtml(title)}</h3>
          <div class="q-meta">
            <span>共 ${p.blank_count || 0} 题</span>
            <span>已考 ${p.attempt_count || 0} 次</span>
            <span>最好 ${p.best_score || 0} 分</span>
            ${when ? `<span>${escapeHtml(when)}</span>` : ""}
          </div>
        </div>
        <div class="q-side">
          <div class="q-actions">
            ${locked
              ? `<button class="btn btn-ghost btn-sm" type="button" data-view="codepaper" data-cp-open="audit" data-cp-paper="${p.id}" title="${reviewHint}">${svg("edit")}去质检</button>`
              : `<button class="btn btn-primary btn-sm" type="button" data-view="codepaper" data-cp-open="exam" data-cp-paper="${p.id}">${svg("play")}${examLabel}</button>`}
            <span class="paper-acts">
              <button class="paper-act paper-act--edit" type="button" data-view="codepaper" data-cp-open="edit" data-cp-paper="${p.id}" title="编辑这份卷（改标题 / 类型 / 两份原文后重新封卷）">${svg("edit")}<span>编辑</span></button>
              <button class="paper-act paper-act--answers" type="button" data-view="codepaper" data-cp-open="edit-answers" data-cp-paper="${p.id}" title="逐空改答案">${svg("comment")}<span>改答案</span></button>
              ${locked ? "" : `<button class="paper-act paper-act--review" type="button" data-review-paper="${p.id}" title="查看完整试卷与标准答案，开考前先复习">${svg("book")}<span>复习</span></button>`}
              ${locked ? "" : `<button class="paper-act paper-act--history" type="button" data-view="codeHistory" data-ch-paper="${p.id}" title="查看这份卷的刷题与考试历史">${svg("history")}<span>历史</span></button>`}
            </span>
            <button class="icon-btn icon-btn-danger" type="button" data-delete-paper="${p.id}" title="删除这份卷">${svg("trash")}</button>
          </div>
        </div>
      </article>`;
  }

  // 整卷列表本地缓存：客户端筛选 + 分页，与单题题库同构
  let libraryPapers = [];
  let paperControlsBound = false;
  let paperPage = 1;
  let paperPerPage = 10;
  let paperFilterState = "";   // 状态筛选（idle / bad / ok）
  let paperQuery = "";         // 自由输入的模糊查询词
  let paperSelectedId = "";    // 从下拉选中的具体卷（非空时按 id 精确筛选）

  // 渲染整卷列表：先按「标题搜索 + 状态」筛选，再分页，最后刷新分页栏；
  // 不再限制单页显示条数——条数由「每页」控件决定（默认 10），其余翻页查看。
  function renderPapers() {
    const list = $("#libPaperList");
    const empty = $("#libPapersEmpty");
    const count = $("#libPapersCount");
    const summary = $("#libPaperSummary");
    if (!list) return;
    const q = paperQuery.trim();
    const filtered = libraryPapers.filter((p) => {
      if (paperSelectedId && String(p.id) !== String(paperSelectedId)) return false;
      // 自由输入走与「整卷历史」一致的模糊匹配：子串优先，其次顺序子序列
      if (!paperSelectedId && q && fuzzyMatch(q, p.title || ("整卷 " + p.id)) < 0) return false;
      if (paperFilterState && paperGroupState(p).cls !== paperFilterState) return false;
      return true;
    });
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / paperPerPage));
    if (paperPage > pages) paperPage = pages;
    if (paperPage < 1) paperPage = 1;
    const start = (paperPage - 1) * paperPerPage;
    const slice = filtered.slice(start, start + paperPerPage);
    if (total) {
      list.innerHTML = slice.map(renderPaperRow).join("");
      if (empty) empty.hidden = true;
    } else {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        const pEl = empty.querySelector("p");
        if (pEl) pEl.textContent = libraryPapers.length
          ? "没有匹配的整卷。"
          : "还没有整卷。点顶部「整卷考试」进整卷入库，录一份空白卷和答案参考，就会以一行出现在这里。";
      }
    }
    if (count) count.textContent = total;
    if (summary) {
      summary.textContent = total
        ? (pages > 1 ? `共 ${total} 份 · ${paperPage} / ${pages} 页` : `共 ${total} 份`)
        : "共 0 份";
    }
    renderPaperPager(pages);
    const pagerBar = $("#libPaperPagerBar");
    if (pagerBar) pagerBar.hidden = libraryPapers.length === 0;
  }

  // 整卷分页栏：与单题题库 renderPager 同构，但作用于客户端 libraryPapers
  function renderPaperPager(pages) {
    const pager = $("#libPaperPager");
    if (!pager) return;
    if (pages <= 1) { pager.innerHTML = ""; return; }
    const current = paperPage;
    let html;
    if (isPhoneLayout()) {
      html = `<button data-page="${current - 1}" ${current <= 1 ? "disabled" : ""} aria-label="上一页">‹</button>`
        + `<span class="pager-current">${current}/${pages}</span>`
        + `<button data-page="${current + 1}" ${current >= pages ? "disabled" : ""} aria-label="下一页">›</button>`;
    } else {
      const nums = [];
      const push = (n) => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
      push(1);
      if (current > 3) push(current - 2);
      if (current > 2) push(current - 1);
      push(current);
      if (current + 1 <= pages) push(current + 1);
      if (current + 2 <= pages) push(current + 2);
      push(pages);
      nums.sort((a, b) => a - b);
      let prev = 0; const parts = [];
      for (const n of nums) {
        if (n - prev > 1) parts.push("<span>…</span>");
        parts.push(`<button class="${n === current ? "active" : ""}" data-page="${n}">${n}</button>`);
        prev = n;
      }
      html = `<button data-page="${current - 1}" ${current <= 1 ? "disabled" : ""}>‹</button>`
        + parts.join("")
        + `<button data-page="${current + 1}" ${current >= pages ? "disabled" : ""}>›</button>`;
    }
    pager.innerHTML = html;
    Array.from(pager.querySelectorAll("[data-page]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const n = Number(btn.dataset.page);
        if (n >= 1 && n <= pages && n !== current) {
          paperPage = n;
          renderPapers();
          const list = $("#libPaperList");
          if (list) list.scrollTop = 0;
        }
      });
    });
  }

  function syncPaperPerPageLabel() {
    const sel = $("#libPaperPerPage");
    const val = $("#libPaperPerPageValue");
    if (sel && val) val.textContent = sel.value === "all" ? "全部" : sel.value + " 条";
  }

  // 整卷搜索组合框：与「整卷历史」同款交互（键入模糊筛选 / 点选具体卷 / 清除）。
  // 下拉改 fixed，避免被 .library-toolbar 的 overflow-x:auto 裁进卡片。
  function paperTitleById(id) {
    const p = libraryPapers.find((x) => String(x.id) === String(id));
    return p ? (p.title || ("整卷 " + p.id)) : "";
  }

  function placePaperCombo() {
    const list = $("#libPaperComboList");
    const box = $("#libPaperComboToggle");
    if (!list || !box || list.hidden) return;
    const r = box.getBoundingClientRect();
    const width = Math.round(r.width);
    const top = r.bottom + 6;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    list.style.top = top + "px";
    list.style.left = left + "px";
    list.style.width = width + "px";
    // 与整卷历史下拉同款：最多 280px，内部滚动；小窗口再按剩余视口高度收缩
    list.style.maxHeight = Math.min(280, Math.max(140, window.innerHeight - top - 12)) + "px";
  }

  function syncPaperComboClear() {
    const clr = $("#libPaperComboClear");
    if (clr) clr.hidden = !(paperSelectedId || paperQuery);
  }

  function renderPaperComboList() {
    const list = $("#libPaperComboList");
    if (!list) return;
    const q = paperQuery.trim();
    const opts = libraryPapers.slice().sort((a, b) =>
      (a.title || ("整卷 " + a.id)).localeCompare(b.title || ("整卷 " + b.id), "zh"));
    const matched = q ? opts.filter((p) => fuzzyMatch(q, p.title || ("整卷 " + p.id)) >= 0) : opts;
    const rows = ['<li class="ch-combo-opt ch-combo-all' + (!paperSelectedId && !q ? " is-active" : "") + '" role="option" tabindex="0" data-pid="">全部试卷</li>'];
    if (!matched.length && q) rows.push('<li class="ch-combo-empty" role="presentation">没有匹配的试卷</li>');
    matched.forEach((p) => {
      const title = p.title || ("整卷 " + p.id);
      rows.push('<li class="ch-combo-opt' + (String(paperSelectedId) === String(p.id) ? " is-active" : "") + '" role="option" tabindex="0" data-pid="' + escapeHtml(p.id) + '">' + escapeHtml(title) + "</li>");
    });
    list.innerHTML = rows.join("");
    if (!list.hidden) placePaperCombo();
  }

  function openPaperCombo() {
    const list = $("#libPaperComboList");
    const toggle = $("#libPaperComboToggle");
    if (!list) return;
    renderPaperComboList();
    list.hidden = false;
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    placePaperCombo();
  }

  function closePaperCombo() {
    const list = $("#libPaperComboList");
    const toggle = $("#libPaperComboToggle");
    if (!list) return;
    list.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function bindPaperControls() {
    if (paperControlsBound) return;
    paperControlsBound = true;

    // 下拉挂到 body：避开 toolbar 滚动容器的裁剪，也避开 .page 切页动画的 transform
    const comboListEl = $("#libPaperComboList");
    if (comboListEl && comboListEl.parentNode !== document.body) document.body.appendChild(comboListEl);

    const s = $("#libPaperSearch");
    if (s) {
      s.addEventListener("input", () => {
        paperQuery = s.value;
        paperSelectedId = "";   // 重新键入即切回「按名称模糊筛选」
        paperPage = 1;
        syncPaperComboClear();
        const list = $("#libPaperComboList");
        if (list && !list.hidden) renderPaperComboList(); else openPaperCombo();
        renderPapers();
      });
      s.addEventListener("focus", () => openPaperCombo());
      // 已聚焦时再点输入框也要能展开（focus 不会重复触发）
      s.addEventListener("click", () => {
        const list = $("#libPaperComboList");
        if (list && list.hidden) openPaperCombo();
      });
      s.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          openPaperCombo();
          const first = $("#libPaperComboList .ch-combo-opt");
          if (first) first.focus();
        } else if (e.key === "Escape") {
          closePaperCombo();
          s.blur();
        }
      });
    }
    const comboToggle = $("#libPaperComboToggle");
    if (comboToggle) comboToggle.addEventListener("click", (e) => {
      // 输入框自身由 focus/click 负责展开，避免 focus→open 与 click→toggle 互相打架
      if (e.target.closest(".ch-combo-clear") || e.target === s) return;
      const list = $("#libPaperComboList");
      if (list && list.hidden) openPaperCombo(); else closePaperCombo();
    });
    const comboClear = $("#libPaperComboClear");
    if (comboClear) comboClear.addEventListener("click", (e) => {
      e.stopPropagation();
      paperSelectedId = ""; paperQuery = "";
      if (s) s.value = "";
      paperPage = 1;
      syncPaperComboClear();
      closePaperCombo();
      renderPapers();
    });
    const comboList = $("#libPaperComboList");
    if (comboList) {
      comboList.addEventListener("click", (e) => {
        const opt = e.target.closest(".ch-combo-opt");
        if (!opt) return;
        const pid = opt.dataset.pid || "";
        paperSelectedId = pid;
        paperQuery = "";
        if (s) s.value = pid ? paperTitleById(pid) : "";
        paperPage = 1;
        syncPaperComboClear();
        closePaperCombo();
        renderPapers();
      });
      comboList.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const opt = e.target.closest(".ch-combo-opt");
          if (opt) opt.click();
        } else if (e.key === "Escape") {
          closePaperCombo();
          if (s) s.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = Array.from(comboList.querySelectorAll(".ch-combo-opt"));
          const at = items.indexOf(e.target);
          const next = e.key === "ArrowDown" ? items[at + 1] : items[at - 1];
          if (next) next.focus();
        }
      });
    }
    document.addEventListener("click", (e) => {
      // 列表已挂到 body，需把列表本身也算作「内部」，否则点选项会被外部处理器抢先关闭
      if (!e.target.closest("#libPaperCombobox, #libPaperComboList")) closePaperCombo();
    });
    window.addEventListener("resize", placePaperCombo);
    window.addEventListener("scroll", placePaperCombo, true);

    // 整卷考试的筛选条件常显（与单题题库一致），故无折叠开关；状态变更直接重渲染
    const st = $("#libPaperState");
    if (st) st.addEventListener("change", () => {
      paperFilterState = st.value;
      paperPage = 1;
      renderPapers();
    });

    const per = $("#libPaperPerPage");
    if (per) per.addEventListener("change", () => {
      paperPerPage = per.value === "all" ? 9999 : Number(per.value);
      syncPaperPerPageLabel();
      paperPage = 1;
      renderPapers();
    });
    syncPaperPerPageLabel();

    const lp = $("#libPaperList");
    if (lp) lp.addEventListener("click", (ev) => {
      const del = ev.target.closest("[data-delete-paper]");
      if (del) { deleteLibraryPaper(Number(del.dataset.deletePaper)); return; }
      const rev = ev.target.closest("[data-review-paper]");
      if (rev) { openPaperReview(Number(rev.dataset.reviewPaper)); }
    });
  }

  // 在「我的题库」原地删除整卷：弹本地确认框，不跳转到整卷入库页
  async function deleteLibraryPaper(id) {
    const p = libraryPapers.find((x) => x.id === id);
    const title = p ? (p.title || ("整卷 " + id)) : ("整卷 " + id);
    const ok = await confirmDialog(
      "删除这份整卷",
      "《" + title + "》的质检记录、历次成绩与错题本里的整卷组会一并删除，且无法恢复。",
      "删除", true
    );
    if (!ok) return;
    try {
      await api("/api/code-papers/papers/" + id, { method: "DELETE" });
      libraryPapers = libraryPapers.filter((x) => x.id !== id);
      if (String(paperSelectedId) === String(id)) {
        paperSelectedId = "";
        const se = $("#libPaperSearch");
        if (se) se.value = "";
        syncPaperComboClear();
      }
      renderPaperComboList();
      const countEl = $("#libPapersCount");
      if (countEl) countEl.textContent = libraryPapers.length;
      const band = $("#libPapers");
      if (band) band.hidden = libraryPapers.length === 0;
      renderPapers();
      showToast("卷子已删除。", "ok");
    } catch (e) {
      showToast("删除失败：" + (e && e.message ? e.message : e), "error");
    }
  }

  // 在「我的题库」行内「复习」：弹出完整试卷 + 标准答案，供开考前过一遍。
  // 完整版来自封卷结果（run.code_template 的 {{n}} 用 blank_checks.filled_raw 回填），
  // 并提供「显示答案」开关：隐藏答案时可自测，勾选后再对答案。
  async function openPaperReview(id) {
    let paper;
    try {
      const d = await api("/api/code-papers/papers/" + id);
      paper = (d && d.paper) || {};
    } catch (e) {
      openModal({
        title: "无法打开复习",
        body: '<p class="modal-hint">' + escapeHtml((e && e.message) ? e.message : String(e)) + '</p>',
        footer: '<button class="btn btn-primary" data-close-modal>知道了</button>'
      });
      return;
    }
    const run = paper.run || {};
    const tpl = run.code_template || "";
    const blanks = run.blanks || [];
    const checks = run.checks || [];
    const ansByNo = {};
    checks.forEach((c) => { if (c.blank_no != null) ansByNo[c.blank_no] = (c.filled_raw != null ? String(c.filled_raw) : ""); });
    const title = paper.title || ("整卷 " + id);
    const lang = paper.language || "通用";
    const total = blanks.length;
    let show = true;

    function renderPaper() {
      if (!tpl) return '<p class="modal-hint">这份卷子还没有可用的试卷内容，请先在「录入试卷」里重新封卷。</p>';
      return tpl.split("\n").map((line) => {
        const html = line.split(/(\{\{\d+\}\})/g).map((part) => {
          const m = part.match(/^\{\{(\d+)\}\}$/);
          if (m) {
            const no = Number(m[1]);
            const ans = ansByNo[no] != null ? ansByNo[no] : "";
            return show
              ? '<span class="cp-rev-ans" title="B' + no + '">' + escapeHtml(ans || "—") + '</span>'
              : '<span class="cp-rev-blank" title="B' + no + '"></span>';
          }
          return escapeHtml(part);
        }).join("");
        return '<div class="cp-review-line">' + (html || "&nbsp;") + '</div>';
      }).join("");
    }
    function renderKeys() {
      if (!total) return '<p class="modal-hint">这份卷子还没有解析出空位。</p>';
      return blanks.map((b) => {
        const no = b.global_no != null ? b.global_no : "";
        const ans = ansByNo[no] != null ? ansByNo[no] : "";
        return '<div class="cp-review-key"><span class="cp-review-key-no">B' + no + '</span><span class="cp-review-key-ans">' + escapeHtml(ans || "—") + '</span></div>';
      }).join("");
    }

    const body =
      '<div class="cp-review">' +
        '<div class="cp-review-bar">' +
          '<div class="cp-review-meta">' +
            '<span class="badge amber">' + escapeHtml(lang) + '</span>' +
            '<span>共 ' + total + ' 空</span>' +
            (paper.verified
              ? '<span>已封存</span>'
              : '<span class="cp-review-warn" title="答案尚未通过入库质检，考试与刷题都未开放">待复核 · 不可作答</span>') +
          '</div>' +
          '<label class="cp-review-toggle"><input type="checkbox" id="cpRevToggle" checked><span>显示答案</span></label>' +
        '</div>' +
        '<div class="cp-review-paper" id="cpRevPaper"></div>' +
        '<details class="cp-review-keys-wrap">' +
          '<summary>答案对照（B1–B' + total + '）</summary>' +
          '<div class="cp-review-keys" id="cpRevKeys"></div>' +
        '</details>' +
      '</div>';

    const footer =
      '<button class="btn btn-ghost" data-close-modal>关闭</button>' +
      (paper.verified
        ? '<button class="btn btn-primary" data-close-modal data-view="codepaper" data-cp-open="exam" data-cp-paper="' + id + '">' + svg("play") + '开考这份</button>'
        : '<button class="btn btn-primary" data-close-modal data-view="codepaper" data-cp-open="audit" data-cp-paper="' + id + '" title="答案待复核，考试与刷题都未开放">' + svg("edit") + '去质检订正</button>');

    const root = openModal({
      title: "复习 · " + title,
      subtitle: "完整试卷与标准答案 · 开考前先过一遍",
      wide: true,
      bodyClass: "cp-review-body",
      body, footer
    });

    const paperEl = $("#cpRevPaper", root);
    const keysEl = $("#cpRevKeys", root);
    if (paperEl) paperEl.innerHTML = renderPaper();
    if (keysEl) keysEl.innerHTML = renderKeys();
    const tog = $("#cpRevToggle", root);
    if (tog) tog.addEventListener("change", () => {
      show = tog.checked;
      if (paperEl) paperEl.innerHTML = renderPaper();
    });
  }

  async function loadLibraryPapers() {
    const band = $("#libPapers");
    const count = $("#libPapersCount");
    if (!band) return;
    try {
      const d = await api("/api/code-papers/papers");
      libraryPapers = d.items || [];
      if (count) count.textContent = libraryPapers.length;
      const libmPapers = $("#libmCountPapers");
      if (libmPapers) libmPapers.textContent = libraryPapers.length;
      band.hidden = libraryPapers.length === 0;
      if ($("#libPapersEmpty")) $("#libPapersEmpty").hidden = libraryPapers.length !== 0;
      bindPaperControls();
      renderPaperComboList();
      syncPaperComboClear();
      renderPapers();
    } catch (error) {
      band.hidden = true;
      if ($("#libPapersEmpty")) $("#libPapersEmpty").hidden = false;
    }
  }

  // 手机端「我的题库」下钻：home（两入口）/ papers（只整卷）/ questions（只单题）。
  // 桌面端不影响——CSS 只在窄屏/触屏媒体查询里按 data-libm 状态切换显隐。
  function setLibMobileSection(section) {
    const lp = document.querySelector('.page[data-page="library"]');
    if (!lp) return;
    lp.dataset.libm = section;
    const back = $("#libMobileBack");
    if (back) {
      const label = back.querySelector(".libm-back-label");
      if (label) label.textContent = section === "papers" ? "整卷考试" : "单题题库";
    }
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  function enterLibMobile(section) {
    if (section === "papers") loadLibraryPapers();
    else if (section === "questions") loadLibrary();
    setLibMobileSection(section);
    requestAnimationFrame(renderPapers);
  }
  function exitLibMobile() {
    setLibMobileSection("home");
  }

  // 桌面端子菜单切换：整卷考试 / 单题题库 二选一显示，缓解拥挤
  function setLibTab(tab) {
    const lp = document.querySelector('.page[data-page="library"]');
    if (!lp) return;
    lp.dataset.libTab = tab;
    $$('.lib-tab').forEach((t) => {
      const active = t.dataset.libTab === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (tab === "papers") {
      requestAnimationFrame(renderPapers);
    } else {
      requestAnimationFrame(fitLibraryRows);
    }
  }

  function renderPager(data) {
    const pager = $("#libPager");
    if (!data || data.pages <= 1) {
      pager.innerHTML = "";
      return;
    }
    const current = data.page;
    const total = data.pages;
    let html;
    if (isPhoneLayout()) {
      // 窄屏整排页码按钮塞不进一行：只留翻页箭头 + 「当前/总页」
      html = `<button data-page="${current - 1}" ${current <= 1 ? "disabled" : ""} aria-label="上一页">‹</button>`
        + `<span class="pager-current">${current}/${total}</span>`
        + `<button data-page="${current + 1}" ${current >= total ? "disabled" : ""} aria-label="下一页">›</button>`;
    } else {
      const pages = [];
      const push = (number) => {
        if (!pages.includes(number) && number >= 1 && number <= total) pages.push(number);
      };
      push(1);
      if (current > 3) push(current - 2);
      if (current > 2) push(current - 1);
      push(current);
      push(current + 1);
      push(current + 2);
      push(total);
      pages.sort((a, b) => a - b);
      let previous = 0;
      const parts = [];
      for (const number of pages) {
        if (number - previous > 1) parts.push(`<span>...</span>`);
        parts.push(`<button class="${number === current ? "active" : ""}" data-page="${number}">${number}</button>`);
        previous = number;
      }
      html = `<button data-page="${current - 1}" ${current <= 1 ? "disabled" : ""}>‹</button>${parts.join("")}<button data-page="${current + 1}" ${current >= total ? "disabled" : ""}>›</button>`;
    }
    pager.innerHTML = html;
    $$("[data-page]", pager).forEach((button) => {
      button.addEventListener("click", () => {
        const page = Number(button.dataset.page);
        if (page >= 1 && page <= total && page !== current) {
          state.library.page = page;
          // 列表内部滚动条由 loadLibrary 统一回到顶部，整页不滚动
          loadLibrary();
        }
      });
    });
  }

  async function handleQuestionListClick(event) {
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      openQuestionEditor(Number(edit.dataset.edit));
      return;
    }
    const del = event.target.closest("[data-delete]");
    if (del) {
      const id = Number(del.dataset.delete);
      const ok = await confirmDialog("删除这道题？", "题目、原图和练习记录会一起删除，此操作不可撤销。", "删除", true);
      if (!ok) return;
      try {
        await api(`/api/questions/${id}`, { method: "DELETE" });
        showToast("题目已删除", "success");
        if (state.view === "library") loadLibrary();
        if (state.view === "wrong") loadWrongBook();
        loadDashboard();
        loadTags(true);
      } catch (error) {
        showToast(error.message, "error");
      }
      return;
    }
    const master = event.target.closest("[data-master]");
    if (master) {
      try {
        await api(`/api/questions/${master.dataset.master}/master`, { method: "POST" });
        showToast("已标记为掌握", "success");
        if (state.view === "library") loadLibrary();
        if (state.view === "wrong") loadWrongBook();
        loadDashboard();
      } catch (error) {
        showToast(error.message, "error");
      }
      return;
    }
    const source = event.target.closest("[data-source]");
    if (source) {
      const qid = Number(source.closest(".question-row")?.dataset.qid || 0);
      openLibraryImage(source.dataset.source, qid);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // 「给大模型的提示词」：凡是出现 AI 识别按钮的地方都要有它，并且成对出现/隐藏。
  // 采集页草稿卡片沿用早期的 [data-ai-note]，readAiHint 同时兼容两者。
  // ---------------------------------------------------------------------
  const AI_HINT_PLACEHOLDER = "告诉大模型哪里识别错了，如：答案应为 B；第 3 空填「圆周率」；选项顺序有误";

  function aiHintHtml({ collapsible = false, grouped = false, value = "" } = {}) {
    // 「点 AI 识别时一起发给模型」这句把提示词和 AI 识别动作直接绑在一起，
    // 不知道的人也能一眼看懂：想纠正识别结果，就在这里写一句再点 AI 识别。
    const head = `${svg("comment")}给大模型的提示词<span class="opt">（可选 · 点「AI 识别」时一起发给模型）</span>`;
    const input = `<input class="ai-hint-input" data-ai-hint type="text" maxlength="500" placeholder="${escapeHtml(AI_HINT_PLACEHOLDER)}" value="${escapeHtml(value)}" aria-label="给大模型的提示词">`;
    if (grouped) {
      // 编辑器折叠区专用：紧贴在识别工具行下方，用强调色块标明归属，不再像孤零零的表单项。
      // 主标题与说明拆成两行，手机端也不会挤成一行难读。
      return `<div class="ai-rec-hint" data-ai-hint-row>
        <div class="ai-rec-hint-head">${svg("comment")}<span class="ai-rec-hint-title">给大模型的提示词</span><span class="opt">可选 · 点「AI 识别」时一起发给模型</span></div>
        ${input}
      </div>`;
    }
    if (collapsible) {
      return `<details class="ai-hint-row is-collapsible" data-ai-hint-row><summary class="ai-hint-summary">${head}<i class="ai-hint-caret" aria-hidden="true"></i></summary>${input}</details>`;
    }
    return `<div class="ai-hint-row" data-ai-hint-row><label class="ai-hint-label">${head}</label>${input}</div>`;
  }

  function readAiHint(scope) {
    const el = scope?.querySelector?.("[data-ai-hint]") || scope?.querySelector?.("[data-ai-note]");
    return String(el?.value || "").trim().slice(0, 500);
  }

  function removeAiHint(scope) {
    scope?.querySelector?.("[data-ai-hint-row]")?.remove();
    scope?.querySelector?.(".ai-note-row")?.remove();
  }

  // ---------------------------------------------------------------------
  // Question editor modal
  // ---------------------------------------------------------------------
  function optionRowsHtml(options) {
    const values = { A: "", B: "", C: "", D: "", ...(options || {}) };
    return Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([letter, text]) => `<div class="option-edit-row">
          <span class="option-letter">${letter}</span>
          <input data-option="${letter}" value="${escapeHtml(text)}" placeholder="选项 ${letter} 的内容">
          <button type="button" class="icon-btn" data-remove-option="${letter}" title="删除选项">${svg("close")}</button>
        </div>`
      )
      .join("");
  }

  async function openQuestionEditor(id, editorOptions = {}) {
    let item = null;
    if (id) {
      try {
        // 练习中编辑要读服务端最新题目，别用手机端可能过期的本地快照
        const data = await api(`/api/questions/${id}`, editorOptions.fresh ? { bypassOffline: true } : {});
        item = data.item;
      } catch (error) {
        showToast(error.message, "error");
        return;
      }
    }
    const isNew = !item;
    const current = item || {
      qno: "",
      stem: "",
      qtype: "single",
      options: { A: "", B: "", C: "", D: "" },
      answer: "",
      explanation: "",
      tags: [],
      note: "",
    };
    // 录入时「图片里选了什么答案 / 是不是错题」存在作答记录里，编辑时也要能看到，
    // 免得重新识别后误以为这部分信息被清掉了。
    const originRow = isNew ? "" : `<div class="q-origin-answer">
      <div><b>图片中的作答：</b><strong>${escapeHtml(current.user_answer || "未记录")}</strong>
        ${current.was_wrong ? `<span class="badge red">原图答错</span>` : `<span class="badge gray">未标记错题</span>`}
        <span class="q-origin-stat">错 ${current.wrong_count || 0} 次 · 对 ${current.correct_count || 0} 次</span></div>
      <small>这是错题截图里当时选的答案，重新识别不会改动它和错题状态。</small>
    </div>`;
    // 所有编辑已有题目的入口（题库、题目详情、练习页）都给一条重识别捷径，
    // 默认收起成一行，窄屏不挤占表单；没有关联原图时整块不出现。
    // 识别结果只填表，不直接写库，用户确认后由表单统一保存。
    const canRerecognize = !isNew && !!current.source_image;
    const recBar = canRerecognize
      ? `<details class="editor-rec" id="editorRec">
          <summary class="editor-rec-toggle" title="展开后可用本地 OCR 或大模型重新识别">
            ${svg("refresh")}<span>用原图重新识别</span>
            <small>结果先填入表单 · 可给 AI 一句提示词</small>
            <i class="editor-rec-caret" aria-hidden="true"></i>
          </summary>
          <div class="editor-rec-body" id="editorRecBar">
            <div class="editor-rec-text"><span>识别不会改动「图片中的作答」和错题记录；本地 OCR 不联网，AI 识别可能需要几十秒。</span></div>
            <div class="editor-rec-actions">
              <a class="btn btn-ghost btn-sm" href="/${escapeHtml(String(current.source_image).replace(/^\/+/, ""))}" target="_blank" rel="noopener" title="在新标签页查看题目原图">${svg("image")}原图</a>
              <button type="button" class="btn btn-ghost btn-sm" data-editor-rec="ocr" title="用本地 OCR 重新识别，不联网">${svg("refresh")}本地识别</button>
              <button type="button" class="btn btn-ghost btn-sm ai" data-editor-rec="ai" title="用大模型重新识别这道题">${svg("spark")}AI 识别</button>
              <span class="editor-rec-status" id="editorRecStatus" role="status" aria-live="polite"></span>
            </div>
            ${aiHintHtml({ grouped: true })}
          </div>
        </details>`
      : "";
    const body = `<form id="questionForm">
      ${originRow}
      ${recBar}
      <div class="field-row">
        <div class="field"><label>题型</label><select name="qtype" id="editorType">
          ${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${current.qtype === value ? "selected" : ""}>${label}</option>`).join("")}
        </select></div>
      </div>
      <div class="field"><div class="field-head"><label>题干</label>${mergeButtonHtml("stem")}</div><textarea name="stem" rows="4" class="draft-stem" placeholder="输入题干，选择题建议保留括号">${escapeHtml(current.stem || "")}</textarea></div>
      <div class="field" id="editorOptionsField"><label>选项</label><div class="option-editor" id="editorOptions">${optionRowsHtml(current.options)}</div>
        <button type="button" class="add-option" id="editorAddOption">+ 添加选项</button>
      </div>
      <div class="draft-warning tf-note" id="editorTypeNote" hidden>判断题不需要 A/B/C/D 选项，练习时直接选择「正确 / 错误」。</div>
      <div class="field-row">
        <div class="field"><label>正确答案</label><input name="answer" class="tf-input ${tfTone(current.answer, current.qtype)}" value="${escapeHtml(current.answer || "")}" placeholder="如 A / ABD / 正确 / 填空答案"></div>
        <div class="field"><label>标签（逗号分隔）</label><input name="tags" value="${escapeHtml((current.tags || []).join("，"))}" placeholder="留空自动提取关键词"></div>
      </div>
      <div class="field"><div class="field-head"><label>解析</label>${mergeButtonHtml("explanation")}</div><textarea name="explanation" rows="4" class="draft-explain" placeholder="可留空">${escapeHtml(current.explanation || "")}</textarea>${mdPreviewHtml()}</div>
      <div class="field"><label>备注</label><input name="note" value="${escapeHtml(current.note || "")}" placeholder="可选"></div>
    </form>`;
    openModal({
      title: isNew ? "手动添加题目" : "编辑题目",
      badge: isNew ? "" : `编号 ${current.qno || "—"}`,
      subtitle: isNew
        ? "填写题目内容，保存后可继续录入下一题。"
        : (editorOptions.subtitle || "修改后会影响之后的练习与判分。"),
      body,
      footer: isNew
        ? `<button class="btn btn-ghost" data-close-modal>完成</button><button class="btn btn-primary" type="submit" form="questionForm">${svg("check")}保存并继续</button>`
        : `<button class="btn btn-ghost" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="questionForm">${svg("check")}保存题目</button>`,
      wide: true,
    });
    const form = $("#questionForm");
    syncMergeButtons($("#modalRoot"));
    // 解析里可能是 Markdown：配一块实时预览，保存前就能核对渲染效果
    attachMdPreview(form.querySelector("textarea[name='explanation']"));
    const optionsField = $("#editorOptionsField");
    const syncType = () => {
      const type = $("#editorType").value;
      const useOptions = ["single", "multiple"].includes(type);
      optionsField.hidden = !useOptions;
      $("#editorTypeNote").hidden = type !== "truefalse";
      syncTfTone(form.answer, type);
    };
    $("#editorType").addEventListener("change", syncType);
    syncType();
    if (canRerecognize) {
      const root = $("#modalRoot");
      // 大模型没配好就把 AI 按钮和配套的提示词输入一起摘掉，别让用户点了才报错
      const dropAi = () => {
        $('[data-editor-rec="ai"]', root)?.remove();
        removeAiHint(root);
      };
      api("/api/llm/config")
        .then((cfg) => {
          if (cfg && cfg.enabled && (cfg.profiles || []).length) return;
          dropAi();
        })
        .catch(dropAi);
      // 折叠区收起时按钮也在 DOM 里，事件可以提前绑好
      $$("[data-editor-rec]", root).forEach((button) => {
        button.addEventListener("click", () => applyEditorRerecognize(button.dataset.editorRec, button));
      });
    }
    async function applyEditorRerecognize(mode, btn) {
      if (!current.id) return;
      if (SYNC_ENABLED && sync.offline) {
        showToast("离线时不能重新识别，连上电脑同步后再试", "error");
        return;
      }
      const status = $("#editorRecStatus");
      const buttons = $$("[data-editor-rec]");
      const old = btn.innerHTML;
      const correction = mode === "ai" ? readAiHint($("#modalRoot")) : "";
      buttons.forEach((b) => { b.disabled = true; });
      // 按钮只转圈，不变成「识别中…」；进度提示放在工具行里，不遮挡表单
      btn.innerHTML = `<span class="spinner"></span>`;
      if (status) {
        status.textContent = mode !== "ai"
          ? "本地 OCR 识别中…"
          : (correction ? "大模型识别中（已带上补充提示）…" : "大模型识别中，可能需要几十秒…");
      }
      try {
        const data = await api(`/api/questions/${current.id}/rerecognize`, {
          method: "POST", body: { mode, correction }, bypassOffline: true,
        });
        const draft = data.draft || {};
        // 这次没认出来的字段沿用表单原值，避免答案 / 选项凭空消失
        if (draft.stem) form.stem.value = draft.stem;
        if (draft.qtype) $("#editorType").value = draft.qtype;
        syncType();
        if (draft.options && Object.keys(draft.options).length) {
          $("#editorOptions").innerHTML = optionRowsHtml(draft.options);
        }
        if (draft.answer) form.answer.value = draft.answer;
        syncTfTone(form.answer, $("#editorType").value);
        if (draft.explanation) form.explanation.value = draft.explanation;
        if (draft.tags && draft.tags.length) form.tags.value = draft.tags.join("，");
        syncMergeButtons($("#modalRoot"));
        if (data.ai_error) {
          showToast(`大模型识别失败，已填入本地 OCR 结果：${data.ai_error}`, "error");
        } else {
          showToast(
            mode === "ai"
              ? (correction ? "AI 识别结果已按提示词填入表单，确认后点「保存题目」" : "AI 识别结果已填入表单，确认后点「保存题目」")
              : "本地识别结果已填入表单，确认后点「保存题目」",
            "success",
          );
        }
      } catch (error) {
        showToast(error.message || "重新识别失败", "error");
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
        btn.innerHTML = old;
        if (status) status.textContent = "";
      }
    }
    const resetEditor = () => {
      form.stem.value = "";
      form.answer.value = "";
      form.explanation.value = "";
      form.tags.value = "";
      form.note.value = "";
      $("#editorOptions").innerHTML = optionRowsHtml({});
      syncType();
      form.stem.focus();
    };
    $("#editorAddOption").addEventListener("click", () => {
      const existing = $$("#editorOptions [data-option]").map((input) => input.dataset.option);
      const next = "ABCDEFGH".split("").find((letter) => !existing.includes(letter));
      if (next) $("#editorOptions").insertAdjacentHTML("beforeend", `<div class="option-edit-row"><span class="option-letter">${next}</span><input data-option="${next}" placeholder="选项 ${next} 的内容"><button type="button" class="icon-btn" data-remove-option="${next}" title="删除选项">${svg("close")}</button></div>`);
    });
    $("#editorOptions").addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-option]");
      if (remove) remove.closest(".option-edit-row").remove();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const type = $("#editorType").value;
      const options = {};
      if (["single", "multiple"].includes(type)) {
        $$("#editorOptions [data-option]").forEach((input) => {
          if (input.value.trim()) options[input.dataset.option] = input.value.trim();
        });
      }
      const payload = {
        stem: form.stem.value.trim(),
        qtype: type,
        options,
        answer: form.answer.value.trim(),
        explanation: form.explanation.value.trim(),
        tags: form.tags.value,
        note: form.note.value.trim(),
      };
      if (!payload.stem) {
        showToast("题干不能为空", "error");
        return;
      }
      if (!payload.answer) {
        showToast("正确答案不能为空", "error");
        return;
      }
      if (["single", "multiple"].includes(type) && Object.keys(options).length < 2) {
        showToast("选择题至少需要 2 个选项", "error");
        return;
      }
      const submitButton = $('[type="submit"][form="questionForm"]');
      submitButton.disabled = true;
      try {
        const saved = await api(isNew ? "/api/questions" : `/api/questions/${item.id}`, {
          method: isNew ? "POST" : "PUT",
          body: payload,
        });
        await loadTags(true);
        if (state.view === "library") loadLibrary();
        if (state.view === "wrong") loadWrongBook();
        // 从学习统计的「题目详情 → 编辑本题」保存后，最易错列表也要跟着更新
        if (state.view === "stats") loadStats();
        loadDashboard();
        if (isNew) {
          // 新增成功后清空表单并保留弹窗，方便连续录入下一题
          resetEditor();
          showToast("题目已添加，可继续录入下一题", "success");
        } else {
          closeModal();
          // 练习中编辑：把服务端返回的最新题目回灌到当前这一题，原地刷新题面
          // 注意：submit 回调里有局部变量 options（选项字典），这里必须用 editorOptions
          if (editorOptions.onSaved) editorOptions.onSaved(saved && saved.item ? saved.item : saved);
          else showToast("修改已保存", "success");
        }
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Practice
  // ---------------------------------------------------------------------
  function preparePracticeView() {
    if (state.practice.session) {
      if (!$("#quizPanel").hidden) startPracticeTimer();
      return;
    }
    $("#practiceSetup").hidden = false;
    $("#quizPanel").hidden = true;
    $("#resultPanel").hidden = true;
    syncPracticeMode();
    loadTags();
    if (state.overview) {
      $("#practiceReadyCount").textContent = state.overview.ready || 0;
      applyPracticeModeAvailability();
    } else {
      api("/api/overview").then((data) => {
        state.overview = data;
        applyOverview(data);
        $("#practiceReadyCount").textContent = data.ready || 0;
      }).catch(() => {});
    }
  }

  // 各练习模式当前还能练多少题。
  // 口径与后端取题完全一致：archived=0 且有答案，错题需 wrong_count>0 且 mastery<3。
  function practiceModeCounts() {
    const overview = state.overview;
    if (!overview) return null;
    const counts = overview.practice_counts;
    if (counts) {
      return {
        wrong: Number(counts.wrong) || 0,
        random: Number(counts.random) || 0,
        unseen: Number(counts.unseen) || 0,
        paper: window.cpPaperCount ? (Number(window.cpPaperCount()) || 0) : 0,
      };
    }
    // 老快照没有 practice_counts，退回用概览字段估算，避免误判
    return {
      wrong: Number(overview.wrong) || 0,
      random: Number(overview.ready) || 0,
      unseen: Number(overview.unseen) || 0,
      paper: window.cpPaperCount ? (Number(window.cpPaperCount()) || 0) : 0,
    };
  }

  // 模式卡片上的计数文案；tag 模式依赖已选标签，这里按标签的题量显示
  function practiceModeCountText(mode, counts) {
    if (mode === "paper-random") {
      const n = Number(counts.paper) || 0;
      return n > 0 ? `${n} 份卷可随机` : "暂无可练试卷";
    }
    if (mode === "tag") {
      const tag = $("#practiceTag").value || state.practice.tag;
      if (!tag) return "先选一个标签";
      const item = (state.tags || []).find((entry) => entry.name === tag);
      const n = item ? Number(item.count) || 0 : 0;
      return n > 0 ? `该标签 ${n} 题` : "该标签暂无题目";
    }
    const n = Number(counts[mode]) || 0;
    if (n <= 0) return "暂无可练题目";
    return `${n} 题可练`;
  }

  // 刷新模式卡片的计数与可用态：
  // 没有题的模式置灰并给出提示，避免点了之后才发现是空的；
  // 默认模式跟着实际题量走 —— 有错题就练错题，没错题就落到随机练习。
  function applyPracticeModeAvailability() {
    const counts = practiceModeCounts();
    if (!counts) return;
    const hasWrong = counts.wrong > 0;
    $$(".mode-card").forEach((card) => {
      const mode = card.dataset.mode;
      const label = card.querySelector(".mode-count");
      if (label) label.textContent = practiceModeCountText(mode, counts);
      const empty = mode === "wrong" ? !hasWrong
        : mode === "unseen" ? counts.unseen <= 0
        : mode === "paper-random" ? counts.paper <= 0
        : false;
      card.classList.toggle("is-empty", empty);
      card.setAttribute("aria-disabled", empty ? "true" : "false");
    });
    // 「推荐」标记跟着实际有题的方向走
    const wrongBadge = document.querySelector(".mode-card[data-mode='wrong'] .mode-badge");
    const randomBadge = document.querySelector(".mode-card[data-mode='random'] .mode-badge");
    if (wrongBadge && randomBadge) {
      wrongBadge.hidden = !hasWrong;
      randomBadge.hidden = hasWrong;
    }
    // 用户没手动选过时，默认模式跟着题量走 —— 有错题练错题，没错题练随机
    if (!state.practice.modePinned) {
      const preferred = hasWrong ? "wrong" : "random";
      if (state.practice.mode !== preferred) {
        state.practice.mode = preferred;
        syncPracticeMode();
      }
      return;
    }
    // 手动选中的模式已经没题可练（错题被答到掌握、新题全做完），
    // 别把用户卡在一个空的模式上，退回随机练习
    const currentEmpty = (state.practice.mode === "wrong" && !hasWrong)
      || (state.practice.mode === "unseen" && counts.unseen <= 0);
    if (currentEmpty && counts.random > 0) {
      state.practice.mode = "random";
      state.practice.modePinned = false;
      syncPracticeMode();
    }
  }

  function syncPracticeMode() {
    $$(".mode-card").forEach((card) => card.classList.toggle("active", card.dataset.mode === state.practice.mode));
    $("#tagOptionGroup").hidden = state.practice.mode !== "tag";
    const isPaper = state.practice.mode === "paper-random";
    // 整卷随机练习不涉及「练习数量 / 标签 / 预计用时」，把这三块收起来
    $$(".practice-options .option-group").forEach((g) => { g.hidden = isPaper; });
    const estWrap = $("#practiceEstimate") && $("#practiceEstimate").closest("span");
    if (estWrap) estWrap.hidden = isPaper;
    const startBtn = $("#startPractice");
    if (startBtn) {
      startBtn.innerHTML = isPaper
        ? `${svg("code")}随机抽一份开考`
        : `${svg("play")}开始练习`;
    }
    const count = state.practice.count || 50;
    $$("#countSegmented button").forEach((button) => button.classList.toggle("active", Number(button.dataset.count) === state.practice.count));
    $("#practiceEstimate").textContent = Math.max(1, Math.round(count * 0.65));
  }

  function bindPractice() {
    // 首屏选中态由服务端渲染（没有待攻克的错题时直接给随机练习），
    // 这里读一次与前端状态对齐，之后一律由状态驱动
    const initialCard = document.querySelector(".mode-card.active");
    if (initialCard && initialCard.dataset.mode) state.practice.mode = initialCard.dataset.mode;
    $$(".mode-card").forEach((card) => {
      card.addEventListener("click", () => {
        const mode = card.dataset.mode;
        // 空模式直接提示，不让用户点了之后才发现没题可练
        if (card.classList.contains("is-empty")) {
          showToast(mode === "wrong" ? "已经没有待攻克的错题了，试试随机练习" : "这个模式暂时没有题目可练", "error");
          return;
        }
        state.practice.mode = mode;
        state.practice.modePinned = true;
        syncPracticeMode();
      });
    });
    $$("#countSegmented button").forEach((button) => {
      button.addEventListener("click", () => {
        state.practice.count = Number(button.dataset.count);
        syncPracticeMode();
      });
    });
    $("#practiceTag").addEventListener("change", () => {
      state.practice.tag = $("#practiceTag").value;
      // 标签题量会变，刷新一下模式卡片上的计数
      applyPracticeModeAvailability();
    });
    $("#startPractice").addEventListener("click", () => startPractice());
    $("#quizOptions").addEventListener("click", handleOptionClick);
    $("#editCurrentQuestion").addEventListener("click", () => editCurrentQuestion());
    $("#submitAnswer").addEventListener("click", submitAnswer);
    $("#nextQuestion").addEventListener("click", nextQuestion);
    $("#exitQuiz").addEventListener("click", exitQuiz);
    $("#retryWrong").addEventListener("click", () => {
      const ids = state.practice.lastWrongIds || [];
      if (ids.length) startPractice("custom", ids);
    });
    $("#backToSetup").addEventListener("click", resetPracticeView);
    $("#viewWrongBook").addEventListener("click", () => switchView("wrong"));
  }

  async function startPractice(overrideMode = null, questionIds = null) {
    let mode = overrideMode || state.practice.mode;
    // 随机练习试卷：跨到整卷考场，随机抽一份开考（复用整卷判分 / 历史成绩逻辑）
    if (mode === "paper-random") {
      const bridge = window.cpStartRandomPaperExam;
      if (typeof bridge !== "function") {
        showToast("整卷模块未就绪，请刷新页面后重试", "error");
        return false;
      }
      switchView("codepaper");
      bridge();
      const btn = $("#startPractice");
      if (btn) { btn.disabled = false; btn.innerHTML = `${svg("code")}随机抽一份开考`; }
      return true;
    }
    const count = state.practice.count === 0 ? 100 : state.practice.count;
    // 兜底：选中的模式实际已经没题可练（错题刚被答到掌握），
    // 直接改走随机练习，比让后端返回一句「没有可练习的题目」友好
    if (mode !== "custom" && mode !== "tag") {
      const counts = practiceModeCounts();
      if (counts && (counts[mode] || 0) <= 0 && counts.random > 0) {
        mode = "random";
        state.practice.mode = "random";
        state.practice.modePinned = false;
        syncPracticeMode();
        showToast("这个模式暂时没有题目，已切换到随机练习", "info");
      }
    }
    const tag = mode === "tag" ? ($("#practiceTag").value || state.practice.tag) : "";
    if (mode === "tag" && !tag) {
      showToast("请先选择一个标签", "error");
      return;
    }
    const button = $("#startPractice");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>正在准备题目...`;
    try {
      const payload = { mode, count, tag };
      if (mode === "custom") payload.question_ids = questionIds;
      const data = await api("/api/practice/start", { method: "POST", body: payload });
      state.practice.session = data;
      state.practice.index = 0;
      state.practice.answers = {};
      state.practice.submitted = false;
      state.practice.selected = [];
      state.practice.startedAt = Date.now();
      state.practice.questionStartedAt = Date.now();
      state.practice.lastWrongIds = [];
      $("#practiceSetup").hidden = true;
      $("#resultPanel").hidden = true;
      $("#quizPanel").hidden = false;
      $("#quizTotal").textContent = data.total;
      renderQuiz();
      startPracticeTimer();
      return true;
    } catch (error) {
      showToast(error.message, "error");
      return false;
    } finally {
      button.disabled = false;
      button.innerHTML = `${svg("play")}开始练习`;
    }
  }

  function startPracticeTimer() {
    stopPracticeTimer();
    updatePracticeTimer();
    state.practice.timer = setInterval(updatePracticeTimer, 1000);
  }

  function stopPracticeTimer() {
    if (state.practice.timer) clearInterval(state.practice.timer);
    state.practice.timer = null;
  }

  function updatePracticeTimer() {
    if (!state.practice.startedAt) return;
    const seconds = Math.floor((Date.now() - state.practice.startedAt) / 1000);
    $("#quizTimer").textContent = formatDuration(seconds);
  }

  function currentQuestion() {
    return state.practice.session?.questions?.[state.practice.index] || null;
  }

  // 练习过程中发现题干 / 选项 OCR 错了：直接复用题库编辑器，不用退出练习
  function editCurrentQuestion() {
    const question = currentQuestion();
    if (!question) return;
    if (SYNC_ENABLED && sync.offline) {
      showToast("离线时暂时不能改题或重新识别，连上电脑同步后再操作", "error");
      return;
    }
    openQuestionEditor(question.id, {
      fresh: true,
      subtitle: "可手动修改；需要时展开「用原图重新识别」，并可给大模型一句提示词。保存后当前这道题立即刷新，已判分的本题结果保持提交时为准。",
      onSaved: refreshCurrentPracticeQuestion,
    });
  }

  function refreshCurrentPracticeQuestion(updated) {
    const question = currentQuestion();
    if (!state.practice.session || !question) return;
    if (updated && updated.id && Number(updated.id) !== Number(question.id)) {
      showToast("题目已保存", "success");
      return;
    }
    if (updated) {
      ["qno", "stem", "qtype", "options", "answer", "explanation", "tags"].forEach((key) => {
        if (updated[key] !== undefined) question[key] = updated[key];
      });
    }
    // 只重绘当前这一题，进度、计时、已答题记录和已选答案都保留
    renderQuiz({ preserveState: true });
    showToast(
      state.practice.submitted
        ? "题目已更新 · 本题判分保持提交时结果，下次练习起用新内容"
        : "题目已更新，继续作答即可",
      "success",
    );
  }

  function renderQuiz(renderOptions = {}) {
    const session = state.practice.session;
    if (!session) return;
    if (state.practice.index >= session.questions.length) {
      finishPractice();
      return;
    }
    const question = currentQuestion();
    // 练习中就地编辑题目后会重新渲染本题，先把作答状态快照下来再恢复
    const keep = renderOptions.preserveState === true ? {
      submitted: state.practice.submitted,
      selected: state.practice.selected.slice(),
      questionStartedAt: state.practice.questionStartedAt,
      answerRecord: state.practice.answers[question.id] || null,
      fillValue: $("#fillInput").value,
    } : null;
    state.practice.submitted = false;
    state.practice.selected = [];
    state.practice.questionStartedAt = Date.now();
    const total = session.questions.length;
    const index = state.practice.index;
    $("#quizIndex").textContent = index + 1;
    $("#quizTotal").textContent = total;
    $("#quizProgress").style.width = `${((index) / total) * 100}%`;
    $("#quizScore").textContent = `已答对 ${Object.values(state.practice.answers).filter((item) => item.result?.is_correct).length} 题`;
    $("#quizBadges").innerHTML = [
      `<span class="badge purple">${typeLabel(question.qtype)}</span>`,
      question.qno ? `<span class="badge gray">${escapeHtml(question.qno)}</span>` : "",
      ...(question.tags || []).map((tag) => `<span class="badge gray">${escapeHtml(tag)}</span>`),
    ].join("");
    $("#quizStem").textContent = question.stem;
    const options = question.options || {};
    const fill = question.qtype === "fill";
    $("#fillAnswer").hidden = !fill;
    $("#quizOptions").hidden = fill;
    if (fill) {
      const input = $("#fillInput");
      input.value = "";
      input.disabled = false;
      setTimeout(() => input.focus(), 30);
    } else {
      const entries = question.qtype === "truefalse"
        ? [["正确", "正确"], ["错误", "错误"]]
        : Object.entries(options);
      $("#quizOptions").innerHTML = entries
        .map(
          ([value, text]) => `<button type="button" class="option-item ${question.qtype === "truefalse" ? `tf-option ${tfTone(value, "truefalse")}` : ""}" data-letter="${value}"><span class="option-letter">${question.qtype === "truefalse" ? (value === "正确" ? "✓" : "×") : value}</span><span>${escapeHtml(text)}</span></button>`
        )
        .join("");
    }
    $("#quizFeedback").hidden = true;
    $("#quizFeedback").className = "quiz-feedback";
    $("#submitAnswer").hidden = false;
    $("#submitAnswer").disabled = false;
    $("#submitAnswer").innerHTML = "提交答案";
    $("#nextQuestion").hidden = true;
    $("#keyboardHint").textContent = question.qtype === "fill"
      ? "输入答案后按 Enter 提交"
      : question.qtype === "multiple"
        ? "可选择多个选项，Enter 提交"
        : question.qtype === "truefalse"
          ? "点击「正确」或「错误」，Enter 提交"
          : "按 A / B / C / D 选择，Enter 提交";
    $("#quizTimer").textContent = formatDuration(Math.floor((Date.now() - state.practice.startedAt) / 1000));
    if (!keep) return;
    state.practice.submitted = keep.submitted;
    state.practice.selected = keep.selected;
    state.practice.questionStartedAt = keep.questionStartedAt;
    if (question.qtype === "fill") $("#fillInput").value = keep.fillValue || "";
    if (keep.submitted && keep.answerRecord) {
      // 判分结果按提交时为准，只用新题面把反馈重画一次，不重新判分
      showFeedback(question, keep.answerRecord.result, { scroll: false });
      $("#submitAnswer").hidden = true;
      $("#nextQuestion").hidden = false;
      $("#nextQuestion").innerHTML = index + 1 >= total ? `查看结果 ${svg("arrow")}` : `下一题 ${svg("arrow")}`;
    } else if (!keep.submitted) {
      $$("#quizOptions .option-item").forEach((button) => {
        button.classList.toggle("selected", keep.selected.includes(button.dataset.letter));
      });
    }
  }

  function handleOptionClick(event) {
    if (state.practice.submitted) return;
    const button = event.target.closest(".option-item");
    if (!button) return;
    const letter = button.dataset.letter;
    const question = currentQuestion();
    if (!question) return;
    if (question.qtype === "multiple") {
      if (state.practice.selected.includes(letter)) {
        state.practice.selected = state.practice.selected.filter((item) => item !== letter);
      } else {
        state.practice.selected.push(letter);
      }
    } else {
      state.practice.selected = [letter];
    }
    $$("#quizOptions .option-item").forEach((item) => {
      item.classList.toggle("selected", state.practice.selected.includes(item.dataset.letter));
    });
  }

  function answerLetters(value) {
    return Array.from(new Set(String(value || "").toUpperCase().match(/[A-H]/g) || [])).sort();
  }

  async function submitAnswer() {
    if (state.practice.submitted) return;
    const question = currentQuestion();
    if (!question) return;
    let answer = "";
    if (question.qtype === "fill") {
      answer = $("#fillInput").value.trim();
    } else {
      answer = state.practice.selected.join("");
    }
    if (!answer) {
      showToast(question.qtype === "fill" ? "请先输入答案" : "请先选择答案", "error");
      return;
    }
    const button = $("#submitAnswer");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>判分中...`;
    try {
      const result = await api("/api/practice/answer", {
        method: "POST",
        body: {
          session_id: state.practice.session.session_id,
          question_id: question.id,
          answer,
          duration_ms: Date.now() - state.practice.questionStartedAt,
        },
      });
      state.practice.submitted = true;
      state.practice.answers[question.id] = { answer, result };
      showFeedback(question, result);
      $("#quizScore").textContent = `已答对 ${Object.values(state.practice.answers).filter((item) => item.result?.is_correct).length} 题`;
      $("#submitAnswer").hidden = true;
      $("#nextQuestion").hidden = false;
      $("#nextQuestion").innerHTML = state.practice.index + 1 >= state.practice.session.questions.length ? `查看结果 ${svg("arrow")}` : `下一题 ${svg("arrow")}`;
      if (!result.is_correct && !state.practice.lastWrongIds.includes(question.id)) {
        state.practice.lastWrongIds.push(question.id);
      }
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
      button.innerHTML = "提交答案";
    }
  }

  function showFeedback(question, result, options = {}) {
    const correctValues = question.qtype === "truefalse"
      ? [result.correct_answer]
      : answerLetters(result.correct_answer);
    if (question.qtype !== "fill") {
      $$("#quizOptions .option-item").forEach((button) => {
        const value = button.dataset.letter;
        button.disabled = true;
        if (correctValues.includes(value)) button.classList.add("correct");
        if (state.practice.selected.includes(value) && !correctValues.includes(value)) button.classList.add("wrong");
      });
    } else {
      $("#fillInput").disabled = true;
    }
    const feedback = $("#quizFeedback");
    feedback.className = `quiz-feedback ${result.is_correct ? "ok" : "bad"}`;
    feedback.hidden = false;
    feedback.innerHTML = `<div class="feedback-head">${svg(result.is_correct ? "check" : "close")}${result.is_correct ? "回答正确" : "回答错误"}</div>
      <div class="feedback-answer"><span>你的答案：<b>${escapeHtml(result.user_answer || "未作答")}</b></span><span>正确答案：<b class="${tfTone(result.correct_answer, question.qtype)}">${escapeHtml(result.correct_answer || "--")}</b></span>${result.streak ? `<span>连续答对：<b>${result.streak}</b> 次</span>` : ""}</div>
      ${result.explanation ? `<div class="feedback-explanation"><strong>解析</strong><div class="md">${renderMarkdown(result.explanation)}</div></div>` : ""}`;
    if (options.scroll !== false) feedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function nextQuestion() {
    if (!state.practice.submitted) return;
    state.practice.index += 1;
    if (state.practice.index >= state.practice.session.questions.length) {
      finishPractice();
      return;
    }
    renderQuiz();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function finishPractice() {
    stopPracticeTimer();
    const session = state.practice.session;
    if (!session) return;
    try {
      const data = await api("/api/practice/finish", {
        method: "POST",
        body: { session_id: session.session_id },
      });
      state.practice.lastWrongIds = data.wrong_ids || [];
      $("#quizPanel").hidden = true;
      $("#resultPanel").hidden = false;
      const score = data.accuracy || 0;
      $("#resultScore").textContent = score;
      $("#scoreRing").style.setProperty("--p", score);
      $("#resultCorrect").textContent = data.correct || 0;
      $("#resultWrong").textContent = Math.max(0, (data.answered || 0) - (data.correct || 0));
      $("#resultTime").textContent = formatDuration(data.elapsed || 0);
      $("#resultTitle").textContent = score >= 90 ? "非常稳，继续保持！" : score >= 70 ? "不错，再巩固一下" : score >= 40 ? "有进步空间" : "从错题开始补起来";
      $("#resultSubtitle").textContent = data.answered < data.total
        ? `本次共 ${data.total} 题，完成 ${data.answered} 题，答对 ${data.correct} 题。`
        : `本次共 ${data.total} 题，答对 ${data.correct} 题，正确率 ${score}%。`;
      $("#retryWrong").hidden = !(data.wrong_ids || []).length;
      $("#resultReview").innerHTML = renderResultReview(data.details || []);
      loadDashboard();
      loadTags();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function renderResultReview(details) {
    if (!details.length) return emptyState("本次没有作答记录", "下次记得提交答案哦。", "clock");
    return `<div class="panel-head"><div><h3>本次答题回顾</h3><p>答错的题已经自动进入错题本</p></div></div>` +
      details
        .map(
          (item) => `<div class="review-item">
            <div class="review-top">
              <span class="badge ${item.is_correct ? "green" : "red"}">${item.is_correct ? "答对" : "答错"}</span>
              <span class="badge gray">${typeLabel(item.qtype)}</span>
              ${item.qno ? `<span class="badge gray">${escapeHtml(item.qno)}</span>` : ""}
            </div>
            <div class="review-stem">${escapeHtml(item.stem)}</div>
            <div class="review-answers">
              <span class="${item.is_correct ? "ok" : "bad"}">你的答案：<b>${escapeHtml(item.user_answer || "--")}</b></span>
              <span>正确答案：<b class="${tfTone(item.correct_answer, item.qtype)}">${escapeHtml(item.correct_answer || "--")}</b></span>
              ${item.explanation ? `<span class="md">解析：${renderMarkdown(item.explanation, { inline: true })}</span>` : ""}
            </div>
          </div>`
        )
        .join("");
  }

  async function exitQuiz() {
    if (!state.practice.session) {
      resetPracticeView();
      return;
    }
    const ok = await confirmDialog("退出本次练习？", "已经作答的题目会被保存，未完成的题目不会计入成绩。", "退出", true);
    if (!ok) return;
    stopPracticeTimer();
    resetPracticeView();
    loadDashboard();
  }

  function resetPracticeView() {
    stopPracticeTimer();
    state.practice.session = null;
    state.practice.index = 0;
    state.practice.answers = {};
    state.practice.submitted = false;
    state.practice.selected = [];
    state.practice.startedAt = 0;
    $("#quizPanel").hidden = true;
    $("#resultPanel").hidden = true;
    $("#practiceSetup").hidden = false;
    syncPracticeMode();
  }

  // ---------------------------------------------------------------------
  // 侧栏折叠：大屏记住偏好，中屏是临时浮层，手机底部导航不参与
  // ---------------------------------------------------------------------
  const SIDEBAR_KEY = "wrongbook.sidebar.collapsed";
  let sidebarPeek = false;
  let sidebarAnimTimer = null;

  function sidebarMode() {
    if (isPhoneLayout()) return "phone";
    return window.matchMedia("(max-width: 1120px)").matches ? "compact" : "wide";
  }

  function syncSidebarMode() {
    const mode = sidebarMode();
    const collapsed = mode === "wide" && lsGet(SIDEBAR_KEY, false) === true;
    const peek = mode === "compact" && sidebarPeek;
    const icons = mode === "wide" ? collapsed : mode === "compact" ? !peek : false;
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    document.body.classList.toggle("sidebar-peek", peek);
    document.body.classList.toggle("sidebar-icons", icons);
    const toggle = $("#sidebarToggle");
    if (!toggle) return;
    const label = mode === "compact"
      ? (peek ? "收起侧边栏" : "展开侧边栏")
      : (collapsed ? "展开侧边栏" : "折叠侧边栏");
    const expanded = mode === "phone" || (mode === "wide" ? !collapsed : peek);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", label);
    toggle.dataset.label = label; // 图标态的气泡与按钮自身共用同一段文案
    toggle.title = `${label}（Ctrl/⌘ + \\）`;
  }

  function toggleSidebar() {
    const mode = sidebarMode();
    if (mode === "phone") return;
    if (mode === "compact") sidebarPeek = !sidebarPeek;
    else lsSet(SIDEBAR_KEY, !(lsGet(SIDEBAR_KEY, false) === true));
    document.body.classList.add("sidebar-animating");
    syncSidebarMode();
    clearTimeout(sidebarAnimTimer);
    // 宽度过渡结束后让题库按新的内容宽度重算每页条数
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sidebarAnimTimer = window.setTimeout(() => {
      document.body.classList.remove("sidebar-animating");
      window.dispatchEvent(new Event("resize"));
    }, reduce ? 0 : 340);
  }

  function initSidebar() {
    $$(".sidebar .nav-item").forEach((item) => {
      const label = item.querySelector("span")?.textContent?.trim();
      if (!label) return;
      item.dataset.label = label;
      if (!item.hasAttribute("aria-label")) item.setAttribute("aria-label", label);
    });
    $("#sidebarToggle")?.addEventListener("click", toggleSidebar);
    // 中屏浮层：点菜单项切换页面、或点主内容区域后自动收起
    document.addEventListener("click", (event) => {
      if (!document.body.classList.contains("sidebar-peek")) return;
      const inSidebar = !!event.target.closest?.(".sidebar");
      if (!inSidebar || event.target.closest(".nav-item")) {
        sidebarPeek = false;
        syncSidebarMode();
      }
    });
    window.addEventListener("resize", () => {
      if (sidebarPeek && sidebarMode() !== "compact") sidebarPeek = false;
      syncSidebarMode();
    });
    syncSidebarMode();
  }

  function handleGlobalKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && (event.code === "Backslash" || event.key === "\\")) {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key === "Escape") {
      if (!$("#modalRoot").hidden) closeModal(false);
      else if (document.body.classList.contains("sidebar-peek")) {
        sidebarPeek = false;
        syncSidebarMode();
      }
      return;
    }
    // 弹窗打开时（例如练习中编辑题目），按键归弹窗，别误触发提交答案 / 翻页
    if (!$("#modalRoot").hidden) return;
    if (state.view !== "practice" || !state.practice.session) return;
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (event.key === "Enter" && tag === "INPUT" && !state.practice.submitted) {
        event.preventDefault();
        submitAnswer();
      } else if (event.key === "Enter" && state.practice.submitted) {
        event.preventDefault();
        nextQuestion();
      }
      return;
    }
    if (state.practice.submitted) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        nextQuestion();
      }
      return;
    }
    const letter = event.key.toUpperCase();
    if (/^[A-H]$/.test(letter)) {
      const question = currentQuestion();
      const target = question?.qtype === "truefalse"
        ? letter === "A" ? "正确" : letter === "B" ? "错误" : ""
        : letter;
      const button = target ? $(`#quizOptions .option-item[data-letter="${target}"]`) : null;
      if (button) button.click();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitAnswer();
    }
  }

  // ---------------------------------------------------------------------
  // Wrong book
  // ---------------------------------------------------------------------
  function bindWrong() {
    $("#wrongSort").addEventListener("change", () => {
      state.wrong.sort = $("#wrongSort").value;
      loadWrongBook();
    });
    // 错题本子菜单：单题错题 / 整卷错题 两页切换
    $$('.wrong-tab').forEach((tabEl) =>
      tabEl.addEventListener("click", () => setWrongTab(tabEl.dataset.wrongTab))
    );
  }

  // ---------------------------------------------------------------------
  // 整卷错题组（v1.4.1）：一份卷 = 一组填空题，不拆成单题。
  // 有任意一空错 → 整组留在错题本；全卷全对 → 整组移出。
  // 单题统计口径完全不动，整卷只在本区块里单独呈现。
  // ---------------------------------------------------------------------
  function renderPaperGroups(items) {
    $("#wbGroupsList").innerHTML = items.map((g, i) => {
      const cells = (g.grid || []).map((cell) => {
        const state = cell.ok ? "ok" : "bad";
        const label = cell.ok ? "正确" : (cell.answered ? "答错" : "未作答");
        return `<span class="wb-grid-cell ${state}" title="第 ${cell.no} 空 · ${label}" aria-label="第 ${cell.no} 空 ${label}">B${cell.no}</span>`;
      }).join("");
      const when = String(g.last_exam_at || "").replace("T", " ").slice(0, 16);
      return `
        <article class="wb-group-card">
          <div class="wb-group-spine" aria-hidden="true"><span>VOL.</span><b>${String(i + 1).padStart(2, "0")}</b></div>
          <div class="wb-group-body">
            <div class="wb-group-top">
              <span class="wb-group-tag">${g.blank_count} 个空一组</span>
              <h4>${escapeHtml(g.title)}</h4>
            </div>
            <p class="wb-group-meta"><b>共 ${g.blank_count} 题</b> · <b class="warn">错 ${g.miss_count} 题</b> · 最近 ${g.score} 分 · ${escapeHtml(when)}</p>
            <div class="wb-group-grid" aria-label="逐空结果格阵">${cells}</div>
          </div>
          <div class="wb-group-actions">
            ${(g.verified === false)
              ? `<button class="btn btn-ghost" type="button" data-view="codepaper" data-cp-open="audit" data-cp-paper="${g.id}" title="这份卷子答案待复核，考试与刷题都未开放">${svg("edit")}先去质检</button>
                 <span class="wb-group-hint">本卷待复核不可作答：订正封卷后才能重考</span>`
              : `<button class="btn btn-primary" type="button" data-view="codepaper" data-cp-open="exam" data-cp-paper="${g.id}" data-cp-retry="1">${svg("play")}整卷重考</button>
                 <span class="wb-group-hint">一次考完整卷，全对才移出</span>`}
          </div>
        </article>`;
    }).join("");
  }

  async function loadPaperGroups() {
    const band = $("#wbGroups");
    const list = $("#wbGroupsList");
    const empty = $("#wbGroupsEmpty");
    if (!band || !list || !empty) return;
    // 整卷错题专区常驻可见，只切换「组列表 / 全清」两种态，不再整体隐藏
    band.hidden = false;
    try {
      const d = await api("/api/code-papers/wrong-papers");
      const items = d.items || [];
      $("#wbGroupsCount").textContent = items.length;
      const paperCount = $("#wrongTabCountPaper");
      if (paperCount) paperCount.textContent = items.length;
      list.hidden = items.length === 0;
      empty.hidden = items.length !== 0;
      if (items.length) {
        renderPaperGroups(items);
      } else {
        const cleared = d.cleared_count || 0;
        $("#wbGroupsEmptyText").textContent = cleared
          ? `${cleared} 份卷子已经全卷答对，整组移出错题本。`
          : "还没有整卷考试记录；去「整卷入库」录一份，就能开考了。";
      }
    } catch (error) {
      // 整卷旁路独立：不可用时不拖累单题错题本，但专区仍可见（提示暂不可用）
      list.hidden = true;
      empty.hidden = false;
      $("#wbGroupsEmptyText").textContent = "整卷错题暂不可用，稍后再试。";
    }
  }

  async function loadWrongBook() {
    $("#wrongSummary").textContent = "正在加载...";
    try {
      const [data, overview] = await Promise.all([
        api(`/api/questions?status=wrong&sort=${encodeURIComponent(state.wrong.sort)}&per_page=100`),
        api("/api/overview"),
      ]);
      state.wrong.items = data.items || [];
      state.overview = overview;
      applyOverview(overview);
      $("#wrongStatWrong").textContent = overview.wrong || 0;
      $("#wrongStatMastered").textContent = overview.mastered || 0;
      $("#wrongStatCount").textContent = (data.items || []).reduce((sum, item) => sum + (item.wrong_count || 0), 0);
      $("#wrongSummary").textContent = data.items.length ? `待攻克 ${data.items.length} 道题，优先复习错误次数多的题。` : "没有待攻克的错题，做得不错。";
      const singleCount = $("#wrongTabCountSingle");
      if (singleCount) singleCount.textContent = data.items.length;
      renderQuestionList($("#wrongList"), data.items || []);
    } catch (error) {
      $("#wrongSummary").textContent = "加载失败";
      showToast(error.message, "error");
    }
    loadPaperGroups();
    setWrongTab(state.wrong.tab);
  }

  // 错题本子菜单：单题错题 / 整卷错题 两页切换，与「我的题库」的整卷考试 / 单题题库 同构
  function setWrongTab(tab) {
    if (tab !== "single" && tab !== "paper") tab = "single";
    state.wrong.tab = tab;
    const page = document.querySelector('.page[data-page="wrong"]');
    if (page) page.dataset.wrongTab = tab;
    $$('.wrong-tab').forEach((t) => {
      const active = t.dataset.wrongTab === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    const single = $("#wrongSinglePanel");
    const paper = $("#wrongPaperPanel");
    if (single) single.hidden = tab !== "single";
    if (paper) paper.hidden = tab !== "paper";
  }

  // ---------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------
  async function loadStats() {
    try {
      const data = await api("/api/stats");
      state.overview = data;
      applyOverview(data);
      $("#statsAttempts").textContent = formatCount(data.total_attempts);
      $("#statsAccuracy").textContent = data.accuracy == null ? "--" : `${data.accuracy}%`;
      $("#statsToday").textContent = data.today_total || 0;
      $("#statsWrong").textContent = data.wrong || 0;
      renderStatsChart(data.daily14 || []);
      renderTagStats(data.tag_stats || []);
      renderHardest(data.hardest || []);
      loadPaperStats();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  // 整卷考试统计模块：只读聚合，离线 / 接口不可达时静默跳过，不阻断单题统计
  async function loadPaperStats() {
    const cards = ["#paperTotal", "#paperExams", "#paperAvg", "#paperPending"];
    if (!cards.every((id) => $(id))) return;
    try {
      const d = await api("/api/code-papers/summary");
      $("#paperTotal").textContent = d.total_papers || 0;
      $("#paperExams").textContent = d.exam_count || 0;
      $("#paperAvg").textContent = d.avg_best || 0;
      $("#paperPending").textContent = d.pending || 0;
      const list = $("#paperRecent");
      const recent = d.recent || [];
      if (!recent.length) {
        list.innerHTML = emptyState("还没有整卷考试记录", "在「我的题库 / 整卷考试」点开考，交卷后会在这里留痕。", "code");
        return;
      }
      list.innerHTML = recent
        .map((r, i) => {
          const when = String(r.created_at || "").replace("T", " ").slice(0, 16);
          const wrong = Math.max(0, (r.total || 0) - (r.correct || 0));
          return `<div class="paper-recent-item" role="button" tabindex="0" data-attempt-id="${r.attempt_id}" title="点击查看完整试卷">
            <span class="paper-recent-rank">${String(i + 1).padStart(2, "0")}</span>
            <div class="paper-recent-main">
              <p class="paper-recent-title">${escapeHtml(r.title || "整卷 " + r.paper_id)}</p>
              <span class="paper-recent-meta"><b class="${r.passed ? "ok" : "bad"}">${r.score} 分</b> · 对 ${r.correct}/${r.total} · ${when}</span>
            </div>
            <span class="paper-recent-wrong">错 ${wrong} 道</span>
          </div>`;
        })
        .join("");
      list.querySelectorAll(".paper-recent-item").forEach((el) => {
        const open = () => openExamAttemptModal(el.dataset.attemptId);
        el.addEventListener("click", open);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
      });
      // 每份试卷的刷题 / 考试次数表
      const byBox = $("#paperByTable");
      const by = d.by_paper || [];
      if (byBox) {
        if (!by.length) {
          byBox.innerHTML = emptyState("还没有整卷记录", "交卷后这里会按试卷汇总刷题与考试次数。", "code");
        } else {
          byBox.innerHTML = `<div class="paper-by-row paper-by-head">
            <span class="paper-by-name">试卷</span>
            <span class="paper-by-num">刷题</span>
            <span class="paper-by-num">考试</span>
            <span class="paper-by-num">最好分</span>
            <span class="paper-by-go"></span>
          </div>` + by.map((p) => {
            const totalTimes = (p.practice_count || 0) + (p.exam_count || 0);
            return `<div class="paper-by-row">
              <span class="paper-by-name" title="${escapeHtml(p.title || "")}">${escapeHtml(p.title || "整卷 " + p.paper_id)}</span>
              <span class="paper-by-num"><b>${p.practice_count || 0}</b> 次</span>
              <span class="paper-by-num"><b>${p.exam_count || 0}</b> 次</span>
              <span class="paper-by-num">${p.best_score || 0}</span>
              <span class="paper-by-go"><button type="button" class="btn btn-ghost btn-xs" data-view="codeHistory" data-ch-paper="${p.paper_id}">历史</button></span>
            </div>`;
          }).join("");
          // 不在这里另绑 click：按钮已带 data-view="codeHistory" / data-ch-paper，
          // 统一交给上面的全局委托 + switchView，返回目标才会记成「学习统计」。
        }
      }
    } catch (_error) {
      /* 离线或接口不可达：保留默认 0，不弹错 */
    }
  }

  // 整卷历史：跨卷合并展示刷题 / 考试记录，可按模式、试卷过滤并分页
  // codeHistoryReturnView：记录从哪个页面点进来的（题库 / 学习统计 …），「返回」按它回退
  let codeHistoryReturnView = "library";
  const codeHistoryReturnLabel = { library: "题库", stats: "学习统计", practice: "练习", wrong: "错题本", dashboard: "概览" };
  const codeHistoryState = { mode: "all", paperId: "", paperQuery: "", page: 1, pageSize: 12, items: [], papers: [], bound: false };

  // 编辑重封卷保存成功后由 codepaper.js 通过 window.appUI 调用：后端已按最新答案
  // 重判该卷的历史考试记录，这里同步作废旧缓存并刷新当前视图，确保「整卷历史 /
  // 学习统计 / 题库卡片」展示最新数据，而不是上一次进入页面时缓存的旧分数。
  function refreshPaperViews(paperId) {
    codeHistoryState.items = [];
    codeHistoryState.papers = [];
    if (state.view === "codeHistory") loadCodeHistory({ reset: true, paperId });
    else if (state.view === "stats") loadStats();
    else if (state.view === "library") loadLibrary();
    refreshOverview();
  }

  // 模糊匹配：子串命中优先，其次按顺序子序列命中（适配中文）
  function fuzzyMatch(q, text) {
    q = (q || "").trim().toLowerCase();
    if (!q) return 2;
    text = (text || "").toLowerCase();
    if (text.includes(q)) return 3;
    let i = 0;
    for (const ch of text) { if (ch === q[i]) i++; if (i === q.length) return 1; }
    return -1;
  }

  function chPaperTitle(pid) {
    const p = codeHistoryState.papers.find((x) => String(x.id) === String(pid));
    return p ? p.title : "";
  }

  function openCombo() {
    const list = $("#chComboList");
    const toggle = $("#chComboToggle");
    if (!list) return;
    renderComboList();
    list.hidden = false;
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }
  function closeCombo() {
    const list = $("#chComboList");
    const toggle = $("#chComboToggle");
    if (!list) return;
    list.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }
  function renderComboList() {
    const list = $("#chComboList");
    if (!list) return;
    const q = codeHistoryState.paperQuery;
    let opts = codeHistoryState.papers.slice();
    if (q) opts = opts.filter((p) => fuzzyMatch(q, p.title) >= 0);
    const rows = ['<li class="ch-combo-opt ch-combo-all' + (codeHistoryState.paperId === "" && !codeHistoryState.paperQuery ? " is-active" : "") + '" role="option" tabindex="0" data-pid="">全部试卷</li>'];
    if (!opts.length && q) {
      rows.push('<li class="ch-combo-empty" role="presentation">没有匹配的试卷</li>');
    }
    opts.forEach((p) => {
      rows.push('<li class="ch-combo-opt' + (String(codeHistoryState.paperId) === String(p.id) ? " is-active" : "") + '" role="option" tabindex="0" data-pid="' + escapeHtml(p.id) + '">' + escapeHtml(p.title) + "</li>");
    });
    list.innerHTML = rows.join("");
  }

  function syncComboClear() {
    const clr = $("#chComboClear");
    if (clr) clr.hidden = !(codeHistoryState.paperId || codeHistoryState.paperQuery);
  }

  async function loadCodeHistory(opts = {}) {
    const box = $("#codeHistoryList");
    if (!box) return;
    if (opts.reset) { codeHistoryState.mode = "all"; codeHistoryState.page = 1; codeHistoryState.paperId = ""; codeHistoryState.paperQuery = ""; }
    if (opts.paperId) codeHistoryState.paperId = String(opts.paperId);
    const backLabel = $("#chBackLabel");
    if (backLabel) backLabel.textContent = codeHistoryReturnLabel[codeHistoryReturnView] ? " · " + codeHistoryReturnLabel[codeHistoryReturnView] : "";
    const searchEl = $("#chSearch");
    if (searchEl) {
      searchEl.value = codeHistoryState.paperId ? chPaperTitle(codeHistoryState.paperId) : codeHistoryState.paperQuery;
    }
    syncComboClear();
    box.innerHTML = `<div class="ch-loading">加载历史记录…</div>`;
    try {
      const d = await api("/api/code-papers/attempts?limit=1000");
      codeHistoryState.items = d.items || [];
      const seen = {};
      codeHistoryState.papers = [];
      codeHistoryState.items.forEach((it) => {
        if (!seen[it.paper_id]) { seen[it.paper_id] = true; codeHistoryState.papers.push({ id: it.paper_id, title: it.title || ("整卷 " + it.paper_id) }); }
      });
      codeHistoryState.papers.sort((a, b) => a.title.localeCompare(b.title, "zh"));
      bindCodeHistoryToolbar();
      renderCodeHistory();
    } catch (e) {
      box.innerHTML = emptyState("历史记录加载失败", e.message, "code");
    }
  }

  function bindCodeHistoryToolbar() {
    if (codeHistoryState.bound) return;
    codeHistoryState.bound = true;
    document.querySelectorAll(".seg-btn[data-ch-mode]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".seg-btn[data-ch-mode]").forEach((x) => x.classList.toggle("is-active", x === b));
        codeHistoryState.mode = b.dataset.chMode;
        codeHistoryState.page = 1;
        renderCodeHistory();
      });
    });
    const searchEl = $("#chSearch");
    if (searchEl) {
      searchEl.addEventListener("input", (e) => {
        codeHistoryState.paperQuery = e.target.value;
        codeHistoryState.paperId = ""; // 自由输入即切换为「按名称模糊筛选」
        codeHistoryState.page = 1;
        syncComboClear();
        renderComboList();
        renderCodeHistory();
      });
      searchEl.addEventListener("focus", () => openCombo());
      searchEl.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); openCombo(); const first = $("#chComboList .ch-combo-opt"); if (first) first.focus(); }
        else if (e.key === "Escape") { closeCombo(); }
      });
    }
    const toggle = $("#chComboToggle");
    if (toggle) toggle.addEventListener("click", (e) => {
      if (e.target.closest(".ch-combo-clear")) return;
      const list = $("#chComboList");
      if (list && list.hidden) openCombo(); else closeCombo();
    });
    const clearBtn = $("#chComboClear");
    if (clearBtn) clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      codeHistoryState.paperId = "";
      codeHistoryState.paperQuery = "";
      const se = $("#chSearch");
      if (se) se.value = "";
      syncComboClear();
      closeCombo();
      renderCodeHistory();
    });
    const list = $("#chComboList");
    if (list) {
      list.addEventListener("click", (e) => {
        const opt = e.target.closest(".ch-combo-opt");
        if (!opt) return;
        const pid = opt.dataset.pid || "";
        if (pid === "") { codeHistoryState.paperId = ""; codeHistoryState.paperQuery = ""; }
        else { codeHistoryState.paperId = pid; codeHistoryState.paperQuery = ""; }
        const se = $("#chSearch");
        if (se) se.value = pid === "" ? "" : chPaperTitle(pid);
        codeHistoryState.page = 1;
        syncComboClear();
        closeCombo();
        renderCodeHistory();
      });
      list.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const opt = e.target.closest(".ch-combo-opt"); if (opt) opt.click(); }
        else if (e.key === "Escape") { closeCombo(); }
      });
    }
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#chCombobox")) closeCombo();
    });
  }

  function renderCodeHistory() {
    const box = $("#codeHistoryList");
    const pager = $("#codeHistoryPager");
    const countEl = $("#chCount");
    if (!box) return;
    let items = codeHistoryState.items;
    if (codeHistoryState.mode !== "all") items = items.filter((it) => it.mode === codeHistoryState.mode);
    if (codeHistoryState.paperId) {
      items = items.filter((it) => String(it.paper_id) === String(codeHistoryState.paperId));
    } else if (codeHistoryState.paperQuery) {
      items = items.filter((it) => fuzzyMatch(codeHistoryState.paperQuery, it.title || ("整卷 " + it.paper_id)) >= 0);
    }
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / codeHistoryState.pageSize));
    const cur = Math.min(codeHistoryState.page, pages);
    codeHistoryState.page = cur;
    if (countEl) countEl.textContent = total ? `共 ${total} 条记录` : "";
    if (!total) {
      box.innerHTML = emptyState("还没有整卷记录", "去「我的题库」开考，交卷后会自动留档。", "code");
      if (pager) pager.innerHTML = "";
      return;
    }
    const slice = items.slice((cur - 1) * codeHistoryState.pageSize, cur * codeHistoryState.pageSize);
    box.innerHTML = slice.map((it) => {
      const when = String(it.created_at || "").replace("T", " ").slice(0, 16);
      const isPrac = it.mode === "practice";
      const wrong = Math.max(0, it.total - it.correct);
      return `<div class="ch-row" role="button" tabindex="0" data-attempt-id="${it.id}" title="点击查看完整试卷">
        <span class="ch-badge ${isPrac ? "prac" : "exam"}">${isPrac ? "刷题" : "考试"}</span>
        <div class="ch-main">
          <p class="ch-title">${escapeHtml(it.title || "整卷 " + it.paper_id)}</p>
          <span class="ch-meta"><b class="${it.passed ? "ok" : "bad"}">${it.score} 分</b> · 对 ${it.correct}/${it.total} · ${when}</span>
        </div>
        <span class="ch-wrong">错 ${wrong} 道</span>
        <span class="ch-go"><svg><use href="#i-arrow"></use></svg></span>
      </div>`;
    }).join("");
    box.querySelectorAll(".ch-row").forEach((el) => {
      const open = () => openExamAttemptModal(el.dataset.attemptId);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    if (pager) renderCodeHistoryPager(pager, cur, pages);
  }

  function renderCodeHistoryPager(pager, cur, pages) {
    if (pages <= 1) { pager.innerHTML = ""; return; }
    let html = `<button type="button" class="ch-pg" data-pg="prev" ${cur === 1 ? "disabled" : ""}>上一页</button>`;
    for (let n = 1; n <= pages; n++) {
      html += `<button type="button" class="ch-pg ${n === cur ? "is-active" : ""}" data-pg="${n}">${n}</button>`;
    }
    html += `<button type="button" class="ch-pg" data-pg="next" ${cur === pages ? "disabled" : ""}>下一页</button>`;
    pager.innerHTML = html;
    pager.querySelectorAll(".ch-pg").forEach((b) => {
      b.addEventListener("click", () => {
        const v = b.dataset.pg;
        if (v === "prev") codeHistoryState.page = Math.max(1, codeHistoryState.page - 1);
        else if (v === "next") codeHistoryState.page = Math.min(pages, codeHistoryState.page + 1);
        else codeHistoryState.page = Number(v);
        renderCodeHistory();
      });
    });
  }

  // 「最近考试」点击：弹出该次考试的完整试卷，逐空对照学生答案与标准答案
  async function openExamAttemptModal(attemptId) {
    if (!attemptId) return;
    try {
      const d = await api("/api/code-papers/attempts/" + attemptId);
      const sub = d.refreshed ? "完整试卷 · 答案已按最新卷库刷新" : "完整试卷 · 逐空对照";
      openModal({
        title: d.title || "整卷试卷",
        subtitle: sub,
        wide: true,
        bodyClass: "exam-paper-modal",
        body: buildExamPaperHtml(d),
      });
    } catch (e) {
      showToast(e.message || "加载试卷失败", "error");
    }
  }

  function buildExamPaperHtml(d) {
    const when = String(d.created_at || "").replace("T", " ").slice(0, 16);
    const byNo = {};
    (d.results || []).forEach((it) => { byNo[it.no] = it; });
    const pad2 = (n) => String(n).padStart(2, "0");

    let body;
    const tpl = (d.code_template || "").replace(/\r/g, "");
    // 单条错题对照 HTML：行内填错误答案（红/删除线），其下给出正确答案
    const fixHtmlFor = (b) => {
      const wrong = b.user || "—";
      const correct = b.correct_answer || "—";
      return `<div class="exam-fix"><span class="exam-fix-item"><span class="exam-fix-bad">错误答案：<s>${escapeHtml(wrong)}</s></span><span class="exam-fix-arrow">→</span><span class="exam-fix-ok">正确答案：${escapeHtml(correct)}</span></span></div>`;
    };
    if (tpl && /\{\{|\{\{BLANK/.test(tpl)) {
      // 有原题模板：逐行渲染，同一行的多个空位合并成一行（不再拆成多行）
      const RE = /\{\{(\d+)\}\}|\[\[BLANK\]\]/g;
      body = tpl.split("\n").map((line, idx) => {
        RE.lastIndex = 0;
        if (!RE.test(line)) return "";               // 纯代码行（无空位）跳过
        RE.lastIndex = 0;
        let out = "", last = 0, m, blanks = [];
        while ((m = RE.exec(line))) {
          out += escapeHtml(line.slice(last, m.index));
          const no = m[1] ? parseInt(m[1], 10) : null;
          const it = no != null ? byNo[no] : null;
          if (it) {
            blanks.push(it);
            if (it.is_correct) {
              out += `<span class="exam-fill exam-fill--ok">${escapeHtml(it.correct_answer || "▢")}</span>`;
            } else {
              // 错题：行内填「错误答案」（保留上下文，直观看出写错在哪），其下给出正确答案
              out += `<span class="exam-fill exam-fill--bad">${escapeHtml(it.user || it.correct_answer || "▢")}</span>`;
            }
          } else {
            out += `<span class="exam-fill exam-fill--ok">▢</span>`;
          }
          last = m.index + m[0].length;
        }
        out += escapeHtml(line.slice(last));
        // 行级判定：取该行最差状态
        let worst = "ok", verdict = "✓ 答对", fixes = [];
        for (const b of blanks) {
          if (!b.is_correct) {
            worst = "bad";
            verdict = b.answered ? "✗ 答错" : "✗ 未作答";
            fixes.push(b);
          }
        }
        const nos = blanks.map((b) => b.no).sort((a, b) => a - b);
        const badge = nos.length > 1 ? `${pad2(nos[0])}–${pad2(nos[nos.length - 1])}` : (nos.length ? pad2(nos[0]) : pad2(idx + 1));
        const fixHtml = fixes.length ? fixes.map(fixHtmlFor).join("") : "";
        return `<div class="exam-line exam-line--${worst}">
          <div class="exam-line-no">${badge}</div>
          <div class="exam-line-main">
            <code class="exam-line-code">${out}<span class="exam-verdict exam-verdict--${worst}">${verdict}</span></code>
            ${fixHtml}
          </div>
        </div>`;
      }).filter(Boolean).join("");
    } else {
      // 兼容旧数据（无模板）：逐空一行，错题行内填错误答案、其下给正确答案
      body = (d.results || []).map((it) => {
        const cls = it.is_correct ? "ok" : "bad";
        const verdict = it.is_correct ? "✓ 答对" : (it.answered ? "✗ 答错" : "✗ 未作答");
        if (it.is_correct) {
          return `<div class="exam-line exam-line--ok">
            <div class="exam-line-no">${pad2(it.no)}</div>
            <div class="exam-line-main">
              <code class="exam-line-code">${escapeHtml(it.context_left || "")}<span class="exam-fill exam-fill--ok">${escapeHtml(it.correct_answer || "▢")}</span>${escapeHtml(it.context_right || "")}<span class="exam-verdict exam-verdict--ok">${verdict}</span></code>
            </div>
          </div>`;
        }
        return `<div class="exam-line exam-line--bad">
          <div class="exam-line-no">${pad2(it.no)}</div>
          <div class="exam-line-main">
            <code class="exam-line-code">${escapeHtml(it.context_left || "")}<span class="exam-fill exam-fill--bad">${escapeHtml(it.user || it.correct_answer || "▢")}</span>${escapeHtml(it.context_right || "")}<span class="exam-verdict exam-verdict--bad">${verdict}</span></code>
            ${fixHtmlFor(it)}
          </div>
        </div>`;
      }).join("");
    }

    return `<div class="exam-summary">
        <span class="exam-score ${d.passed ? "ok" : "bad"}">${d.score} 分</span>
        <span>对 ${d.correct}/${d.total}</span>
        <span>${d.passed ? "已通过" : "未通过"}</span>
        <span class="exam-date">${when}</span>
      </div>
      <div class="exam-blanks">${body}</div>`;
  }

  function renderStatsChart(daily) {
    const container = $("#statsChart");
    const max = Math.max(1, ...daily.map((item) => item.total));
    container.innerHTML = daily
      .map((item) => {
        const height = item.total ? Math.max(5, Math.round((item.correct / max) * 100)) : 0;
        const totalHeight = item.total ? Math.max(8, Math.round((item.total / max) * 100)) : 0;
        const date = item.date.slice(5).replace("-", "/");
        return `<div class="day-col ${item.date === todayString() ? "today" : ""}" title="${item.date}：练习 ${item.total}，答对 ${item.correct}">
          <div class="day-stack" style="position:relative"><i style="height:${height}%"></i><span style="position:absolute;left:0;right:0;bottom:0;height:${totalHeight}%;background:rgba(162,112,28,.14);z-index:-1"></span></div>
          <span class="day-label">${date}</span>
        </div>`;
      })
      .join("");
  }

  function renderTagStats(tags) {
    const container = $("#tagStats");
    if (!tags.length) {
      container.innerHTML = emptyState("还没有标签数据", "上传题目时可以给题目打标签。", "filter");
      return;
    }
    container.innerHTML = tags
      .map((tag) => {
        const percent = tag.total ? Math.round(((tag.total - tag.wrong) / tag.total) * 100) : 0;
        return `<div class="tag-stat-row">
          <div class="tag-stat-top"><span>${escapeHtml(tag.tag)}</span><b>${tag.total} 题 · 待攻克 ${tag.wrong}</b></div>
          <div class="tag-mini-bar"><i style="width:${percent}%"></i></div>
        </div>`;
      })
      .join("");
  }

  function renderHardest(items) {
    const container = $("#hardestList");
    if (!items.length) {
      container.innerHTML = emptyState("还没有练习数据", "做几道题后，这里会显示最容易错的题目。", "chart");
      return;
    }
    container.innerHTML = items
      .map(
        (item, index) => `<div class="hardest-item" role="button" tabindex="0" data-detail-id="${item.id}" title="点击查看题目详情">
          <span class="hardest-rank">${String(index + 1).padStart(2, "0")}</span>
          <div class="hardest-main"><p>${escapeHtml(item.stem)}</p></div>
          <span>错 ${item.wrong_count} 次</span>
        </div>`
      )
      .join("");
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  // 「手机访问」卡片：扫码后手机可在同一 Wi-Fi 下使用完整系统
  function renderLanHosts(data) {
    const box = $("#lanHosts");
    if (!box) return;
    const list = (data.candidates || []).filter((item) => item && item.ip);
    if (list.length < 2) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML =
      `<span class="lan-hosts-label">电脑有多块网卡，手机连不上时换一个地址生成二维码：</span>` +
      list
        .map(
          (item) =>
            `<button class="lan-host${item.ip === data.lan_ip ? " is-current" : ""}" type="button" data-host="${escapeHtml(item.ip)}">` +
            `${item.primary ? "默认 · " : ""}${escapeHtml(item.alias || "网卡")} ${escapeHtml(item.ip)}</button>`
        )
        .join("");
  }

  async function loadLanInfo(host = "") {
    const qr = $("#lanQr");
    const placeholder = $("#lanQrPlaceholder");
    const copyBtn = $("#copyLanUrl");
    if (!qr || !placeholder) return;
    state.settings = state.settings || {};
    try {
      const query = host ? `?host=${encodeURIComponent(host)}` : "";
      const data = await api(`/api/lan/info${query}`);
      state.settings.lan = data;
      if (data.available) {
        qr.hidden = false;
        const sep = data.qr_url.includes("?") ? "&" : "?";
        qr.src = `${data.qr_url}${sep}v=${Date.now()}`;
        qr.onerror = () => {
          qr.hidden = true;
          placeholder.hidden = false;
          placeholder.innerHTML = `${svg("alert")}<span>二维码加载失败</span>`;
        };
        placeholder.hidden = true;
        $("#lanUrl").textContent = data.url;
        if (copyBtn) copyBtn.disabled = false;
      } else {
        qr.hidden = true;
        placeholder.hidden = false;
        placeholder.innerHTML = `${svg("alert")}<span>未检测到局域网</span>`;
        $("#lanUrl").textContent = data.message || "仅本机可用";
        if (copyBtn) copyBtn.disabled = true;
      }
      renderLanHosts(data);
    } catch (error) {
      qr.hidden = true;
      placeholder.hidden = false;
      placeholder.innerHTML = `${svg("alert")}<span>暂时不可用</span>`;
      $("#lanUrl").textContent = error?.message || "请确认本地服务运行正常";
      if (copyBtn) copyBtn.disabled = true;
    }
  }

  async function loadLanDiag(force = false) {
    const box = $("#lanDiagList");
    if (!box) return;
    box.innerHTML = "<span>正在检测网络、防火墙与本机服务...</span>";
    try {
      const data = await api(`/api/lan/diag${force ? "?force=1" : ""}`);
      const hints = Array.isArray(data.hints) ? data.hints : [];
      box.innerHTML = hints.length
        ? hints
            .map(
              (hint) =>
                `<div class="lan-diag-item ${escapeHtml(hint.level || "info")}"><i></i><span>${escapeHtml(hint.text)}</span></div>`
            )
            .join("")
        : "<span>未发现明显问题，手机与电脑保持同一网络即可。</span>";
    } catch (_error) {
      box.innerHTML =
        '<div class="lan-diag-item"><i></i><span>连接诊断只在电脑端显示；手机端请直接看顶栏的同步状态。</span></div>';
    }
  }

  async function copyLanUrl() {
    const url = state.settings?.lan?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch (_error) {
      // 局域网是 HTTP，部分浏览器不开放 clipboard API
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    showToast("手机访问链接已复制", "success");
  }

  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      state.settings = data;
      $("#settingsDataDir").textContent = data.data_dir;
      $("#settingsDbSize").textContent = formatBytes(data.db_size);
      $("#settingsCounts").textContent = `${data.counts.questions} / ${data.counts.imports} / ${data.counts.attempts}`;
      $("#settingsImages").textContent = `${data.image_count} 张`;
      const status = $("#engineStatus");
      if (data.ocr.available) {
        status.className = "engine-status";
        status.innerHTML = `<span class="status-dot"></span><div><strong>引擎可用 · ${escapeHtml(data.ocr.name)}</strong><p>${escapeHtml(data.ocr.message)}</p></div>`;
      } else {
        status.className = "engine-status warn";
        status.innerHTML = `<span class="status-dot" style="background:#a2701c;box-shadow:0 0 0 4px rgba(162,112,28,.12)"></span><div><strong>OCR 组件不可用</strong><p>${escapeHtml(data.ocr.message)}</p></div>`;
      }
      if ($("#settingsEngine")) $("#settingsEngine").textContent = data.ocr.name;
      await loadLlmPresets();
      renderLlmChannel(data.llm.ocr, "ocr");
      renderLlmChannel(data.llm.parse, "parse");
      await loadLanInfo();
      loadLanDiag();
      const hint = $("#normalizeHint");
      if (hint) hint.textContent = "把旧题目里因排版折行产生的换行合并成一行。";
    } catch (error) {
      if (!error.offline) showToast(error.message, "error");
    }
  }

  // 一次性整理历史题目里因 OCR 排版折行留下的换行
  async function normalizeExistingLines() {
    const btn = $("#normalizeLines");
    if (!btn) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>整理中...`;
    try {
      const data = await api("/api/questions/normalize-lines", { method: "POST", body: {} });
      const parts = [];
      if (data.stem_fixed) parts.push(`题干 ${data.stem_fixed} 道`);
      if (data.explanation_fixed) parts.push(`解析 ${data.explanation_fixed} 道`);
      showToast(
        data.updated
          ? `已整理 ${data.updated} 道题${parts.length ? `（${parts.join("，")}）` : ""}`
          : "没有需要整理的换行",
        "success"
      );
      await loadSettings();
      if (state.view === "library") loadLibrary();
      if (state.view === "wrong") loadWrongBook();
      loadDashboard();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  // ---------------------------------------------------------------------
  // External LLM (settings) — multiple profiles, one active
  // ---------------------------------------------------------------------
  let llmPresets = [];

  async function loadLlmPresets() {
    try {
      const data = await api("/api/llm/presets");
      llmPresets = data.presets || [];
      const sel = $("#llmPreset");
      if (sel) sel.innerHTML = llmPresets.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("");
    } catch (_error) {
      /* non-fatal: the select just stays empty */
    }
  }

  function providerLabel(id) {
    const preset = llmPresets.find((p) => p.id === id);
    return preset ? preset.label : id || "--";
  }

  const LLM_SCOPE_LABEL = { ocr: "图片识别", parse: "整卷解析" };
  let currentLlmScope = "ocr";  // 当前打开的添加/编辑表单属于哪个通道

  // 设置页改了模型配置后广播一次：整卷录入页（另一个独立 IIFE）据此重拉
  // parse 通道状态，否则在设置里打开开关后回到录入页，开关仍会置灰。
  function notifyLlmConfigChanged(scope) {
    window.dispatchEvent(new CustomEvent("llm:config-changed", { detail: { scope: scope || "ocr" } }));
  }

  function llmChannel(scope) {
    return document.querySelector(`.llm-channel[data-llm-scope="${scope}"]`);
  }

  function renderLlmChannel(cfg, scope) {
    const root = llmChannel(scope);
    if (!root) return;
    const wrap = root.querySelector("[data-llm-profiles]");
    if (!cfg || !cfg.profiles.length) {
      wrap.innerHTML = `<div class="llm-empty">还没有添加任何模型，点下方“添加模型”开始。</div>`;
    } else {
      wrap.innerHTML = cfg.profiles.map((p) => {
        const active = p.id === cfg.active_id;
        return `<div class="llm-profile ${active ? "active" : ""}" data-pid="${p.id}">
          <div class="llm-profile-head">
            <span class="llm-profile-radio" data-activate="${p.id}" title="设为生效模型"></span>
            <span class="llm-profile-name">${escapeHtml(p.name)}${active ? `<span class="active-tag">生效中</span>` : ""}</span>
          </div>
          <div class="llm-profile-meta">
            <span class="badge purple">${escapeHtml(providerLabel(p.provider))}</span>
            <span>${escapeHtml(p.model || "（未填模型）")}</span>
            <span>${escapeHtml(p.base_url || "")}</span>
            <span>${p.has_key ? `密钥 ${escapeHtml(p.api_key_mask)}` : "未配置密钥"}</span>
          </div>
          <div class="llm-profile-actions">
            <button class="text-btn" data-edit-profile="${p.id}">编辑</button>
            <button class="text-btn danger" data-del-profile="${p.id}">删除</button>
          </div>
        </div>`;
      }).join("");
    }
    root.querySelector("[data-llm-enabled-state]").textContent = cfg && cfg.enabled ? "已启用" : "未启用";
    root.querySelector("[data-llm-active]").textContent = cfg && cfg.active_label ? cfg.active_label : "--";
    const enabled = root.querySelector("[data-llm-enabled]");
    if (enabled) enabled.checked = Boolean(cfg && cfg.enabled);
  }

  function bindLlmSettings() {
    const sel = $("#llmPreset");
    if (sel) sel.addEventListener("change", (event) => {
      const preset = llmPresets.find((p) => p.id === event.target.value);
      if (!preset) return;
      // Auto-fill the base_url/model defaults, but don't clobber what the user
      // already typed (only fill when the matching field is empty).
      if (!$("#llmBaseUrl").value && preset.base_url) $("#llmBaseUrl").value = preset.base_url;
      if (!$("#llmModel").value && preset.default_model) $("#llmModel").value = preset.default_model;
    });
    $("#llmCancel").addEventListener("click", () => { $("#llmForm").hidden = true; llmEditingId = null; });
    $("#llmSave").addEventListener("click", saveLlmProfile);
    $("#llmTest").addEventListener("click", testLlm);
    // 每个通道各自绑定启用开关、添加按钮与列表内的激活/编辑/删除
    $$(".llm-channel").forEach((root) => {
      const scope = root.dataset.llmScope;
      const togg = root.querySelector("[data-llm-enabled]");
      if (togg) togg.addEventListener("change", () => toggleLlmEnabled(scope));
      root.querySelector("[data-llm-add]").addEventListener("click", () => {
        currentLlmScope = scope;
        renderLlmForm(null);
      });
      const wrap = root.querySelector("[data-llm-profiles]");
      if (wrap) wrap.addEventListener("click", async (event) => {
        const activate = event.target.closest("[data-activate]");
        if (activate) { await activateProfile(activate.dataset.activate, scope); return; }
        const edit = event.target.closest("[data-edit-profile]");
        if (edit) { await editProfile(edit.dataset.editProfile, scope); return; }
        const del = event.target.closest("[data-del-profile]");
        if (del) { await deleteProfile(del.dataset.delProfile, scope); return; }
      });
    });
  }

  let llmEditingId = null;  // null => adding a new model

  function parseLlmInt(raw, fallback, minv, maxv) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(maxv, Math.max(minv, n));
  }

  function renderLlmForm(profile) {
    llmEditingId = profile ? profile.id : null;
    const form = $("#llmForm");
    form.hidden = false;
    $("#llmName").value = profile ? profile.name : "";
    const sel = $("#llmPreset");
    if (sel) sel.value = profile ? profile.provider : "openai";
    $("#llmBaseUrl").value = profile ? profile.base_url : "";
    $("#llmApiKey").value = "";
    $("#llmModel").value = profile ? profile.model : "";
    const mt = $("#llmMaxTokens");
    if (mt) mt.value = profile && profile.max_tokens ? profile.max_tokens : 2048;
    const mask = $("#llmMask");
    if (mask) mask.textContent = profile && profile.has_key
      ? `已保存密钥：${profile.api_key_mask}（留空表示不修改）`
      : "尚未保存密钥";
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function saveLlmProfile() {
    const wasEdit = llmEditingId !== null;
    const payload = {
      name: $("#llmName").value.trim(),
      provider: $("#llmPreset").value,
      base_url: $("#llmBaseUrl").value.trim(),
      api_key: $("#llmApiKey").value,
      model: $("#llmModel").value.trim(),
      max_tokens: parseLlmInt($("#llmMaxTokens").value, 2048, 1, 32000),
    };
    const btn = $("#llmSave");
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>保存中...`;
    try {
      const url = wasEdit
        ? `/api/llm/profiles/${llmEditingId}?scope=${currentLlmScope}`
        : `/api/llm/profiles?scope=${currentLlmScope}`;
      const method = wasEdit ? "PUT" : "POST";
      await api(url, { method, body: payload });
      const cfg = await api(`/api/llm/config?scope=${currentLlmScope}`);
      renderLlmChannel(cfg, currentLlmScope);
      notifyLlmConfigChanged(currentLlmScope);
      $("#llmForm").hidden = true;
      llmEditingId = null;
      showToast(wasEdit ? "模型已更新" : "模型已添加", "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  async function testLlm() {
    const btn = $("#llmTest");
    if (!btn) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>测试中...`;
    try {
      let body = {};
      // If the add/edit form is open, test the values just typed (unsaved).
      if (!$("#llmForm").hidden) {
        body = {
          config: {
            base_url: $("#llmBaseUrl").value.trim(),
            api_key: $("#llmApiKey").value,
            model: $("#llmModel").value.trim(),
            max_tokens: parseLlmInt($("#llmMaxTokens").value, 2048, 1, 32000),
          },
        };
      }
      const data = await api(`/api/llm/test?scope=${currentLlmScope}`, { method: "POST", body });
      if (data.ok) showToast(`连接成功：${String(data.reply || "").slice(0, 40)}`, "success");
      else showToast(data.error || "连接失败", "error");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  async function toggleLlmEnabled(scope) {
    const root = llmChannel(scope);
    const enabled = root.querySelector("[data-llm-enabled]").checked;
    const btn = root.querySelector("[data-llm-enabled]");
    const previous = !enabled;
    btn.disabled = true;
    try {
      const data = await api(`/api/llm/enabled?scope=${scope}`, { method: "POST", body: { enabled } });
      renderLlmChannel(data, scope);
      notifyLlmConfigChanged(scope);
      showToast(enabled ? `已启用${LLM_SCOPE_LABEL[scope] || ""}大模型` : `已关闭${LLM_SCOPE_LABEL[scope] || ""}大模型`, "success");
    } catch (error) {
      btn.checked = previous;
      showToast(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function activateProfile(pid, scope) {
    try {
      const data = await api(`/api/llm/activate/${pid}?scope=${scope}`, { method: "POST" });
      renderLlmChannel(data, scope);
      notifyLlmConfigChanged(scope);
      showToast("已切换为生效模型", "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function editProfile(pid, scope) {
    try {
      const cfg = await api(`/api/llm/config?scope=${scope}`);
      const p = cfg.profiles.find((x) => x.id === pid);
      if (p) { currentLlmScope = scope; renderLlmForm(p); }
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function deleteProfile(pid, scope) {
    if (!(await confirmDialog("删除模型", "确定删除这个大模型配置吗？删除后可在设置中重新添加。", "删除", true))) return;
    try {
      const data = await api(`/api/llm/profiles/${pid}?scope=${scope}`, { method: "DELETE" });
      renderLlmChannel(data, scope);
      notifyLlmConfigChanged(scope);
      showToast("模型已删除", "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  // ---------------------------------------------------------------------
  // OCR correction dictionary (persisted, editable during capture)
  // ---------------------------------------------------------------------
  let corrections = [];

  function correctText(text) {
    if (!text) return text;
    corrections.forEach((c) => {
      if (c.wrong) text = text.split(c.wrong).join(c.right);
    });
    return text;
  }

  async function loadCorrections() {
    try {
      const data = await api("/api/ocr/corrections");
      corrections = data.corrections || [];
      renderCorrections();
    } catch (_error) {
      /* non-fatal */
    }
  }

  function renderCorrections() {
    const list = $("#correctionList");
    const empty = $("#correctionEmpty");
    if (!list) return;
    if (!corrections.length) {
      list.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");
    list.innerHTML = corrections.map((c) => `
      <div class="correct-item" data-cid="${c.id}">
        <span class="c-pair"><span class="c-wrong">${escapeHtml(c.wrong)}</span><span class="c-arrow">→</span><span class="c-right">${escapeHtml(c.right)}</span></span>
        <button class="icon-btn" data-del-correction="${c.id}" title="删除">${svg("trash")}</button>
      </div>`).join("");
  }

  async function addCorrection(wrong, right) {
    wrong = (wrong || "").trim();
    right = (right || "").trim();
    if (!wrong || !right) { showToast("误识文本和正确文本都要填写", "error"); return false; }
    try {
      const data = await api("/api/ocr/corrections", { method: "POST", body: { wrong, right } });
      corrections.unshift(data.correction);
      renderCorrections();
      return true;
    } catch (error) {
      showToast(error.message, "error");
      return false;
    }
  }

  async function deleteCorrection(cid) {
    try {
      await api(`/api/ocr/corrections/${cid}`, { method: "DELETE" });
      corrections = corrections.filter((c) => c.id !== Number(cid));
      renderCorrections();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function bindCorrections() {
    const addBtn = $("#addCorrection");
    if (addBtn) addBtn.addEventListener("click", async () => {
      if (await addCorrection($("#correctionWrong").value, $("#correctionRight").value)) {
        $("#correctionWrong").value = "";
        $("#correctionRight").value = "";
        showToast("已加入纠错词典", "success");
      }
    });
    const toggle = $("#toggleCorrect");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const card = $(".correct-card");
        if (!card) return;
        const collapsed = card.classList.toggle("collapsed");
        toggle.setAttribute("aria-expanded", String(!collapsed));
      });
    }
    const list = $("#correctionList");
    if (list) list.addEventListener("click", (event) => {
      const del = event.target.closest("[data-del-correction]");
      if (del) deleteCorrection(del.dataset.delCorrection);
    });
  }

  function openCorrectionModal(uid) {
    const draft = findDraft(uid);
    if (!draft) return;
    const body = `
      <p class="modal-hint">把题目中被误识别的字词纠正为本来的写法，保存后会立即应用到本题，并写入纠错词典供以后识别复用。</p>
      <div class="field"><label>误识文本</label><input id="corrWrong" placeholder="如：数居" maxlength="200"></div>
      <div class="field"><label>正确文本</label><input id="corrRight" placeholder="如：数据" maxlength="200"></div>`;
    const footer = `<button class="btn btn-ghost" data-close-modal>取消</button><button class="btn btn-primary" id="corrSave">保存到词典并应用</button>`;
    openModal({ title: "加入 OCR 纠错词典", subtitle: "", body, footer, small: true });
    const wrongInput = $("#corrWrong");
    if (wrongInput) wrongInput.value = draft.stem || "";
    const save = $("#corrSave");
    if (save) save.addEventListener("click", async () => {
      if (!(await addCorrection($("#corrWrong").value, $("#corrRight").value))) return;
      if (draft.stem) draft.stem = correctText(draft.stem);
      if (draft.options) Object.keys(draft.options).forEach((k) => { draft.options[k] = correctText(draft.options[k]); });
      if (draft.answer) draft.answer = correctText(draft.answer);
      if (draft.explanation) draft.explanation = correctText(draft.explanation);
      renderDrafts();
      closeModal(false);
      showToast("已应用到本题并写入词典", "success");
    });
  }

  async function aiEnhanceDraft(uid) {
    const draft = findDraft(uid);
    if (!draft) return;
    if (!draft.source_image) {
      showToast("这道题没有保留原图，无法调用大模型", "error");
      return;
    }
    // 「图片中的作答」是判断这道题是不是错题的依据。大模型常常把它留空，
    // 所以先存一份：重新解析只允许补上原本没有的作答，绝不能把已有作答清掉。
    const oldUserAnswer = String(draft.user_answer || "").trim();
    const idx = state.capture.drafts.findIndex((d) => d.uid === uid) + 1;
    const card = document.querySelector(`.draft-card[data-uid="${escapeHtml(uid)}"]`);
    const btn = card ? card.querySelector("[data-ai-enhance]") : null;
    const noteEl = card ? card.querySelector("[data-ai-note]") : null;
    const correction = (noteEl ? noteEl.value : (draft.ai_note || "")).trim();
    if (btn) {
      btn.disabled = true;
      btn.classList.add("busy");
      btn.innerHTML = `<span class="spinner"></span>`;
    }
    // 解析中提示出现在「识别结果」标题下方（固定位置，位于题目上方），不遮挡、可继续看下一题
    showBusy(`正在用大模型重新解析第 ${idx} 题…${correction ? "（已带上你的纠正说明）" : ""}`);
    try {
      const hint = [draft.stem, JSON.stringify(draft.options || {}), draft.answer, draft.user_answer].filter(Boolean).join("\n");
      const data = await api("/api/llm/parse", { method: "POST", body: { image_url: draft.source_image, ocr_hint: hint, correction } });
      if (!data.draft) throw new Error(data.error || "大模型未返回有效结果");
      const parsed = data.draft;
      if (parsed.stem) draft.stem = mergeLines(parsed.stem);
      if (parsed.qtype) draft.qtype = parsed.qtype;
      if (parsed.options && typeof parsed.options === "object") {
        const merged = Object.assign({}, draft.options || {});
        Object.entries(parsed.options).forEach(([letter, text]) => {
          if (text && String(text).trim()) merged[letter] = text;
        });
        draft.options = merged;
      }
      if (parsed.answer !== undefined && parsed.answer !== null) draft.answer = String(parsed.answer);
      if (parsed.explanation !== undefined) draft.explanation = parsed.explanation;
      if (Array.isArray(parsed.tags) && parsed.tags.length) draft.tags = parsed.tags;
      const aiUserAnswer = typeof parsed.user_answer === "string" ? parsed.user_answer.trim() : "";
      if (oldUserAnswer) {
        // 已有作答时以原图 / 用户填写的为准；模型留空或给出别的值都不覆盖，
        // 否则「原图答错」这道错题的判断会凭空消失。
        draft.user_answer = oldUserAnswer;
      } else if (aiUserAnswer) {
        // 原本没读到作答时，才采用模型从图片里认出的作答。
        draft.user_answer = aiUserAnswer;
      }
      // 是否答错由「图片中的作答 vs 正确答案」重新推导，不采信模型给的布尔值，
      // 与 collectDrafts() 入库时的算法保持一致。
      draft.was_wrong = draftWasWrong(draft);
      showToast(correction ? "已按你的纠正说明重新解析，请核对" : "已用大模型重新解析，请核对并修改", "success");
      renderDrafts();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      clearBusy();
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("busy");
        btn.innerHTML = svg("spark");
      }
    }
  }

  // ---------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------
  function openModal({ title, subtitle = "", badge = "", body, footer = "", wide = false, small = false, onClose = null, bodyClass = "" }) {
    // 新弹窗要占满整层，先把可能叠着的图片查看器撤掉，避免两层内容互相打架
    unmountViewerLayer();
    // 上面若还叠着一个二次确认框，一并撤掉（按「取消」处理），
    // 否则这一层被替换掉时，等着它的那段代码会永远等不到结果
    unmountConfirmLayer(false);
    // 底层页面残留的提示气泡会浮在弹窗上方挡住内容，开弹窗时先收掉
    hideTip();
    modalOnClose = onClose || null;
    const root = $("#modalRoot");
    root.hidden = false;
    root.innerHTML = `<div class="modal-backdrop"></div>
      <div class="modal ${wide ? "wide" : ""} ${small ? "small" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-head">
          <div><h3>${escapeHtml(title)}${badge ? `<span class="modal-title-badge">${escapeHtml(badge)}</span>` : ""}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>
          <button class="icon-btn" data-close-modal aria-label="关闭">${svg("close")}</button>
        </div>
        <div class="modal-body ${bodyClass}">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
      </div>`;
    document.body.style.overflow = "hidden";
    document.body.classList.add("modal-open");
    $(".modal-backdrop", root).addEventListener("click", () => closeModal(false));
    $$("[data-close-modal]", root).forEach((button) => button.addEventListener("click", () => closeModal(false)));
    const first = $("input, textarea, select", root);
    if (first) setTimeout(() => first.focus(), 30);
    return root;
  }

  // 一次把两层都收掉：先撤图片查看器，再关掉底层弹窗。
  // 切换页面时用得上 —— 别把上一页的列表带到下一页去。
  function closeAllModals() {
    unmountViewerLayer();
    closeModal(false);
  }

  // 画廊弹窗的筛选条固定在顶部：列表往下滚时给它加一道浅影，
  // 提示「下面还有内容在动」，松手后这层就压在图片上面。
  function bindFilterBarScroll(root) {
    const bar = root.querySelector(".upload-filter-bar");
    const scroller = root.querySelector(".upload-scroll");
    if (!bar || !scroller) return;
    const sync = () => {
      bar.classList.toggle("is-scrolled", scroller.scrollTop > 2);
    };
    scroller.addEventListener("scroll", sync, { passive: true });
    sync();
  }

  function closeModal(result = false) {
    // 二次确认框是最上面那层：先撤它，底下那张列表原样留着
    if (unmountConfirmLayer(result)) return;
    // 图片查看器是叠在列表之上的一层：先撤掉这一层，保留下面的列表原样
    // （滚动位置、筛选、多选都不丢），用户点「返回」还能回到刚才那张列表。
    if (unmountViewerLayer()) return;
    const root = $("#modalRoot");
    root.hidden = true;
    root.innerHTML = "";
    document.body.style.overflow = "";
    document.body.classList.remove("modal-open");
    const onClose = modalOnClose;
    modalOnClose = null;
    if (modalResolve) {
      const resolve = modalResolve;
      modalResolve = null;
      resolve(result);
    }
    // 若有 onClose（如从「已上传图片」打开原图后返回列表），关闭时回调
    if (onClose) onClose();
  }

  // 二次确认框单独占一层，压在当前弹窗之上。
  // 早先它是走 openModal 弹的，会把底下那张列表整个换掉 ——
  // 用户点「取消」之后列表就没了（多选状态也跟着丢），
  // 还得再点一次「已上传图片」才回得去，很莫名其妙。
  function mountConfirmLayer() {
    const root = $("#modalRoot");
    const old = root.querySelector(":scope > .modal-layer-confirm");
    if (old) old.remove();
    const layer = document.createElement("div");
    layer.className = "modal-layer modal-layer-confirm";
    root.appendChild(layer);
    root.classList.add("has-confirm");
    return layer;
  }

  // 撤掉确认层并把结果交还给等待它的那段代码。
  // 底下还压着别的弹窗就留着它，否则整层清空。
  function unmountConfirmLayer(result = false) {
    const root = $("#modalRoot");
    const layer = root.querySelector(":scope > .modal-layer-confirm");
    if (!layer) return false;
    layer.remove();
    root.classList.remove("has-confirm");
    if (modalResolve) {
      const resolve = modalResolve;
      modalResolve = null;
      resolve(result);
    }
    if (!root.querySelector(":scope > .modal") && !root.querySelector(":scope > .modal-layer-viewer")) {
      root.hidden = true;
      root.innerHTML = "";
      document.body.style.overflow = "";
      document.body.classList.remove("modal-open");
    }
    return true;
  }

  function confirmDialog(title, message, confirmText = "确定", danger = false) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const root = $("#modalRoot");
      const layer = mountConfirmLayer();
      root.hidden = false;
      document.body.style.overflow = "hidden";
      document.body.classList.add("modal-open");
      layer.innerHTML = `<div class="modal-backdrop"></div>
        <div class="modal small" role="dialog" aria-modal="true" aria-label="请确认">
          <div class="modal-head">
            <div><h3>请确认</h3></div>
            <button class="icon-btn" data-close-modal data-confirm-cancel aria-label="关闭">${svg("close")}</button>
          </div>
          <div class="modal-body"><div class="confirm-body">
            <div class="confirm-icon">${svg(danger ? "alert" : "check")}</div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
          </div></div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close-modal data-confirm-cancel>取消</button>
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="confirmOk" data-confirm-ok>${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      layer.querySelector(".modal-backdrop").addEventListener("click", () => unmountConfirmLayer(false));
      layer.querySelectorAll("[data-confirm-cancel]").forEach((b) => b.addEventListener("click", () => unmountConfirmLayer(false)));
      layer.querySelector("[data-confirm-ok]").addEventListener("click", () => unmountConfirmLayer(true));
      // 删除类的确认默认把焦点放在「取消」上，键盘用户不会一按回车就删掉
      const focusTarget = layer.querySelector(danger ? "[data-confirm-cancel]" : "[data-confirm-ok]");
      if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    });
  }

  // ---------------------------------------------------------------------
  // 弹窗分层：图片查看器单独占一层，压在已有弹窗（列表）之上
  // ---------------------------------------------------------------------
  // 以前查看原图是直接把整个弹窗内容换掉，回来时只能重新拉一遍列表 ——
  // 滚动位置、筛选条件、多选状态全丢，用户看着像「刚看的图找不到了」。
  // 现在改成叠一层：底下的列表一个节点都不动，只在最上面加一层查看器，
  // 点「返回」只撤掉查看器这一层，下面的列表原样露出来。
  function mountViewerLayer() {
    const root = $("#modalRoot");
    const old = root.querySelector(":scope > .modal-layer-viewer");
    if (old) old.remove();
    const layer = document.createElement("div");
    layer.className = "modal-layer modal-layer-viewer";
    root.appendChild(layer);
    root.classList.add("has-viewer");
    return layer;
  }

  // 撤掉查看器这一层；底下还压着列表就留着它，否则整层清空。
  function unmountViewerLayer() {
    const root = $("#modalRoot");
    const layer = root.querySelector(":scope > .modal-layer-viewer");
    if (!layer) return false;
    layer.remove();
    root.classList.remove("has-viewer");
    if (!root.querySelector(":scope > .modal")) {
      root.hidden = true;
      root.innerHTML = "";
      document.body.style.overflow = "";
      document.body.classList.remove("modal-open");
    }
    return true;
  }

  function openImageModal(url, meta = null, nav = null, extra = null) {
    if (!url) return;
    const clean = String(url).replace(/^\/+/, "");
    const list = nav && Array.isArray(nav.list) ? nav.list : null;
    let pos = list ? nav.index : 0;

    const layer = mountViewerLayer();
    // 底层页面残留的提示气泡会浮在弹窗上方挡住内容，开弹窗时先收掉
    hideTip();
    // 下面压着列表弹窗时，「返回」就是回到刚才那张列表，而不是重新打开一遍
    const hasBack = !!$("#modalRoot").querySelector(":scope > .modal");

    const render = () => {
      const item = list ? list[pos] : null;
      const curUrl = item ? item.url : clean;
      const curMeta = item ? item.meta : meta;
      const curClean = String(curUrl).replace(/^\/+/, "");
      const m = curMeta && curMeta.index ? curMeta : null;
      const heading = m ? `第 ${m.index} 张${m.total ? ` / 共 ${m.total} 张` : ""}` : "题目原图";
      const sub = m && m.stem ? m.stem : (hasBack ? "来自本地截图，仅用于核对。点「返回列表」回到刚才的列表。" : "来自本地截图，仅用于核对。");
      const ident = m
        ? `<div class="upload-ident"><span class="upload-ident-tag">${escapeHtml(heading)}</span>${m.stem ? `<span class="upload-ident-stem">${escapeHtml(m.stem)}</span>` : ""}${m.name ? `<span class="upload-ident-file">${escapeHtml(m.name)}</span>` : ""}</div>`
        : "";
      const extraHtml = extra ? extra.html() : "";
      layer.innerHTML = `<div class="modal-backdrop"></div>
        <div class="modal wide viewer${extraHtml ? " has-action" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(m ? `题目原图 · ${heading}` : "题目原图")}">
          <div class="modal-head">
            <div><h3>${escapeHtml(m ? `题目原图 · ${heading}` : "题目原图")}</h3><p>${escapeHtml(sub)}</p></div>
            <button class="icon-btn" data-close-modal aria-label="关闭">${svg("close")}</button>
          </div>
          <div class="modal-body">${ident}<div class="img-view"><img src="/${escapeHtml(curClean)}" alt="题目原图"></div></div>
          ${extraHtml ? `<div class="img-action-bar">${extraHtml}</div>` : ""}
          <div class="modal-foot viewer-foot">
            <a class="btn btn-ghost" href="/${escapeHtml(curClean)}" target="_blank" rel="noopener">${svg("external")}在新标签页打开</a>
            ${list ? `<div class="img-nav">
              <button class="btn btn-ghost btn-sm" data-img-prev ${pos <= 0 ? "disabled" : ""}>上一张</button>
              <button class="btn btn-ghost btn-sm" data-img-next ${pos >= list.length - 1 ? "disabled" : ""}>下一张</button>
              <span class="img-counter">${pos + 1} / ${list.length}</span>
            </div>` : ""}
            <button class="btn btn-primary" data-close-modal>${hasBack ? "返回列表" : "关闭"}</button>
          </div>
        </div>`;
      layer.querySelector(".modal-backdrop").addEventListener("click", () => closeModal(false));
      layer.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", () => closeModal(false)));
      const prev = layer.querySelector("[data-img-prev]");
      const next = layer.querySelector("[data-img-next]");
      if (prev) prev.addEventListener("click", () => { if (pos > 0) { pos -= 1; render(); } });
      if (next) next.addEventListener("click", () => { if (pos < list.length - 1) { pos += 1; render(); } });
      if (extra && extra.bind) extra.bind(layer);
    };

    const root = $("#modalRoot");
    root.hidden = false;
    document.body.style.overflow = "hidden";
    document.body.classList.add("modal-open");
    render();
  }

  // 题库里点开原图时，额外给出「重新识别 / AI识别」：对这道题的识别结果不满意时重来一遍
  function openLibraryImage(url, questionId) {
    // 切换上一张/下一张会重绘弹窗，提示词要存在闭包里带回去，别让用户输入丢掉
    let hint = "";
    const extra = {
      // 「给大模型的提示词」与「AI 识别」做成一个输入组：输入框和按钮焊在一起，
      // 填完顺手点按钮，两者再也不会隔着一整行让人对不上关系。
      html: () => `<div class="ai-action">
          <div class="ai-action-head">
            <span class="ai-action-title">识别结果不满意？</span>
            <span class="ai-action-sub">写一句提示词，点「AI识别」连同原图一起发给大模型</span>
          </div>
          <div class="ai-action-row">
            <button class="btn btn-ghost btn-sm" data-rerec-ocr title="用本地 OCR 重新识别这道题">${svg("refresh")}重新识别</button>
            <div class="ai-dock" data-ai-hint-row>
              <input class="ai-hint-input" data-ai-hint type="text" maxlength="500" placeholder="给大模型的提示词（可选）" value="${escapeHtml(hint)}" aria-label="给大模型的提示词">
              <button class="btn btn-ghost ai btn-sm" data-rerec-ai title="用大模型重新识别这道题">${svg("spark")}AI识别</button>
            </div>
          </div>
        </div>`,
      bind: (root) => {
        const input = root.querySelector("[data-ai-hint]");
        if (input) input.addEventListener("input", () => { hint = input.value; });
        const ocr = root.querySelector("[data-rerec-ocr]");
        const ai = root.querySelector("[data-rerec-ai]");
        if (ocr) ocr.addEventListener("click", () => rerecognizeQuestion(questionId, "ocr", ocr));
        if (ai) ai.addEventListener("click", () => rerecognizeQuestion(questionId, "ai", ai, hint));
      },
    };
    openImageModal(url, null, null, extra);
    const dropAi = () => {
      document.querySelector("#modalRoot [data-rerec-ai]")?.remove();
      document.querySelector("#modalRoot [data-ai-hint-row]")?.remove();
    };
    // 大模型是否可用要问一次服务端；不可用时 AI 按钮与提示词一起隐藏
    api("/api/llm/config")
      .then((cfg) => {
        const ok = !!(cfg && cfg.enabled && (cfg.profiles || []).length);
        if (!ok) {
          dropAi();
          return;
        }
        const label = cfg.active_label || "";
        const btn = document.querySelector("#modalRoot [data-rerec-ai]");
        if (btn && label) btn.title = `用大模型（${label}）重新识别这道题`;
      })
      .catch(dropAi);
  }

  // 重新识别一道题：只取识别结果给用户确认，确认后才写回题库
  async function rerecognizeQuestion(questionId, mode, btn, hint = "") {
    if (!questionId) return;
    const old = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>${mode === "ai" ? "AI识别中…" : "识别中…"}`;
    }
    try {
      const data = await api(`/api/questions/${questionId}/rerecognize`, {
        method: "POST", body: { mode, correction: mode === "ai" ? String(hint || "").trim().slice(0, 500) : "" },
      });
      showRerecognizePreview(questionId, data);
    } catch (error) {
      showToast(error.message || "重新识别失败", "error");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = old;
      }
    }
  }

  function showRerecognizePreview(questionId, data) {
    const draft = data.draft || {};
    const isAi = data.source === "ai";
    const opts = draft.options && Object.keys(draft.options).length
      ? `<ul class="rec-opts-list">${Object.entries(draft.options).map(([k, v]) => `<li><b>${escapeHtml(k)}.</b> ${escapeHtml(v)}</li>`).join("")}</ul>`
      : "";
    const warn = data.ai_error
      ? `<div class="rec-warn">${svg("alert")}<span>大模型识别失败，以下是本地 OCR 的结果：${escapeHtml(data.ai_error)}</span></div>`
      : "";
    const keep = data.keep || {};
    const keepHtml = `<div class="rec-keep">${svg("check")}<div>
        <b>原图作答与错题记录会原样保留</b>
        <span>图片中的作答：<b>${escapeHtml(keep.user_answer || "未记录")}</b>
          ${keep.was_wrong ? `<span class="badge red">原图答错</span>` : ""}
          · 已错 ${keep.wrong_count || 0} 次 / 答对 ${keep.correct_count || 0} 次</span>
        <small>重新识别只更新题干、选项、答案与解析，不会清空图片中选择的答案，也不会改变这道题的错题状态。</small>
      </div></div>`;
    const body = `<div class="rec">
      ${warn}
      <div class="rec-item">
        <div class="rec-item-head"><b>重新识别结果</b><span class="badge ${isAi ? "purple" : "gray"}">${isAi ? "大模型" : "本地 OCR"}</span><span class="badge gray">${escapeHtml(TYPE_LABELS[draft.qtype] || draft.qtype || "")}</span></div>
        <div class="rec-stem">${escapeHtml(draft.stem || "")}</div>
        ${opts}
        ${draft.answer ? `<div class="rec-answer">答案：${escapeHtml(draft.answer)}</div>` : ""}
        ${draft.explanation ? `<div class="rec-match md">解析：${renderMarkdown(draft.explanation, { inline: true })}</div>` : ""}
      </div>
      ${keepHtml}
      <p class="rec-note">确认无误后点「应用到这道题」，用上面的内容覆盖题干、选项、答案与解析；本次没认出的字段沿用原题。</p>
    </div>`;
    const root = openModal({
      title: "重新识别结果",
      subtitle: "对比原图确认内容是否正确，再决定是否覆盖题目。",
      body,
      footer: `<button class="btn btn-ghost" data-close-modal>取消</button><button class="btn btn-primary" id="applyRerec">应用到这道题</button>`,
      wide: true,
    });
    const apply = root.querySelector("#applyRerec");
    if (apply) {
      apply.addEventListener("click", async () => {
        apply.disabled = true;
        apply.innerHTML = `<span class="spinner"></span>保存中…`;
        try {
          const cur = await api(`/api/questions/${questionId}`);
          const item = cur.item || {};
          const saved = await api(`/api/questions/${questionId}`, {
            method: "PUT",
            body: {
              stem: draft.stem,
              qtype: draft.qtype || item.qtype,
              // 这次没认出来的字段沿用原题，避免重新识别后答案 / 选项凭空消失
              options: draft.options && Object.keys(draft.options).length ? draft.options : (item.options || {}),
              answer: draft.answer || item.answer || "",
              explanation: draft.explanation || item.explanation || "",
              tags: draft.tags && draft.tags.length ? draft.tags : item.tags,
              source_image: item.source_image,
              note: item.note,
            },
          });
          closeModal(false);
          // 从练习页原图弹窗进来时，也要把新题面原地刷回去，别让计时 / 已选 / 判分状态丢掉
          const active = currentQuestion();
          if (state.view === "practice" && active && Number(active.id) === Number(questionId)) {
            const updated = saved && saved.item
              ? saved.item
              : (await api(`/api/questions/${questionId}`, { bypassOffline: true })).item;
            refreshCurrentPracticeQuestion(updated);
          } else {
            showToast("已更新题目，图片中的作答与错题记录已保留", "success");
          }
          if (state.view === "library") loadLibrary();
          if (state.view === "wrong") loadWrongBook();
          loadDashboard();
        } catch (error) {
          showToast(error.message || "保存失败", "error");
          apply.disabled = false;
          apply.innerHTML = "应用到这道题";
        }
      });
    }
  }

  // 通用只读题目详情：学习统计「最易错题目」、概览「待攻克」、草稿去重共用。
  // 默认带「编辑本题」入口；草稿去重传 showEdit:false，保持原来的「知道了」。
  async function openQuestionDetail(id, options = {}) {
    if (!id) return;
    let item;
    try {
      const data = await api(`/api/questions/${id}`);
      item = data.item;
    } catch (error) {
      showToast("读取题目失败：" + error.message, "error");
      return;
    }
    if (!item) {
      showToast("题库中未找到这道题（可能已被删除）", "error");
      return;
    }
    const showEdit = options.showEdit !== false;
    const showStats = options.showStats !== false;
    const correct = correctOptionLetters(item);
    const opts = item.options && Object.keys(item.options).length
      ? Object.entries(item.options)
          .map(([k, v]) => `<li class="${correct.has(k) ? "is-correct" : ""}"><b>${escapeHtml(k)}.</b> ${escapeHtml(v)}${correct.has(k) ? "<em>✓ 正确选项</em>" : ""}</li>`)
          .join("")
      : "";
    const src = item.source_image ? String(item.source_image) : "";
    const imgUrl = src ? "/" + src.split("/").filter(Boolean).join("/") : "";
    // 通用详情的编号已在标题角标里，元信息行不再重复；草稿去重场景没有角标则保留
    const metaNo = showEdit ? "" : `编号 ${escapeHtml(item.qno || "—")} · `;
    const stats = showStats
      ? `<div class="q-detail-stats">
          <span>错 <b>${item.wrong_count || 0}</b> 次</span>
          <span>对 <b>${item.correct_count || 0}</b> 次</span>
          <span>${escapeHtml(masteryText(item.mastery))}</span>
          ${item.last_practiced_at ? `<span>最近练习 ${escapeHtml(formatDate(item.last_practiced_at))}</span>` : ""}
        </div>`
      : "";
    const body = `
      <div class="q-detail">
        <div class="q-detail-meta">${metaNo}题型 ${escapeHtml(TYPE_LABELS[item.qtype] || item.qtype)} · 标签 ${(item.tags || []).map((t) => escapeHtml(t)).join("、") || "—"}</div>
        <div class="q-detail-stem">${escapeHtml(item.stem || "")}</div>
        ${opts ? `<ul class="q-detail-opts">${opts}</ul>` : ""}
        <div class="q-detail-answer"><b>答案：</b>${escapeHtml(item.answer || "—")}</div>
        <div class="q-detail-answer"><b>图片中的作答：</b>${escapeHtml(item.user_answer || "未记录")}${item.was_wrong ? `<span class="badge red" style="margin-left:8px">原图答错</span>` : ""}</div>
        ${item.explanation ? `<div class="q-detail-exp"><b>解析：</b><div class="md">${renderMarkdown(item.explanation)}</div></div>` : ""}
        ${item.note ? `<div class="q-detail-exp"><b>备注：</b>${escapeHtml(item.note)}</div>` : ""}
        ${stats}
        ${imgUrl ? `<div class="q-detail-img"><a href="${escapeHtml(imgUrl)}" target="_blank" rel="noopener" title="在新标签页查看原图"><img src="${escapeHtml(imgUrl)}" alt="原题原图"></a></div>` : ""}
      </div>`;
    openModal({
      title: options.title || "题目详情",
      subtitle: options.subtitle || "只读查看；需要改动请点右下角「编辑本题」。",
      badge: showEdit && item.qno ? `编号 ${item.qno}` : "",
      body,
      footer: options.footer || (showEdit
        ? `<button class="btn btn-ghost" data-close-modal>关闭</button><button class="btn btn-primary" id="detailEditQuestion">${svg("edit")}编辑本题</button>`
        : `<button class="btn btn-primary" data-close-modal>知道了</button>`),
      wide: true,
    });
    $("#detailEditQuestion")?.addEventListener("click", () => {
      if (SYNC_ENABLED && sync.offline) {
        showToast("离线时暂时不能改题，连上电脑同步后再编辑", "error");
        return;
      }
      const questionId = item.id;
      closeModal(false);
      openQuestionEditor(questionId);
    });
  }

  // 「题目原图」：真正生成了题目的图片单独存放在 data/question_images/
  let qImageKeyword = "";

  function copyTextToClipboard(text) {
    const done = () => showToast("目录路径已复制", "success");
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        done();
      } catch (_error) {
        showToast("复制失败，请手动选中路径", "error");
      }
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  async function openQuestionImagesModal() {
    let data;
    try {
      data = await api("/api/question-images");
    } catch (error) {
      showToast("读取题目原图失败：" + error.message, "error");
      return;
    }
    const images = data.images || [];
    const folder = data.folder || "";
    const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
    const fmtTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const cards = images.map((u, i) => {
      const qs = (u.questions || []).filter((q) => q && q.stem);
      const first = qs[0];
      const qno = first?.qno || "未关联";
      const preview = qs.length
        ? `<div class="upload-q" title="${escapeHtml(qs.map((q) => q.stem).join("\n"))}">${escapeHtml(first.stem)}${qs.length > 1 ? `<span class="upload-q-more">等 ${qs.length} 题</span>` : ""}</div>`
        : `<div class="upload-q is-empty">未关联题目</div>`;
      const meta = {
        index: i + 1,
        total: images.length,
        name: u.name,
        stem: first?.stem || "",
      };
      const searchable = `${u.name} ${qno} ${qs.map((q) => `${q.qno || ""} ${q.stem || ""}`).join(" ")}`.toLowerCase();
      return `<div class="upload-card" data-search="${escapeHtml(searchable)}">
        <div class="upload-thumb-wrap">
          <span class="upload-idx" title="第 ${i + 1} 张，共 ${images.length} 张">${i + 1}</span>
          <button type="button" class="upload-thumb" data-view-image="${escapeHtml(u.url)}" data-upload-meta="${escapeHtml(JSON.stringify(meta))}" data-upload-index="${i}" title="查看原图：${escapeHtml(first?.stem || u.name)}">
            <img src="${escapeHtml(u.url)}" alt="第 ${i + 1} 张：${escapeHtml(first?.stem || u.name)}" loading="lazy">
          </button>
        </div>
        <div class="upload-meta">
          <div class="upload-label">第 ${i + 1} 张 / 共 ${images.length} 张</div>
          ${preview}
          <div class="upload-sub">${fmtSize(u.size)} · ${fmtTime(u.mtime)}</div>
          <div class="upload-foot"><span class="badge green">${escapeHtml(qno)}</span>${qs.length > 1 ? `<span class="badge gray">${qs.length} 题共用</span>` : ""}</div>
        </div>
      </div>`;
    }).join("");
    const navList = images.map((u, i) => ({
      url: u.url,
      meta: {
        index: i + 1,
        total: images.length,
        name: u.name,
        stem: (u.questions || []).filter((q) => q && q.stem).map((q) => q.stem)[0] || "",
      },
    }));
    const root = openModal({
      title: "题目原图",
      subtitle: images.length
        ? `共 ${images.length} 张已生成题目的原图，单独存放；「已上传图片」里还有 ${data.unused_uploads || 0} 张未使用的图片。`
        : "题目入库后，它的原图会自动移到这里单独存放。",
      body: `<div class="upload-filter-bar">
          <div class="upload-toolbar">
            <div class="upload-chips"><span class="chip on">已归档 <b>${images.length}</b></span></div>
            <div class="upload-search-wrap">${svg("search")}<input type="search" class="upload-search" id="qiSearch" placeholder="搜索编号、题干或文件名" value="${escapeHtml(qImageKeyword)}"></div>
          </div>
          <div class="upload-count" id="qiCount"></div>
        </div>
        <div class="upload-scroll">
          <div class="qi-path">
            ${svg("folder")}
            <div class="qi-path-text"><b>单独存放位置</b><span>${escapeHtml(folder)}</span><small>目录里还有「题目索引.csv」，可用 Excel 按编号查到对应图片。</small></div>
            <button type="button" class="btn btn-ghost btn-sm" data-copy-folder>复制路径</button>
            <a class="btn btn-ghost btn-sm" href="/question_images/${encodeURIComponent("题目索引.csv")}" download>下载索引表</a>
          </div>
          <div class="upload-grid">${cards}</div>
          <div class="upload-empty" id="qiEmpty" hidden>${images.length ? "没有符合条件的图片，换个关键词试试。" : "还没有题目原图。先上传截图并保存题目，原图会自动归档到这里。"}</div>
        </div>`,
      footer: `<button class="btn btn-ghost" data-sync-images>${svg("refresh")}重新整理</button><button class="btn btn-primary" data-close-modal>关闭</button>`,
      wide: true,
      bodyClass: "modal-body-gallery",
    });

    const grid = root.querySelector(".upload-grid");
    bindFilterBarScroll(root);
    const applyFilter = () => {
      const kw = qImageKeyword.trim().toLowerCase();
      let shown = 0;
      root.querySelectorAll(".upload-card").forEach((card) => {
        const ok = !kw || (card.dataset.search || "").includes(kw);
        card.hidden = !ok;
        if (ok) shown += 1;
      });
      root.querySelector("#qiCount").textContent = `显示 ${shown} / ${images.length} 张`;
      root.querySelector("#qiEmpty").hidden = shown > 0;
      grid.classList.toggle("is-filtered", shown > 0 && shown < images.length);
    };
    root.querySelector("#qiSearch").addEventListener("input", (event) => {
      qImageKeyword = event.target.value;
      applyFilter();
    });
    applyFilter();

    root.querySelectorAll("[data-view-image]").forEach((btn) => {
      let meta = null;
      try {
        meta = btn.dataset.uploadMeta ? JSON.parse(btn.dataset.uploadMeta) : null;
      } catch (_error) {
        meta = null;
      }
      btn.addEventListener("click", () => {
        const visible = [];
        root.querySelectorAll(".upload-card:not([hidden])").forEach((card) => {
          const idx = Number(card.querySelector(".upload-thumb")?.dataset.uploadIndex ?? -1);
          if (idx >= 0 && navList[idx]) visible.push(navList[idx]);
        });
        const list = visible.length ? visible : navList;
        const pos = list.findIndex((item) => item.url === btn.dataset.viewImage);
        openImageModal(btn.dataset.viewImage, meta, {
          list,
          index: pos >= 0 ? pos : Number(btn.dataset.uploadIndex || 0),
        });
      });
    });
    root.querySelectorAll("[data-copy-folder]").forEach((btn) =>
      btn.addEventListener("click", () => copyTextToClipboard(folder))
    );
    root.querySelectorAll("[data-sync-images]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const result = await api("/api/question-images/sync", { method: "POST", body: {} });
          showToast(`整理完成：移入 ${result.moved || 0} 张，退回 ${result.restored || 0} 张`, "success");
          openQuestionImagesModal();
        } catch (error) {
          showToast("整理失败：" + error.message, "error");
          btn.disabled = false;
        }
      })
    );
  }

  // 「已上传图片」列表的筛选状态：status = all | pending(待关联) | linked(已关联)
  let uploadFilter = { status: "all", keyword: "" };
  let uploadMetaMap = {};        // name -> meta，批量识别时复用卡片的序号 / 总数
  let uploadSelection = new Set(); // 多选模式下选中的图片名（仅未关联的、可删除的）

  // 批量识别的结果暂存：队列原本只活在 showRecognizeQueue 的闭包里，
  // 用户点「返回列表」整批结果就没了。暂存下来，回列表后还能接着处理剩下的。
  let recognizeQueueCache = null; // { queue: [...], pos: number }
  // 当前「已上传图片」弹窗的上下文：删除一张后就地更新这张表，不必重建整个弹窗
  let uploadsModalCtx = null;

  async function openUploadsModal() {
    uploadMetaMap = {};
    uploadSelection = new Set();
    let uploads = [];
    try {
      const data = await api("/api/uploads");
      uploads = data.uploads || [];
    } catch (error) {
      showToast("读取已上传图片失败：" + error.message, "error");
      return;
    }
    // 大模型是否可用：不可用时就不显示「AI 识别」按钮，避免点了才报错
    let llmReady = false;
    let llmLabel = "";
    try {
      const cfg = await api("/api/llm/config");
      llmReady = !!(cfg && cfg.enabled && (cfg.profiles || []).length);
      llmLabel = cfg?.active_label || "";
    } catch (error) {
      llmReady = false;
    }
    const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
    const fmtTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    if (!uploads.length) {
      openModal({
        title: "已上传图片",
        subtitle: "这里只放还没生成题目的图片。",
        body: `<p style="color:var(--muted)">上传并识别截图后、还没保存成题目的图片会留在这里；一旦入库，原图就会移到「题目原图」单独存放。</p>`,
        footer: `<button class="btn btn-primary" data-close-modal>关闭</button>`,
      });
      return;
    }
    const navList = uploads.map((u, i) => ({
      url: u.url,
      meta: {
        index: i + 1,
        total: uploads.length,
        name: u.name,
        stem: (u.questions || []).filter((q) => q && q.stem).map((q) => q.stem)[0] || "",
      },
    }));
    const pendingCount = uploads.filter((u) => !(u.used_by > 0)).length;
    const linkedCount = uploads.length - pendingCount;
    // 已生成题目的图片现在单独归档，这里通常一张「已关联」都没有，别留空筛选按钮
    if (uploadFilter.status === "linked" && !linkedCount) uploadFilter.status = "all";
    const cards = uploads.map((u, i) => {
      const used = u.used_by > 0;
      const tag = used
        ? `<span class="badge green">已在题库 ${u.used_by} 题</span>`
        : `<span class="badge gray">未保存题目</span>`;
      const qs = (u.questions || []).filter((q) => q && q.stem);
      // 用「序号 + 关联题目」直接告诉用户这张图是哪张，不必猜；
      // 还没关联题目的图则显示当初 OCR 识别出的文字，方便按内容找图
      const preview = qs.length
        ? `<div class="upload-q" title="${escapeHtml(qs.map((q) => q.stem).join("\n"))}">${escapeHtml(qs[0].stem)}${qs.length > 1 ? `<span class="upload-q-more">等 ${qs.length} 题</span>` : ""}</div>`
        : u.ocr_text
          ? `<div class="upload-q" title="${escapeHtml(u.ocr_text)}">${escapeHtml(u.ocr_text.slice(0, 56))}<span class="upload-q-more">待关联</span></div>`
          : `<div class="upload-q is-empty">尚未关联题目</div>`;
      const meta = {
        index: i + 1,
        total: uploads.length,
        name: u.name,
        stem: qs.length ? qs[0].stem : "",
        used: used,
      };
      uploadMetaMap[u.name] = meta;
      // 只有关联了题目的图片才允许删除；没关联的可以「识别」后与题库比对
      const recognizeBtn = used
        ? ""
        : `<button type="button" class="btn btn-ghost btn-sm upload-recognize" data-recognize-upload="${escapeHtml(u.name)}" data-mode="ocr" title="用本地 OCR 识别这张图里的题目，并与题库比对">${svg("search")}识别并关联</button>`;
      const aiBtn = used || !llmReady
        ? ""
        : `<button type="button" class="btn btn-ghost btn-sm upload-recognize ai" data-recognize-upload="${escapeHtml(u.name)}" data-mode="ai" title="用大模型${llmLabel ? `（${llmLabel}）` : ""}重新识别这张图里的题目，并与题库比对">${svg("spark")}AI识别</button>`;
      // 提示词与 AI 识别按钮成对出现；大模型没启用时两者都不渲染
      const aiHint = aiBtn ? aiHintHtml({ collapsible: true }) : "";
      const searchable = `${u.name} ${qs.map((q) => q.stem).join(" ")} ${u.ocr_text || ""}`.toLowerCase();
      return `<div class="upload-card" data-status="${used ? "linked" : "pending"}" data-upload-name="${escapeHtml(u.name)}" data-search="${escapeHtml(searchable)}">
        <div class="upload-thumb-wrap">
          ${used ? "" : `<label class="upload-check" title="选择这张图片，用于批量删除或批量识别"><input type="checkbox" data-select-upload="${escapeHtml(u.name)}"><span class="upload-check-mark">${svg("check")}</span></label>`}
          <span class="upload-idx" title="第 ${i + 1} 张，共 ${uploads.length} 张">${i + 1}</span>
          <button type="button" class="upload-thumb" data-view-image="${escapeHtml(u.url)}" data-upload-meta="${escapeHtml(JSON.stringify(meta))}" data-upload-index="${i}" title="查看原图：${escapeHtml(qs.length ? qs[0].stem : u.name)}">
            <img src="${escapeHtml(u.url)}" alt="第 ${i + 1} 张：${escapeHtml(qs.length ? qs[0].stem : u.name)}" loading="lazy">
          </button>
          <button type="button" class="icon-btn upload-del" data-del-upload="${escapeHtml(u.name)}" title="${used ? "该图片已被题目引用，不可删除" : "删除此图片"}" ${used ? "disabled" : ""}>${svg("trash")}</button>
        </div>
        <div class="upload-meta">
          <div class="upload-label">第 ${i + 1} 张 / 共 ${uploads.length} 张</div>
          ${preview}
          <div class="upload-sub">${fmtSize(u.size)} · ${fmtTime(u.mtime)}</div>
          <div class="upload-foot">
            ${tag}
          </div>
          ${recognizeBtn || aiBtn ? `<div class="upload-actions">${recognizeBtn}${aiBtn}</div>` : ""}
          ${aiHint}
        </div>
      </div>`;
    }).join("");
    // 上一次批量识别的结果还暂存着：顶部给一个入口，
    // 用户从识别结果点「返回列表」回来后，整批识别结果还在，随时能接着处理
    const pendingQueue = recognizeQueueCache
      ? recognizeQueueCache.queue.filter((q) => !q.done).length
      : 0;
    const resumeBar = pendingQueue
      ? `<div class="upload-resume">
          <button type="button" class="btn btn-primary btn-sm" id="uploadResumeQueue">${svg("spark")}继续处理批量识别结果（还有 ${pendingQueue} 张没处理）</button>
          <button type="button" class="icon-btn" id="uploadResumeDrop" aria-label="放弃这批识别结果" data-tip="放弃这批识别结果">${svg("close")}</button>
        </div>`
      : "";
    const root = openModal({
      title: "已上传图片",
      subtitle: `共 ${uploads.length} 张尚未生成题目的图片。已生成题目的原图已移到「题目原图」单独存放，可按状态筛选或搜索关键词。`,
      body: `${resumeBar}<div class="upload-filter-bar">
          <div class="upload-toolbar">
            <div class="upload-chips">
              <button type="button" class="chip ${uploadFilter.status === "all" ? "on" : ""}" data-filter="all">全部 <b>${uploads.length}</b></button>
              <button type="button" class="chip ${uploadFilter.status === "pending" ? "on" : ""}" data-filter="pending">待关联 <b>${pendingCount}</b></button>
              ${linkedCount ? `<button type="button" class="chip ${uploadFilter.status === "linked" ? "on" : ""}" data-filter="linked">已关联 <b>${linkedCount}</b></button>` : ""}
            </div>
            <div class="upload-search-wrap">
              ${svg("search")}
              <input type="search" class="upload-search" id="uploadSearch" placeholder="搜索文件名或题干关键词" value="${escapeHtml(uploadFilter.keyword)}">
            </div>
            <button class="btn btn-ghost btn-sm upload-select-btn" id="uploadSelectToggle" type="button" title="进入多选模式，可批量删除或批量识别">${svg("check")}多选</button>
          </div>
          <div class="upload-count" id="uploadCount"></div>
        </div>
        <div class="upload-scroll">
          <div class="upload-grid">${cards}</div>
          <div class="upload-empty" id="uploadEmpty" hidden>没有符合条件的图片，换个筛选条件试试。</div>
        </div>`,
      footer: `<div class="batch-bar" id="batchBar" hidden>
          <span class="batch-count" id="batchCount">已选 0 张</span>
          <div class="batch-actions">
            <button class="btn btn-ghost btn-sm" id="batchCancel" type="button">退出多选</button>
            <button class="btn btn-danger btn-sm" id="batchDelete" type="button" disabled>${svg("trash")}删除所选</button>
            <button class="btn btn-ghost btn-sm" id="batchOcr" type="button" disabled>${svg("search")}批量识别</button>
            <button class="btn btn-primary btn-sm ai" id="batchAi" type="button" disabled>${svg("spark")}批量 AI 识别</button>
          </div>
          ${aiHintHtml({ collapsible: true })}
        </div>
        <button class="btn btn-primary" data-close-modal>关闭</button>`,
      wide: true,
      bodyClass: "modal-body-gallery",
    });

    // 筛选：按状态（全部/待关联/已关联）+ 关键词（文件名或题干）
    const grid = root.querySelector(".upload-grid");
    root.querySelector(".modal-foot")?.classList.add("uploads-foot");
    bindFilterBarScroll(root);
    const applyFilter = () => {
      const kw = uploadFilter.keyword.trim().toLowerCase();
      let shown = 0;
      root.querySelectorAll(".upload-card").forEach((card) => {
        const okStatus = uploadFilter.status === "all" || card.dataset.status === uploadFilter.status;
        const okKw = !kw || (card.dataset.search || "").includes(kw);
        const show = okStatus && okKw;
        card.hidden = !show;
        if (show) shown += 1;
      });
      const cnt = root.querySelector("#uploadCount");
      if (cnt) cnt.textContent = `显示 ${shown} / ${uploads.length} 张`;
      const empty = root.querySelector("#uploadEmpty");
      if (empty) empty.hidden = shown > 0;
      grid && grid.classList.toggle("is-filtered", shown > 0 && shown < uploads.length);
    };
    root.querySelectorAll("[data-filter]").forEach((chip) =>
      chip.addEventListener("click", () => {
        uploadFilter.status = chip.dataset.filter;
        root.querySelectorAll("[data-filter]").forEach((c) => c.classList.toggle("on", c === chip));
        applyFilter();
      })
    );
    const searchInput = root.querySelector("#uploadSearch");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        uploadFilter.keyword = searchInput.value;
        applyFilter();
      });
    }
    applyFilter();
    // 接着处理上一批批量识别结果：入口摆在列表顶部，
    // 从识别结果点「返回列表」回来后不用重新识别一遍
    root.querySelector("#uploadResumeQueue")?.addEventListener("click", () => {
      if (recognizeQueueCache) showRecognizeQueue(recognizeQueueCache.queue, { resume: true });
    });
    root.querySelector("#uploadResumeDrop")?.addEventListener("click", () => {
      recognizeQueueCache = null;
      root.querySelector(".upload-resume")?.remove();
    });
    root.querySelectorAll("[data-view-image]").forEach((btn) => {
      let meta = null;
      try {
        meta = btn.dataset.uploadMeta ? JSON.parse(btn.dataset.uploadMeta) : null;
      } catch (err) {
        meta = null;
      }
      btn.addEventListener("click", () => {
        // 「上一张 / 下一张」只在当前筛选结果里翻，方便顺着筛选结果逐张处理
        const visible = root.querySelectorAll(".upload-card:not([hidden])");
        const list = [];
        visible.forEach((card) => {
          const idx = Number(card.querySelector(".upload-thumb")?.dataset.uploadIndex ?? -1);
          if (idx >= 0 && navList[idx]) list.push(navList[idx]);
        });
        const url = btn.dataset.viewImage;
        const pos = list.findIndex((item) => item.url === url);
        // 打开的是叠在列表之上的一层：点「返回列表」直接露出下面这张列表，不用重新拉数据
        openImageModal(url, meta, { list: list.length ? list : navList, index: pos >= 0 ? pos : Number(btn.dataset.uploadIndex || 0) });
      });
    });
    root.querySelectorAll("[data-del-upload]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteUpload(btn.dataset.delUpload);
      })
    );
    root.querySelectorAll("[data-recognize-upload]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const card = btn.closest(".upload-card");
        const idx = card?.querySelector(".upload-idx")?.textContent.trim() || "";
        recognizeUpload(btn.dataset.recognizeUpload, { index: idx }, btn.dataset.mode || "ocr");
      })
    );

    // —— 多选 / 批量操作 ——
    const selectToggle = root.querySelector("#uploadSelectToggle");
    const batchBar = root.querySelector("#batchBar");
    const batchCount = root.querySelector("#batchCount");
    const batchCancelBtn = root.querySelector("#batchCancel");
    const batchDeleteBtn = root.querySelector("#batchDelete");
    const batchOcrBtn = root.querySelector("#batchOcr");
    const batchAiBtn = root.querySelector("#batchAi");
    const updateBatchUI = () => {
      const n = uploadSelection.size;
      batchCount.textContent = `已选 ${n} 张`;
      const en = n > 0;
      batchDeleteBtn.disabled = !en;
      batchOcrBtn.disabled = !en;
      batchAiBtn.disabled = !en;
    };
    // 记下当前列表的上下文：删掉一张图片后就地更新这张表，不重建整个弹窗
    uploadsModalCtx = { root, uploads, navList, applyFilter, updateBatchUI };
    selectToggle.addEventListener("click", () => {
      const on = grid.classList.toggle("is-selecting");
      selectToggle.classList.toggle("active", on);
      selectToggle.innerHTML = on ? `${svg("check")}退出多选` : `${svg("check")}多选`;
      if (!on) {
        uploadSelection.clear();
        grid.querySelectorAll(".upload-card.selected").forEach((c) => c.classList.remove("selected"));
        grid.querySelectorAll("[data-select-upload]").forEach((c) => (c.checked = false));
      }
      batchBar.hidden = !on;
      updateBatchUI();
    });
    grid.querySelectorAll("[data-select-upload]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const name = cb.dataset.selectUpload;
        if (cb.checked) uploadSelection.add(name);
        else uploadSelection.delete(name);
        cb.closest(".upload-card").classList.toggle("selected", cb.checked);
        updateBatchUI();
      });
    });
    batchCancelBtn.addEventListener("click", () => {
      uploadSelection.clear();
      grid.classList.remove("is-selecting");
      selectToggle.classList.remove("active");
      selectToggle.innerHTML = `${svg("check")}多选`;
      grid.querySelectorAll(".upload-card.selected").forEach((c) => c.classList.remove("selected"));
      grid.querySelectorAll("[data-select-upload]").forEach((c) => (c.checked = false));
      batchBar.hidden = true;
      updateBatchUI();
    });
    batchDeleteBtn.addEventListener("click", async () => {
      const names = [...uploadSelection];
      if (!names.length) return;
      const ok = await confirmDialog(
        `删除选中的 ${names.length} 张图片？`,
        "仅删除本地图片文件与导入记录，不影响已保存的题目。此操作不可撤销。",
        "删除",
        true
      );
      if (!ok) return;
      batchDeleteBtn.disabled = true;
      let failed = 0;
      for (const name of names) {
        try {
          await api(`/api/uploads/${encodeURIComponent(name)}`, { method: "DELETE" });
          // 同样就地移除，列表不闪一下，滚动位置也留着
          removeUploadCard(name);
        } catch (err) {
          failed += 1;
        }
      }
      if (failed) showToast(`已删除 ${names.length - failed} 张，${failed} 张删除失败`, "error");
      else showToast(`已删除 ${names.length} 张图片`, "success");
    });
    batchOcrBtn.addEventListener("click", () => {
      const names = [...uploadSelection];
      if (names.length) batchRecognize(names, "ocr", "");
    });
    batchAiBtn.addEventListener("click", () => {
      const names = [...uploadSelection];
      if (!names.length) return;
      const correction = readAiHint(batchBar) || "";
      batchRecognize(names, "ai", correction);
    });
  }

  // 批量识别：逐张顺序处理（不并发），避免结果相互覆盖；
  // 全部识别完后再以「队列」形式一张张呈现，方便用户逐一处理。
  async function batchRecognize(names, mode, correction = "") {
    if (!names.length) return;
    const total = names.length;
    const queue = [];
    let done = 0;
    const root = openModal({
      title: mode === "ai" ? "批量 AI 识别" : "批量识别",
      subtitle: `共 ${total} 张，正在逐张识别…`,
      body: `<div class="batch-progress">
          <div class="progress-track"><i id="batchBarFill" style="width:0%"></i></div>
          <p id="batchProgressText">准备中…</p>
        </div>`,
      footer: `<button class="btn btn-primary" data-close-modal>关闭</button>`,
      small: true,
    });
    const fill = root.querySelector("#batchBarFill");
    const txt = root.querySelector("#batchProgressText");
    for (const name of names) {
      const meta = uploadMetaMap[name] || { index: "?", total, name };
      txt.textContent = `正在识别第 ${done + 1} / ${total} 张：${name}`;
      try {
        const data = await api(`/api/uploads/${encodeURIComponent(name)}/recognize`, {
          method: "POST",
          body: { mode, correction },
        });
        queue.push({ name, meta, data });
      } catch (err) {
        queue.push({ name, meta, data: { questions: [], error: err.message || "识别失败" } });
      }
      done += 1;
      if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
    }
    txt.textContent = `识别完成，共 ${total} 张`;
    setTimeout(() => {
      closeModal(false);
      showRecognizeQueue(queue);
    }, 450);
  }

  // 识别结果队列：每张结果单独呈现，带「上一张 / 下一张」，处理完一项自动跳到下一项，
  // 满足「同时识别多个题目时，一一处理、互不打断」的需求。
  // options.resume = true 时从「第一张还没处理完的」接着来（返回列表后再进来用）。
  function showRecognizeQueue(queue, options = {}) {
    if (!queue || !queue.length) {
      showToast("没有可识别的图片", "error");
      return;
    }
    let pos = 0;
    const total = queue.length;
    if (options.resume) {
      const first = queue.findIndex((q) => !q.done);
      if (first !== -1) pos = first;
    } else if (Number.isInteger(options.startPos) && options.startPos >= 0) {
      pos = Math.min(options.startPos, total - 1);
    }
    // 整批结果暂存起来：用户点「返回列表」时不会把识别结果一起丢掉，
    // 回列表后还能从顶部的入口接着处理剩下的。
    recognizeQueueCache = { queue, pos };
    const root = openModal({
      title: "批量识别结果",
      subtitle: "逐张查看并处理：可加入题库、关联或删除。",
      body: `<div class="rec-queue">
          <div class="rec-queue-bar">
            <div class="rec-queue-meta">第 <b id="rqPos">1</b> / ${total} 张</div>
            <div class="rec-queue-nav">
              <button class="btn btn-ghost btn-sm" id="rqPrev" type="button" disabled>${svg("chevron")}上一张</button>
              <button class="btn btn-ghost btn-sm" id="rqNext" type="button"${total <= 1 ? " disabled" : ""}>下一张${svg("chevron")}</button>
            </div>
          </div>
          <div class="rec-queue-progress"><div class="progress-track"><i id="rqFill" style="width:${Math.round((1 / total) * 100)}%"></i></div></div>
          <div id="rqBody" class="rec"></div>
        </div>`,
      footer: `<button class="btn btn-ghost" id="rqBack" type="button">返回列表</button><button class="btn btn-primary" data-close-modal>完成</button>`,
      wide: true,
    });
    const rqBody = root.querySelector("#rqBody");
    const rqPos = root.querySelector("#rqPos");
    const rqFill = root.querySelector("#rqFill");
    const prevBtn = root.querySelector("#rqPrev");
    const nextBtn = root.querySelector("#rqNext");
    const render = () => {
      const item = queue[pos];
      // 队列里把序号改成「当前第几张 / 本批共几张」，与顶部计数保持一致，
      // 不再显示原始 53 张列表里的旧序号，避免两套计数混淆。
      if (item.deleted) {
        // 这张已经删掉了，别再渲染识别结果，免得看着像还能操作
        rqBody.innerHTML = `<div class="rec-all-done"><svg><use href="#i-check"></use></svg><p>这张图片已删除。</p><p class="rec-all-done-sub">点「下一张」继续处理剩下的图片。</p></div>`;
      } else {
        rqBody.innerHTML = buildRecInner(item.name, item.data, { ...item.meta, index: pos + 1, total });
        wireRecActions(rqBody, item.name, item.data, (kind) => {
          item.done = true;
          if (kind === "deleted") item.deleted = true;
          afterAct();
        });
      }
      rqPos.textContent = String(pos + 1);
      if (rqFill) rqFill.style.width = `${Math.round(((pos + 1) / total) * 100)}%`;
      prevBtn.disabled = pos === 0;
      nextBtn.disabled = pos === total - 1;
      if (recognizeQueueCache) recognizeQueueCache.pos = pos;
    };
    const afterAct = () => {
      const nextPos = queue.findIndex((q, i) => i > pos && !q.done);
      const firstUndone = queue.findIndex((q) => !q.done);
      if (nextPos !== -1) {
        pos = nextPos;
        render();
      } else if (firstUndone !== -1) {
        pos = firstUndone;
        render();
      } else {
        // 全部处理完了，暂存就没意义了，清掉免得列表顶部一直挂着入口
        recognizeQueueCache = null;
        rqBody.innerHTML = `<div class="rec-all-done"><svg><use href="#i-check"></use></svg><p>全部图片已处理完成。</p><p class="rec-all-done-sub">点「完成」返回已上传图片列表。</p></div>`;
        prevBtn.disabled = true;
        nextBtn.disabled = true;
      }
    };
    prevBtn.addEventListener("click", () => {
      if (pos > 0) {
        pos -= 1;
        render();
      }
    });
    nextBtn.addEventListener("click", () => {
      if (pos < total - 1) {
        pos += 1;
        render();
      }
    });
    // 「返回列表」不清暂存：整批识别结果还在列表顶部的入口里，随时能接着处理
    root.querySelector("#rqBack").addEventListener("click", () => openUploadsModal());
    render();
  }

  // 单张识别结果的内部 HTML（识别头 + 各题识别块），单张与批量队列共用
  function buildRecInner(name, data, meta) {
    const questions = data.questions || [];
    const linked = data.linked || 0;
    const conflicts = data.conflicts || [];
    const isAi = data.mode === "ai";
    const modeTag = isAi
      ? `<span class="badge purple">${svg("spark")}大模型识别${data.ai_model ? ` · ${escapeHtml(data.ai_model)}` : ""}</span>`
      : `<span class="badge gray">本地 OCR 识别</span>`;
    const aiError = data.ai_error
      ? `<div class="rec-warn">${svg("alert")}<span>大模型识别失败，已改用本地 OCR 的结果：${escapeHtml(data.ai_error)}</span></div>`
      : "";
    const errBlock = data.error
      ? `<div class="rec-warn">${svg("alert")}<span>识别失败：${escapeHtml(data.error)}</span></div>`
      : "";
    const blocks = questions
      .map((q, i) => {
        const m = q.match;
        let status = "";
        let actions = "";
        const srcTag = q.source === "ai" ? `<span class="badge purple">AI</span>` : `<span class="badge gray">OCR</span>`;
        if (q.status === "linked" && m) {
          status = `<span class="badge green">${svg("check")}已关联到题目 ${escapeHtml(m.qno || "#" + m.id)}</span>`;
          actions = `<button type="button" class="btn btn-ghost btn-sm" data-unlink-upload="${escapeHtml(name)}" data-qid="${m.id}">取消关联</button>`;
        } else if (q.status === "conflict" && m) {
          status = `<span class="badge amber">${svg("alert")}题目 ${escapeHtml(m.qno || "#" + m.id)} 已有原图</span>`;
          actions = linked
            ? `<span class="rec-note">当前图片已关联到题库其它题目，不能删除</span>`
            : `<button type="button" class="btn btn-danger btn-sm" data-del-upload="${escapeHtml(name)}" data-del-conflict="1">删除当前这张图片</button>`;
        } else {
          status = `<span class="badge gray">题库中未找到这道题</span>`;
          actions = `<button type="button" class="btn btn-primary btn-sm" data-add-from-upload="${escapeHtml(name)}" data-qindex="${i}">加入题库</button>`;
        }
        const opts = q.options && Object.keys(q.options).length
          ? `<div class="rec-opts">${Object.entries(q.options).map(([k, v]) => `<span><b>${escapeHtml(k)}.</b> ${escapeHtml(v)}</span>`).join("")}</div>`
          : "";
        const matchStem = m ? `<div class="rec-match">题库中的原题：${escapeHtml(m.stem || "")}</div>` : "";
        const existImg = m && m.source_image
          ? `<div class="rec-exist"><img src="/${escapeHtml(String(m.source_image).replace(/^\/+/, ""))}" alt="题库中已有的原图"><small>题库里这道题现在用的原图</small></div>`
          : "";
        return `<div class="rec-item">
          <div class="rec-item-head"><b>识别到第 ${i + 1} 道题</b>${srcTag}${status}</div>
          <div class="rec-stem">${escapeHtml(q.stem || "")}</div>
          ${opts}
          ${q.answer ? `<div class="rec-answer">答案：${escapeHtml(q.answer)}</div>` : ""}
          ${expHtml(q, `rec${i}`)}
          ${q.user_answer ? `<div class="rec-match">图片中的作答：<b>${escapeHtml(q.user_answer)}</b>${q.was_wrong ? `<span class="badge red" style="margin-left:6px">原图答错</span>` : ""}</div>` : ""}
          ${matchStem}
          ${existImg}
          <div class="rec-actions">${actions}</div>
        </div>`;
      })
      .join("");
    const headline = linked
      ? `已把第 ${meta.index || "?"} 张图片关联到题库中已有的 ${linked} 道题。`
      : conflicts.length
      ? `第 ${meta.index || "?"} 张图片对应的题目在题库里已经有原图，建议删除这张图片。`
      : questions.length
      ? `第 ${meta.index || "?"} 张图片里的题目在题库里还没有，可直接加入。`
      : `第 ${meta.index || "?"} 张图片没有识别出题目。`;
    const imgUrl = data.image && data.image.url ? "/" + String(data.image.url).replace(/^\/+/, "") : "";
    const thumb = imgUrl
      ? `<img class="rec-thumb" src="${escapeHtml(imgUrl)}" alt="当前图片">`
      : `<div class="rec-thumb rec-thumb-empty">无图</div>`;
    // 每张图片都要有删除入口：不管这道题在题库里算「新题」还是「冲突」，
    // 用户想删这张图就得能删 —— 以前只有冲突图才给按钮，其余的卡住没法继续处理。
    // 已经关联到题目的图删不掉（后端会拒绝），就明说，不给一个点了没反应的按钮。
    const deleteAction = linked
      ? `<span class="rec-note">已关联到题目，不能删除</span>`
      : `<button type="button" class="btn btn-ghost btn-sm rec-del-image" data-del-upload="${escapeHtml(name)}">${svg("trash")}删除这张图片</button>`;
    return `<div class="rec-head">
        ${thumb}
        <div class="rec-head-text">
          <div class="upload-ident-tag">第 ${escapeHtml(meta.index || "?")} 张${meta.total ? ` / 共 ${meta.total} 张` : ""}</div>
          <div class="rec-file">${escapeHtml(name)}</div>
          <div class="rec-mode">${modeTag}</div>
          <div class="rec-lead">${escapeHtml(headline)}</div>
        </div>
        <div class="rec-head-actions">${deleteAction}</div>
      </div>
      ${aiError}
      ${errBlock}
      ${blocks || `<p style="color:var(--muted)">没有识别出题目，可能是图片内容太模糊。</p>`}`;
  }

  // 绑定单张 / 队列里每张结果的「加入题库 / 关联 / 删除」动作；
  // onResolved 在用户处理完当前这张后调用（单张时回到列表，队列里则跳到下一张），
  // 第二个参数说明这次做的是哪种处理，队列据此把「已删除」的那张标出来。
  function wireRecActions(scope, name, data, onResolved) {
    const questions = data.questions || [];
    scope.querySelectorAll("[data-unlink-upload]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api(`/api/uploads/${encodeURIComponent(b.dataset.unlinkUpload)}/unlink`, { method: "POST" });
          showToast("已取消关联", "success");
          onResolved && onResolved("unlinked");
        } catch (err) {
          showToast(err.message || "取消关联失败", "error");
        }
      })
    );
    scope.querySelectorAll("[data-del-upload]").forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        // 冲突图（题库里已有同一道题）与普通图的提示文案不一样，说清楚再删
        const isConflict = b.dataset.delConflict === "1";
        const ok = await confirmDialog(
          isConflict ? "删除当前这张图片？" : "删除这张图片？",
          isConflict
            ? "这张图对应的题目在题库里已经有原图，删除后不会影响题库里的题目。"
            : "仅删除本地图片文件与导入记录，不影响已保存的题目。",
          "删除"
        );
        if (!ok) return;
        try {
          await api(`/api/uploads/${encodeURIComponent(b.dataset.delUpload)}`, { method: "DELETE" });
          showToast("已删除图片", "success");
          onResolved && onResolved("deleted");
        } catch (err) {
          showToast(err.message || "删除失败", "error");
        }
      })
    );
    scope.querySelectorAll("[data-add-from-upload]").forEach((b) =>
      b.addEventListener("click", async () => {
        const q = questions[Number(b.dataset.qindex)] || {};
        b.disabled = true;
        b.innerHTML = `<span class="spinner"></span>保存中…`;
        try {
          await api("/api/questions", {
            method: "POST",
            body: {
              stem: q.stem,
              qtype: q.qtype,
              options: q.options,
              answer: q.answer,
              explanation: q.explanation,
              tags: q.tags,
              user_answer: q.user_answer || "",
              was_wrong: Boolean(q.answer && q.user_answer && !simpleAnswersEqual(q.answer, q.user_answer, q.qtype)),
              source_image: `uploads/${b.dataset.addFromUpload}`,
            },
          });
          showToast("已加入题库并关联这张图片", "success");
          onResolved && onResolved("added");
        } catch (err) {
          showToast(err.message || "加入题库失败", "error");
          b.disabled = false;
          b.innerHTML = "加入题库";
        }
      })
    );
  }

  // 识别一张未关联题目的图片，拿它的题干去题库比对
  // mode: "ocr" = 本地 OCR；"ai" = 大模型（更准，但慢、要联网）
  async function recognizeUpload(name, meta = {}, mode = "ocr") {
    if (!name) return;
    const isAi = mode === "ai";
    const btn = document.querySelector(`[data-recognize-upload="${CSS.escape(name)}"][data-mode="${mode}"]`);
    const card = btn?.closest(".upload-card");
    const original = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>${isAi ? "AI识别中…" : "识别中…"}`;
    }
    card?.querySelector(".upload-status")?.remove();
    const status = document.createElement("div");
    status.className = "upload-status";
    const correction = isAi ? readAiHint(card) : "";
    status.textContent = isAi
      ? `正在用大模型识别第 ${meta.index || "?"} 张图片…${correction ? "（已带上补充提示）" : "（首次可能要几十秒）"}`
      : `正在识别第 ${meta.index || "?"} 张图片…（需十几秒）`;
    card?.querySelector(".upload-meta")?.appendChild(status);
    try {
      const data = await api(`/api/uploads/${encodeURIComponent(name)}/recognize`, {
        method: "POST", body: { mode, correction },
      });
      showRecognizeResult(name, meta, data);
    } catch (error) {
      showToast(error.message || "识别失败", "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
      status.remove();
    }
  }

  function showRecognizeResult(name, meta, data) {
    const root = openModal({
      title: `识别结果 · 第 ${meta.index || "?"} 张`,
      subtitle: "识别结果已与题库比对：题干相同即视为同一道题。",
      body: `<div class="rec">${buildRecInner(name, data, meta)}</div>`,
      footer: `<button class="btn btn-ghost" data-back-uploads>返回图片列表</button><button class="btn btn-primary" data-close-modal>完成</button>`,
      wide: true,
    });
    root.querySelectorAll("[data-back-uploads]").forEach((b) => b.addEventListener("click", () => openUploadsModal()));
    wireRecActions(root, name, data, () => openUploadsModal());
  }

  // 删掉一张图片后，就地把这张卡片摘掉：滚动位置、筛选、多选状态全都留着，
  // 用户可以接着删下一张 —— 以前整页重建，列表一眨眼就没了，手上的活儿也断了。
  function removeUploadCard(name) {
    const ctx = uploadsModalCtx;
    // 当前弹窗已经不是「已上传图片」列表了（比如被识别结果弹窗替换），那就重开列表
    if (!ctx || !ctx.root || !ctx.root.querySelector(".upload-grid")) {
      openUploadsModal();
      return;
    }
    const idx = ctx.uploads.findIndex((u) => u.name === name);
    if (idx !== -1) ctx.uploads.splice(idx, 1);
    if (ctx.navList && idx !== -1) ctx.navList.splice(idx, 1);
    delete uploadMetaMap[name];
    uploadSelection.delete(name);
    ctx.root.querySelector(`.upload-card[data-upload-name="${CSS.escape(name)}"]`)?.remove();

    // 序号重排：删掉一张后，后面几张的「第 N 张」和导航索引都要跟着往前挪
    const cards = Array.from(ctx.root.querySelectorAll(".upload-card"));
    const total = cards.length;
    cards.forEach((card, i) => {
      const label = card.querySelector(".upload-label");
      if (label) label.textContent = `第 ${i + 1} 张 / 共 ${total} 张`;
      const idxEl = card.querySelector(".upload-idx");
      if (idxEl) {
        idxEl.textContent = String(i + 1);
        idxEl.title = `第 ${i + 1} 张，共 ${total} 张`;
      }
      const thumb = card.querySelector(".upload-thumb");
      if (thumb) thumb.dataset.uploadIndex = String(i);
      const nm = card.dataset.uploadName;
      if (nm && uploadMetaMap[nm]) uploadMetaMap[nm].index = i + 1;
    });
    if (ctx.navList) {
      ctx.navList.forEach((item, i) => {
        if (item.meta) {
          item.meta.index = i + 1;
          item.meta.total = total;
        }
      });
    }

    // 顶部筛选 chip 与标题里的总数也跟着变
    const allChip = ctx.root.querySelector('.chip[data-filter="all"] b');
    if (allChip) allChip.textContent = String(ctx.uploads.length);
    const pendingChip = ctx.root.querySelector('.chip[data-filter="pending"] b');
    if (pendingChip) {
      pendingChip.textContent = String(ctx.uploads.filter((u) => !(u.used_by > 0)).length);
    }
    const subtitle = ctx.root.querySelector(".modal-head p");
    if (subtitle) {
      subtitle.textContent = `共 ${ctx.uploads.length} 张尚未生成题目的图片。已生成题目的原图已移到「题目原图」单独存放，可按状态筛选或搜索关键词。`;
    }
    ctx.applyFilter();
    ctx.updateBatchUI();
  }

  async function deleteUpload(name) {
    if (!name) return;
    const ok = await confirmDialog("删除这张图片？", "仅删除本地图片文件与导入记录，不影响已保存的题目。", "删除");
    if (!ok) return;
    try {
      await api(`/api/uploads/${encodeURIComponent(name)}`, { method: "DELETE" });
      showToast("已删除图片", "success");
      // 就地摘掉这张卡片，不重建整个弹窗：滚动、筛选、多选都留着，能接着删下一张
      removeUploadCard(name);
    } catch (error) {
      showToast(error.message || "删除失败", "error");
    }
  }

  // ---------------------------------------------------------------------
  // Global bindings / init
  // ---------------------------------------------------------------------
  function bindGlobal() {
    // 从别的标签页/别的设备加了题，切回页面时立刻强制校验标签指纹
    // （置脏可以绕过 5 秒节流，保证新标签马上出现）
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) invalidateTags(true);
    });
    window.addEventListener("focus", () => invalidateTags(true));
    document.addEventListener("click", (event) => {
      // 手册目录跳章：只滚动，不改地址栏。
      // 地址栏的 hash 已经被视图路由占了（#capture / #library …），
      // 用它当章节点会把 hashchange 触发成「切换视图」。
      const guideAnchor = event.target.closest("[data-anchor]");
      if (guideAnchor) {
        event.preventDefault();
        const target = document.getElementById(guideAnchor.dataset.anchor);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          // 目录高亮立刻跟上，不等滚动结束
          document.querySelectorAll(".guide-toc [data-anchor]").forEach((a) =>
            a.classList.toggle("is-current", a === guideAnchor)
          );
        }
        return;
      }
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        event.preventDefault();
        const opts = {};
        if (viewButton.dataset.view === "codeHistory" && viewButton.dataset.chPaper) {
          // 来源页由 switchView 统一记录，这里只透传「按试卷过滤」参数
          opts.chPaper = viewButton.dataset.chPaper;
        }
        switchView(viewButton.dataset.view, opts);
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === "code-history-back") { switchView(codeHistoryReturnView || "library"); return; }
      if (action === "go-capture") switchView("capture");
      if (action === "go-library") switchView("library");
      if (action === "go-wrong") switchView("wrong");
      if (action === "go-stats") switchView("stats");
      if (action === "start-practice") switchView("practice");
      if (action === "scroll-top") window.scrollTo({ top: 0, behavior: "smooth" });
      if (action === "start-wrong-practice") {
        // 没有待攻克的错题就别硬开错题重练，改走随机练习
        const counts = practiceModeCounts();
        if (counts && counts.wrong <= 0) {
          state.practice.mode = "random";
          state.practice.modePinned = false;
          switchView("practice");
          setTimeout(() => startPractice("random"), 80);
          showToast("没有待攻克的错题了，已切换到随机练习", "info");
          return;
        }
        state.practice.mode = "wrong";
        state.practice.modePinned = true;
        state.practice.session = null;
        switchView("practice");
        setTimeout(() => startPractice("wrong"), 80);
      }
      if (action === "open-add-question") openQuestionEditor(null);
      if (action === "reload-stats") loadStats();
    });
    document.addEventListener("click", (event) => {
      // 「解析」开关：必须排在 [data-detail-id] 前面 —— 统计 / 概览里整卡可点，
      // 按钮若被当成整卡点击就会误开详情弹窗
      const expBtn = event.target.closest("[data-exp-toggle]");
      if (expBtn) {
        event.preventDefault();
        event.stopPropagation();
        toggleExplanation(expBtn);
        return;
      }
      // 统计 / 概览里的题目条目：点击是「看这道题」，不是直接进编辑表单
      const detailItem = event.target.closest("[data-detail-id]");
      if (detailItem) openQuestionDetail(Number(detailItem.dataset.detailId));
    });
    // 条目是 div，补上键盘可操作性（Enter / 空格等同点击）
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // 条目内部的按钮（解析开关）有自己的键盘行为，别再补一次整卡点击
      if (event.target.closest?.("button, a, input, textarea, select")) return;
      const item = event.target.closest?.("[data-detail-id]");
      if (!item) return;
      event.preventDefault();
      item.click();
    });
    // 弹窗内的“合并行”按钮（草稿卡里的由 handleDraftClick 单独处理）
    $("#modalRoot").addEventListener("click", (event) => {
      const mergeBtn = event.target.closest("[data-merge-lines]");
      if (!mergeBtn) return;
      event.preventDefault();
      applyMergeLines(mergeBtn);
    });
    $("#modalRoot").addEventListener("input", (event) => {
      if (event.target.name === "answer") {
        syncTfTone(event.target, $("#editorType")?.value);
        return;
      }
      const area = event.target.closest("textarea");
      if (!area) return;
      const button = area.closest(".field")?.querySelector("[data-merge-lines]");
      if (button) button.hidden = !area.value.includes("\n");
    });
    document.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("hashchange", () => {
      const view = location.hash.replace("#", "") || "dashboard";
      if (view !== state.view) switchView(view, { keepHash: true });
    });
    $("#shutdownApp").addEventListener("click", async () => {
      const ok = await confirmDialog("退出错题簿？", "本地服务将停止。你可以随时重新双击启动程序。", "退出", true);
      if (!ok) return;
      try {
        await api("/api/shutdown", { method: "POST" });
        showToast("程序已退出，可以关闭这个页面了", "success");
      } catch (_error) {
        showToast("程序已退出，可以关闭这个页面了", "success");
      }
    });
  }

  // 全局悬浮提示气泡：由 initTooltips 创建，供各处收起。
  let tipEl = null;
  function hideTip() {
    if (!tipEl) return;
    tipEl.hidden = true;
    tipEl.removeAttribute("data-pos");
  }

  // 原生 title 气泡（浏览器自带那个灰色小方块）有两个毛病：
  // 一是丑得跟整体风格不搭；二是手机长按/点按就会冒出来，还浮在最上层，
  // 正好压住刚打开的弹窗内容（比如「查看原图」挡住「重新识别」按钮）。
  // 所以统一把 title 搬进 data-tip，改由我们的主题气泡接管。
  // 只有图标、没有可见文字的元素要补一个 aria-label，
  // 否则读屏软件念不出这是什么按钮（去掉 title 就等于丢了无障碍名）。
  function normalizeTitle(el) {
    if (!el || el.nodeType !== 1) return;
    const text = el.getAttribute("title");
    if (text == null) return;
    el.removeAttribute("title");
    const trimmed = text.trim();
    if (!trimmed) {
      // 标题被清空了（比如「同步」徽标没有同步时间），旧提示也要一起收走
      el.removeAttribute("data-tip");
      if (el.getAttribute("data-tip-label") === "1") {
        el.removeAttribute("aria-label");
        el.removeAttribute("data-tip-label");
      }
      return;
    }
    el.setAttribute("data-tip", text);
    // 只有图标、没有可见文字的元素要补一个 aria-label，
    // 否则读屏软件念不出这是什么按钮（去掉 title 就等于丢了无障碍名）。
    if (!el.hasAttribute("aria-label") && !hasInnerLabel(el)) {
      el.setAttribute("aria-label", text);
      el.setAttribute("data-tip-label", "1");
    }
  }
  // 元素自己（或里面的图片）有没有已经能念出来的名字
  function hasInnerLabel(el) {
    if ((el.textContent || "").trim()) return true;
    const img = el.querySelector && el.querySelector("img[alt]");
    return !!(img && (img.getAttribute("alt") || "").trim());
  }
  function normalizeTitles(root) {
    if (!root) return;
    if (root.nodeType === 1) normalizeTitle(root);
    if (root.querySelectorAll) root.querySelectorAll("[title]").forEach(normalizeTitle);
  }
  // 页面内容是动态生成的（列表、弹窗、题目卡片），
  // 所以要盯着 DOM 变化随时把新出现的 title 收走。
  function initTitleNormalization() {
    normalizeTitles(document.body);
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === "attributes") {
          normalizeTitle(rec.target);
          continue;
        }
        rec.addedNodes.forEach((node) => {
          if (node.nodeType === 1) normalizeTitles(node);
        });
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });
  }

  // 自定义悬浮提示：接管所有原生 title，换成与「暖纸灯下」主题一致的气泡，
  // 同时去掉浏览器丑陋的原生气泡。
  function initTooltips() {
    const tip = document.createElement("div");
    tip.className = "wb-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    tipEl = tip;

    function show(el) {
      let text = el.getAttribute("data-tip");
      if (text == null && el.hasAttribute("title")) {
        text = el.getAttribute("title");
        el.setAttribute("data-tip", text);
        el.removeAttribute("title"); // 去掉原生气泡，避免双重提示
      }
      if (!text || !text.trim()) { hide(); return; }
      // 弹窗开着的时候，底层页面的元素就别再冒泡了 ——
      // 气泡浮在弹窗上方，会挡住弹窗里的内容（手机上尤其明显）。
      const modalRoot = $("#modalRoot");
      if (modalRoot && !modalRoot.hidden && !modalRoot.contains(el)) { hide(); return; }
      tip.textContent = text;
      tip.hidden = false;
      position(el);
    }
    function hide() { hideTip(); }

    function position(el) {
      const r = el.getBoundingClientRect();
      tip.style.left = "0px"; tip.style.top = "0px";
      const tr = tip.getBoundingClientRect();
      const gap = 8;
      let left = r.left + r.width / 2 - tr.width / 2;
      let top = r.top - tr.height - gap;
      let pos = "top";
      if (top < 6) { top = r.bottom + gap; pos = "bottom"; }
      left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
      tip.dataset.pos = pos;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
      tip.style.setProperty("--caret-x", (r.left + r.width / 2 - left) + "px");
    }

    // 触屏没有 hover 语义：手指点一下，浏览器也会补发 mouseover，
    // 那时气泡会浮在刚打开的弹窗上，正好挡住「重新识别」按钮。
    // 用「上一次输入是不是手指」来把关：点按一律不提示，键盘 Tab 才提示。
    let lastInputTouch = false;
    document.addEventListener("pointerdown", (e) => {
      lastInputTouch = e.pointerType !== "mouse";
      if (lastInputTouch) hide();
    }, true);
    document.addEventListener("keydown", () => { lastInputTouch = false; }, true);

    document.addEventListener("pointerover", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (!el || el.closest(".sidebar-icons")) { hide(); return; }
      show(el);
    }, true);
    document.addEventListener("pointerout", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const from = e.target.closest && e.target.closest("[data-tip]");
      const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-tip]");
      if (from && from !== to) hide();
    }, true);
    // 兼容只派发 mouseover 的环境；触屏补发的那次会被上面的判断挡掉
    document.addEventListener("mouseover", (e) => {
      if (lastInputTouch) return;
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (!el || el.closest(".sidebar-icons")) { hide(); return; }
      show(el);
    }, true);
    document.addEventListener("mouseout", (e) => {
      if (lastInputTouch) return;
      const from = e.target.closest && e.target.closest("[data-tip]");
      const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-tip]");
      if (from && from !== to) hide();
    }, true);
    document.addEventListener("focusin", (e) => {
      if (lastInputTouch) { hide(); return; }
      const el = e.target.closest && e.target.closest("[data-tip]");
      if (!el || el.closest(".sidebar-icons") || el.matches("input, textarea, select")) return;
      // :focus-visible 只在键盘操作时成立 —— 手指点按拿到的焦点不算，
      // 免得气泡赖在「重新识别」按钮上方不走。
      let keyboard = true;
      try { keyboard = el.matches(":focus-visible"); } catch (_error) { keyboard = !lastInputTouch; }
      if (keyboard) show(el); else hide();
    });
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }

  async function init() {
    bindGlobal();
    // 先把原生 title 收干净，再挂自定义气泡 —— 顺序反了会漏掉一部分
    initTitleNormalization();
    initTooltips();
    initSidebar();
    bindCapture();
    bindLibrary();
    bindPractice();
    bindWrong();
    bindLlmSettings();
    bindCorrections();
    const normalizeBtn = $("#normalizeLines");
    if (normalizeBtn) normalizeBtn.addEventListener("click", normalizeExistingLines);
    $("#copyLanUrl")?.addEventListener("click", copyLanUrl);
    $("#lanDiagRefresh")?.addEventListener("click", () => loadLanDiag(true));
    $("#lanHosts")?.addEventListener("click", (event) => {
      const btn = event.target.closest?.("[data-host]");
      if (btn) loadLanInfo(btn.dataset.host);
    });
    setInterval(pollMobileInbox, 3000);
    // 兜底：即使标签是别的设备新增的，页面停留不动最多 30 秒也会自动更新
    setInterval(() => { if (!document.hidden) invalidateTags(true); }, 30000);
    // 不阻塞首屏：手机端先用本地快照渲染下拉，联网成功后再静默换成实时标签
    loadTags();
    // 扫码入口 /p/<token> 会跳到 /?entry=qr#dashboard。手机浏览器或桌面图标
    // 有时会恢复上次停留的 #settings，这里以扫码标记为准，一律回到概览首页。
    const fromQr = new URLSearchParams(location.search).get("entry") === "qr";
    // 扫码、桌面图标、浏览器会话恢复都是一次「新导航」；手动刷新属于 reload。
    // 手机端新导航若仍指向 #settings，说明是浏览器记住了上次的页面，回概览首页；
    // 而在设置页主动刷新（配置大模型、一键同步）则保留当前页。
    const navEntry = (performance.getEntriesByType("navigation") || [])[0];
    const isReload = !!navEntry && navEntry.type === "reload";
    const hashView = location.hash.replace("#", "");
    let initial = VIEW_META[hashView] ? hashView : "dashboard";
    if (fromQr || (isPhoneLayout() && !isReload && initial === "settings")) {
      initial = "dashboard";
      // 清掉入口参数与残留 hash，随后「添加到桌面」保存的也是干净的首页地址
      history.replaceState(null, "", `${location.pathname}#dashboard`);
    }
    switchView(initial, { keepHash: true });
    initSync();
  }

  document.addEventListener("DOMContentLoaded", init);

  // 整卷模块（static/js/codepaper.js）是另一个独立 IIFE，访问不到本文件作用域
  // 里的弹窗 / 提示函数。历史上「定向重解析」直接裸调用 openModal 会抛
  // ReferenceError 而毫无反应。这里显式挂一个桥接对象供它复用主站弹窗层。
  window.appUI = { openModal, closeModal, showToast, confirmDialog, switchView, refreshPaperViews };
})();
