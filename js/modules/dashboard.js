(function () {
  const Z = window.ZJ;
  const { esc, termDispL, TYPE_COLOR, SUBJ_COLOR, SYS_SUBJECT, SEASON_NAME, GRADES, GRADE_ORDER, todayStr } = Z.utils;
  const { qs: $, qsa: $$, renderPager, toast, dlg, dlgClose, dlgErr, FG, dlgFoot, showPage } = Z.ui;
  const api = Z.api;
  const st = Z.state;
  const M = Z.modules = Z.modules || {};

  const badge = (s, cls = 'gray') => `<span class="badge ${cls}">${esc(s)}</span>`;
  const stTag = s => badge(s, s === '在读' ? 'free' : s === '待开课' ? 'blue' : 'gray');
  const typeBadge = t => `<span class="badge ${TYPE_COLOR[t] || 'gray'}">${esc(t)}</span>`;
  const subjBadge = s => s ? `<span class="badge ${SUBJ_COLOR[s] || 'gray'}">${esc(s)}</span>` : '';
  const classRowLabel = r => r.班级 || (r.班级名 || []).join('、') || r.课程 || '未命名班级';

  let schedMap = {};
  function buildSchedMap() {
    schedMap = {};
    st.SCHEDULE.forEach(r => { (r.班级名 || [r.班级]).filter(Boolean).forEach(c => { schedMap[c] = { 星期: r.星期, 时间: r.时间 }; }); });
  }

  // ================= 2026-09-08 助教个人工作台 · 首页重设计 =================
  const TODO_KINDS = ['请假', '调课', '退费', '跟进', '反馈催收', '其他'];
  const todoKindBadge = k => `<span class="badge ${k === '请假' ? 'gold' : k === '退费' ? 'red' : k === '调课' ? 'blue' : 'gray'}">${esc(k || '其他')}</span>`;

  function todoPend() { return (st.TODO_LIST || []).filter(t => t.状态 === '待办'); }
  function todoOverdue(today) { return todoPend().filter(t => (t.截止 || '') < today).sort((a, b) => String(a.截止).localeCompare(String(b.截止))); }
  function todoToday(today) { return todoPend().filter(t => (t.截止 || '') === today); }
  function todoWeek(today) {
    const end = new Date(); end.setDate(end.getDate() + 7);
    const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    return todoPend().filter(t => (t.截止 || '') > today && (t.截止 || '') <= endStr).sort((a, b) => String(a.截止).localeCompare(String(b.截止)));
  }
  function todoItemHtml(t, red) {
    return `<div class="todo-item${red ? ' todo-red' : ''}">
      <div class="todo-main">${todoKindBadge(t.类型)}<span class="todo-title">${esc(t.标题)}</span></div>
      <div class="todo-sub">${t.姓名 ? `👤 <a href="javascript:void(0)" class="todo-sid" data-sid="${esc(t.studentId || '')}" style="color:#2563EB;font-weight:600;text-decoration:none;">${esc(t.姓名)}</a>` : ''}${t.班级 ? `<span class="muted"> · ${esc(t.班级)}</span>` : ''}${t.备注 ? `<div class="muted" style="margin-top:2px;">${esc(t.备注)}</div>` : ''}</div>
      <div class="todo-acts"><span class="muted" style="font-size:11px;">截止 ${esc(t.截止 || '—')}${t.提醒 ? ' ' + esc(t.提醒) : ''}</span><span class="btn sub sm todo-done" data-tid="${esc(t.tid)}" data-title="${esc(t.标题)}">完成</span><span class="btn sub sm todo-del" data-tid="${esc(t.tid)}" data-title="${esc(t.标题)}" style="color:#DC2626;">✕</span></div>
    </div>`;
  }
  function bindTodoItemEvents(box) {
    if (!box) return;
    box.querySelectorAll('.todo-done').forEach(b => b.onclick = () => doneTodoDlg(b.dataset.tid, b.dataset.title));
    box.querySelectorAll('.todo-del').forEach(b => b.onclick = async () => {
      if (!confirm(`确认取消这条待办？\n${b.dataset.title}`)) return;
      const r = await api.post('/api/todo/delete', { tid: b.dataset.tid, 标题: b.dataset.title });
      if (r.ok) { toast('已取消'); await refresh(); } else alert(r.错误 || '操作失败');
    });
    box.querySelectorAll('.todo-sid').forEach(a => { if (a.dataset.sid) a.onclick = () => { location.hash = 'profile/' + encodeURIComponent(a.dataset.sid); }; });
  }

  function renderHome() {
    const h = st.HOME || {};
    const s = h.看板 || {};
    const cur = h.当期 || '2026秋';
    const today = todayStr();
    const tag = $('#homeTermTag'); if (tag) tag.textContent = `${termDispL(cur)} · 我的个人工作台 · 云端同步`;

    // 逾期红条（置顶警示）
    const od = todoOverdue(today);
    const odBox = $('#homeOverdue');
    if (odBox) odBox.innerHTML = od.length ? `<div class="overdue-bar">🚨 <b>${od.length} 条待办已逾期</b>：${od.slice(0, 3).map(t => esc(t.标题)).join('；')}${od.length > 3 ? ` 等 ${od.length} 条` : ''} —— 请尽快处理</div>` : '';

    // KPI 数字：在读 + S/A层级 + 逾期动作（PRD 8.1）
    const stSegs = st.SEGMENTATION || [];
    const segCount = lv => stSegs.filter(x => x.分层 === lv).length;
    const priCount = stSegs.filter(x => ['S', 'A'].includes(x.分层) && x.未完成动作数 > 0).length;
    const stats = $('#homeStats');
    if (stats) stats.innerHTML = [
      [`${termDispL(cur)}在读`, s.去重学生 || 0, '人'],
      ['🔴 S级重点', segCount('S'), '人'],
      ['🟡 A级优先', segCount('A'), '人'],
      ['⏰ 逾期动作', od.length, '条'],
    ].map(x => `<div class="kpi-card"><div class="kpi-k">${x[0]}</div><div class="kpi-v">${x[1]}<span>${x[2]}</span></div></div>`).join('');

    // 今日优先跟进卡（PRD 8.1）：逾期必做 → S级 → A级 → 风险多者 → 最近跟进更久者
    const pri = $('#homePriority');
    if (pri) {
      const byId = {};
      st.ROSTER.forEach(r => { byId[r.id] = r; });
      const items = stSegs
        .filter(x => x.分层 === 'S' || x.分层 === 'A')
        .map(x => ({ ...x, stu: byId[x.studentId] }))
        .filter(x => x.stu)
        .sort((a, b) => (a.分层 === 'S' ? 0 : 1) - (b.分层 === 'S' ? 0 : 1) || (b.风险标签 || []).length - (a.风险标签 || []).length);
      if (!items.length) {
        pri.innerHTML = '<div class="note ok">今天没有逾期或高优先级跟进，常规维护按课程节点进行。</div>';
        const pc = $('#homePriorityCard'); if (pc) pc.style.display = 'none';
      } else {
        const pc = $('#homePriorityCard'); if (pc) pc.style.display = '';
        const reasons = x => (x.分层依据 || []).slice(0, 2).map(r => `<span class="muted" style="font-size:11px;">· ${esc(r)}</span>`).join('');
        pri.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;">` + items.slice(0, 8).map(x => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid ${x.分层 === 'S' ? '#FECACA' : '#FDE68A'};border-radius:8px;background:${x.分层 === 'S' ? '#FEF2F2' : '#FFFBEB'};">
            <b style="min-width:70px;color:${x.分层 === 'S' ? '#DC2626' : '#B45309'};">${segBadge(x.分层)} ${esc(x.stu.姓名)}</b>
            <div style="flex:1;min-width:0;">
              <div style="font-size:11.5px;line-height:1.4;">${reasons(x)}</div>
              ${(x.风险标签 || []).slice(0, 3).map(t => `<span class="badge gold" style="font-size:10px;margin-right:2px;">${esc(t.label || t.code)}</span>`).join('')}
              ${x.未完成动作数 ? `<span class="badge blue" style="font-size:10px;">动作 ${x.未完成动作数}</span>` : ''}
            </div>
            <span class="btn sub sm" data-pri-go="${esc(x.studentId)}">档案</span>
            <span class="btn sub sm" data-pri-flw="${esc(x.studentId)}" data-pri-name="${esc(x.stu.姓名)}">跟进</span>
          </div>`).join('') + `</div>`;
        pri.querySelectorAll('[data-pri-go]').forEach(b => b.onclick = () => { location.hash = 'profile/' + encodeURIComponent(b.dataset.priGo); });
        pri.querySelectorAll('[data-pri-flw]').forEach(b => b.onclick = () => openAddFollowModal(b.dataset.priFlw, b.dataset.priName));
      }
    }

    // 今日待办（含逾期，置顶红）
    const tt = $('#homeTodoToday');
    if (tt) {
      const list = od.concat(todoToday(today));
      tt.innerHTML = list.length ? list.map(t => todoItemHtml(t, (t.截止 || '') < today)).join('') : '<div class="note ok">✅ 今日待办已全部清空</div>';
      bindTodoItemEvents(tt);
    }
    // 本周待办（按天分组）
    const tw = $('#homeTodoWeek');
    if (tw) {
      const wk = todoWeek(today);
      if (!wk.length) { tw.innerHTML = '<div class="note">本周暂无其他待办</div>'; }
      else {
        const byDay = {};
        wk.forEach(t => { (byDay[t.截止] = byDay[t.截止] || []).push(t); });
        tw.innerHTML = Object.keys(byDay).sort().map(day => `<div style="margin-bottom:10px;"><div style="font-size:12px;font-weight:700;color:#64748B;margin-bottom:6px;">${esc(day)}</div>${byDay[day].map(t => todoItemHtml(t, false)).join('')}</div>`).join('');
        bindTodoItemEvents(tw);
      }
    }

    // 学情反馈进度（多讲次切换，实时反映云端反馈库）
    const fb = $('#homeFeedback');
    if (fb) {
      const metas = st.FEEDBACK_META || [];
      if (!metas.length) {
        fb.innerHTML = '<div class="note">反馈库暂无数据</div>';
      } else {
        const curLesson = metas.find(m => m.lesson === st._fbLesson) ? st._fbLesson : metas[metas.length - 1].lesson;
        st._fbLesson = curLesson;
        const meta = metas.find(m => m.lesson === curLesson);
        const bs = meta.byStatus || {};
        const pill = (k, cls) => bs[k] ? `<span class="badge ${cls}" style="margin-right:6px;">${esc(k)} ${bs[k]}</span>` : '';
        const tabs = metas.length > 1 ? `<div style="display:flex;gap:6px;margin-bottom:8px;">${metas.map(m => `<span class="vt${m.lesson === curLesson ? ' on' : ''}" data-fblesson="${esc(m.lesson)}" style="cursor:pointer;">${esc(m.lesson)}</span>`).join('')}</div>` : '';
        fb.innerHTML = tabs + `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 0;">
          <b style="font-size:15px;">${esc(meta.lesson || '')}</b><span class="muted">共 ${meta.total} 人 · 数据实时来自云端反馈库，录入即更新</span>
          ${pill('已出反馈', 'free')}${pill('小明班免发', 'blue')}${pill('周三未开课', 'gold')}${pill('请假缺课', 'gold')}${pill('免发未到课', 'gray')}${pill('试听刚报未上', 'gray')}
        </div>`;
        fb.querySelectorAll('[data-fblesson]').forEach(el => el.onclick = () => { st._fbLesson = el.dataset.fblesson; renderHome(); });
      }
    }

    // 今日排课：过滤 1 号教室与租用，按时间先后升序排序
    let td = (h.今日排课 || []).filter(r => String(r.教室 || '').trim() !== '1号' && !String(r.课程 || '').includes('租用') && r.来源 !== '教室租用');
    td.sort((a, b) => String(a.时间 || '').localeCompare(String(b.时间 || '')));
    const todayBox = $('#homeToday');
    if (todayBox) todayBox.innerHTML = td.length ? '<table><tr><th>星期</th><th>时间</th><th>课程/班级 (点击看学生)</th><th>老师</th><th>教室</th><th>校区</th><th>在班</th></tr>' +
      td.map(r => `<tr><td>${esc(r.星期 || '')}</td><td class="tk">${esc(r.时间 || '')}</td><td><a href="javascript:void(0)" class="home-cls-link" data-cls="${esc(r.班号 || classRowLabel(r))}" style="color:#2563EB;font-weight:700;text-decoration:none;">${esc(classRowLabel(r))}</a></td><td>${esc(r.老师 || '')}</td><td>${esc(r.教室 || '')}</td><td class="muted">${esc(r.校区 || '')}</td><td><b style="color:#059669">${(r.在班 || []).length || r.在班人数 || 0}人</b></td></tr>`).join('') + '</table>' : '<div class="note">今日无排课</div>';
    if (todayBox) {
      todayBox.querySelectorAll('.home-cls-link').forEach(el => {
        el.onclick = () => {
          const row = td.find(r => (r.班号 || classRowLabel(r)) === el.dataset.cls) || st.SCHEDULE.find(r => (r.班号 || classRowLabel(r)) === el.dataset.cls);
          if (row) classDetailDlg(row);
        };
      });
    }
  }

  // ---- 学员搜索联动组件：输入姓名 → 自动带出秋季在读班级 ----
  // 复用 st.ROSTER + st.ENR_BY_ID，纯前端；单班自动填入、多班下拉选择、无在读班留空提示。
  const currentTerm = () => {
    try { return Z.utils.curTermLabel(); } catch (e) { return '2026秋'; }
  };
  const stuActiveClasses = id => (st.ENR_BY_ID[id] || []).filter(e => !e.is_void && (e.期 === currentTerm() || e.term === currentTerm())).map(e => e.班级).filter(Boolean);
  // 第三个参数 onClassSet：班级确定后回调(班级名)，可用于联动日期等
  function bindStuAutoClass(nameEl, clsEl, onClassSet) {
    if (!nameEl || !clsEl) return;
    const fire = cls => { if (typeof onClassSet === 'function') onClassSet(cls); };
    nameEl.onchange = () => {
      const val = (nameEl.value || '').trim();
      if (!val) { clsEl.value = ''; return; }
      const found = st.ROSTER.find(s => s.姓名 === val);
      if (!found) return;
      const list = [...new Set(stuActiveClasses(found.id))];
      if (!list.length) { clsEl.value = ''; toast('该学员暂无当前学期在读班，请手动填/选班级', false); return; }
      if (list.length === 1) { clsEl.value = list[0]; fire(list[0]); return; }
      // 多班：下拉让老板选
      const mk = (label, fn) => {
        const w = document.createElement('div');
        w.style.cssText = 'border:1px solid #F59E0B;border-radius:8px;padding:8px 10px;margin:4px 0;background:#FFFBEB;font-size:13px;';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = 'margin:2px 6px 2px 0;padding:3px 10px;border:1px solid #F59E0B;border-radius:6px;background:#fff;cursor:pointer;color:#92400E;';
        b.onclick = () => { clsEl.value = c; fire(c); w.remove(); };
        w.appendChild(b);
        return w;
      };
      const wrap = clsEl.closest('.dlg-body') || clsEl.parentNode;
      [...wrap.querySelectorAll('[data-autocls]')].forEach(n => n.remove());
      const label = document.createElement('div');
      label.textContent = '该学员当前有多个在读班，选择要关联的班：';
      label.style.cssText = 'font-size:12px;color:#92400E;margin:4px 0;font-weight:600;';
      label.dataset.autocls = '1';
      wrap.appendChild(label);
      list.forEach(c => {
        const w = mk('✓ ' + c, () => { clsEl.value = c; fire(c); });
        w.dataset.autocls = '1';
        wrap.appendChild(w);
      });
    };
  }

  // ---- 待办：新增弹窗（可一键联动登记请假）----
  function openTodoDlg(preset = {}) {
    const kinds = TODO_KINDS.map(k => `<option${preset.kind === k ? ' selected' : ''}>${k}</option>`).join('');
    dlg('＋ 新增待办', `
      ${FG('一句话待办 <b style="color:#B91C1C">*</b>', `<input id="td-title" placeholder="例：给张三登记9/10请假 / 跟进李四退费" value="${esc(preset.title || '')}">`)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('类型', `<select id="td-kind">${kinds}</select>`)}
        ${FG('截止日期', `<input id="td-due" type="date" value="${esc(preset.due || todayStr())}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('关联学员（选填）', `<input id="td-name" list="stuNameData" placeholder="输入姓名自动匹配档案" value="${esc(preset.name || '')}">`)}
        ${FG('班级（选填）', `<input id="td-cls" list="classData" value="${esc(preset.cls || '')}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('下班前提醒时刻', `<input id="td-remind" type="time" value="${esc(preset.remind || '17:00')}">`)}
        ${FG('备注（选填）', `<input id="td-note" placeholder="补充细节" value="${esc(preset.note || '')}">`)}
      </div>
      <div id="td-leaveWrap" style="display:none;border:1px dashed #F59E0B;border-radius:8px;padding:10px 12px;margin-bottom:12px;background:#FFFBEB;">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#92400E;"><input type="checkbox" id="td-withLeave"> 同时直接登记请假（学员立即变请假状态，本待办自动完成）</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px;">
          ${FG('请假日期', `<input id="td-leaveDate" type="date" value="${todayStr()}">`)}
          ${FG('请假原因', `<input id="td-leaveReason" placeholder="例：病假 / 事假">`)}
        </div>
      </div>
      ${dlgFoot('保存待办')}`, box => {
      const kindSel = box.querySelector('#td-kind');
      const syncLeave = () => { box.querySelector('#td-leaveWrap').style.display = kindSel.value === '请假' ? 'block' : 'none'; };
      kindSel.onchange = syncLeave; syncLeave();
      bindStuAutoClass(box.querySelector('#td-name'), box.querySelector('#td-cls'));
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const withLeave = box.querySelector('#td-withLeave').checked;
        const body = {
          标题: box.querySelector('#td-title').value.trim(), 类型: kindSel.value,
          截止: box.querySelector('#td-due').value, 提醒: box.querySelector('#td-remind').value,
          姓名: box.querySelector('#td-name').value.trim(), 班级: box.querySelector('#td-cls').value.trim(),
          备注: box.querySelector('#td-note').value.trim(),
        };
        if (!body.标题) return dlgErr('待办标题必填');
        if (withLeave) {
          if (!body.姓名 || !body.班级) return dlgErr('联动登记请假必须填写学员与班级');
          body.登记请假 = true; body.日期 = box.querySelector('#td-leaveDate').value; body.原因 = box.querySelector('#td-leaveReason').value.trim();
        }
        const r = await api.post('/api/todo/record', body);
        if (!r.ok) return dlgErr(r.错误 || '保存失败');
        dlgClose(); toast(withLeave ? '已登记请假并完成待办' : '待办已保存');
        await refresh();
      };
    });
  }

  // ---- 待办：完成弹窗（可补记处理结果）----
  function doneTodoDlg(tid, title) {
    dlg('完成待办', `
      <div style="font-size:13px;margin-bottom:10px;"><b>${esc(title)}</b></div>
      ${FG('完成补记（选填）', `<input id="td-doneText" placeholder="例：已联系家长，请假已登记 / 已转交财务">`)}
      ${dlgFoot('确认完成')}`, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const r = await api.post('/api/todo/done', { tid, 标题: title, 完成补记: box.querySelector('#td-doneText').value.trim() });
        if (!r.ok) return dlgErr(r.错误 || '操作失败');
        dlgClose(); toast('已完成 ✓'); await refresh();
      };
    });
  }

  // ---- 待办：全部清单弹窗 ----
  function openTodoListDlg() {
    const all = (st.TODO_LIST || []).slice();
    const render = (box) => {
      const pend = all.filter(t => t.状态 === '待办').sort((a, b) => String(a.截止).localeCompare(String(b.截止)));
      const done = all.filter(t => t.状态 !== '待办').slice(0, 30);
      box.querySelector('#td-allList').innerHTML =
        (pend.length ? pend.map(t => todoItemHtml(t, (t.截止 || '') < todayStr())).join('') : '<div class="note ok">没有未办待办</div>') +
        (done.length ? `<div style="font-size:12px;font-weight:700;color:#64748B;margin:14px 0 6px;">最近已完成 / 已取消（前30条）</div>` + done.map(t => `<div class="todo-item" style="opacity:.55;"><div class="todo-main">${todoKindBadge(t.类型)}<span class="todo-title" style="text-decoration:line-through;">${esc(t.标题)}</span></div><div class="todo-sub muted">${esc(t.状态)} ${esc(t.完成时间 || '')}${t.完成补记 ? ' · ' + esc(t.完成补记) : ''}</div></div>`).join('') : '');
      bindTodoItemEvents(box.querySelector('#td-allList'));
    };
    dlg('全部待办', `<div id="td-allList" style="max-height:60vh;overflow:auto;"></div>`, box => {
      render(box);
      const ob = new MutationObserver(() => {});
      box.addEventListener('click', () => setTimeout(() => render(box), 1200));
    });
  }

  // ---- 提醒：下班前/逾期 弹窗提醒（站内）----
  function checkTodoReminder() {
    const today = todayStr();
    const pend = todoPend();
    if (!pend.length) return;
    const od = todoOverdue(today);
    const dueToday = todoToday(today);
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const remindAt = dueToday.map(t => t.提醒).filter(Boolean).sort()[0] || '17:00';
    const key = 'zj-remind-' + today;
    let flags = {};
    try { flags = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch (e) {}
    let kind = '';
    if (od.length && !flags.overdue) kind = 'overdue';
    else if (dueToday.length && hm >= remindAt && !flags.evening) kind = 'evening';
    if (!kind) return;
    flags[kind] = true;
    try { sessionStorage.setItem(key, JSON.stringify(flags)); } catch (e) {}
    const list = od.concat(dueToday);
    dlg(kind === 'overdue' ? '🚨 有逾期待办未处理' : '🔔 下班前提醒：今日待办', `
      <div style="font-size:13px;color:#475569;margin-bottom:10px;">${kind === 'overdue' ? `有 <b style="color:#DC2626">${od.length}</b> 条待办已过截止日期，请优先处理：` : `现在已过 ${esc(remindAt)}，今日还有 <b>${dueToday.length}</b> 条待办未办：`}</div>
      <div style="max-height:50vh;overflow:auto;">${list.map(t => todoItemHtml(t, (t.截止 || '') < today)).join('')}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><span class="btn" id="dlgCancel">知道了</span></div>`, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      bindTodoItemEvents(box);
    });
  }

  // ---- 微信提醒设置/测试 ----
  async function openWechatDlg() {
    dlg('🔔 微信提醒设置', `
      <div style="font-size:13px;line-height:1.8;color:#334155;">
        <b>当前机制</b>：每天北京时间 <b>10:00</b> 与 <b>17:00</b> 云端自动检查未办待办，有则推送微信（Vercel Cron 双推送）。<br>
        <b>开通步骤（一次性）</b>：<br>
        方式A · Server酱（推送到个人微信）：微信搜「Server酱·Turbo」关注 → 扫码登录 sct.ftqq.com → 复制 SendKey → 填到 Vercel 环境变量 <code>SCT_SENDKEY</code>。<br>
        方式B · 企业微信群机器人：群 → 设置 → 群机器人 → 添加 → 复制 Webhook 地址 → 填到 Vercel 环境变量 <code>WECHAT_WEBHOOK</code>。<br>
        两个都填则优先 Server酱。另可在 Vercel 环境变量设 <code>CRON_SECRET</code> 加强鉴权。<br>
        <b>站内提醒</b>：不依赖任何配置，打开工作台即有弹窗提醒（逾期立即提醒、下班前按提醒时刻提醒）。
      </div>
      <div id="wc-result" style="margin-top:10px;"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><span class="btn sub" id="dlgCancel">关闭</span><span class="btn" id="wc-test">立即测试推送</span></div>`, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#wc-test').onclick = async () => {
        const rEl = box.querySelector('#wc-result');
        rEl.innerHTML = '<div class="note">正在调用云端推送…</div>';
        const r = await api.get('/api/cron/remind').catch(e => ({ ok: false, 错误: e.message }));
        if (!r.ok) { rEl.innerHTML = `<div class="note" style="color:#DC2626;">失败：${esc(r.错误 || '未知错误')}</div>`; return; }
        rEl.innerHTML = r.pending === 0
          ? '<div class="note ok">✅ 当前无未办待办，无需推送</div>'
          : (r.pushed ? `<div class="note ok">✅ 已推送 ${r.pending} 条待办到微信（通道：${esc(r.channel)}），请查收</div>`
            : `<div class="note" style="color:#B45309;">有 ${r.pending} 条未办，但微信通道未配置（请按上方步骤填 SendKey 后重试）</div>`);
      };
    });
  }

  // ---- 反馈：按班浏览弹窗（跟随当前讲次）----
  function openFeedbackBrowser() {
    const metas = st.FEEDBACK_META || [];
    const meta = metas.find(m => m.lesson === st._fbLesson) || metas[0];
    const clsList = meta && meta.classes ? Object.keys(meta.classes).sort() : [];
    dlg(`📝 ${meta ? esc(meta.lesson) : ''} · 按班浏览反馈`, `
      <div class="fbar" style="margin-bottom:10px;"><select id="fbw-cls">${clsList.map(c => `<option>${esc(c)}</option>`).join('')}</select><span class="note" id="fbw-info"></span></div>
      <div id="fbw-list" style="max-height:62vh;overflow:auto;"></div>`, async box => {
      const render = async () => {
        const cls = box.querySelector('#fbw-cls').value;
        const listBox = box.querySelector('#fbw-list');
        listBox.innerHTML = '<div class="note">加载中…</div>';
        const r = await api.get('/api/feedback/list?className=' + encodeURIComponent(cls) + (meta ? '&lesson=' + encodeURIComponent(meta.lesson) : '')).catch(() => ({ list: [] }));
        const list = r.list || [];
        const ci = meta && meta.classes && meta.classes[cls];
        box.querySelector('#fbw-info').textContent = ci ? ` 已出反馈 ${ci.done}/${ci.total} 人` : ` 共 ${list.length} 人`;
        listBox.innerHTML = list.length ? list.map(f => fbCardHtml(f)).join('') : '<div class="note">本班暂无反馈记录</div>';
        bindFbCopy(listBox);
      };
      box.querySelector('#fbw-cls').onchange = render;
      await render();
    });
  }

  // ---- 反馈：老师催收看板（哪些老师/班级还没交，一目了然）----
  function openTeacherFbBoard() {
    const metas = st.FEEDBACK_META || [];
    const meta = metas.find(m => m.lesson === st._fbLesson) || metas[0];
    if (!meta) return toast('暂无反馈数据', false);
    const classes = meta.classes || {};
    const byTeacher = {};
    Object.keys(classes).forEach(c => {
      const t = classes[c].teacher || '未标注老师';
      (byTeacher[t] = byTeacher[t] || []).push({ name: c, ...classes[c] });
    });
    const excused = ['小明班免发', '免发未到课', '试听刚报未上'];
    const rows = Object.keys(byTeacher).sort((a, b) => {
      const ra = byTeacher[a].filter(c => c.done === 0 && !Object.keys(c.byStatus || {}).every(s => excused.includes(s) || s === '周三未开课')).length;
      const rb = byTeacher[b].filter(c => c.done === 0 && !Object.keys(c.byStatus || {}).every(s => excused.includes(s) || s === '周三未开课')).length;
      return rb - ra;
    }).map(t => {
      const cls = byTeacher[t];
      const done = cls.reduce((s, c) => s + c.done, 0), total = cls.reduce((s, c) => s + c.total, 0);
      const missing = cls.filter(c => c.done === 0 && !Object.keys(c.byStatus || {}).every(s => excused.includes(s) || s === '周三未开课'));
      return `<div class="fb-card" style="border-left-color:${missing.length ? '#DC2626' : '#059669'}">
        <div class="fb-head"><span><b>${esc(t)}</b> <span class="muted">${cls.length} 个班 · 已出 ${done}/${total} 人</span></span><span>${missing.length ? `<span class="badge red">${missing.length} 个班未见提交</span>` : '<span class="badge free">已全部有反馈</span>'}</span></div>
        <div style="margin-top:6px;">${cls.sort((a, b) => a.done - b.done).map(c => {
          const stTxt = Object.entries(c.byStatus || {}).map(([k, v]) => `${k}${v}`).join(' ');
          const allExcused = c.done === 0 && Object.keys(c.byStatus || {}).every(s => excused.includes(s) || s === '周三未开课');
          return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px dashed #E5E7EB;font-size:12.5px;flex-wrap:wrap;"><span>${esc(c.name)}</span><span>${c.done > 0 ? `<span class="badge free">已出 ${c.done}/${c.total}</span>` : allExcused ? `<span class="badge gray">${esc(stTxt)}</span>` : '<span class="badge red">未提交</span>'}<span class="muted" style="font-size:11px;margin-left:6px;">${esc(stTxt)}</span></span></div>`;
        }).join('')}</div>
      </div>`;
    }).join('');
    dlg(`📣 ${esc(meta.lesson)} · 老师反馈催收看板`, `<div style="font-size:12.5px;color:#64748B;margin-bottom:10px;">按老师分组，红标 = 该班无一人有反馈正文（周三未开课/请假/免发不算欠交）。收到老师微信反馈后，到对应学员档案「＋ 录入讲次反馈」保存，本看板即实时更新。</div><div style="max-height:62vh;overflow:auto;">${rows}</div>`, () => {});
  }
  function fbCardHtml(f) {
    const fid = String(f.fid || '').replace(/[^A-Za-z0-9_-]/g, '_');
    return `<div class="fb-card">
      <div class="fb-head"><span><b>${esc(f.姓名 || '')}</b>${f.lesson ? ` · ${esc(f.lesson)}` : ''}${f.讲次标题 ? ` · ${esc(f.讲次标题)}` : ''}</span><span>${badge(f.状态 || '', f.状态 === '已出反馈' ? 'free' : 'gray')}${f.正文 ? ` <span class="btn sub sm fb-copy" data-fid="${esc(fid)}">一键复制</span>` : ''}</span></div>
      <div class="fb-meta muted">${esc(f.班级 || '')}${f.老师 ? ' · ' + esc(f.老师) : ''}${f.上课日期 ? ' · ' + esc(f.上课日期) : ''}</div>
      <div class="fb-body" id="fbc-${esc(fid)}">${esc(f.正文 || '（本讲次无反馈正文：' + (f.状态 || '') + '）')}</div>
    </div>`;
  }
  function bindFbCopy(box) {
    box.querySelectorAll('.fb-copy').forEach(b => b.onclick = () => {
      const el = document.getElementById('fbc-' + b.dataset.fid);
      const text = el ? el.innerText : '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('已复制，可直接粘贴发家长'), () => toast('复制失败，请手动选择', false));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('已复制，可直接粘贴发家长'); } catch (e) { toast('复制失败，请手动选择', false); }
        document.body.removeChild(ta);
      }
    });
  }

  // ---- 学员档案：讲次反馈卡 ----
  async function renderProfileFeedback(a) {
    const box = $('#pfFeedback');
    if (!box) return;
    box.innerHTML = '<div class="note">加载中…</div>';
    const r = await api.get('/api/feedback/list?studentId=' + encodeURIComponent(a.id)).catch(() => ({ list: [] }));
    const list = r.list || [];
    box.innerHTML = list.length ? list.map(f => fbCardHtml(f)).join('') : '<div class="note">暂无讲次反馈记录，点击右上角「＋ 录入讲次反馈」手动补录</div>';
    bindFbCopy(box);
  }
  // ---- 手动录入讲次反馈（学员档案页）----
  function openFeedbackRecordDlg(a) {
    const cur = (st.HOME && st.HOME.当期) || '2026秋';
    const firstCls = (st.ENR_BY_ID[a.id] || [])[0] || {};
    dlg('＋ 录入讲次反馈 · ' + a.姓名, `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        ${FG('学期', `<input id="fb-term" value="${esc(cur)}">`)}
        ${FG('讲次 <b style="color:#B91C1C">*</b>', `<input id="fb-lesson" value="第1讲">`)}
        ${FG('上课日期', `<input id="fb-date" type="date" value="${todayStr()}">`)}
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;">
        ${FG('班级', `<input id="fb-cls" list="classData" value="${esc(firstCls.班级 || '')}">`)}
        ${FG('状态', `<select id="fb-status"><option>已出反馈</option><option>小明班免发</option><option>周三未开课</option><option>请假缺课</option><option>免发未到课</option><option>试听刚报未上</option></select>`)}
      </div>
      ${FG('反馈正文 <b style="color:#B91C1C">*</b>（老师原版，原样粘贴，不做删改）', `<textarea id="fb-content" rows="10" style="width:100%;box-sizing:border-box;" placeholder="【本讲内容】…\n【课堂表现】…\n【课后建议】…\n【课后作业】…"></textarea>`)}
      ${dlgFoot('保存反馈')}`, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const body = {
          student_id: a.id, student_name: a.姓名, phone: a.电话 || '',
          term: box.querySelector('#fb-term').value.trim() || cur,
          lesson: box.querySelector('#fb-lesson').value.trim(),
          lesson_date: box.querySelector('#fb-date').value,
          class_name: box.querySelector('#fb-cls').value.trim(),
          status: box.querySelector('#fb-status').value,
          content: box.querySelector('#fb-content').value,
          note: '手动录入',
        };
        if (!body.lesson) return dlgErr('讲次必填');
        if (!body.content.trim()) return dlgErr('反馈正文必填');
        const r = await api.post('/api/feedback/record', body);
        if (!r.ok) return dlgErr(r.错误 || '保存失败');
        dlgClose(); toast('反馈已保存到云端');
        renderProfileFeedback(a); refresh();
      };
    });
  }

function segBadge(lv) {
    const map = { S: 'red', A: 'gold', B: 'free', C: 'gray' };
    return lv ? `<span class="badge ${map[lv] || 'gray'}">${esc(lv)}</span>` : '';
  }
  // ===== 2026-09-09 学员分层：花名册增加层级列与筛选 =====
  function fillStuFilters() {
    const cur = (st.HOME && st.HOME.当期) || '2026秋';
    const terms = [...new Set(st.ENROLL.map(e => e.期))].filter(Boolean).sort().reverse();
    const el = $('#stuTerm');
    if (el) {
      el.innerHTML = `<option value="${esc(cur)}">当期 ·${termDispL(cur)}</option>` + terms.filter(t => t !== cur).map(t => `<option value="${esc(t)}">${termDispL(t)}</option>`).join('') + '<option value="all">全部历史</option>';
      el.value = cur;
    }
    const camps = [...new Set(st.ENROLL.map(e => e.校区))].filter(Boolean).sort();
    const campus = $('#stuCampus'); if (campus) campus.innerHTML = '<option value="">全部校区</option>' + camps.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    // 分层筛选(在stuSort 下拉后加一个分层下拉)
    const segEl = $('#stuSeg'); if (segEl) { const segs = ['', 'S', 'A', 'B', 'C']; segEl.innerHTML = segs.map(s => `<option value="${s}">${s ? s + '级' : '全部层级'}</option>`).join(''); }
  }
  function stuRows() {
    const term = ($('#stuTerm') || {}).value || '2026秋', campus = ($('#stuCampus') || {}).value || '';
    const segf = ($('#stuSeg') || {}).value || '';
    const kw = st.filters.stuKw.trim().toLowerCase();
    // 以“报名行”为维度过滤：筛选条件作用于单条报名记录，而不是学员名下全部班级
    let rows = [];
    st.ROSTER.forEach(a => {
      const es = (st.ENR_BY_ID[a.id] || []).filter(e => {
        if (term !== 'all' && e.期 !== term) return false;
        if (campus && e.校区 !== campus) return false;
        if (term !== 'all' && e.在册 === false) return false;
        return true;
      });
      es.forEach(e => rows.push({ st: a, es: [e], enroll: e }));
      if (term === 'all' && !es.length) rows.push({ st: a, es: [], enroll: null });
    });
    if (kw) rows = rows.filter(a => (a.st.姓名 || '').toLowerCase().includes(kw) || (a.st.电话 || '').includes(kw) || (a.enroll && (a.enroll.班级 || '').toLowerCase().includes(kw)));
    if (segf) rows = rows.filter(a => (a.st.分层 || '') === segf);
    if (st.filters.stuSort === 'name') rows.sort((a, b) => (a.st.姓名 || '').localeCompare(b.st.姓名 || '', 'zh'));
    else rows.sort((a, b) => {
      const da = (a.enroll && (a.enroll.开课 || a.enroll.期)) || a.st.最近 || '';
      const db = (b.enroll && (b.enroll.开课 || b.enroll.期)) || b.st.最近 || '';
      return st.filters.stuSort === 'dateAsc' ? String(da).localeCompare(String(db)) : String(db).localeCompare(String(da));
    });
    return { rows, term };
  }
  function pickClsRows(es, term, person) {
    let rows = term === 'all' ? (person.当期 && person.当期.length ? person.当期 : es.slice(0, 1)) : es.filter(e => e.期 === term);
    const active = rows.filter(e => e.源状态 !== '历史在班学生' && !e.作废);
    return active.length ? active : rows.slice(0, 1);
  }
  function clsTime(e) {
    const x = schedMap[e.班级] || {};
    const day = x.星期 || e.星期 || '';
    const tm = x.时间 || e.时间 || '';
    if (day && tm) return `${day} ${tm}`;
    if (tm) return tm;
    return '—';
  }
  function clsCell(e) {
    const bName = String(e.班级 || '').trim();
    // 班级名称后已有老师简称的，不再重复追加全名
    const hasTeacherInName = /-(温温|飞飞|小明|小天|小树|金金|晓晓|章章|俞老师)$/.test(bName);
    const tDisplay = (!hasTeacherInName && e.老师) ? `<span class="muted" style="font-size:11px;margin-left:4px;">${esc(e.老师)}</span>` : '';
    return `<div style="padding:2px 0;"><b>${esc(bName)}</b>${tDisplay}</div>`;
  }
  function renderStudents() {
    const box = $('#stuList'); if (!box) return;
    const { rows, term } = stuRows();
    const tag = $('#stuTermTag'); if (tag) tag.textContent = term === 'all' ? '全部历史' : termDispL(term);
    
    // 按所报班级拆分行展示（一人兼报多科分多条展示，使多科目清晰明了）
    const flatRows = [];
    rows.forEach(({ st: person, es }) => {
      const clsList = pickClsRows(es, term, person);
      if (clsList.length > 0) {
        clsList.forEach((e, idx) => {
          flatRows.push({ person, enroll: e, totalEnr: clsList.length, enrIndex: idx + 1 });
        });
      } else {
        flatRows.push({ person, enroll: null, totalEnr: 0, enrIndex: 0 });
      }
    });

    const pg = st.PG.stu, slice = flatRows.slice((pg.page - 1) * pg.size, pg.page * pg.size);
    box.innerHTML = slice.length ? `<table><tr><th>学员姓名 / ID</th><th>层级</th><th>风险</th><th>报读科目/班级</th><th>上课时间段</th><th>任课老师</th><th>校区</th><th>联系电话</th><th>操作</th></tr>` + slice.map(({ person, enroll, totalEnr, enrIndex }) => {
      const multiTag = totalEnr > 1 ? `<span class="badge blue" style="margin-left:4px;font-size:10.5px;">兼报${totalEnr}科 (${enrIndex}/${totalEnr})</span>` : '';
      const timeStr = enroll ? clsTime(enroll) : '—';
      const riskTags = (person.风险标签 || []).slice(0, 2).map(t => `<span class="badge gold" style="font-size:10px;margin-right:2px;">${esc(t.label || t.code || '')}</span>`).join('');
      return `<tr><td class="tk"><b>${esc(person.姓名)}</b>${multiTag}<div class="muted" style="font-size:11px;font-family:monospace;margin-top:2px;">ID: ${esc(person.sourceStudentId || person.id)}</div></td><td>${segBadge(person.分层)}</td><td style="min-width:80px;">${riskTags || '<span class="muted">—</span>'}</td><td>${enroll ? clsCell(enroll) : '<span class="muted">—</span>'}</td><td class="tk">${esc(timeStr)}</td><td>${enroll ? esc(enroll.老师 || '—') : '—'}</td><td class="muted">${enroll ? esc(enroll.校区 || '—') : '—'}</td><td class="muted">${esc(person.电话)}</td><td style="display:flex;gap:6px;"><span class="btn sub sm" data-id="${esc(person.id)}">学员档案</span><span class="btn sub sm" data-leave-kid="${esc(person.id)}" data-leave-name="${esc(person.姓名)}" data-leave-cls="${esc(enroll ? enroll.班级 : '')}">记请假</span></td></tr>`;
    }).join('') + '</table>' : '<div class="note">没有符合条件的学员</div>';
    renderPager($('#stuPager'), flatRows.length, pg.page, pg.size, (p, s) => { st.PG.stu = { page: p, size: s }; renderStudents(); });
    box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { location.hash = 'profile/' + encodeURIComponent(b.dataset.id); });
    box.querySelectorAll('[data-family]').forEach(b => b.onclick = () => { location.hash = 'family/' + encodeURIComponent(b.dataset.family); });
    box.querySelectorAll('[data-leave-kid]').forEach(b => b.onclick = () => openLeaveModal(b.dataset.leaveKid, b.dataset.leaveName, b.dataset.leaveCls));
  }

  function fillSchFilters() {
    const cur = (st.HOME && st.HOME.当期) || '2026秋';
    const fill = (id, vals, defaultText, order) => {
      const el = $('#' + id); if (!el) return;
      const uniq = [...new Set(vals.filter(Boolean))];
      if (order) uniq.sort((a, b) => (order.indexOf(a) >= 0 ? order.indexOf(a) : 99) - (order.indexOf(b) >= 0 ? order.indexOf(b) : 99));
      else uniq.sort((a, b) => String(a).localeCompare(String(b), 'zh'));
      el.innerHTML = `<option value="">${defaultText}</option>` + uniq.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    };
    const terms = [...new Set(st.SCHEDULE.map(r => r.期).filter(Boolean))].sort().reverse();
    if (!terms.includes(cur)) terms.unshift(cur);
    const term = $('#schTerm'); if (term) { term.innerHTML = `<option value="">全部学期</option>` + terms.map(t => `<option value="${esc(t)}">${termDispL(t)}</option>`).join(''); term.value = terms.includes('2026秋') ? '2026秋' : ''; }
    fill('schType', st.SCHEDULE.map(r => r.班型), '全部班型', ['小明班', '自招', '中考', '创新', '尖子', '奥数', '短期班', '其他']);
    fill('schGrade', st.SCHEDULE.map(r => r.年级), '全部年级', GRADE_ORDER);
    fill('schTeacher', st.SCHEDULE.map(r => r.老师), '全部老师');
    fill('schCampus', st.SCHEDULE.map(r => r.校区), '全部校区');
    fill('schSubject', st.SCHEDULE.map(r => r.学科), '全部学科');
  }
  function schFiltered() {
    const term = ($('#schTerm') || {}).value || '', ty = ($('#schType') || {}).value || '', g = ($('#schGrade') || {}).value || '', sub = ($('#schSubject') || {}).value || '';
    const day = ($('#schDay') || {}).value || '', t = ($('#schTeacher') || {}).value || '', c = ($('#schCampus') || {}).value || '', kw = (($('#schKw') || {}).value || '').trim().toLowerCase();
    
    // 过滤掉 1 号教室与租用条目
    let list = st.SCHEDULE.filter(r => {
      if (String(r.教室 || '').trim() === '1号' || String(r.课程 || '').includes('租用') || r.来源 === '教室租用') return false;
      return (!term || r.期 === term) && (!ty || r.班型 === ty) && (!g || r.年级 === g) && (!sub || r.学科 === sub) && (!day || r.星期 === day) && (!t || r.老师 === t) && (!c || r.校区 === c) && (!kw || [r.班级, (r.班级名 || []).join(' '), r.课程, r.老师, r.教室, r.班号, r.校区, r.星期, r.班型].join(' ').toLowerCase().includes(kw));
    });

    // 默认排序：先按星期（周一至周日顺序），再按时间先后（08:00到晚上）
    const dayWeight = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7 };
    list.sort((a, b) => {
      const wa = dayWeight[a.星期] || 99, wb = dayWeight[b.星期] || 99;
      if (wa !== wb) return wa - wb;
      return String(a.时间 || '').localeCompare(String(b.时间 || ''));
    });

    return list;
  }
  function renderSchedule() {
    const box = $('#schListView'); if (!box) return;
    const rows = schFiltered();
    $('#schCount').textContent = `课表 · ${rows.length} 项 (已隐藏1号外租教室)`;
    const pg = st.PG.sch, slice = rows.slice((pg.page - 1) * pg.size, pg.page * pg.size);
    box.innerHTML = slice.length ? `<table><tr><th>期次</th><th>星期</th><th>时段</th><th>班级 (点击看学生)</th><th>班型</th><th>老师</th><th>教室</th><th>校区</th><th>人数</th><th>操作</th></tr>` + slice.map(r => `<tr><td>${termDispL(r.期 || '—')}</td><td>${esc(r.星期 || '—')}</td><td class="tk">${esc(r.时间 || '—')}</td><td><a href="javascript:void(0)" class="sch-cls-link" data-cls="${esc(r.班号 || classRowLabel(r))}" style="color:#2563EB;font-weight:700;text-decoration:none;">${esc(classRowLabel(r))}</a></td><td>${r.班型 ? typeBadge(r.班型) : '<span class="muted">—</span>'}${subjBadge(r.学科)}</td><td>${esc(r.老师 || '—')}</td><td>${esc(r.教室 || '—')}</td><td class="muted">${esc(r.校区 || '—')}</td><td><b style="color:#059669">${r.在班人数 || r.人数 || 0}人</b></td><td><span class="btn sub sm" data-cls="${esc(r.班号 || classRowLabel(r))}">学生名单</span></td></tr>`).join('') + '</table>' : '<div class="note">没有符合条件的班级</div>';
    renderPager($('#schPager'), rows.length, pg.page, pg.size, (p, s) => { st.PG.sch = { page: p, size: s }; renderSchedule(); });
    box.querySelectorAll('[data-cls], .sch-cls-link').forEach(b => b.onclick = () => { const row = rows.find(r => (r.班号 || classRowLabel(r)) === b.dataset.cls); if (row) classDetailDlg(row); });
  }
  function fillMatrixFilters() {
    const camps = [...new Set(st.SCHEDULE.filter(r => r.来源 !== '教室租用').map(r => r.校区))].filter(Boolean).sort();
    const campEl = $('#schMatrixCampus');
    if (campEl) campEl.innerHTML = camps.map(c => `<option${c === '贵都校区' ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const dayW = {'周一':1,'周二':2,'周三':3,'周四':4,'周五':5,'周六':6,'周日':7};
    const days = [...new Set(st.SCHEDULE.filter(r => r.来源 !== '教室租用').map(r => r.星期))].filter(Boolean).sort((a,b) => (dayW[a]||99) - (dayW[b]||99));
    const wn = ['周日','周一','周二','周三','周四','周五','周六'];
    const todayDay = wn[new Date().getDay()];
    const defaultDay = days.includes(todayDay) ? todayDay : days[0] || '周六';
    const dayEl = $('#schMatrixDay');
    if (dayEl) dayEl.innerHTML = days.map(d => `<option${d === defaultDay ? ' selected' : ''}>${esc(d)}</option>`).join('');
  }
  function renderScheduleMatrix() {
    const grid = $('#schMatrixGrid'); if (!grid) return;
    const campus = ($('#schMatrixCampus') || {}).value || '贵都校区';
    const day = ($('#schMatrixDay') || {}).value || '周六';
    const items = st.SCHEDULE.filter(r => r.校区 === campus && r.星期 === day && String(r.教室||'').trim() !== '1号' && !String(r.课程||'').includes('租用') && r.来源 !== '教室租用');
    const roomMap = {};
    items.forEach(r => { const rm = r.教室 || '未知'; (roomMap[rm] = roomMap[rm] || []).push(r); });
    Object.values(roomMap).forEach(arr => arr.sort((a,b) => String(a.时间||'').localeCompare(String(b.时间||''))));
    const allRooms = [...new Set(st.SCHEDULE.filter(r => r.校区 === campus && String(r.教室||'').trim() !== '1号' && !String(r.课程||'').includes('租用') && r.来源 !== '教室租用').map(r => r.教室))].filter(Boolean);
    const roomOrd = n => { const m = String(n).match(/^(\d+)号$/); return m ? [0, Number(m[1])] : [1, n]; };
    allRooms.sort((a,b) => { const [ta,na]=roomOrd(a),[tb,nb]=roomOrd(b); if(ta!==tb) return ta-tb; return typeof na==='number'? na-nb : String(na).localeCompare(String(nb),'zh'); });
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (!allRooms.length) { grid.innerHTML = '<div class="note">该校区暂无教室排课数据</div>'; return; }
    let html = `<div class="room-matrix-header"><span class="rmh-campus">${esc(campus)}</span><span class="rmh-day">${esc(day)}</span><span class="rmh-info">${items.length} 节课 · ${allRooms.length} 间教室</span></div><div class="room-grid">`;
    allRooms.forEach((room, i) => {
      const courses = roomMap[room] || [];
      const letter = labels[i] || String(i+1);
      html += `<div class="room-card${courses.length ? '' : ' room-idle-card'}"><div class="room-card-head"><span class="room-letter">${letter}</span><span class="room-num">${esc(room)}</span>${courses.length ? `<span class="room-count">${courses.length}节</span>` : '<span class="room-free-tag">空闲</span>'}</div>`;
      if (courses.length) {
        html += '<div class="room-courses">';
        courses.forEach(r => {
          const cn = classRowLabel(r), cnt = (r.在班||r.enrolledList||[]).length || r.在班人数 || r.人数 || 0;
          const tp = r.班型 || '', colorCls = tp.includes('创新')||tp.includes('自招') ? 'rc-gold' : tp.includes('物理')||(r.学科||'').includes('物理') ? 'rc-green' : 'rc-blue';
          html += `<div class="room-course ${colorCls}" data-cls-no="${esc(r.班号||cn)}"><div class="rc-time">${esc(r.时间||'—')}</div><div class="rc-name">${esc(cn)}</div><div class="rc-bottom"><span class="rc-teacher">${esc(r.老师||'—')}</span><span class="rc-stu">${cnt}人</span></div></div>`;
        });
        html += '</div>';
      } else {
        html += `<div class="room-idle-body">当日无课程安排</div>`;
      }
      html += '</div>';
    });
    html += '</div>';
    grid.innerHTML = html;
    grid.querySelectorAll('.room-course').forEach(el => {
      el.onclick = () => { const row = st.SCHEDULE.find(r => (r.班号||classRowLabel(r)) === el.dataset.clsNo); if (row) classDetailDlg(row); };
    });
  }
  function classDetailDlg(r) {
    dlg('班级学生花名册 · ' + classRowLabel(r), `<div class="kv"><div class="i"><span class="l">上课时间</span><b>${esc(r.星期 || '')} ${esc(r.时间 || '')}</b></div><div class="i"><span class="l">任课老师</span>${esc(r.老师 || '')}</div><div class="i"><span class="l">教室校区</span>${esc(r.校区 || '')} ${esc(r.教室 || '')}</div><div class="i"><span class="l">在班人数</span><b style="color:#059669">${r.在班人数 || (r.在班 || []).length || 0} 人</b></div></div>${(r.enrolledList || r.在班 || []).length ? `<table style="margin-top:12px;"><tr><th>序号</th><th>学员姓名</th><th>年级</th><th>联系电话</th><th>操作</th></tr>${(r.enrolledList || r.在班 || []).map((x, i) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(x.姓名 || x.name)}</b></td><td>${esc(x.年级 || x.grade || '')}</td><td class="muted">${esc(x.电话 || x.phone || '')}</td><td><span class="btn sm" style="background:#059669;color:#fff;" data-goto-id="${esc(x.id)}">进入学员档案 →</span></td></tr>`).join('')}</table>` : '<div class="note">当前班级暂无在班学员</div>'}`, box => { box.querySelectorAll('[data-goto-id]').forEach(b => b.onclick = () => { dlgClose(); location.hash = 'profile/' + encodeURIComponent(b.dataset.gotoId); }); });
  }

  async function loadLeaves() { const d = await api.get('/api/leave/list').catch(() => ({ leaves: [] })); st.LEAVES = d.leaves || []; renderLeavePage(); }
  function renderLeavePage() {
    const kw = (st.filters.leaveKw || '').trim().toLowerCase();
    let rows = st.LEAVES.slice().sort((a, b) => String(b.创建时间 || '').localeCompare(String(a.创建时间 || '')));
    if (kw) rows = rows.filter(r => (r.姓名 || '').toLowerCase().includes(kw) || (r.班级 || '').toLowerCase().includes(kw));
    const stats = $('#leaveStats'); if (stats) stats.innerHTML = [['累计请假人次', rows.length, '次'], ['累计折算退费', '¥' + rows.reduce((s, x) => s + (Number(x.折算金额) || 0), 0), ''], ['涉及班级数', new Set(rows.map(r => r.班级)).size, '个']].map(x => `<div class="kpi-card"><div class="kpi-k">${x[0]}</div><div class="kpi-v">${x[1]}<span>${x[2]}</span></div></div>`).join('');
    const box = $('#leaveTable'); if (!box) return;
    box.innerHTML = rows.length ? `<table><tr><th>请假单号</th><th>学员姓名</th><th>请假班级</th><th>请假日期</th><th>原因/事由</th><th>折算退费金额</th><th>登记时间</th><th>操作</th></tr>${rows.map(r => `<tr><td class="muted">${esc(r.lid)}</td><td class="tk"><b>${esc(r.姓名)}</b></td><td>${esc(r.班级)}</td><td class="muted">${esc(r.日期)}</td><td>${esc(r.原因)}</td><td><b style="color:#2563EB;">¥${esc(r.折算金额)}</b></td><td class="muted">${esc(r.创建时间 || '')}</td><td><span class="btn sub sm" style="color:#DC2626;border-color:#FECACA;" data-del-leave="${esc(r.lid)}">撤销</span></td></tr>`).join('')}</table>` : '<div class="note">暂无请假与退费记录</div>';
    box.querySelectorAll('[data-del-leave]').forEach(b => b.onclick = async () => { if (!confirm('确认撤销这条请假记录？')) return; const r = await api.post('/api/leave/delete', { lid: b.dataset.delLeave }); if (r.ok) { await loadLeaves(); toast('已撤销'); } });
  }
  function openLeaveModal(studentId = '', studentName = '', defaultClass = '') {
    dlg('登记学员请假与折算退费', `
      ${FG('学员姓名 <b style="color:#B91C1C">*</b>', `<input id="lv-name" value="${esc(studentName)}" list="stuNameList" placeholder="必须是系统内的在读学员" ${studentName ? 'readonly' : ''}>`)}
      <datalist id="stuNameList">${st.ROSTER.map(s => `<option value="${esc(s.姓名)}">${esc(s.姓名)} · ${esc(s.年级 || '')} · ${esc(s.电话 || '')}</option>`).join('')}</datalist>
      ${FG('报读班级 <b style="color:#B91C1C">*</b>', `<input id="lv-class" value="${esc(defaultClass)}" list="classData" placeholder="选择或输入当期班级"/>`)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('请假日期', `<input id="lv-date" type="date" value="${todayStr()}">`)}
        ${FG('折算退费金额 (元)', '<input id="lv-fee" type="number" value="200">')}
      </div>
      ${FG('请假原因', '<select id="lv-reason"><option>事假 (提前报备)</option><option>病假 (身体不适)</option><option>临时冲突</option><option>其他</option></select>')}
      ${FG('助教备注', '<input id="lv-note" placeholder="选填">')}
      ${dlgFoot('确认登记')}
    `, box => {
      const okBtn = box.querySelector('#dlgOk');
      box.querySelector('#dlgCancel').onclick = dlgClose;
      
      // 当输入姓名时，自动联动匹配当前学期在读班级（复用 bindStuAutoClass）
      const nameInput = box.querySelector('#lv-name');
      const clsInput = box.querySelector('#lv-class');
      const dateInput = box.querySelector('#lv-date');
      // 班级确定后：按该班上课星期自动计算"最近一次上课日"填入请假日期
      const autoLeaveDate = cls => {
        if (!cls || !dateInput) return;
        const sch = schedMap[cls];
        const dayMap = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0 };
        const wd = sch && dayMap[sch.星期];
        if (wd === undefined) return; // 查不到排课星期，保留默认
        const now = new Date();
        let diff = wd - now.getDay();
        if (diff <= 0) diff += 7; // 距今最近的下一次该上课日
        const d = new Date(now.getTime() + diff * 86400000);
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        dateInput.value = ds;
      };
      bindStuAutoClass(nameInput, clsInput, autoLeaveDate);

      okBtn.onclick = async () => {
        let sid = studentId;
        const sname = nameInput.value.trim();
        const cls = clsInput.value.trim();
        if (!sname) return dlgErr('请填写或选择学员姓名');
        if (!cls) return dlgErr('请选择学员报读班级');

        // 强校验学员合法性
        const found = st.ROSTER.find(s => s.姓名 === sname || s.id === sid);
        if (!found) return dlgErr(`系统内未找到学员【${sname}】，请选择真实在读学员！`);
        sid = found.id;

        // 防抖：防止重复连击
        if (okBtn.disabled) return;
        okBtn.disabled = true;
        okBtn.textContent = '提交中...';

        try {
          const r = await api.post('/api/leave/record', {
            studentId: sid,
            姓名: sname,
            班级: cls,
            日期: box.querySelector('#lv-date').value,
            折算金额: box.querySelector('#lv-fee').value,
            原因: box.querySelector('#lv-reason').value,
            备注: box.querySelector('#lv-note').value
          });
          if (!r.ok) {
            okBtn.disabled = false;
            okBtn.textContent = '确认登记';
            return dlgErr(r.错误 || '登记失败');
          }
          dlgClose();
          await loadLeaves();
          toast('请假登记成功！');
        } catch (err) {
          okBtn.disabled = false;
          okBtn.textContent = '确认登记';
          dlgErr('网络或服务异常，请重试');
        }
      };
    });
  }

  // ======================
  // 转介绍管理模块（学员转介绍 → 助教沟通）
  // ======================
  function refState() { return st.REFERRALS || []; }
  function refBadge(s) {
    const map = { '待测评': 'gold', '已测评待试听': 'blue', '待报名': 'purple', '已报名': 'free', '已流失': 'gray' };
    return `<span class="badge ${map[s] || 'gray'}">${esc(s || '待测评')}</span>`;
  }
  function renderReferralPage() {
    const kw = ($('#refKw') || {}).value ? $('#refKw').value.trim().toLowerCase() : '';
    const sf = ($('#refStatus') || {}).value || '';
    let rows = refState().slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (sf) rows = rows.filter(r => r.status === sf);
    if (kw) rows = rows.filter(r => (r.referrer || '').toLowerCase().includes(kw) || (r.studentName || '').toLowerCase().includes(kw));
    const notLost = rows.filter(r => r.status !== '已流失');
    const stats = $('#refStats'); if (stats) stats.innerHTML = [
      ['进行中', notLost.length, '条'], ['待测评', rows.filter(r => r.status === '待测评').length, '条'],
      ['已测评待试听', rows.filter(r => r.status === '已测评待试听').length, '条'], ['已报名', refState().filter(r => r.status === '已报名').length, '人'],
    ].map(x => `<div class="kpi-card"><div class="kpi-k">${x[0]}</div><div class="kpi-v">${x[1]}<span>${x[2]}</span></div></div>`).join('');
    const box = $('#refTable'); if (!box) return;
    box.innerHTML = rows.length ? `<table><tr><th>新生姓名</th><th>介绍家长</th><th>年级/班型/学科</th><th>测评日期</th><th>测评分数</th><th>试听日期</th><th>状态</th><th>操作</th></tr>${rows.map(r => `<tr>
      <td class="tk"><b>${esc(r.studentName)}</b>${r.note ? `<div class="muted" style="font-size:11px;">${esc(r.note)}</div>` : ''}</td>
      <td>${esc(r.referrer)}${r.referrerPhone ? `<div class="muted" style="font-size:11px;">${esc(r.referrerPhone)}</div>` : ''}</td>
      <td class="muted">${esc(r.grade || '—')} · ${esc(r.classType || '—')} · ${esc(r.subject || '—')}</td>
      <td>${esc(r.evalDate || '—')}</td>
      <td>${r.evalScore ? `<b style="color:#2563EB;">${esc(r.evalScore)}</b>` : '—'}</td>
      <td>${esc(r.trialDate || '—')}</td>
      <td>${refBadge(r.status)}${r.remindTid ? `<div class="muted" style="font-size:11px;">🔔 已设提醒</div>` : ''}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;"><span class="btn sub sm" data-ref-edit="${esc(r.rid)}">编辑</span><span class="btn sub sm" data-ref-next="${esc(r.rid)}">流转 ↓</span>${r.status === '已报名' && r.studentId ? `<span class="btn sm" data-ref-go="${esc(r.studentId)}" style="background:#059669;color:#fff;">进档案 →</span>` : ''}</td>
    </tr>`).join('')}</table>` : '<div class="note">暂无转介绍记录</div>';
    box.querySelectorAll('[data-ref-edit]').forEach(b => b.onclick = () => openReferralDlg(refState().find(r => r.rid === b.dataset.refEdit)));
    box.querySelectorAll('[data-ref-next]').forEach(b => b.onclick = () => openReferralNextDlg(refState().find(r => r.rid === b.dataset.refNext)));
    box.querySelectorAll('[data-ref-go]').forEach(b => b.onclick = () => { location.hash = 'profile/' + encodeURIComponent(b.dataset.refGo); });
  }
  const REF_NEXT = { '待测评': ['已测评待试听', '已流失'], '已测评待试听': ['待报名', '已流失'], '待报名': ['已报名', '已流失'] };
  function openReferralNextDlg(r) {
    if (!r) return;
    const opts = REF_NEXT[r.status] || [];
    if (!opts.length) { dlg('状态流转', `<div class="note">当前状态「${esc(r.status)}」无需流转</div>`, () => {}); return; }
    dlg(`流转状态 · ${esc(r.studentName)}`, `<div style="margin-bottom:12px;font-size:13px;">当前：${refBadge(r.status)}<div class="muted" style="margin-top:4px;">选择下一状态：</div></div>${opts.map(s => `<div style="margin:6px 0;"><span class="btn" data-next="${esc(s)}">→ ${esc(s)}</span></div>`).join('')}${dlgFoot('关闭')}`, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = dlgClose;
      box.querySelectorAll('[data-next]').forEach(b => b.onclick = async () => {
        const stt = b.dataset.next;
        const extra = {};
        if (stt === '已测评待试听' && !r.evalScore) {
          const score = prompt('测评分数是多少？（可跳过直接点确定）', '');
          if (score !== null) extra.evalScore = score.trim();
        }
        if (stt === '已报名') {
          const sid = prompt('已报名：请填该生在系统内的学员ID（若已新增学员可在花名册看 ID）；直接点确定则仅标记报名', r.studentId || '');
          if (sid !== null) extra.studentId = sid.trim();
        }
        const body = { rid: r.rid, status: stt, evalScore: extra.evalScore || r.evalScore, studentId: extra.studentId || r.studentId, studentName: r.studentName, referrer: r.referrer };
        const res = await api.post('/api/referral/update', body);
        if (!res.ok) return dlgErr(res.错误 || '操作失败');
        dlgClose(); toast(`已流转为「${stt}」`);
        await Z.bootstrap.loadAllData(); renderReferralPage();
      });
    });
  }
  function openReferralDlg(r = null) {
    const isNew = !r;
    dlg(isNew ? '＋ 新增转介绍' : '编辑转介绍 · ' + (r.studentName || ''), `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('介绍家长 <b style="color:#B91C1C">*</b>', `<input id="rf-referrer" value="${esc(r ? r.referrer : '')}" placeholder="例：张三妈妈">`)}
        ${FG('介绍家长电话', `<input id="rf-referrerPhone" value="${esc(r ? r.referrerPhone : '')}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('新生姓名 <b style="color:#B91C1C">*</b>', `<input id="rf-stuName" value="${esc(r ? r.studentName : '')}">`)}
        ${FG('年级', `<select id="rf-grade"><option value=""></option>${GRADES.map(g => `<option${r && r.grade === g ? ' selected' : ''}>${g}</option>`).join('')}</select>`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('班型', `<select id="rf-classType"><option value=""></option><option${r && r.classType === '创新班' ? ' selected' : ''}>创新班</option><option${r && r.classType === '尖子班' ? ' selected' : ''}>尖子班</option></select>`)}
        ${FG('学科', `<select id="rf-subject"><option value=""></option><option${r && r.subject === '数学' ? ' selected' : ''}>数学</option><option${r && r.subject === '物理' ? ' selected' : ''}>物理</option></select>`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('约定测评日期', `<input id="rf-evalDate" type="date" value="${esc(r ? r.evalDate : '')}">`)}
        ${FG('试听课日期', `<input id="rf-trialDate" type="date" value="${esc(r ? r.trialDate : '')}">`)}
      </div>
      ${isNew ? `${FG('评价分数（测评后填，可稍后补）', '<input id="rf-evalScore" placeholder="例：85">')}` : ''}
      ${FG('助教备注', `<input id="rf-note" value="${esc(r ? r.note : '')}" placeholder="阶段/沟通要点等">`)}
      ${dlgFoot(isNew ? '保存并生成提醒' : '保存')}
    `, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const body = {
          referrer: box.querySelector('#rf-referrer').value.trim(), referrerPhone: box.querySelector('#rf-referrerPhone').value.trim(),
          studentName: box.querySelector('#rf-stuName').value.trim(), grade: box.querySelector('#rf-grade').value,
          classType: box.querySelector('#rf-classType').value, subject: box.querySelector('#rf-subject').value,
          evalDate: box.querySelector('#rf-evalDate').value, trialDate: box.querySelector('#rf-trialDate').value,
          evalScore: box.querySelector('#rf-evalScore') ? box.querySelector('#rf-evalScore').value.trim() : (r ? r.evalScore : ''),
          note: box.querySelector('#rf-note').value.trim(),
        };
        if (!body.referrer) return dlgErr('请填写介绍家长');
        if (!body.studentName) return dlgErr('请填写新生姓名');
        if (isNew) {
          const res = await api.post('/api/referral/record', body);
          if (!res.ok) return dlgErr(res.错误 || '保存失败');
          dlgClose(); toast('已保存转介绍，提醒待办已生成（约定日前一天）');
        } else {
          const res = await api.post('/api/referral/update', { rid: r.rid, ...body, status: r.status });
          if (!res.ok) return dlgErr(res.错误 || '保存失败');
          dlgClose(); toast('已保存');
        }
        await Z.bootstrap.loadAllData(); renderReferralPage();
      };
    });
  }

  // ======================
  // 学情与日常跟进模块
  // ======================
  async function loadFollowups() {
    const d = await api.get('/api/followup/list').catch(() => ({ list: [] }));
    st.FOLLOWUPS = d.list || [];
    renderFollowupPage();
  }
  function renderFollowupPage() {
    const kw = ($('#flwKw') || {}).value ? $('#flwKw').value.trim().toLowerCase() : '';
    const typeFilter = ($('#flwType') || {}).value || '';
    let list = (st.FOLLOWUPS || []).slice();
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (typeFilter) list = list.filter(item => item.type === typeFilter);
    if (kw) list = list.filter(item => (item.studentName || '').toLowerCase().includes(kw) || (item.phone || '').includes(kw) || (item.content || '').toLowerCase().includes(kw));

    const stats = $('#flwStats');
    if (stats) stats.innerHTML = [
      ['累计跟进沟通', (st.FOLLOWUPS || []).length, '次'],
      ['覆盖学员数', new Set((st.FOLLOWUPS || []).map(f => f.studentId)).size, '人'],
      ['家长沟通记录', (st.FOLLOWUPS || []).filter(f => f.type === '家长沟通').length, '条'],
      ['课堂与学情反馈', (st.FOLLOWUPS || []).filter(f => f.type.includes('学情') || f.type.includes('课堂') || f.type.includes('答疑')).length, '条']
    ].map(x => `<div class="kpi-card"><div class="kpi-k">${x[0]}</div><div class="kpi-v">${x[1]}<span>${x[2]}</span></div></div>`).join('');

    const box = $('#flwTable');
    if (!box) return;
    const pg = st.PG.flw || { page: 1, size: 20 };
    const slice = list.slice((pg.page - 1) * pg.size, pg.page * pg.size);
    box.innerHTML = slice.length ? `<table><tr><th>时间</th><th>学员姓名</th><th>联系电话</th><th>类型</th><th>科目</th><th>沟通要点摘要</th><th>记录人</th><th>操作</th></tr>` + slice.map(r => `
      <tr>
        <td class="muted">${esc(r.createdAt ? r.createdAt.slice(0, 16).replace('T', ' ') : '—')}</td>
        <td class="tk"><b>${esc(r.studentName || '—')}</b></td>
        <td class="muted">${esc(r.phone || '—')}</td>
        <td><span class="badge blue">${esc(r.type || '日常沟通')}</span></td>
        <td><span class="badge ${r.subject === '物理' ? 'c-wuli' : 'c-zhong'}">${esc(r.subject || '全科')}</span></td>
        <td style="max-width:320px;line-height:1.4;">${esc(r.content || '')}</td>
        <td class="muted">${esc(r.creator || '助教')}</td>
        <td><span class="btn sub sm" data-goto-stu="${esc(r.studentId)}">档案</span></td>
      </tr>
    `).join('') + `</table>` : `<div class="note">暂无符合条件的日常跟进记录</div>`;

    renderPager($('#flwPager'), list.length, pg.page, pg.size, (p, s) => {
      st.PG.flw = { page: p, size: s };
      renderFollowupPage();
    });

    box.querySelectorAll('[data-goto-stu]').forEach(b => {
      b.onclick = () => { location.hash = 'profile/' + encodeURIComponent(b.dataset.gotoStu); };
    });
  }

  function openAddFollowModal(defaultStudentId = '', defaultStudentName = '') {
    dlg('登记学情与日常沟通记录', `
      ${FG('沟通学员 <b style="color:#B91C1C">*</b>', `<input id="af-student" value="${esc(defaultStudentName)}" list="stuNameList" placeholder="搜索或输入学生姓名" ${defaultStudentName ? 'readonly' : ''}>`)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('沟通类型', `
          <select id="af-type">
            <option>家长沟通</option>
            <option>课堂表现</option>
            <option>错题答疑</option>
            <option>请假补课</option>
            <option>阶段学情</option>
            <option>首课反馈</option>
            <option>拓科跟进</option>
            <option>续班沟通</option>
            <option>其他</option>
          </select>
        `)}
        ${FG('关联科目', `
          <select id="af-subject">
            <option>数学</option>
            <option>物理</option>
            <option>全科综合</option>
          </select>
        `)}
      </div>
      ${FG('沟通要点与学情内容 <b style="color:#B91C1C">*</b>', `
        <textarea id="af-content" rows="4" style="width:100%;border:1px solid #E2E8F0;border-radius:6px;padding:8px;font-size:13px;resize:vertical;" placeholder="记录沟通核心内容（如：与妈妈通话，孩子反馈平面几何辅助线掌握较弱，已预约周六课后进行答疑...）"></textarea>
      `)}
      ${FG('记录人', '<input id="af-creator" value="助教">')}
      ${dlgFoot('确认保存记录')}
    `, box => {
      const okBtn = box.querySelector('#dlgOk');
      box.querySelector('#dlgCancel').onclick = dlgClose;
      okBtn.onclick = async () => {
        const sname = box.querySelector('#af-student').value.trim();
        const type = box.querySelector('#af-type').value;
        const subj = box.querySelector('#af-subject').value;
        const content = box.querySelector('#af-content').value.trim();
        const creator = box.querySelector('#af-creator').value.trim();
        if (!sname) return dlgErr('请选择沟通学员');
        if (!content) return dlgErr('请填写沟通要点内容');

        const found = st.ROSTER.find(s => s.姓名 === sname || s.id === defaultStudentId);
        if (!found) return dlgErr(`系统内未匹配到学员【${sname}】，请确认姓名！`);

        if (okBtn.disabled) return;
        okBtn.disabled = true;
        okBtn.textContent = '保存中...';

        try {
          const r = await api.post('/api/followup/record', {
            studentId: found.id,
            studentName: found.姓名,
            type,
            subject: subj === '全科综合' ? '全科' : subj,
            content,
            creator
          });
          if (!r.ok) {
            okBtn.disabled = false;
            okBtn.textContent = '确认保存记录';
            return dlgErr(r.错误 || '保存失败');
          }
          dlgClose();
          toast('跟进记录已成功保存！');
          await loadFollowups();
          if (location.hash.startsWith('#profile/')) openProfile(found.id);
        } catch (e) {
          okBtn.disabled = false;
          okBtn.textContent = '确认保存记录';
          dlgErr('网络或服务异常，请重试');
        }
      };
    });
  }

  async function openProfile(id) {
    const d = await api.get('/api/student?id=' + encodeURIComponent(id)).catch(() => null); if (!d || !d.基本) { location.hash = 'stu'; return; }
    const a = d.基本;
    $('#pfName').textContent = a.姓名 + ' · 学员档案';
    $('#pfMeta').innerHTML = `学员唯一ID: <b>${esc(a.sourceStudentId || a.id)}</b>` + (d.家庭 && (d.家庭.children || []).length > 1 ? ` <span class="btn sub sm" data-open-family="${esc(d.家庭.familyId)}">查看家庭档案 (${d.家庭.children.length}孩共用电话)</span>` : '');
    const famBtn = $('#pfMeta [data-open-family]'); if (famBtn) famBtn.onclick = () => { location.hash = 'family/' + encodeURIComponent(famBtn.dataset.openFamily); };
    $('#pfBase').innerHTML = `<div class="kv"><div class="i"><span class="l">学员姓名</span><b>${esc(a.姓名)}</b></div><div class="i"><span class="l">年级</span>${esc(a.年级 || '—')}</div><div class="i"><span class="l">性别</span>${esc(a.性别 || '—')}</div><div class="i"><span class="l">联系电话</span>${esc(a.电话 || '—')}</div><div class="i"><span class="l">状态</span>${stTag(a.状态)}</div><div class="i"><span class="l">首次报名</span>${esc(a.首次 || '—')}</div>${a.备注 ? `<div class="i" style="grid-column:1/-1"><span class="l">备注</span>${esc(a.备注)}</div>` : ''}</div>
    <div style="margin-top:12px;border-top:2px solid #E2E8F0;padding-top:12px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <b>跟进画像</b>
        ${segBadge(d.分层)}${d.人工覆盖 ? '<span class="badge" style="background:#DBEAFE;color:#1E40AF;">人工覆盖</span>' : ''}
        <span class="muted">自动: ${esc(d.自动分层 || '—')} · 分数 ${d.分层分数 || 0}</span>
        <span class="btn sub sm" data-seg-edit="${esc(a.id)}">编辑分层</span>
      </div>
      ${(d.风险标签 || []).length ? `<div style="margin-top:6px;">${d.风险标签.map(t => `<span class="badge gold" style="font-size:10.5px;margin-right:4px;">${esc(t.label || t.code)}</span>`).join('')}</div>` : ''}
      ${(d.分层依据 || []).length ? `<div style="margin-top:4px;font-size:12px;color:#6B7280;line-height:1.5;">${d.分层依据.slice(0, 3).map(r => `· ${esc(r)}`).join('<br>')}</div>` : ''}
      <div style="margin-top:6px;font-size:12px;color:#6B7280;display:flex;gap:12px;flex-wrap:wrap;">
        <span>📅 最近跟进: ${d.最近跟进 ? esc(d.最近跟进.slice(0,10)) : '无'}</span>
        <span>📅 下次跟进: ${d.下次跟进 ? esc(d.下次跟进.slice(0,10)) : '未安排'}</span>
        ${d.未完成动作数 ? `<span class="badge blue">${d.未完成动作数} 个待办未完成</span>` : ''}
      </div>
    </div>`;
    $('#pfBase').querySelectorAll('[data-seg-edit]').forEach(b => b.onclick = () => openSegmentDlg(b.dataset.segEdit, d));
    $('#pfEdit').onclick = () => editStudentDlg(a);
    $('#pfAddEnr').onclick = () => addEnrollDlg(a);
    $('#pfAddFlwBtn').onclick = () => openAddFollowModal(a.id, a.姓名);

    // 科目学情与跟进 Tab 渲染
    const enrs = d.报名 || [];
    const subjects = [...new Set(enrs.map(e => e.学科 || (String(e.班级).includes('物理') ? '物理' : '数学')))].filter(Boolean);
    if (!subjects.length) subjects.push('全科');
    const tabsBox = $('#pfFollowTabs');
    let currentTab = '全部动态';
    const renderFollowTabContent = async (tabName) => {
      const flwRes = await api.get('/api/followup/list?studentId=' + encodeURIComponent(a.id)).catch(() => ({ list: [] }));
      let list = flwRes.list || [];
      if (tabName !== '全部动态') list = list.filter(item => item.subject === tabName || item.subject === '全科');
      const box = $('#pfFollowList');
      if (!box) return;
      box.innerHTML = list.length ? `<div style="display:flex;flex-direction:column;gap:12px;">` + list.map(item => `
        <div style="background:#F9FAFB;border:1px solid #E2E8F0;border-left:4px solid #2563EB;border-radius:6px;padding:12px 14px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:#6B7280;">
            <span><b style="color:#111827;font-size:13px;">${esc(item.type)}</b> · <span class="badge blue">${esc(item.subject || '全科')}</span> 由 ${esc(item.creator || '助教')} 记录</span>
            <span>${esc(item.createdAt ? item.createdAt.slice(0, 16).replace('T', ' ') : '')}</span>
          </div>
          <div style="font-size:13.5px;color:#1F2937;line-height:1.5;">${esc(item.content)}</div>
        </div>
      `).join('') + `</div>` : `<div class="note">当前科目暂无日常沟通与学情记录，点击上方【＋ 记一条跟进】随时录入。</div>`;
    };

    if (tabsBox) {
      tabsBox.innerHTML = [`<div class="vt on" data-ftab="全部动态">全部动态</div>`].concat(subjects.map(s => `<div class="vt" data-ftab="${esc(s)}">${esc(s)}学情</div>`)).join('');
      tabsBox.querySelectorAll('[data-ftab]').forEach(tabEl => {
        tabEl.onclick = () => {
          tabsBox.querySelectorAll('[data-ftab]').forEach(t => t.classList.remove('on'));
          tabEl.classList.add('on');
          renderFollowTabContent(tabEl.dataset.ftab);
        };
      });
    }
    renderFollowTabContent('全部动态');
    renderProfileFeedback(a);
    const pfAddFb = $('#pfAddFb'); if (pfAddFb) pfAddFb.onclick = () => openFeedbackRecordDlg(a);

    const orders = d.订单 || []; $('#pfPay').innerHTML = `<div class="kv"><div class="i"><span class="l">报名次数</span>${a.次数 || (d.报名 || []).length} 次</div><div class="i"><span class="l">累计已缴</span>${d.累计缴费 ? d.累计缴费 + ' 元' : '—'}</div><div class="i"><span class="l">订单数</span>${orders.length} 条</div></div>` + (orders.length ? '<table><tr><th>下单时间</th><th>商品</th><th>金额</th><th>状态</th></tr>' + orders.map(o => `<tr><td class="muted">${esc(o.下单)}</td><td>${esc(o.商品)}</td><td>${esc(o.金额)}</td><td>${badge(o.状态, o.状态 === '已支付' ? 'free' : 'gray')}</td></tr>`).join('') + '</table>' : '<div class="note">无订单记录</div>');
    const terms = {}; (d.报名 || []).forEach(r => { (terms[r.期] = terms[r.期] || []).push(r); });
    $('#pfTerms').innerHTML = Object.keys(terms).sort().reverse().map(k => `<div class="term open"><div class="term-h"><span class="arrow">▼</span>${termDispL(k)} · ${terms[k].length} 门课</div><div class="term-b"><table><tr><th>班级</th><th>校区</th><th>老师</th><th>开课 → 结课</th><th>状态</th><th></th></tr>${terms[k].map(r => `<tr><td>${esc(r.班级)}${r.源状态 === '历史在班学生' ? ' <span class="badge gray">转出</span>' : ''}${r.作废 ? ' <span class="tg-void">已作废</span>' : ''}</td><td class="muted">${esc(r.校区)}</td><td>${esc(r.老师)}</td><td class="muted">${esc(r.开课)} → ${esc(r.结课)}</td><td>${r.作废 || r.源状态 === '历史在班学生' ? '—' : stTag(r.状态)}</td><td style="display:flex;gap:4px;flex-wrap:wrap;"><span class="btn sub sm" data-ee="${esc(r.eid || '')}">编辑</span><span class="btn sub sm" data-vd="${esc(r.eid || '')}" data-doing="${r.作废 ? '0' : '1'}" style="color:${r.作废 ? '#059669' : '#DC2626'}">${r.作废 ? '恢复' : '作废'}</span>${!r.作废 && r.状态 !== '已结课' && r.源状态 !== '历史在班学生' ? `<span class="btn sm" data-refund-eid="${esc(r.eid || '')}" data-refund-cls="${esc(r.班级 || '')}" style="background:#DC2626;color:#fff;">退费退班</span>` : ''}</td></tr>`).join('')}</table></div></div>`).join('') || '<div class="note">没有报名记录</div>';
    $('#pfTerms').querySelectorAll('[data-ee]').forEach(b => b.onclick = () => { const e = (d.报名 || []).find(x => x.eid === b.dataset.ee); if (e) editEnrollDlg(a, e); });
    $('#pfTerms').querySelectorAll('[data-vd]').forEach(b => b.onclick = () => voidEnroll(b.dataset.vd, b.dataset.doing === '1'));
    $('#pfTerms').querySelectorAll('[data-refund-eid]').forEach(b => b.onclick = () => refundEnroll(a, b.dataset.refundEid, b.dataset.refundCls));
    showPage('profile');
  }
  async function openFamily(id) {
    const d = await api.get('/api/family?id=' + encodeURIComponent(id)).catch(() => null); if (!d || !d.家庭) { location.hash = 'stu'; return; }
    const f = d.家庭, kids = d.孩子 || [], pending = d.待分配报名 || [];
    $('#famTitle').textContent = (f.sourceName || kids.map(k => k.姓名).join(' / ')) + ' · 家庭档案'; $('#famStatus').textContent = f.needsReview ? `待确认 ${pending.length} 条` : '归属已确认'; $('#famMeta').textContent = `家庭ID ${f.familyId} · 共用电话 ${f.phone || '—'} · ${kids.length} 个孩子档案`;
    $('#famKids').innerHTML = `<div class="family-kids">${kids.map(k => `<div class="kid-card"><div class="kk-name">${esc(k.姓名)}</div><div class="muted">${esc(k.年级 || '年级待确认')}</div><span class="btn sub sm" data-kid="${esc(k.id)}">打开孩子档案</span></div>`).join('')}</div>`;
    $('#famKids').querySelectorAll('[data-kid]').forEach(b => b.onclick = () => { location.hash = 'profile/' + encodeURIComponent(b.dataset.kid); });
    $('#famPendingCard').classList.toggle('hide', !pending.length); $('#famPending').innerHTML = pending.length ? '<div class="note">当前有待确认报名，请在后续家庭归属模块处理。</div>' : '<div class="note">没有待确认课程</div>';
    const orders = d.订单 || []; $('#famOrders').innerHTML = `<div class="kv"><div class="i"><span class="l">家庭累计已缴</span>${d.家庭累计缴费 ? d.家庭累计缴费 + ' 元' : '—'}</div><div class="i"><span class="l">订单数</span>${orders.length} 条</div></div>` + (orders.length ? `<table><tr><th>下单</th><th>商品</th><th>订单姓名</th><th>金额</th><th>状态</th></tr>${orders.map(o => `<tr><td class="muted">${esc(o.下单)}</td><td>${esc(o.商品)}</td><td>${esc(o.姓名)}</td><td>${esc(o.金额)}</td><td>${badge(o.状态, o.状态 === '已支付' ? 'free' : 'gray')}</td></tr>`).join('')}</table>` : '<div class="note">无订单</div>');
    showPage('family');
  }


  function renderOutlines() { const out = st.OUTLINES || {}; const sysEl = $('#olSys'); if (!sysEl) return; sysEl.innerHTML = Object.keys(out).map(s => `<option>${esc(s)}</option>`).join(''); fillTrack(); }
  function olTracks(sys) { return st.OUTLINES[sys] ? Object.keys(st.OUTLINES[sys]) : []; }
  function fillTrack() { const sys = $('#olSys').value || Object.keys(st.OUTLINES || {})[0] || ''; $('#olTrack').innerHTML = olTracks(sys).map(t => `<option>${esc(t)}</option>`).join(''); fillSeason(); }
  function fillSeason() { const sys = $('#olSys').value, tr = $('#olTrack').value; const seasons = st.OUTLINES[sys] && st.OUTLINES[sys][tr] ? Object.keys(st.OUTLINES[sys][tr]) : []; $('#olSeason').innerHTML = seasons.map(s => `<option>${esc(s)}</option>`).join(''); renderOutlineDetail(); }
  function curOutline() { return ((st.OUTLINES[$('#olSys').value] || {})[$('#olTrack').value] || {})[$('#olSeason').value] || []; }
  function renderOutlineDetail() { if (!$('#olPretty')) return; const rows = curOutline(), sys = $('#olSys').value, tr = $('#olTrack').value, se = $('#olSeason').value, seName = SEASON_NAME[se] || se; $('#olCount').textContent = `共 ${rows.length} 讲 · ${SYS_SUBJECT[sys] || ''}`; $('#olTitle').textContent = `${sys || ''} · ${tr || ''} · ${seName || ''}内容明细`; $('#olPretty').innerHTML = rows.length ? rows.map(r => `<div class="ol-row"><span class="n">第${r.n}讲</span><span><span class="t">${esc(r.topic)}</span>${r.module ? `<span class="m">${esc(r.module)}</span>` : ''}${r.desc ? `<div class="d">${esc(r.desc)}</div>` : ''}</span></div>`).join('') : '<div class="note">没有该大纲数据</div>'; }


  // 分层编辑弹窗：人工覆盖/清除（PRD 6.2）
  function openSegmentDlg(sid, profile) {
    const cur = profile || {};
    dlg('跟进分层 · ' + (cur.基本 ? cur.基本.姓名 : ''), `
      <div class="kv" style="margin-bottom:12px;">
        <div class="i"><span class="l">自动层级</span>${segBadge(cur.分层)} ${esc(cur.分层名称 || '')} · 分数 ${cur.分层分数 || 0}${cur.人工覆盖 ? ' <span class="badge" style="background:#DBEAFE;color:#1E40AF;">人工覆盖中</span>' : ''}</div>
      </div>
      ${FG('手动层级', `<select id="sg-code"><option value="">跟随系统</option>${['S', 'A', 'B', 'C'].map(x => `<option${cur.人工分层 === x ? ' selected' : ''}>${x}</option>`).join('')}<option value="NONE"${cur.人工分层 === 'NONE' ? ' selected' : ''}>不跟进</option></select>`)}
      ${FG('分层备注', `<input id="sg-note" value="${esc(cur.分层备注 || '')}" placeholder="例：每周必须沟通一次">`)}
      <div style="font-size:12px;color:#6B7280;margin-bottom:12px;">提示：手动层级为「跟随系统」时不覆盖自动结果；选择 S/A/B/C/不跟进 则人工锁定该层级。</div>
      ${dlgFoot('保存')}
    `, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const code = box.querySelector('#sg-code').value;
        const note = box.querySelector('#sg-note').value.trim();
        const res = await api.post('/api/student/segment', { studentId: sid, segmentCode: code, riskLevel: '', riskTags: [], note }).catch(() => null);
        if (!res || !res.ok) return dlgErr((res && res.错误) || '保存失败，可能分层字段迁移未执行');
        dlgClose(); toast('已保存分层设置');
        await refresh(); openProfile(sid);
      };
    });
  }

  function editStudentDlg(a) { dlg('编辑学员 · ' + a.姓名, `${FG('姓名 <b style="color:#B91C1C">*</b>', `<input id="es-name" value="${esc(a.姓名)}">`)}<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">${FG('联系电话', `<input id="es-phone" value="${esc(a.电话 || '')}">`)}${FG('年级', `<select id="es-grade"><option value=""></option>${GRADES.map(g => `<option${g === a.年级 ? ' selected' : ''}>${g}</option>`).join('')}</select>`)}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">${FG('性别', `<select id="es-sex"><option value=""></option><option${a.性别 === '男' ? ' selected' : ''}>男</option><option${a.性别 === '女' ? ' selected' : ''}>女</option></select>`)}${FG('备注', `<input id="es-note" value="${esc(a.备注 || '')}">`)}</div>${dlgFoot('保存')}`, box => { box.querySelector('#dlgCancel').onclick = dlgClose; box.querySelector('#dlgOk').onclick = async () => { const body = { id: a.id, 姓名: box.querySelector('#es-name').value.trim(), 电话: box.querySelector('#es-phone').value.trim(), 年级: box.querySelector('#es-grade').value, 性别: box.querySelector('#es-sex').value, 备注: box.querySelector('#es-note').value.trim() }; if (!body.姓名) return dlgErr('姓名必填'); const r = await api.post('/api/student/edit', body); if (!r.ok) return dlgErr(r.错误 || '保存失败'); dlgClose(); await refresh(); if (location.hash.startsWith('#profile/')) openProfile(a.id); else renderStudents(); }; }); }
  function addStudentDlg(familyId = '') {
    dlg('极简录入新学员', `
      ${FG('学生姓名 <b style="color:#B91C1C">*</b>', '<input id="ns-name" placeholder="学员姓名">')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${FG('联系电话 <b style="color:#B91C1C">*</b>', '<input id="ns-phone" placeholder="家长手机号">')}
        ${FG('就读年级', `<select id="ns-grade"><option value=""></option>${GRADES.map(g => `<option>${g}</option>`).join('')}</select>`)}
      </div>
      <div style="background:#F6F8FB;border:1px solid #E2E8F0;border-radius:8px;padding:12px;margin-top:8px;">
        <div style="font-weight:700;font-size:12.5px;color:#2563EB;margin-bottom:8px;">选择报读班级（自动带出上课时间、任课老师与校区）</div>
        ${FG('选择班级', '<input id="ns-class" list="classData" placeholder="输入或下拉选择班级全称">')}
        <div id="ns-class-preview" style="font-size:11.5px;color:#4B5563;line-height:1.6;margin-top:6px;min-height:20px;"></div>
      </div>
      ${FG('助教学员备注', '<input id="ns-note" placeholder="选填">')}
      ${dlgFoot('确认入班')}
    `, box => {
      const clsInp = box.querySelector('#ns-class');
      const prevBox = box.querySelector('#ns-class-preview');
      let autoInfo = null;

      clsInp.oninput = () => {
        const val = clsInp.value.trim();
        const found = st.SCHEDULE.find(r => (r.班级 || classRowLabel(r)) === val);
        if (found) {
          autoInfo = found;
          prevBox.innerHTML = `<span style="color:#059669;font-weight:700;">✓ 已匹配班级主档：</span> 老师: <b>${esc(found.老师 || '')}</b> | 时间: <b>${esc(found.星期 || '')} ${esc(found.时间 || '')}</b> | 教室: <b>${esc(found.校区 || '')} ${esc(found.教室 || '')}</b> | 学科: <b>${esc(found.学科 || '数学')}</b>`;
        } else {
          autoInfo = null;
          prevBox.innerHTML = val ? `<span style="color:#D97706;">未完全匹配排课矩阵，将作为普通自填班级录入</span>` : '';
        }
      };

      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const name = box.querySelector('#ns-name').value.trim();
        const phone = box.querySelector('#ns-phone').value.trim();
        const grade = box.querySelector('#ns-grade').value;
        const cls = clsInp.value.trim();
        const note = box.querySelector('#ns-note').value.trim();
        if (!name) return dlgErr('请填写学员姓名');
        if (!phone) return dlgErr('请填写家长联系电话');

        const body = {
          familyId,
          姓名: name,
          电话: phone,
          年级: grade || (autoInfo && autoInfo.年级) || '',
          备注: note
        };
        if (cls) {
          Object.assign(body, {
            班级: cls,
            开课: (autoInfo && autoInfo.开课) || todayStr(),
            结课: (autoInfo && autoInfo.结课) || '',
            老师: (autoInfo && autoInfo.老师) || '',
            校区: (autoInfo && autoInfo.校区) || '',
            学科: (autoInfo && autoInfo.学科) || (cls.includes('物理') ? '物理' : '数学'),
            课费: 0
          });
        }
        const r = await api.post('/api/student', body);
        if (!r.ok) return dlgErr(r.错误 || '保存失败');
        dlgClose();
        await refresh();
        renderStudents();
        toast('学员已成功入班保存！');
      };
    });
  }
  function addEnrollDlg(a) { dlg('新增报名 · ' + a.姓名, `${FG('班级名称 <b style="color:#B91C1C">*</b>', '<input id="ae-class" list="classData">')}${FG('开课日期', `<input id="ae-start" type="date" value="${todayStr()}">`)}${FG('结课日期', '<input id="ae-end" type="date">')}${FG('老师', '<input id="ae-teacher">')}${FG('校区', '<input id="ae-campus">')}${FG('学科', '<select id="ae-subject"><option value=""></option><option>数学</option><option>物理</option></select>')}${FG('课费', '<input id="ae-fee" type="number">')}${dlgFoot('保存')}`, box => { box.querySelector('#dlgCancel').onclick = dlgClose; box.querySelector('#dlgOk').onclick = async () => { const body = { id: a.id, 班级: box.querySelector('#ae-class').value.trim(), 开课: box.querySelector('#ae-start').value, 结课: box.querySelector('#ae-end').value, 老师: box.querySelector('#ae-teacher').value.trim(), 校区: box.querySelector('#ae-campus').value.trim(), 学科: box.querySelector('#ae-subject').value, 课费: box.querySelector('#ae-fee').value }; if (!body.班级) return dlgErr('班级名称必填'); const r = await api.post('/api/enrollment', body); if (!r.ok) return dlgErr(r.错误 || '保存失败'); dlgClose(); await refresh(); openProfile(a.id); }; }); }
  function editEnrollDlg(a, e) { dlg('编辑报名 · ' + a.姓名, `${FG('班级名称', `<input id="ee-class" value="${esc(e.班级)}" list="classData">`)}${FG('开课日期', `<input id="ee-start" type="date" value="${esc(e.开课 || '')}">`)}${FG('结课日期', `<input id="ee-end" type="date" value="${esc(e.结课 || '')}">`)}${FG('老师', `<input id="ee-teacher" value="${esc(e.老师 || '')}">`)}${FG('校区', `<input id="ee-campus" value="${esc(e.校区 || '')}">`)}${FG('学科', `<input id="ee-subject" value="${esc(e.学科 || '')}">`)}${FG('课费', `<input id="ee-fee" type="number" value="${esc(e.课费 || '')}">`)}${dlgFoot('保存')}`, box => { box.querySelector('#dlgCancel').onclick = dlgClose; box.querySelector('#dlgOk').onclick = async () => { const body = { eid: e.eid, 班级: box.querySelector('#ee-class').value.trim(), 开课: box.querySelector('#ee-start').value, 结课: box.querySelector('#ee-end').value, 老师: box.querySelector('#ee-teacher').value.trim(), 校区: box.querySelector('#ee-campus').value.trim(), 学科: box.querySelector('#ee-subject').value.trim(), 课费: box.querySelector('#ee-fee').value }; const r = await api.post('/api/enrollment/edit', body); if (!r.ok) return dlgErr(r.错误 || '保存失败'); dlgClose(); await refresh(); openProfile(a.id); }; }); }
  async function voidEnroll(eid, doing) { if (doing && !confirm('确认作废这条报名？')) return; const r = await api.post('/api/enrollment/void', { eid, 作废: doing }); if (!r.ok) return alert(r.错误 || '操作失败'); await refresh(); if (location.hash.startsWith('#profile/')) openProfile(location.hash.slice(9)); }
  function refundEnroll(student, eid, className) {
    dlg('退费退班 · ' + student.姓名, `
      <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 14px;margin-bottom:16px;color:#991B1B;font-size:13px;line-height:1.5;">
        <b>确认将 ${esc(student.姓名)} 从【${esc(className)}】退费退班？</b><br>
        退班后该学员将从此班级的在班名单中移除，报名记录标记为"退费"状态。
      </div>
      ${FG('退费原因', `<select id="rf-reason"><option>家长主动退费</option><option>课程调整</option><option>转班/转校</option><option>其他原因</option></select>`)}
      ${FG('退费金额 (元)', `<input id="rf-amount" type="number" placeholder="选填">`)}
      ${FG('备注', `<input id="rf-note" placeholder="选填">`)}
      ${dlgFoot('确认退费退班')}
    `, box => {
      box.querySelector('#dlgCancel').onclick = dlgClose;
      box.querySelector('#dlgOk').onclick = async () => {
        const reason = box.querySelector('#rf-reason').value;
        const amount = box.querySelector('#rf-amount').value;
        const note = box.querySelector('#rf-note').value.trim();
        const okBtn = box.querySelector('#dlgOk');
        if (okBtn.disabled) return;
        okBtn.disabled = true; okBtn.textContent = '处理中...';
        try {
          const r = await api.post('/api/enrollment/refund', {
            eid, studentId: student.id, studentName: student.姓名,
            className, reason, amount: amount || 0, note
          });
          if (!r.ok) { okBtn.disabled = false; okBtn.textContent = '确认退费退班'; return dlgErr(r.错误 || '操作失败'); }
          dlgClose(); toast('已成功退费退班'); await refresh();
          if (location.hash.startsWith('#profile/')) openProfile(student.id);
        } catch (e) { okBtn.disabled = false; okBtn.textContent = '确认退费退班'; dlgErr('网络异常，请重试'); }
      };
    });
  }

  async function refresh() { await Z.bootstrap.loadAllData(); renderAll(); }
  function initCommon() {
    $$('.side .ni').forEach(n => n.onclick = () => { location.hash = n.dataset.p; });
    window.onhashchange = Z.bootstrap.route;
    $('#addStuBtn') && ($('#addStuBtn').onclick = () => addStudentDlg());
    $('#newLeaveBtn') && ($('#newLeaveBtn').onclick = () => openLeaveModal());
    $('#leaveKw') && ($('#leaveKw').oninput = e => { st.filters.leaveKw = e.target.value; renderLeavePage(); });
    $('#stuSearch') && ($('#stuSearch').oninput = e => { st.filters.stuKw = e.target.value; st.PG.stu.page = 1; renderStudents(); });
    $('#stuSort') && ($('#stuSort').onchange = e => { st.filters.stuSort = e.target.value; renderStudents(); });
    $('#stuSeg') && ($('#stuSeg').onchange = () => { st.PG.stu.page = 1; renderStudents(); });
    $('#stuTerm') && ($('#stuTerm').onchange = () => { st.PG.stu.page = 1; renderStudents(); });
    $('#stuCampus') && ($('#stuCampus').onchange = () => { st.PG.stu.page = 1; renderStudents(); });
    ['schTerm', 'schType', 'schGrade', 'schSubject', 'schDay', 'schTeacher', 'schCampus'].forEach(id => $('#' + id) && ($('#' + id).onchange = () => { st.PG.sch.page = 1; renderSchedule(); }));
    $('#schKw') && ($('#schKw').oninput = () => { st.PG.sch.page = 1; renderSchedule(); });
    $('#schReset') && ($('#schReset').onclick = () => { ['schType', 'schGrade', 'schSubject', 'schTeacher', 'schCampus', 'schDay'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; }); $('#schKw').value = ''; const t = $('#schTerm'); if (t) t.value = '2026秋'; renderSchedule(); });
    $('#olSys') && ($('#olSys').onchange = fillTrack); $('#olTrack') && ($('#olTrack').onchange = fillSeason); $('#olSeason') && ($('#olSeason').onchange = renderOutlineDetail);
    $('#olCopy') && ($('#olCopy').onclick = copyOutlineMd); $('#olImg') && ($('#olImg').onclick = renderOutlineImage);
    $('#schToggleView') && ($('#schToggleView').onclick = () => {
      const isMatrix = !$('#schMatrixView').classList.contains('hide');
      $('#schMatrixView').classList.toggle('hide', isMatrix);
      $('#schListWrap').classList.toggle('hide', !isMatrix);
      $('#schToggleView').textContent = isMatrix ? '切换教室看板' : '切换列表视图';
    });
    $('#schMatrixCampus') && ($('#schMatrixCampus').onchange = renderScheduleMatrix);
    $('#schMatrixDay') && ($('#schMatrixDay').onchange = renderScheduleMatrix);
    $('#flwAddQuickBtn') && ($('#flwAddQuickBtn').onclick = () => openAddFollowModal());
    $('#flwType') && ($('#flwType').onchange = renderFollowupPage);
    $('#flwKw') && ($('#flwKw').oninput = renderFollowupPage);
    // ===== 2026-09-08 转介绍管理 =====
    $('#refAddBtn') && ($('#refAddBtn').onclick = () => openReferralDlg());
    $('#refStatus') && ($('#refStatus').onchange = renderReferralPage);
    $('#refKw') && ($('#refKw').oninput = renderReferralPage);
    // ===== 2026-09-08 工作台快捷操作与提醒 =====
    $('#qaTodo') && ($('#qaTodo').onclick = () => openTodoDlg());
    $('#qaLeave') && ($('#qaLeave').onclick = () => openLeaveModal());
    $('#qaStu') && ($('#qaStu').onclick = () => addStudentDlg());
    $('#qaFlw') && ($('#qaFlw').onclick = () => openAddFollowModal());
    $('#todoAllBtn') && ($('#todoAllBtn').onclick = () => openTodoListDlg());
    $('#homeWechatBtn') && ($('#homeWechatBtn').onclick = () => openWechatDlg());
    $('#fbBrowseBtn') && ($('#fbBrowseBtn').onclick = () => openFeedbackBrowser());
    $('#fbTeacherBtn') && ($('#fbTeacherBtn').onclick = () => openTeacherFbBoard());
    if (!window.__zjTodoTimer) {
      window.__zjTodoTimer = setInterval(() => { if (st.LOGIN_OK && !document.hidden) checkTodoReminder(); }, 10 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && st.LOGIN_OK) checkTodoReminder(); });
    }
  }
  function renderAll() {
    buildSchedMap();
    fillStuFilters(); fillSchFilters();
    const stuData = $('#stuData'); if (stuData) stuData.innerHTML = st.ROSTER.map(a => `<option value="${esc(a.id)}">${esc(a.姓名)}（${esc(a.年级 || '')} · ${esc(a.电话 || '')}）</option>`).join('');
    const classData = $('#classData'); if (classData) classData.innerHTML = [...new Set(st.ENROLL.map(x => x.班级).concat(st.SCHEDULE.map(x => x.班级 || x.课程)))].filter(Boolean).sort().map(c => `<option value="${esc(c)}">`).join('');
    renderHome(); renderStudents(); renderSchedule(); renderLeavePage(); renderOutlines(); fillMatrixFilters(); renderScheduleMatrix(); loadFollowups(); renderReferralPage();
    const stuNameData = $('#stuNameData'); if (stuNameData) stuNameData.innerHTML = st.ROSTER.map(a => `<option value="${esc(a.姓名)}">`).join('');
    setTimeout(checkTodoReminder, 1200);
  }
  function onPage(id) {
    if (id === 'leave') loadLeaves();
    if (id === 'flw') loadFollowups();
    if (id === 'ref') renderReferralPage();
    if (id === 'oln') renderOutlineDetail();
  }

  function outlineMarkdown() {
    const rows = curOutline(), sys = $('#olSys').value, tr = $('#olTrack').value, se = $('#olSeason').value, seName = SEASON_NAME[se] || se;
    const lines = [`# ${sys} · ${tr} · ${seName}内容明细`, `共 ${rows.length} 讲`];
    rows.forEach(r => {
      lines.push(`## 第${r.n}讲 ${r.module ? '【' + r.module + '】' : ''}${r.topic}`);
      if (r.desc) lines.push(r.desc);
    });
    return lines.join('\n\n');
  }
  async function copyOutlineMd() {
    if (!curOutline().length) { toast('当前无大纲数据', false); return; }
    const md = outlineMarkdown();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        const ta = document.createElement('textarea');
        ta.value = md; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      toast('大纲 Markdown 已复制');
    } catch (e) {
      toast('复制失败，请重试', false);
    }
  }
  function renderOutlineImage() {
    const rows = curOutline(), sys = $('#olSys').value, tr = $('#olTrack').value, se = $('#olSeason').value, seName = SEASON_NAME[se] || se;
    if (!rows.length) { toast('当前无大纲数据', false); return; }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const pad = 44, baseW = 760, lineH = 40;
    let totalH = 150;
    rows.forEach(r => { totalH += lineH; if (r.desc) totalH += Math.ceil(String(r.desc).length / 30) * 26 + 12; });
    canvas.width = baseW; canvas.height = totalH;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#001A35'; ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    ctx.fillText(`${sys} · ${tr} · ${seName}内容明细`, pad, 66, baseW - pad * 2);
    ctx.fillStyle = '#0046B8'; ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
    ctx.fillText(`共 ${rows.length} 讲`, pad, 100);
    let y = 128;
    rows.forEach(r => {
      ctx.fillStyle = '#0046B8'; ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
      ctx.fillText(`第${r.n}讲`, pad, y);
      ctx.fillStyle = '#0B192C'; ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
      ctx.fillText(`${r.module ? '【' + r.module + '】' : ''}${r.topic}`, pad + 70, y);
      y += lineH;
      if (r.desc) {
        ctx.fillStyle = '#5E6E85'; ctx.font = '14px "Microsoft YaHei", sans-serif';
        const text = String(r.desc);
        let line = '';
        for (const ch of text) {
          if (ctx.measureText(line + ch).width > baseW - pad * 2 && line) { ctx.fillText(line, pad + 70, y); line = ch; y += 26; }
          else line += ch;
        }
        if (line) { ctx.fillText(line, pad + 70, y); y += 10; }
      }
      y += 12;
    });
    const dataUrl = canvas.toDataURL('image/png');
    $('#olImgBox').innerHTML = `<img src="${dataUrl}" alt="大纲图片">`;
    $('#olDownload').href = dataUrl;
    $('#olDownload').setAttribute('download', `${sys}-${tr}-${seName}大纲.png`);
    $('#olImgCard').classList.remove('hide');
  }

  M.openClassByNo = function(classNo) {
    const row = st.SCHEDULE.find(r => (r.班号 || classRowLabel(r)) === classNo);
    if (row) classDetailDlg(row);
  };
  M.initCommon = initCommon;
  M.renderAll = renderAll;
  M.onPage = onPage;
  M.openProfile = openProfile;
  M.openFamily = openFamily;
})();
