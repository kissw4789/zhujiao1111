const crypto = require('crypto');
const url = require('url');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '661119';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const SESSION_COOKIE = 'zhujiao_session';
const TERM = '2026秋';

const today = () => new Date().toISOString().slice(0, 10);
const nowText = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ ok: true, ts: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return i >= 0 ? [x.slice(0, i), decodeURIComponent(x.slice(i + 1))] : [x, ''];
  }));
}
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.', 2);
  if (sign(payload) !== sig) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.ok && Date.now() - Number(data.ts || 0) < 1000 * 60 * 60 * 24 * 14;
  } catch (e) { return false; }
}
function cookieFlags(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = proto === 'https' || process.env.VERCEL === '1';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
function setSessionCookie(req, res) {
  // 不设置 Max-Age 和 Expires，使其成为标准的会话 Cookie（Session Cookie）
  // 浏览器窗口或标签页关闭后自动失效，每次新打开必须重新输入密码
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(makeSession())}; ${cookieFlags(req)}`);
}
function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 5e6) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function sb(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase 环境变量未配置');
  const endpoint = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`;
  const res = await fetch(endpoint, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch (e) { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}
const q = encodeURIComponent;
async function select(table, params = 'select=*') {
  return await sb(`${table}?${params}`);
}
async function upsert(table, rows, conflict) {
  const arr = Array.isArray(rows) ? rows : [rows];
  if (!arr.length) return [];
  return await sb(`${table}?on_conflict=${q(conflict)}`, { method: 'POST', body: JSON.stringify(arr) });
}
async function patch(table, filter, body) {
  return await sb(`${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(body) });
}

function cnStudent(s) {
  return {
    id: s.id,
    familyId: s.family_id || '',
    sourceStudentId: s.source_student_id || '',
    姓名: s.name || '',
    电话: s.phone || '',
    性别: s.gender || '',
    年级: s.grade || '',
    英文名: s.english_name || '',
    标签: s.tags || [],
    意向: s.intent || '',
    备注: s.note || '',
    家庭排序: s.family_order || 1,
    首次: s.first_date || '',
    最近: s.recent_date || '',
    次数: s.enrollment_count || 0,
    来源姓名: s.source_name || '',
    分配确认: !!s.assignment_confirmed,
    手工: !!s.is_manual,
  };
}
function cnFamily(f, kids = []) {
  return {
    familyId: f.family_id,
    phone: f.phone || '',
    sourceStudentId: f.source_student_id || '',
    sourceName: f.source_name || '',
    children: kids.map(k => k.id),
    needsReview: !!f.needs_review,
    pendingEnrollments: f.pending_enrollments || 0,
    孩子: kids.map(cnStudent),
  };
}
function cnEnrollment(e, status) {
  return {
    eid: e.eid,
    studentId: e.source_student_id || e.student_id,
    id: e.student_id || e.source_student_id,
    childId: e.student_id || '',
    familyId: e.family_id || '',
    姓名: e.student_name || '',
    电话: e.phone || '',
    班级: e.class_name || '',
    班级名称: e.class_display_name || e.class_name || '',
    年级: e.grade || '',
    学科: e.subject || '',
    学期: e.term_name || e.term || '',
    期: e.term || TERM,
    校区: e.campus || '',
    老师: e.teacher || '',
    时间: e.time_range || '',
    讲次时间: e.lecture_times || '',
    开课: e.start_date || '',
    结课: e.end_date || '',
    源状态: e.source_status || '',
    分配状态: e.assignment_status || '',
    状态: status || e.display_status || '',
    已报预招: e.capacity_text || '',
    应收: e.amount_due || 0,
    课费: e.fee_text || String(e.amount_due || ''),
    书本费: e.book_fee || 0,
    欠费: e.arrears || 0,
    作废: !!e.is_void,
    手工: !!e.is_manual,
  };
}
function cnOrder(o) {
  return {
    单号: o.order_no || o.id,
    校区: o.campus || '',
    老师: o.teacher || '',
    学期: o.term || '',
    商品: o.product || '',
    下单: o.ordered_at || '',
    支付: o.paid_at || '',
    金额: o.amount || 0,
    方式: o.payment_method || '',
    姓名: o.student_name || '',
    电话: o.phone || '',
    状态: o.payment_status || '',
    familyId: o.family_id || '',
    sourceStudentId: o.source_student_id || '',
    childId: o.child_id || '',
    分配状态: o.assignment_status || '',
  };
}
function enrStatus(e, now) {
  if (e.start_date && now < e.start_date) return '待开课';
  if (e.end_date && now > e.end_date) return '已结课';
  if (!e.start_date) return '待开课';
  return '在读';
}
function studentStatus(enrs, now) {
  if (enrs.some(e => !e.is_void && enrStatus(e, now) === '在读')) return '在读';
  if (enrs.some(e => !e.is_void && enrStatus(e, now) === '待开课')) return '待开课';
  return '已结课';
}
function normalizeTeacher(v) {
  const a = { '飞飞': '王易飞', '温温': '温佳炜', '小明': '小明老师', '小明老师': '小明老师', '小天': '陈世崇', '小树': '束亚成', '金金': '刘金鑫', '晓晓': '张梦晓', '章章': '章雪萍', '俞老师': '俞锐钦' };
  const s = String(v || '').trim().replace(/老师$/, '');
  return a[s] || a[s + '老师'] || s;
}
function normalizeSubject(v, cls = '') {
  const s = String(v || '') + String(cls || '');
  if (s.includes('物理')) return '物理';
  if (s.includes('数学') || s.includes('奥数') || s.includes('中考') || s.includes('自招') || s.includes('创新') || s.includes('尖子') || s.includes('小明')) return '数学';
  return v || '数学';
}
function classType(v) {
  const s = String(v || '');
  if (s.includes('小明班')) return '小明班';
  if (s.includes('自招')) return '自招';
  if (s.includes('中考')) return '中考';
  if (s.includes('创新')) return '创新';
  if (s.includes('尖子')) return '尖子';
  if (s.includes('奥综') || s.includes('奥数')) return '奥数';
  return '其他';
}
function gradeOfClass(v) {
  const m = String(v || '').match(/^([1-9])/);
  return m ? m[1] + '年级' : '';
}
function termOf(dateStr) {
  const y = Number(String(dateStr || '').slice(0, 4)) || 2026;
  const m = Number(String(dateStr || '').slice(5, 7));
  if (m >= 3 && m <= 5) return y + '春';
  if (m >= 6 && m <= 8) return y + '暑';
  if (m >= 9 && m <= 11) return y + '秋';
  return y + '寒';
}
function nextTerm(label) {
  const y = Number(String(label || '').slice(0, 4)) || 2026;
  const s = String(label || '').slice(4);
  const seq = ['春', '暑', '秋', '寒'];
  const i = seq.indexOf(s);
  return s === '寒' ? (y + 1) + '春' : y + (seq[i + 1] || '秋');
}
function stableId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}
async function getData() {
  const [students, families, enrollments, orders, schedule, outlines, followups, leaves, progress, familyRules, oplog] = await Promise.all([
    select('students', 'select=*&order=name.asc'),
    select('families', 'select=*'),
    select('enrollments', 'select=*&order=start_date.desc'),
    select('orders', 'select=*'),
    select('schedule_items', 'select=*'),
    select('course_outlines', 'select=*'),
    select('followups', 'select=*'),
    select('leaves', 'select=*'),
    select('class_progress', 'select=*'),
    select('family_assignment_rules', 'select=*'),
    select('op_logs', 'select=*&order=id.desc&limit=500'),
  ]);
  const studentsById = Object.fromEntries(students.map(s => [s.id, s]));
  const familiesById = Object.fromEntries(families.map(f => [f.family_id, f]));
  const enrsByStudent = {};
  enrollments.forEach(e => { if (e.student_id) (enrsByStudent[e.student_id] = enrsByStudent[e.student_id] || []).push(e); });
  return { students, families, enrollments, orders, schedule, outlines, followups, leaves, progress, familyRules, oplog, studentsById, familiesById, enrsByStudent };
}
function rosterView(d, now) {
  return d.students.map(st => {
    const es = d.enrsByStudent[st.id] || [];
    const fam = d.familiesById[st.family_id];
    const kids = d.students.filter(x => x.family_id === st.family_id);
    return {
      ...cnStudent(st),
      状态: studentStatus(es, now),
      当期: es.filter(e => !e.is_void && enrStatus(e, now) !== '已结课').map(e => ({ 班级: e.class_name, 老师: e.teacher, 期: e.term, 状态: enrStatus(e, now), 校区: e.campus })),
      累计缴费: Math.round(d.orders.filter(o => o.child_id === st.id && o.payment_status === '已支付').reduce((s, o) => s + Number(o.amount || 0), 0)),
      家庭: fam ? cnFamily(fam, kids) : null,
      同家庭人数: kids.length || 1,
    };
  });
}
function classRows(d) {
  const map = {};
  d.enrollments.forEach(e => {
    if (e.is_void || !e.class_name) return;
    const c = map[e.class_name] = map[e.class_name] || { 期: e.term, 学期: e.term_name, 班级: e.class_name, 学科: e.subject || normalizeSubject('', e.class_name), 老师: e.teacher, 校区: e.campus, 开课: e.start_date, 结课: e.end_date, 在班: [], 退出: [], 待确认: [] };
    if (!e.student_id) {
      c.待确认.push({ eid: e.eid, 原始姓名: e.student_name, 候选年级: e.grade, familyId: e.family_id, 电话: e.phone });
      return;
    }
    const st = d.studentsById[e.student_id];
    if (!st) return;
    const item = { id: st.id, 姓名: st.name, 年级: st.grade, 电话: st.phone, familyId: st.family_id, 源状态: e.source_status };
    if (e.source_status === '历史在班学生' || !e.active_in_latest) c.退出.push(item);
    else if (!c.在班.some(x => x.id === item.id)) c.在班.push(item);
  });
  return d.schedule.map(r => {
    const cls = r.class_name || r.course || '';
    const c = map[cls] || {};
    const inClass = c.在班 || [];
    return {
      来源: String(r.course || '').includes('教室租用') || r.source === '教室租用' ? '教室租用' : '课表',
      班号: r.class_no || r.schedule_id,
      星期: r.weekday || '',
      时间: r.time_range || '',
      教室: r.room || '',
      课程: r.course || cls,
      班级: cls,
      班级名: [cls],
      期: r.term || TERM,
      老师: normalizeTeacher(r.teacher || c.老师),
      老师全名: r.teacher_full_name || c.老师 || '',
      校区: r.campus || c.校区 || '',
      备注: (r.raw && r.raw.备注) || '',
      年级: r.grade || gradeOfClass(cls),
      班型: r.class_type || classType(cls),
      学科: r.subject || normalizeSubject('', cls),
      人数: inClass.length || Number(r.enrolled_count) || 0,
      在班人数: inClass.length || Number(r.enrolled_count) || 0,
      在班: inClass,
      enrolledList: inClass,
      退出: c.退出 || [],
      待确认: c.待确认 || [],
      开课: r.start_date || c.开课 || '2026-09-05',
      结课: r.end_date || c.结课 || '2027-01-17',
    };
  });
}
function homeData(d, now) {
  const cur = TERM, next = TERM;
  const active = d.enrollments.filter(e => !e.is_void && e.student_id && e.term === cur && enrStatus(e, now) !== '已结课' && e.source_status !== '历史在班学生');
  const kids = new Set(active.map(e => e.student_id));
  const classes = new Set(active.map(e => e.class_name));
  const weekDayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekDayNames[new Date().getDay()];
  return {
    今天: now,
    星期: weekday,
    当期: cur,
    招生期: next,
    看板: { 当期在读: kids.size, 当期班级: classes.size, 下期已报: 0, 下期班级: 0, 已续班人数: 0, 续班率: 0, 待拓科人数: 0 },
    今日排课: classRows(d).filter(s => s.星期 === weekday),
    待办: { 跟进到期: [] },
  };
}
function followMap(d, kind, term) {
  const out = {};
  d.followups.filter(f => f.kind === kind && (!term || f.term === term)).forEach(f => {
    out[f.student_id] = { 状态: f.status || '', 备注: f.note || '', 下次跟进: f.next_followup_date || '' };
  });
  return out;
}
function renewDetail(d, term = TERM, next = nextTerm(term)) {
  const follow = followMap(d, 'renew', term);
  const termEnr = d.enrollments.filter(e => e.term === term && !e.is_void && e.student_id);
  const nextEnr = d.enrollments.filter(e => e.term === next && !e.is_void && e.student_id);
  const nextByChild = {};
  nextEnr.forEach(e => (nextByChild[e.student_id] = nextByChild[e.student_id] || []).push(e));
  const byChild = {};
  termEnr.forEach(e => (byChild[e.student_id] = byChild[e.student_id] || []).push(e));
  const rows = Object.entries(byChild).map(([cid, es]) => {
    const st = d.studentsById[cid] || {};
    const fam = d.familiesById[st.family_id] || {};
    const ne = nextByChild[cid] || [];
    const activeThis = es.some(e => e.source_status !== '历史在班学生' && e.active_in_latest);
    const activeNext = ne.some(e => e.source_status !== '历史在班学生' && e.active_in_latest);
    const status = activeNext ? '已续班' : activeThis ? '未续班' : '流失学员';
    return {
      childId: cid,
      姓名: st.name || cid,
      电话: st.phone || '',
      年级: st.grade || '',
      家庭: fam.source_name || '',
      状态: status,
      期: ['整期'],
      本期班级: es.map(e => ({ 班级: e.class_name, 开课: e.start_date, 源状态: e.source_status })),
      下期班级: ne.map(e => ({ 班级: e.class_name, 开课: e.start_date })),
      秋季退班: false,
      仅缴费: false,
      下期已缴: 0,
      跟进: follow[cid] || { 状态: '', 备注: '', 下次跟进: '' },
    };
  });
  const summary = { 上课学员: rows.length, 已续班: rows.filter(r => r.状态 === '已续班').length, 流失学员: rows.filter(r => r.状态 === '流失学员').length, 未续班: rows.filter(r => r.状态 === '未续班').length };
  return { term, next, 汇总: summary, 分期: [{ 期: '整期', 开课: '', 人数: rows.length, 已续班: summary.已续班, 流失: summary.流失学员, 未续班: summary.未续班 }], 明细: rows, 待确认: [] };
}
function expansionDetail(d, term = TERM) {
  const follow = followMap(d, 'expansion', term);
  const rowsByKid = {};
  d.enrollments.filter(e => !e.is_void && e.student_id && ['7', '8', '9'].includes(String(e.grade || '').charAt(0))).forEach(e => {
    const st = d.studentsById[e.student_id] || {};
    const r = rowsByKid[e.student_id] = rowsByKid[e.student_id] || { childId: e.student_id, 姓名: st.name || '', 年级: st.grade || e.grade || '', 电话: st.phone || '', familyId: st.family_id || '', 数学班: [], 物理班: [], 未识别班: [], 来源期次: [] };
    const cls = { 班级: e.class_name, 期: e.term };
    const sub = normalizeSubject(e.subject, e.class_name);
    if (sub === '数学') r.数学班.push(cls);
    else if (sub === '物理') r.物理班.push(cls);
    else r.未识别班.push(cls);
    r.来源期次.push(e.term);
  });
  const rows = Object.values(rowsByKid).map(r => {
    r.数学班 = [...new Map(r.数学班.map(x => [x.期 + x.班级, x])).values()];
    r.物理班 = [...new Map(r.物理班.map(x => [x.期 + x.班级, x])).values()];
    r.未识别班 = [...new Map(r.未识别班.map(x => [x.期 + x.班级, x])).values()];
    r.状态 = r.数学班.length && r.物理班.length ? '数学物理都已报' : r.数学班.length ? '数学已报·待拓物理' : r.物理班.length ? '物理已报·待拓数学' : '学科待确认';
    r.秋季状态 = [...r.数学班, ...r.物理班].some(x => x.期 === term) ? '秋季已报名' : '秋季未报名';
    r.跟进 = follow[r.childId] || { 状态: '未联系', 备注: '', 下次跟进: '' };
    r.班级年级 = [r.年级];
    r.年级待核对 = false;
    return r;
  }).filter(r => r.状态 !== '数学物理都已报');
  return { term, 统计期次: [term], 汇总: { 总人数: rows.length, 待拓科: rows.filter(r => r.状态 !== '数学物理都已报').length, 数学单科: rows.filter(r => r.状态 === '数学已报·待拓物理').length, 物理单科: rows.filter(r => r.状态 === '物理已报·待拓数学').length, 双科: 0, 待确认归属: 0 }, 明细: rows, 待确认: [] };
}
async function log(action, detail) {
  await upsert('op_logs', { source_hash: crypto.randomBytes(10).toString('hex'), logged_at: nowText(), action, target: detail && detail.对象 || '', class_name: detail && detail.班级 || '', change: detail && detail.变更 || '', detail: detail || {} }, 'source_hash');
}
async function handlePost(p, body, d) {
  if (p === '/api/leave/record') {
    const item = { lid: stableId('L'), student_id: body.studentId || null, student_name: body.姓名 || '', class_name: body.班级 || '', leave_date: body.日期 || today(), reason: body.原因 || '', refund_amount: Number(body.折算金额 || 0), note: body.备注 || '', created_at_text: nowText(), raw: body };
    await upsert('leaves', item, 'lid');
    await log('登记请假', { 对象: body.姓名 || body.studentId || '', 班级: body.班级 || '', 变更: body.日期 || '' });
    return { ok: true, item };
  }
  if (p === '/api/leave/delete') {
    await patch('leaves', `lid=eq.${q(body.lid || '')}`, { raw: { deleted: true, deletedAt: nowText() } });
    return { ok: true };
  }
  if (p === '/api/renew/followup' || p === '/api/expansion/followup') {
    const kind = p.includes('renew') ? 'renew' : 'expansion';
    const source_key = `${kind}|${body.term || TERM}|${body.childId}`;
    const row = { kind, term: body.term || TERM, student_id: body.childId || null, status: body.状态 || '', note: body.备注 || '', next_followup_date: body.下次跟进 || '', source_key, raw: body };
    await upsert('followups', row, 'source_key');
    await log(kind === 'renew' ? '续班跟进' : '拓科跟进', { 对象: body.childId || '', 变更: body.状态 || '' });
    return { ok: true, 跟进: { 状态: row.status, 备注: row.note, 下次跟进: row.next_followup_date } };
  }
  if (p === '/api/student') {
    const id = stableId('S');
    const familyId = body.familyId || stableId('F');
    await upsert('families', { family_id: familyId, phone: body.电话 || '', source_name: body.姓名 || '', raw: body }, 'family_id');
    const st = { id, family_id: familyId, source_student_id: id, name: body.姓名 || '', phone: body.电话 || '', gender: body.性别 || '', grade: body.年级 || '', note: body.备注 || '', tags: [], is_manual: true, assignment_confirmed: true, raw: body };
    await upsert('students', st, 'id');
    if (body.班级) await createEnrollment(id, familyId, st, body);
    await log('新增学员', { 对象: body.姓名 || id, 变更: body.班级 || '' });
    return { ok: true, id, 姓名: body.姓名 || '' };
  }
  if (p === '/api/student/edit') {
    await patch('students', `id=eq.${q(body.id || '')}`, { name: body.姓名 || '', phone: body.电话 || '', gender: body.性别 || '', grade: body.年级 || '', note: body.备注 || '', updated_at: new Date().toISOString() });
    await log('编辑学员', { 对象: body.id || '', 变更: body.姓名 || '' });
    return { ok: true };
  }
  if (p === '/api/enrollment') {
    const st = d.studentsById[body.id];
    if (!st) return { ok: false, 错误: '没有这个学员' };
    const e = await createEnrollment(st.id, st.family_id, st, body);
    await log('新增报名', { 对象: st.name || st.id, 班级: body.班级 || '' });
    return { ok: true, eid: e.eid };
  }
  if (p === '/api/enrollment/edit') {
    await patch('enrollments', `eid=eq.${q(body.eid || '')}`, { class_name: body.班级 || '', class_display_name: body.班级 || '', normalized_class_name: body.班级 || '', start_date: body.开课 || '', end_date: body.结课 || '', teacher: body.老师 || '', campus: body.校区 || '', subject: body.学科 || '', fee_text: body.课费 || '', amount_due: Number(body.课费 || 0), updated_at: new Date().toISOString() });
    await log('编辑报名', { 对象: body.eid || '', 班级: body.班级 || '' });
    return { ok: true };
  }
  if (p === '/api/enrollment/void') {
    await patch('enrollments', `eid=eq.${q(body.eid || '')}`, { is_void: !!body.作废, updated_at: new Date().toISOString() });
    await log(body.作废 ? '作废报名' : '恢复报名', { 对象: body.eid || '' });
    return { ok: true };
  }
  if (p === '/api/family/assign') {
    for (const eid of body.eids || []) await patch('enrollments', `eid=eq.${q(eid)}`, { student_id: body.childId, assignment_status: '人工确认', updated_at: new Date().toISOString() });
    await log('确认家庭班级', { 对象: body.childId || '', 变更: `${(body.eids || []).length} 条报名` });
    return { ok: true, 数量: (body.eids || []).length };
  }
  return { ok: false, 错误: '当前云端版本暂不支持该操作' };
}
async function createEnrollment(studentId, familyId, st, body) {
  const cls = body.班级 || '';
  const term = termOf(body.开课 || today());
  const classId = `CLS-${crypto.createHash('sha1').update(cls + term).digest('hex').slice(0, 10)}`;
  await upsert('classes', { id: classId, class_name: cls, normalized_class_name: cls, term, grade: body.年级 || st.grade || gradeOfClass(cls), subject: body.学科 || normalizeSubject('', cls), campus: body.校区 || '', teacher: body.老师 || '', start_date: body.开课 || today(), end_date: body.结课 || '', class_type: classType(cls), raw: body, active_in_latest: true }, 'id');
  const eid = stableId('E');
  const row = { eid, student_id: studentId, source_student_id: st.source_student_id || studentId, family_id: familyId, class_id: classId, student_name: st.name || body.姓名 || '', phone: st.phone || body.电话 || '', class_name: cls, class_display_name: cls, normalized_class_name: cls, grade: body.年级 || st.grade || gradeOfClass(cls), subject: body.学科 || normalizeSubject('', cls), term, term_name: term, campus: body.校区 || '', teacher: body.老师 || '', start_date: body.开课 || today(), end_date: body.结课 || '', source_status: '界面录入', assignment_status: '已确认', display_status: '界面录入', amount_due: Number(body.课费 || 0), fee_text: body.课费 || '', is_manual: true, active_in_latest: true, raw: body };
  await upsert('enrollments', row, 'eid');
  return row;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  const u = url.parse(req.url, true);
  let p = u.pathname || '/';
  if (!p.startsWith('/api')) p = '/api' + (p.startsWith('/') ? p : '/' + p);
  p = p.replace(/\/+$/, '');
  try {
    if (p === '/api/auth/status') return send(res, isAuthed(req) ? 200 : 401, { ok: isAuthed(req) });
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!APP_PASSWORD || body.password === APP_PASSWORD) { setSessionCookie(req, res); return send(res, 200, { ok: true }); }
      return send(res, 401, { ok: false, 错误: '密码不正确' });
    }
    if (p === '/api/auth/logout') { clearSessionCookie(req, res); return send(res, 200, { ok: true }); }
    if (!isAuthed(req)) return send(res, 401, { ok: false, 错误: '请先登录' });

    const d = await getData();
    const now = today();
    if (req.method === 'POST') {
      const result = await handlePost(p, await readBody(req), d);
      return send(res, result.ok === false ? 400 : 200, result);
    }

    if (p === '/api/health') return send(res, 200, { ok: true, students: d.students.length, enrollments: d.enrollments.length, classes: d.schedule.length, families: d.families.length, supabase: !!SUPABASE_URL });
    if (p === '/api/home') return send(res, 200, homeData(d, now));
    if (p === '/api/students') return send(res, 200, rosterView(d, now));
    if (p === '/api/enrollments') return send(res, 200, d.enrollments.map(e => cnEnrollment(e, enrStatus(e, now))));
    if (p === '/api/families') return send(res, 200, d.families.map(f => cnFamily(f, d.students.filter(s => s.family_id === f.family_id))));
    if (p === '/api/classes' || p === '/api/schedule') return send(res, 200, classRows(d));
    if (p === '/api/outlines') return send(res, 200, (d.outlines.find(x => x.id === 'main') || {}).payload || {});
    if (p === '/api/state') return send(res, 200, { leaves: d.leaves, opLog: d.oplog, expansion: d.followups.filter(f => f.kind === 'expansion'), renewFollowup: d.followups.filter(f => f.kind === 'renew') });
    if (p === '/api/oplog') return send(res, 200, d.oplog.map(l => ({ 时间: l.logged_at, 动作: l.action, 对象: l.target, 班级: l.class_name, 变更: l.change, ...(l.detail || {}) })));
    if (p === '/api/leave/list') return send(res, 200, { ok: true, leaves: d.leaves.filter(x => !(x.raw && x.raw.deleted)).map(x => ({ lid: x.lid, studentId: x.student_id, 姓名: x.student_name, 班级: x.class_name, 日期: x.leave_date, 原因: x.reason, 折算金额: x.refund_amount, 备注: x.note, 创建时间: x.created_at_text || x.created_at })) });
    if (p === '/api/student') {
      const st = d.studentsById[u.query.id];
      if (!st) return send(res, 404, { ok: false, 错误: '没有这个学员' });
      const es = (d.enrsByStudent[st.id] || []).map(e => cnEnrollment(e, enrStatus(e, now)));
      const orders = d.orders.filter(o => o.child_id === st.id).map(cnOrder);
      const fam = d.familiesById[st.family_id];
      const kids = d.students.filter(s => s.family_id === st.family_id && s.id !== st.id).map(cnStudent);
      return send(res, 200, { 基本: { ...cnStudent(st), 状态: studentStatus(d.enrsByStudent[st.id] || [], now) }, 报名: es, 订单: orders, 累计缴费: Math.round(orders.filter(o => o.状态 === '已支付').reduce((a, b) => a + Number(b.金额 || 0), 0)), 家庭: fam ? cnFamily(fam, d.students.filter(s => s.family_id === fam.family_id)) : null, 同家庭: kids });
    }
    if (p === '/api/family') {
      const fam = d.familiesById[u.query.id];
      if (!fam) return send(res, 404, { ok: false, 错误: '没有这个家庭' });
      const kids = d.students.filter(s => s.family_id === fam.family_id);
      const pending = d.enrollments.filter(e => e.family_id === fam.family_id && !e.student_id).map(e => cnEnrollment(e));
      const orders = d.orders.filter(o => o.family_id === fam.family_id).map(cnOrder);
      return send(res, 200, { 家庭: cnFamily(fam, kids), 孩子: kids.map(cnStudent), 待分配报名: pending, 订单: orders, 家庭累计缴费: Math.round(orders.filter(o => o.状态 === '已支付').reduce((a, b) => a + Number(b.金额 || 0), 0)) });
    }
    if (p === '/api/renew-detail') return send(res, 200, renewDetail(d, u.query.term || TERM, u.query.next || nextTerm(u.query.term || TERM)));
    if (p === '/api/expansion') return send(res, 200, expansionDetail(d, u.query.term || TERM));
    if (p === '/api/sync/status') return send(res, 200, { running: false, stage: '云端数据库已接入；机构自动同步暂未启用', startedAt: '', finishedAt: '', ok: null, error: '', report: null });
    if (p === '/api/inbox') return send(res, 200, { 待处理: [], 台账: [] });
    if (p === '/api/materials') return send(res, 200, { 做题痕迹: [], 学情反馈: [], 老师反馈: [], 家庭共享: [], 收件箱: [] });
    if (p === '/api/reports') return send(res, 200, []);
    return send(res, 404, { ok: false, path: p, 错误: 'Not found' });
  } catch (e) {
    return send(res, 500, { ok: false, 错误: String(e && e.message || e) });
  }
};
