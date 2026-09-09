(function () {
  const Z = window.ZJ = window.ZJ || {};

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };
  const curTermLabel = () => {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
    if (m >= 3 && m <= 5) return y + '春';
    if (m >= 6 && m <= 8) return y + '暑';
    if (m >= 9 && m <= 11) return y + '秋';
    return y + '寒';
  };
  const termDispL = l => String(l || '').replace('暑', ' 暑期').replace('秋', ' 秋季').replace('寒', ' 寒假').replace('春', ' 春季');
  const SEASON_NAME = { '暑': '暑期', '秋': '秋季', '寒': '寒假', '春': '春季' };
  const TEACHER_ALIASES = { '飞飞': '王易飞', '温温': '温佳炜', '小明': '小明老师', '小明老师': '小明老师', '小天': '陈世崇', '小树': '束亚成', '金金': '刘金鑫', '晓晓': '张梦晓', '章章': '章雪萍', '俞老师': '俞锐钦' };
  const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级'];
  const GRADE_ORDER = ['1年级', '2年级', '3年级', '4年级', '5年级', '6年级', '7年级', '8年级', '9年级'];
  const TYPE_COLOR = { '尖子': 'c-zhong', '中考': 'c-zhong', '创新': 'c-chuang', '自招': 'c-chuang' };
  const SUBJ_COLOR = { '物理': 'c-wuli' };
  const SYS_SUBJECT = { '小学奥数': '数学', '初中数学': '数学', '初中物理': '物理' };

  const normalizeTeacher = v => {
    const s = String(v || '').trim().replace(/老师$/, '');
    return TEACHER_ALIASES[s] || TEACHER_ALIASES[s + '老师'] || s;
  };
  const normalizeSubject = (v, className = '') => {
    const s = String(v || '') + String(className || '');
    if (s.includes('物理')) return '物理';
    if (s.includes('数学') || s.includes('奥数') || s.includes('奥综') || s.includes('小奥') || s.includes('中考') || s.includes('自招') || s.includes('创新') || s.includes('尖子') || s.includes('小明')) return '数学';
    return String(v || '数学') || '数学';
  };
  const classType = v => {
    const s = String(v || '');
    if (s.includes('小明班')) return '小明班';
    if (s.includes('自招')) return '自招';
    if (s.includes('中考')) return '中考';
    if (s.includes('创新')) return '创新';
    if (s.includes('尖子')) return '尖子';
    if (s.includes('奥综') || s.includes('奥数')) return '奥数';
    return '其他';
  };
  const normalizedClassName = v => String(v || '').trim().replace(/\s+/g, '').replace(/自招-A/g, '自招A').replace(/自招-B/g, '自招B');
  const stableHash = (...parts) => {
    let str = parts.map(x => String(x == null ? '' : x)).join('|');
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  };
  const toMoney = v => {
    const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const fmtMoney = v => (Number(v) ? Number(v).toFixed(0) : '0');
  const termOf = (dateStr, termName = '') => {
    if (/^\d{4}[春暑秋寒]$/.test(String(termName || ''))) return String(termName);
    if (String(termName || '').includes('秋')) return (dateStr || '2026').slice(0, 4) + '秋';
    if (String(termName || '').includes('暑')) return (dateStr || '2026').slice(0, 4) + '暑';
    if (String(termName || '').includes('春')) return (dateStr || '2026').slice(0, 4) + '春';
    if (dateStr) {
      const y = Number(String(dateStr).slice(0, 4));
      const m = Number(String(dateStr).slice(5, 7));
      if (m >= 3 && m <= 5) return y + '春';
      if (m >= 6 && m <= 8) return y + '暑';
      if (m >= 9 && m <= 11) return y + '秋';
      return y + '寒';
    }
    return '2026秋';
  };

  let __bootCache = null; // bootstrap 内存缓存：{t: 时间戳, d: 数据}
  const state = Z.state = {
    HOME: null,
    ROSTER: [],
    ENROLL: [],
    ENR_BY_ID: {},
    FAMILIES: [],
    OUTLINES: {},
    SCHEDULE: [],
    LEAVES: [],
    FOLLOWUPS: [],
    TODO_LIST: [],
    FEEDBACK_META: [],
    REFERRALS: [],
    SEGMENTATION: [],
    LOGIN_OK: false,
    currentPage: 'home',
    filters: {
      stuKw: '',
      stuSort: 'dateDesc',
      leaveKw: '',
    },
    PG: { stu: { page: 1, size: 10 }, sch: { page: 1, size: 15 }, flw: { page: 1, size: 20 } },
  };

  const api = async (path, opt = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(opt.timeout || 20000));
    try {
      const res = await fetch(path, { credentials: 'same-origin', ...opt, signal: controller.signal, headers: { ...(opt.headers || {}) } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, 错误: text || res.statusText }; }
    if (!res.ok) {
      const err = new Error((data && (data.错误 || data.message || data.msg)) || text || res.statusText || '请求失败');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    // 写操作成功后使云端 bootstrap 缓存失效，保证 refresh 拉到的永远是最新数据
    const m = (opt.method || 'GET').toUpperCase();
    if (m !== 'GET' && data && data.ok) __bootCache = null;
    return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw e;
    } finally { clearTimeout(timer); }
  };
  const get = path => api(path);
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const put = (path, body, headers = {}) => api(path, { method: 'PUT', body, headers });
  const del = (path, body) => api(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const qs = s => document.querySelector(s);
  const qsa = s => [].slice.call(document.querySelectorAll(s));
  const ensureEl = (id, html) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
    if (html != null) el.innerHTML = html;
    return el;
  };

  const renderPager = (el, total, page, size, onChange) => {
    if (!el) return;
    const pages = Math.max(1, Math.ceil(total / size));
    if (pages <= 1) {
      el.innerHTML = total > size ? `<span class="pg-info note">共 ${total} 条</span>` : '';
      return;
    }
    const nums = [];
    const add = n => { if (n >= 1 && n <= pages && !nums.includes(n)) nums.push(n); };
    add(1); add(2); for (let n = page - 1; n <= page + 1; n++) add(n); add(pages - 1); add(pages);
    nums.sort((a, b) => a - b);
    let html = `<span class="note" style="margin-right:4px">共 ${total} 条 · 第 ${page}/${pages} 页</span>`;
    html += `<span class="pg-btn${page <= 1 ? ' off' : ''}" data-pg="prev">‹ 上一页</span>`;
    let last = 0;
    nums.forEach(n => {
      if (n - last > 1) html += '<span class="note">…</span>';
      html += `<span class="pg-num${n === page ? ' on' : ''}" data-pg="${n}">${n}</span>`;
      last = n;
    });
    html += `<span class="pg-btn${page >= pages ? ' off' : ''}" data-pg="next">下一页 ›</span>`;
    el.innerHTML = html;
    el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => {
      const v = b.dataset.pg;
      const np = v === 'prev' ? page - 1 : v === 'next' ? page + 1 : Number(v);
      if (np < 1 || np > pages || np === page) return;
      onChange(np, size);
    });
  };

  const toast = (msg, ok = true) => {
    let box = document.getElementById('zj-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'zj-toast';
      box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 14px;border-radius:10px;color:#fff;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.18);max-width:320px;line-height:1.5;display:none;';
      document.body.appendChild(box);
    }
    box.style.background = ok ? '#059669' : '#DC2626';
    box.textContent = msg;
    box.style.display = 'block';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.display = 'none'; }, 2400);
  };

  // ===== 2026-09-09 弹窗栈（PRD §9.3：嵌套不覆盖上层、未保存内容关闭/返回时提示）=====
  const dlgStack = [];
  const dlg = (title, bodyHtml, onMount) => {
    const mask = document.createElement('div');
    mask.className = 'mask hide dlg-layer';
    mask.style.zIndex = String(9100 + dlgStack.length);
    mask.innerHTML = `<div class="dlg"><div class="dlg-h"><span class="dlg-title"></span><span class="dlg-x">✕</span></div><div class="dlg-b dlg-body"></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('.dlg-title').textContent = title;
    const body = mask.querySelector('.dlg-b');
    body.innerHTML = bodyHtml;
    const state = { dirty: false };
    body.addEventListener('input', () => { state.dirty = true; });
    body.addEventListener('change', () => { state.dirty = true; });
    const close = () => {
      if (state.dirty && !confirm('弹窗中有未保存的内容，确定放弃关闭？')) return;
      mask.classList.add('hide');
      const i = dlgStack.indexOf(mask);
      if (i >= 0) dlgStack.splice(i, 1);
      setTimeout(() => mask.remove(), 160);
    };
    // 关闭只认 ✕ 与「取消」，遮罩区不关（防误触丢失表单，2026-09-08 既有约定）
    mask.querySelector('.dlg-x').onclick = close;
    dlgStack.push(mask);
    mask.classList.remove('hide');
    onMount && onMount(body, close);
    return body;
  };
  const dlgClose = () => {
    const top = dlgStack[dlgStack.length - 1];
    if (top) top.querySelector('.dlg-x').click();
    else { const m = document.getElementById('dlgMask'); if (m) m.classList.add('hide'); }
  };
  const dlgErr = msg => {
    const top = dlgStack[dlgStack.length - 1];
    const el = top ? top.querySelector('#dlgErr') : document.getElementById('dlgErr');
    if (el) el.textContent = msg;
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dlgStack.length) dlgClose(); });
  const FG = (label, inner, hint) => `<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">${label}</label>${inner}${hint ? `<div class="note" style="margin-top:3px">${hint}</div>` : ''}</div>`;
  const dlgFoot = okText => `<div class="dlg-err" id="dlgErr" style="color:#DC2626;font-size:12px;margin:8px 0;"></div><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;"><span class="btn sub" id="dlgCancel">取消</span><span class="btn" id="dlgOk">${okText}</span></div>`;

  const showPage = id => {
    // 离开当前页前记录滚动位置（PRD §9.2 上下文恢复）
    if (state.currentPage && id !== state.currentPage) {
      ctxCache.current = { page: state.currentPage, scrollY: window.scrollY };
      try { sessionStorage.setItem('zj-ctx-' + state.currentPage, JSON.stringify(ctxCache.current)); } catch (e) {}
    }
    state.currentPage = id;
    qsa('.page').forEach(p => p.classList.add('hide'));
    const t = document.getElementById('p-' + id);
    if (t) t.classList.remove('hide');
    qsa('.side .ni').forEach(n => n.classList.toggle('on', n.dataset.p === id));
    // 恢复该页滚动位置
    try {
      const saved = JSON.parse(sessionStorage.getItem('zj-ctx-' + id) || 'null');
      if (saved && typeof saved.scrollY === 'number') setTimeout(() => window.scrollTo(0, saved.scrollY), 30);
      else window.scrollTo(0, 0);
    } catch (e) { window.scrollTo(0, 0); }
  };
  const ctxCache = { current: null };

  const buildIndices = () => {
    state.ENR_BY_ID = {};
    state.ENROLL.forEach(x => {
      const key = x.student_id || x.studentId || x.id;
      if (!key) return;
      (state.ENR_BY_ID[key] = state.ENR_BY_ID[key] || []).push(x);
    });
  };

  const loadAllData = async () => {
    // bootstrap 内存缓存：TTL 12s。写操作成功会通过 api() 失效，保证数据始终最新。
    const now = Date.now();
    if (__bootCache && now - __bootCache.t < 12000) {
      Object.assign(state, __bootCache.d);
      buildIndices();
      return state;
    }
    const b = await get('/api/bootstrap');
    const d = {
      HOME: b && b.home || {},
      ROSTER: b && Array.isArray(b.students) ? b.students : [],
      SCHEDULE: b && Array.isArray(b.classes) ? b.classes : [],
      ENROLL: b && Array.isArray(b.enrollments) ? b.enrollments : [],
      FAMILIES: b && Array.isArray(b.families) ? b.families : [],
      OUTLINES: b && b.outlines && typeof b.outlines === 'object' ? b.outlines : {},
      LEAVES: b && Array.isArray(b.leaves) ? b.leaves : [],
      FOLLOWUPS: b && Array.isArray(b.followups) ? b.followups : [],
      TODO_LIST: b && Array.isArray(b.todoList) ? b.todoList : [],
      FEEDBACK_META: b && Array.isArray(b.feedbackMeta) ? b.feedbackMeta : [],
      REFERRALS: b && Array.isArray(b.referrals) ? b.referrals : [],
      SEGMENTATION: b && Array.isArray(b.segmentation) ? b.segmentation : [],
    };
    Object.assign(state, d);
    __bootCache = { t: Date.now(), d };
    buildIndices();
    return state;
  };

  const ensureLoginUI = () => {
    if (document.getElementById('loginMask')) return;
    const mask = document.createElement('div');
    mask.id = 'loginMask';
    mask.className = 'login-mask hide';
    mask.innerHTML = `
      <div class="login-card">
        <div class="login-title">苏E好学 · 助教工作台</div>
        <div class="login-sub">请输入内部访问密码</div>
        ${FG('访问密码', '<input id="loginPwd" type="password" placeholder="输入密码后进入">')}
        <div class="dlg-err" id="loginErr" style="color:#DC2626;font-size:12px;margin:8px 0;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;"><span class="btn" id="loginBtn">进入系统</span></div>
      </div>`;
    document.body.appendChild(mask);
    qs('#loginBtn').onclick = async () => {
      const pwd = qs('#loginPwd').value.trim();
      if (!pwd) { qs('#loginErr').textContent = '密码必填'; return; }
      try {
        await post('/api/auth/login', { password: pwd });
        state.LOGIN_OK = true;
        mask.classList.add('hide');
        await afterLogin();
      } catch (e) {
        qs('#loginErr').textContent = e.message || '登录失败';
      }
    };
    qs('#loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') qs('#loginBtn').click(); });
  };

  const ensureAuth = async () => {
    ensureLoginUI();
    try {
      const s = await get('/api/auth/status');
      state.LOGIN_OK = !!(s && s.ok);
      document.getElementById('loginMask').classList.toggle('hide', state.LOGIN_OK);
      return state.LOGIN_OK;
    } catch (e) {
      state.LOGIN_OK = false;
      document.getElementById('loginMask').classList.remove('hide');
      return false;
    }
  };

  const afterLogin = async () => {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        try { await get('/api/auth/logout'); } catch (e) {}
        state.LOGIN_OK = false;
        location.reload();
      };
    }
    if (Z.modules && typeof Z.modules.initCommon === 'function') Z.modules.initCommon();
    await loadAllData();
    if (Z.modules && typeof Z.modules.renderAll === 'function') Z.modules.renderAll();
    route();
  };

  // ===== 2026-09-09 统一导航层（PRD §9：navigate/back/closeCurrent，来源与上下文恢复）=====
  const NAV_KEY = 'zj-nav-stack';
  let navStack = [];
  const navLoad = () => { try { const s = sessionStorage.getItem(NAV_KEY); if (s) { const arr = JSON.parse(s); if (Array.isArray(arr)) navStack = arr; } } catch (e) {} };
  const navSave = () => { try { sessionStorage.setItem(NAV_KEY, JSON.stringify(navStack.slice(-40))); } catch (e) {} };
  const parseHash = h => {
    // 拆出 path 与 query：如 todo?type=flw&status=active / todo/T123
    // 注意：调用方通常已对 hash 整体 decode 过，这里不再二次 decode path；query 由 URLSearchParams 自动解
    const qi = h.indexOf('?');
    let path = h, query = {};
    if (qi >= 0) { path = h.slice(0, qi); new URLSearchParams(h.slice(qi + 1)).forEach((v, k) => { query[k] = v; }); }
    return { path, query };
  };
  const navGo = (target, opts = {}) => {
    target = String(target || 'home').replace(/^#/, '');
    const { path } = parseHash(target);
    const from = { page: state.currentPage, route: location.hash.replace(/^#/, '') || 'home', scrollY: window.scrollY };
    if (!opts.replace) { navStack.push(from); navSave(); }
    if (opts.context) { try { sessionStorage.setItem('zj-ctx-page-' + (parseHash(path).path.split('/')[0]), JSON.stringify(opts.context)); } catch (e) {} }
    if (path.startsWith('profile/') || path.startsWith('family/') || path.startsWith('todo')) {
      // 直接跳转保持浏览器历史一致（hash 变化即可）
    }
    if (location.hash === '#' + target) route();
    else location.hash = '#' + target;
  };
  const navBack = () => {
    const prev = navStack.pop(); navSave();
    if (prev && prev.route) {
      if (location.hash === '#' + prev.route) route();
      else if (window.history.length > 1) window.history.back();
      else location.hash = '#' + prev.route;
    } else {
      if (window.history.length > 1) window.history.back();
      else location.hash = '#home';
    }
    // 恢复来源页滚动
    if (prev && typeof prev.scrollY === 'number') setTimeout(() => window.scrollTo(0, prev.scrollY), 50);
  };
  const closeCurrent = () => dlgClose();

  const route = () => {
    let raw = '';
    try { raw = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { raw = ''; toast('链接格式无效，已返回首页', false); }
    const { path, query } = parseHash(raw);
    if (path.startsWith('profile/')) {
      showPage('profile');
      Z.modules && Z.modules.openProfile && Z.modules.openProfile(path.slice(8));
      return;
    }
    if (path.startsWith('family/')) {
      showPage('family');
      Z.modules && Z.modules.openFamily && Z.modules.openFamily(path.slice(7));
      return;
    }
    if (path.startsWith('todo')) {
      const rest = path.slice(4).replace(/^\//, '');
      showPage('todo');
      Z.modules && Z.modules.onTodoRoute && Z.modules.onTodoRoute(rest, query);
      return;
    }
    if (raw) {
      const valid = ['home', 'sch', 'stu', 'leave', 'flw', 'ref', 'oln'];
      if (!valid.includes(path)) { toast('未找到该页面，已回到首页', false); path = 'home'; }
      showPage(path);
      Z.modules && Z.modules.onPage && Z.modules.onPage(path);
      return;
    }
    showPage('home');
    Z.modules && Z.modules.onPage && Z.modules.onPage('home');
  };

  Z.utils = { esc, todayStr, curTermLabel, termDispL, termOf, fmtMoney, toMoney, normalizeTeacher, normalizeSubject, classType, normalizedClassName, stableHash, SEASON_NAME, TEACHER_ALIASES, GRADES, GRADE_ORDER, TYPE_COLOR, SUBJ_COLOR, SYS_SUBJECT };
  Z.api = { request: api, get, post, put, del };
  Z.ui = { qs, qsa, ensureEl, renderPager, toast, dlg, dlgClose, dlgErr, FG, dlgFoot, showPage };
  Z.nav = { go: navGo, back: navBack, closeCurrent, route };
  Z.bootstrap = { loadAllData, ensureAuth, afterLogin, route, buildIndices };
  navLoad();
})();
