const crypto = require('crypto');
const url = require('url');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '661119';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const SESSION_COOKIE = 'zhujiao_session';

// 服务端运行在 UTC（Vercel），业务时间统一按北京时间展示
const CN_TZ = 8 * 60 * 60 * 1000;
const cnNowIso = () => new Date(Date.now() + CN_TZ).toISOString();
const today = () => cnNowIso().slice(0, 10);
const nowText = () => cnNowIso().slice(0, 16).replace('T', ' ');

// 当期学期：按北京时间月份自动推导（3-5春 / 6-8暑 / 9-11秋 / 12-2寒），
// 支持环境变量 TERM_OVERRIDE 强制覆盖（如跨季过渡期需要钉住旧学期）
function currentTerm() {
  const ov = String(process.env.TERM_OVERRIDE || '').trim();
  if (/^\d{4}[春暑秋寒]$/.test(ov)) return ov;
  const d = new Date(Date.now() + CN_TZ);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m >= 3 && m <= 5) return y + '春';
  if (m >= 6 && m <= 8) return y + '暑';
  if (m >= 9 && m <= 11) return y + '秋';
  return y + '寒';
}
const TERM = currentTerm();

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

// 登录防爆破：按来源 IP 做简单的失败计数与延时（Serverless 下为尽力而为）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const loginAttempts = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
}
function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { loginAttempts.delete(ip); return false; }
  return rec.count >= 10;
}
function loginHit(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = Date.now(); }
  rec.count++;
  loginAttempts.set(ip, rec);
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
// 仅"表/列不存在"(PGRST204/205/206)降级为空数组；网络错误/500/超时等真实异常向上抛（PRD 10.8）
async function selectSafe(table, params = 'select=*') {
  try {
    return await sb(`${table}?${params}`);
  } catch (e) {
    const msg = String(e && e.message || e) || '';
    const pgrst = /PGRST(20[4-6])/.test(msg) || /Could not find the (table|column)/.test(msg);
    if (pgrst) return [];
    throw e;
  }
}
async function upsert(table, rows, conflict) {
  const arr = Array.isArray(rows) ? rows : [rows];
  if (!arr.length) return [];
  return await sb(`${table}?on_conflict=${q(conflict)}`, { method: 'POST', body: JSON.stringify(arr) });
}
async function patch(table, filter, body) {
  return await sb(`${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(body) });
}
async function remove(table, filter) {
  return await sb(`${table}?${filter}`, { method: 'DELETE' });
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
    人工分层: s.segment_code || '',
    人工风险等级: s.risk_level || '',
    人工风险标签: Array.isArray(s.risk_tags) ? s.risk_tags : [],
    分层备注: s.segment_note || '',
    分层更新时间: s.segment_updated_at || '',
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
    学科: inferSubject(e.subject, e.class_name),
    学期: e.term_name || e.term || '',
    期: e.term || TERM,
    校区: e.campus || '',
    老师: e.teacher || '',
    时间: displayTime(e.weekday || '', e.time_range || '', e.start_date || ''),
    原始时间: e.time_range || '',
    讲次时间: e.lecture_times || '',
    开课: e.start_date || '',
    结课: e.end_date || '',
    源状态: e.source_status || '',
    在册: activeEnrollment(e),
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
    有效订单: validRecentOrder(o),
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
  if (s.includes('数学') || s.includes('奥数') || s.includes('奥综') || s.includes('小奥') || s.includes('中考') || s.includes('自招') || s.includes('创新') || s.includes('尖子') || s.includes('小明')) return '数学';
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
function stableId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}
function activeEnrollment(e) {
  return !!e.student_id && e.term === TERM && !e.is_void && e.active_in_latest !== false && e.source_status !== '历史在班学生';
}
function validRecentOrder(o) {
  if (o.payment_status !== '已支付') return false;
  const text = [o.term, o.product, o.ordered_at, o.paid_at].map(x => String(x || '')).join(' ');
  return text.includes('2026秋') || text.includes('2026 秋') || text.includes('秋季') || text.includes('2026暑') || text.includes('2026 暑') || text.includes('暑期') || text.includes('暑假');
}
function orderBelongsToStudent(o, st) {
  const sid = st.id;
  const sourceId = st.source_student_id || st.id;
  // 已明确归属的订单只归该学员；电话仅用于未分配订单的家庭候选
  const explicit = String(o.child_id || o.source_student_id || '').trim();
  if (explicit) return o.child_id === sid || o.source_student_id === sourceId;
  return !!(o.phone && st.phone && o.phone === st.phone);
}
function displayTime(weekday, timeRange, startDate) {
  const parts = [];
  if (startDate) parts.push(startDate);
  const tr = String(timeRange || '').trim();
  // 星期与时段去重：时段文本里已含星期则不重复拼接（修复"周日 2026-09-06 周日 13:30"式重复）
  if (weekday && !tr.includes(weekday)) parts.push(weekday);
  if (tr) {
    // 时段按逗号去重连续重复段（修复导入异常产生的"13:30-15:30,13:30-15:30,…"18连重复）
    const segs = [...new Set(tr.split(/[,，]/).map(s => s.trim()).filter(Boolean))];
    parts.push(segs.join(','));
  }
  return parts.join(' ') || '';
}
function classKey(v) {
  return String(v || '').trim().replace(/\s+/g, '').replace(/：/g, ':');
}
function followupType(v) {
  const s = String(v || '').trim();
  const map = {
    expansion: '拓科跟进',
    retention: '续班沟通',
    daily: '日常沟通',
    parent: '家长沟通',
    class: '课堂表现',
    homework: '作业反馈',
    question: '错题答疑',
    leave: '请假补课',
    stage: '阶段学情',
    first_lesson: '首课反馈',
  };
  return map[s] || s || '日常沟通';
}
function inferSubject(value, className = '') {
  const s = String(value || '').trim();
  if (s && s !== '全科' && s !== '全科综合') return normalizeSubject(s, className);
  return normalizeSubject('', className);
}
async function getData() {
  const [students, families, enrollments, orders, schedule, outlines, followups, leaves, todos, feedbacks] = await Promise.all([
    select('students', 'select=*&order=name.asc'),
    select('families', 'select=*'),
    select('enrollments', 'select=*&order=start_date.desc'),
    select('orders', 'select=*'),
    select('schedule_items', 'select=*'),
    select('course_outlines', 'select=*'),
    select('followups', 'select=*'),
    select('leaves', 'select=*'),
    // 2026-09-08 新增两张表；仅当"表/列不存在"时降级为空，网络错误/500 会抛给上层（PRD 10.8）
    selectSafe('todos', 'select=*&order=created_at.desc'),
    selectSafe('lesson_feedbacks', 'select=fid,term,lesson,lesson_title,lesson_date,student_id,student_name,class_name,teacher,subject,campus,status&order=class_name.asc'),
  ]);
  // 转介绍：仅表不存在降级为空
  const referrals = await selectSafe('referrals', 'select=*&order=created_at.desc');
  const studentsById = Object.fromEntries(students.map(s => [s.id, s]));
  const familiesById = Object.fromEntries(families.map(f => [f.family_id, f]));
  const enrsByStudent = {};
  enrollments.forEach(e => { if (e.student_id) (enrsByStudent[e.student_id] = enrsByStudent[e.student_id] || []).push(e); });
  return { students, families, enrollments, orders, schedule, outlines, followups, leaves, todos, feedbacks, referrals, studentsById, familiesById, enrsByStudent };
}
function segmentStudent(st, d, now) {
  const es = (d.enrsByStudent[st.id] || []).filter(e => !e.is_void && e.active_in_latest !== false && e.source_status !== '历史在班学生');
  const active = es.filter(activeEnrollment);
  const subjects = new Set(active.map(e => inferSubject(e.subject, e.class_name)).filter(Boolean));
  const familyKids = d.students.filter(x => x.family_id && x.family_id === st.family_id);
  const familyActiveKids = familyKids.filter(k => (d.enrsByStudent[k.id] || []).some(activeEnrollment));
  const tags = [], reasons = [], add = (code, label, points, reason) => { tags.push({ code, label }); reasons.push(reason); score += points; };
  let score = 0;
  if (subjects.size > 1) add('MULTI_SUBJECT', '多学科', 35, '当期报名涉及多个学科');
  if (active.length > 1) add('MULTI_ENROLLMENT', '多报名', 28, '当期有多个有效报名记录');
  if (familyActiveKids.length > 1) add('MULTI_CHILD_FAMILY', '多子女家庭', 30, '同一家庭有多个在读孩子');
  const gradeText = String(st.grade || '');
  if (/^[一二三四年级]|^[1-4]年级/.test(gradeText)) add('LOW_GRADE', '低年级', 18, '低年级家长需要更主动维护');
  const first = String(st.first_date || '');
  if (first && ((new Date(now) - new Date(first)) / 86400000 <= 30)) add('NEW_STUDENT', '新学员', 20, '首次报名在近30天内');
  if (es.some(e => Number(e.arrears || 0) > 0)) add('ARREARS', '存在欠费', 35, '报名记录存在欠费');
  const recentLeave = d.leaves.some(l => l.student_id === st.id && !(l.raw && l.raw.deleted) && String(l.leave_date || '') >= new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
  if (recentLeave) add('ABSENCE', '近期请假/缺课', 20, '近14天有请假或消课记录');
  if (d.familiesById[st.family_id] && d.familiesById[st.family_id].needs_review) add('FAMILY_REVIEW', '家庭待确认', 25, '家庭归属仍待确认');
  const related = d.followups.filter(f => f.student_id === st.id);
  const last = related.map(f => f.created_at || '').filter(Boolean).sort().pop() || '';
  const next = related.map(f => f.next_followup_date || (f.raw && f.raw.next_followup_date) || '').filter(Boolean).sort().pop() || '';
  if (next && next < now) add('FOLLOWUP_OVERDUE', '跟进逾期', 25, '已超过下次跟进日期');
  if (active.length && !next && !last) add('NO_NEXT_ACTION', '缺少跟进安排', 18, '当前在读但还没有跟进记录');
  const refs = d.referrals.filter(r => r.student_id === st.id || (r.student_name && r.student_name === st.name)).filter(r => !['已报名', '已流失'].includes(r.status));
  if (refs.length) add('REFERRAL_PENDING', '转介绍待处理', 25, '存在未完成的转介绍流程');
  const pendingFb = d.feedbacks.filter(f => f.student_id === st.id && f.term === TERM && f.status !== '已出反馈');
  if (pendingFb.length) add('FEEDBACK_PENDING', '反馈未完成', 20, '当前学期存在未完成反馈');
  const manualCode = st.segment_code || '';
  const autoCode = score >= 65 ? 'S' : score >= 25 ? 'A' : active.length ? 'B' : 'C';
  const labels = { S: '重点维护', A: '优先跟进', B: '常规维护', C: '低频维护' };
  const effectiveCode = manualCode || autoCode;
  return { 自动分层: autoCode, 自动分层名称: labels[autoCode], 分层: effectiveCode, 分层名称: labels[effectiveCode] || effectiveCode, 分层分数: score, 风险标签: tags, 分层依据: reasons, 最近跟进: last, 下次跟进: next, 未完成动作数: (d.todos || []).filter(t => t.student_id === st.id && t.status === '待办').length, 人工覆盖: !!manualCode };
}
function segmentationActions(st, seg, d) {
  if (!['S', 'A'].includes(seg.分层)) return [];
  const actions = [];
  const add = (rule, title, days = 0) => {
    const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const sourceKey = `seg:${st.id}:${rule}:${due.slice(0, 7)}`;
    if (!(d.todos || []).some(t => t.source_key === sourceKey || (t.raw && t.raw.source_key === sourceKey))) actions.push({ sourceKey, rule, title, due });
  };
  add('weekly_touch', `【${seg.分层名称}】${st.name} 家长触达`, 0);
  seg.风险标签.forEach(t => {
    if (t.code === 'ARREARS') add('arrears', `${st.name} 欠费核对与提醒`, 0);
    if (t.code === 'ABSENCE') add('absence', `${st.name} 请假后续/补课回访`, 1);
    if (t.code === 'FEEDBACK_PENDING') add('feedback', `${st.name} 讲次反馈催收`, 0);
    if (t.code === 'FAMILY_REVIEW') add('family_review', `${st.name} 家庭归属核对`, 0);
    if (t.code === 'NO_NEXT_ACTION') add('followup_plan', `${st.name} 补充下一步跟进安排`, 0);
  });
  return actions;
}
function rosterView(d, now) {
  return d.students.map(st => {
    const es = d.enrsByStudent[st.id] || [];
    const fam = d.familiesById[st.family_id];
    const kids = d.students.filter(x => x.family_id === st.family_id);
    return {
      ...cnStudent(st),
      状态: studentStatus(es, now),
      ...segmentStudent(st, d, now),
      当期: es.filter(activeEnrollment).map(e => ({ 班级: e.class_name, 老师: e.teacher, 期: e.term, 状态: enrStatus(e, now), 校区: e.campus, 学科: inferSubject(e.subject, e.class_name), 时间: displayTime(e.weekday || '', e.time_range || '', e.start_date || ''), 开课: e.start_date || '' })),
      累计缴费: Math.round(d.orders.filter(o => orderBelongsToStudent(o, st) && validRecentOrder(o)).reduce((s, o) => s + Number(o.amount || 0), 0)),
      家庭: fam ? cnFamily(fam, kids) : null,
      同家庭人数: kids.length || 1,
    };
  });
}
function classRows(d) {
  const map = {};
  d.enrollments.forEach(e => {
    if (e.is_void || !e.class_name) return;
    const key = classKey(e.class_name);
    const c = map[key] = map[key] || { 期: e.term, 学期: e.term_name, 班级: e.class_name, 学科: inferSubject(e.subject, e.class_name), 老师: e.teacher, 校区: e.campus, 开课: e.start_date, 结课: e.end_date, 在班: [], 退出: [], 待确认: [] };
    if (!e.student_id) {
      c.待确认.push({ eid: e.eid, 原始姓名: e.student_name, 候选年级: e.grade, familyId: e.family_id, 电话: e.phone });
      return;
    }
    const st = d.studentsById[e.student_id];
    if (!st) return;
    const item = { id: st.id, 姓名: st.name, 年级: st.grade, 电话: st.phone, familyId: st.family_id, 源状态: e.source_status, eid: e.eid };
    if (!activeEnrollment(e)) c.退出.push(item);
    else if (!c.在班.some(x => x.id === item.id)) c.在班.push(item);
  });
  const scheduleByClass = new Map();
  d.schedule.forEach(r => {
    const cls = r.class_name || r.course || '';
    const key = classKey(cls);
    if (!key) return;
    const old = scheduleByClass.get(key);
    if (!old || (r.active_in_latest && !old.active_in_latest) || (String(r.start_date || '').localeCompare(String(old.start_date || '')) >= 0)) scheduleByClass.set(key, r);
  });
  return Array.from(scheduleByClass.values()).map(r => {
    const cls = r.class_name || r.course || '';
    const c = map[classKey(cls)] || {};
    const inClass = c.在班 || [];
    const weekday = r.weekday || '';
    const timeRange = r.time_range || '';
    const startDate = r.start_date || c.开课 || '2026-09-05';
    return {
      来源: String(r.course || '').includes('教室租用') || r.source === '教室租用' ? '教室租用' : '课表',
      班号: r.class_no || r.schedule_id,
      星期: weekday,
      时间: displayTime(weekday, timeRange, startDate),
      原始时间: timeRange,
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
      学科: inferSubject(r.subject, cls),
      人数: inClass.length || Number(r.enrolled_count) || 0,
      在班人数: inClass.length || Number(r.enrolled_count) || 0,
      在班: inClass,
      enrolledList: inClass,
      退出: c.退出 || [],
      待确认: c.待确认 || [],
      开课: startDate,
      结课: r.end_date || c.结课 || '2027-01-17',
    };
  });
}
function homeData(d, now) {
  const cur = TERM;
  const active = d.enrollments.filter(activeEnrollment);
  const kids = new Set(active.map(e => e.student_id));
  const classes = new Set(active.map(e => e.class_name));
  const weekDayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekDayNames[new Date(Date.now() + CN_TZ).getUTCDay()];
  const todayClasses = classRows(d).filter(s => s.星期 === weekday);
  const todo = [];
  const followups = mapFollowups(d);
  const leaves = mapLeaves(d);
  if (leaves.length) todo.push({ type: '请假后续', count: leaves.length, text: `当前有 ${leaves.length} 条请假/退费待跟进` });
  if (followups.length) todo.push({ type: '学情跟进', count: followups.length, text: `当前有 ${followups.length} 条学情跟进记录` });
  return {
    今天: now,
    星期: weekday,
    当期: cur,
    看板: { 当期在读: active.length, 当期班级: classes.size, 去重学生: kids.size },
    今日排课: todayClasses,
    今日待办: todo,
  };
}
function mapLeaves(d) {
  return d.leaves.filter(x => !(x.raw && x.raw.deleted)).map(x => ({ lid: x.lid, studentId: x.student_id, 姓名: x.student_name, 班级: x.class_name, 日期: x.leave_date, 原因: x.reason, 折算金额: x.refund_amount, 备注: x.note, 创建时间: x.created_at_text || x.created_at }));
}
function mapFollowups(d) {
  return (d.followups || []).map(f => ({
    id: f.id,
    studentId: f.student_id,
    studentName: (d.studentsById[f.student_id] || {}).name || (f.raw && f.raw.studentName) || '',
    phone: (d.studentsById[f.student_id] || {}).phone || '',
    type: followupType(f.kind || f.status || '日常沟通'),
    subject: inferSubject(f.subject || (f.raw && f.raw.subject) || '全科', (d.studentsById[f.student_id] || {}).name || ''),
    content: f.note || '',
    createdAt: f.created_at || (f.raw && f.raw.created_at) || '',
    creator: f.creator || (f.raw && f.raw.creator) || '助教'
  }));
}
// ===== 2026-09-08 助教个人待办 =====
function mapTodos(d) {
  return (d.todos || []).map(t => ({
    tid: t.tid,
    标题: t.title || '',
    类型: t.kind || '其他',
    studentId: t.student_id || '',
    姓名: t.student_name || '',
    班级: t.class_name || '',
    备注: t.note || '',
    截止: t.due_date || '',
    提醒: t.remind_at || '',
    状态: t.status || '待办',
    完成补记: t.done_text || '',
    联动请假单: t.link_leave_lid || '',
    创建: t.created_at_text || t.created_at || '',
    完成时间: t.done_at_text || '',
  }));
}
// ===== 2026-09-08 转介绍跟进 =====
function mapReferrals(d) {
  return (d.referrals || []).map(r => ({
    rid: r.rid,
    referrer: r.referrer || '',
    referrerPhone: r.referrer_phone || '',
    studentName: r.student_name || '',
    grade: r.grade || '',
    classType: r.class_type || '',
    subject: r.subject || '',
    evalDate: r.eval_date || '',
    evalScore: r.eval_score || '',
    trialDate: r.trial_date || '',
    note: r.note || '',
    status: r.status || '待测评',
    studentId: r.student_id || '',
    remindTid: r.remind_tid || '',
    creator: r.creator || '助教',
    createdAt: r.created_at_text || r.created_at || '',
  }));
}
function feedbackMeta(d) {
  const byLesson = {};
  (d.feedbacks || []).forEach(f => {
    const L = f.lesson || '第1讲';
    const o = byLesson[L] = byLesson[L] || { lesson: L, lessonTitle: f.lesson_title || '', total: 0, byStatus: {}, classes: {}, teachers: {} };
    o.total++;
    const stt = f.status || '未标记';
    o.byStatus[stt] = (o.byStatus[stt] || 0) + 1;
    if (f.class_name) {
      const c = o.classes[f.class_name] = o.classes[f.class_name] || { total: 0, done: 0, teacher: f.teacher || '', byStatus: {} };
      c.total++;
      c.byStatus[stt] = (c.byStatus[stt] || 0) + 1;
      if (stt === '已出反馈') c.done++;
    }
    if (f.teacher) {
      const t = o.teachers[f.teacher] = o.teachers[f.teacher] || { total: 0, done: 0 };
      t.total++;
      if (stt === '已出反馈') t.done++;
    }
  });
  return Object.values(byLesson);
}
function bootstrapData(d, now) {
  return {
    home: homeData(d, now),
    students: rosterView(d, now),
    enrollments: d.enrollments.map(e => cnEnrollment(e, enrStatus(e, now))),
    families: d.families.map(f => cnFamily(f, d.students.filter(s => s.family_id === f.family_id))),
    classes: classRows(d).filter(r => r.来源 !== '教室租用' && String(r.教室 || '').trim() !== '1号' && !String(r.课程 || '').includes('租用')),
    outlines: (d.outlines.find(x => x.id === 'main') || {}).payload || {},
    leaves: mapLeaves(d),
    followups: mapFollowups(d),
    todoList: mapTodos(d),
    referrals: mapReferrals(d),
    feedbackMeta: feedbackMeta(d),
    segmentation: d.students.map(st => { const seg = segmentStudent(st, d, now); return { studentId: st.id, ...seg, actions: segmentationActions(st, seg, d) }; }),
    todos: homeData(d, now).今日待办 || [],
  };
}
async function log(action, detail) {
  await upsert('op_logs', { source_hash: crypto.randomBytes(10).toString('hex'), logged_at: nowText(), action, target: detail && detail.对象 || '', class_name: detail && detail.班级 || '', change: detail && detail.变更 || '', detail: detail || {} }, 'source_hash');
}
// 转介绍提醒:生成一条待办提醒助教。分两种情况——
// ① 已约测评/试听日期:在"约定日前一天"提醒(如周六测评→周五提醒)
// ② 尚未约定:在"本周五"提醒去约家长(测评基本安排在周末,周五必须联系家长敲定)
// 返回 { tid, remindNote } 供落库
async function linkReferralRemind(body, rid) {
  const evalDate = body.evalDate || '';
  const trialDate = body.trialDate || '';
  const dates = [evalDate, trialDate].filter(Boolean);
  let due, kind, note, targetDate;
  if (dates.length) {
    targetDate = dates[0];
    const t = new Date(targetDate + 'T00:00:00');
    t.setDate(t.getDate() - 1); // 约定日前一天提醒
    due = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    kind = dates[0] === evalDate && evalDate ? '测评' : '试听';
    note = `转介绍提醒(${kind}日 ${targetDate}),记得提醒家长`;
  } else {
    // 未约:本周五提醒去约(测评基本在周末,需周五前敲定)。今天已是周五/周六/周日 → 提醒就设在今天/尽快
    const now = new Date(Date.now() + CN_TZ);
    const day = now.getUTCDay();
    let diff = 5 - day; // 周五=5
    if (diff < 0) diff += 7;
    const d = new Date(now.getTime() + diff * 86400000);
    due = d.toISOString().slice(0, 10);
    kind = '约测评';
    note = '尚未约定测评/试听时间,周五联系家长敲定';
    targetDate = '';
  }
  const tid = stableId('T');
  const title = `【转介绍】${body.referrer || ''}介绍 ${body.studentName || ''} · ${kind === '约测评' ? '还没约测评,本周五记得联系家长约时间' : `明天${kind},记得提醒家长`}`;
  const item = {
    tid, title, kind: '跟进', student_id: body.studentId || null, student_name: body.studentName || '',
    class_name: '', note, due_date: due, remind_at: body.remindAt || '17:00',
    status: '待办', creator: '助教', created_at_text: nowText(), raw: { source: 'referral', rid },
  };
  await upsert('todos', item, 'tid');
  return { tid, evalDate: '', trialDate: '' };
}
async function handlePost(p, body, d) {
  // ===== 2026-09-08 助教个人待办 =====
  if (p === '/api/todo/record') {
    if (!body.标题) return { ok: false, 错误: '待办标题必填' };
    let sid = body.studentId || '';
    if (!sid && body.姓名) {
      const m = d.students.find(s => s.name && body.姓名 && s.name.trim() === body.姓名.trim());
      if (m) sid = m.id;
    }
    const tid = stableId('T');
    let linkLid = '';
    // 联动登记请假：勾了"同时登记请假"就直接落 leaves，学员立即变请假状态
    if (body.登记请假 && body.姓名 && body.班级) {
      linkLid = stableId('L');
      await upsert('leaves', { lid: linkLid, student_id: sid || null, student_name: body.姓名, class_name: body.班级, leave_date: body.日期 || today(), reason: body.原因 || body.备注 || '', refund_amount: Number(body.折算金额 || 0), note: '由待办联动登记', created_at_text: nowText(), raw: body }, 'lid');
      await log('登记请假', { 对象: body.姓名, 班级: body.班级, 变更: body.日期 || today() });
    }
    const item = {
      tid, title: body.标题, kind: body.类型 || '其他', student_id: sid || null, student_name: body.姓名 || '',
      class_name: body.班级 || '', note: body.备注 || '', due_date: body.截止 || today(), remind_at: body.提醒 || '',
      status: linkLid ? '已完成' : '待办', link_leave_lid: linkLid || null, done_text: linkLid ? '已联动登记请假' : '',
      done_at_text: linkLid ? nowText() : '', creator: '助教', created_at_text: nowText(), raw: body,
    };
    await upsert('todos', item, 'tid');
    await log('新增待办', { 对象: body.姓名 || body.标题, 班级: body.班级 || '', 变更: body.截止 || today() });
    return { ok: true, item: { tid, 联动请假单: linkLid } };
  }
  if (p === '/api/todo/done') {
    if (!body.tid) return { ok: false, 错误: '缺少tid' };
    await patch('todos', `tid=eq.${encodeURIComponent(body.tid)}`, { status: '已完成', done_text: body.完成补记 || '', done_at_text: nowText(), updated_at: new Date().toISOString() });
    await log('完成待办', { 对象: body.标题 || body.tid, 变更: body.完成补记 || '' });
    return { ok: true };
  }
  if (p === '/api/todo/delete') {
    if (!body.tid) return { ok: false, 错误: '缺少tid' };
    await patch('todos', `tid=eq.${encodeURIComponent(body.tid)}`, { status: '已取消', updated_at: new Date().toISOString() });
    await log('取消待办', { 对象: body.标题 || body.tid, 变更: '' });
    return { ok: true };
  }
  // ===== 2026-09-08 讲次学情反馈 =====
  if (p === '/api/feedback/record') {
    if (!body.student_name && !body.student_id) return { ok: false, 错误: '学员必填' };
    if (!body.content) return { ok: false, 错误: '反馈正文必填' };
    let sid = body.student_id || '';
    if (!sid && body.student_name) {
      const m = d.students.find(s => s.name && body.student_name && s.name.trim() === body.student_name.trim());
      if (m) sid = m.id;
    }
    const fid = body.fid || `FB-${body.term || TERM}-${body.lesson || '第1讲'}-${body.class_name || ''}-${sid || stableId('X')}`;
    const item = {
      fid, term: body.term || TERM, lesson: body.lesson || '第1讲', lesson_title: body.lesson_title || '', lesson_date: body.lesson_date || '',
      student_id: sid || null, student_name: body.student_name || '', class_name: body.class_name || '', teacher: body.teacher || '',
      grade: body.grade || '', subject: body.subject || '', campus: body.campus || '', phone: body.phone || '',
      status: body.status || '已出反馈', content: body.content || '', note: body.note || '手动录入', raw: body,
    };
    await upsert('lesson_feedbacks', item, 'fid');
    await log('录入讲次反馈', { 对象: body.student_name || sid, 班级: body.class_name || '', 变更: body.lesson || '第1讲' });
    return { ok: true, fid };
  }
  if (p === '/api/feedback/bulk') {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return { ok: false, 错误: 'rows为空' };
    if (rows.length > 500) return { ok: false, 错误: '单次最多500条' };
    const items = rows.map(r => ({
      fid: r.fid || `FB-${r.term || TERM}-${r.lesson || '第1讲'}-${r.class_name || ''}-${r.student_id || stableId('X')}`,
      term: r.term || TERM, lesson: r.lesson || '第1讲', lesson_title: r.lesson_title || '', lesson_date: r.lesson_date || '',
      student_id: r.student_id || null, student_name: r.student_name || '', class_name: r.class_name || '', teacher: r.teacher || '',
      grade: r.grade || '', subject: r.subject || '', campus: r.campus || '', phone: r.phone || '',
      status: r.status || '已出反馈', content: r.content || r.feedback_content || '', note: r.note || '', raw: r,
    }));
    // 分批upsert，避免单包过大
    let ok = 0;
    for (let i = 0; i < items.length; i += 50) {
      await upsert('lesson_feedbacks', items.slice(i, i + 50), 'fid');
      ok += Math.min(50, items.length - i);
    }
    await log('批量导入讲次反馈', { 对象: `${ok}条`, 变更: items[0] ? items[0].lesson : '' });
    return { ok: true, upserted: ok };
  }
  if (p === '/api/leave/record') {
    if (!body.姓名 || !body.班级) return { ok: false, 错误: '学员姓名与班级必填' };
    let sid = body.studentId;
    if (!sid) {
      const match = d.students.find(s => s.name === body.姓名 || (s.name && body.姓名 && s.name.trim() === body.姓名.trim()));
      if (!match) return { ok: false, 错误: '系统学员名单中不存在此学员，请确认姓名' };
      sid = match.id;
    }
    const item = { lid: stableId('L'), student_id: sid || null, student_name: body.姓名 || '', class_name: body.班级 || '', leave_date: body.日期 || today(), reason: body.原因 || '', refund_amount: Number(body.折算金额 || 0), note: body.备注 || '', created_at_text: nowText(), raw: body };
    await upsert('leaves', item, 'lid');
    await log('登记请假', { 对象: body.姓名 || sid || '', 班级: body.班级 || '', 变更: body.日期 || '' });
    return { ok: true, item };
  }
  if (p === '/api/leave/delete') {
    await patch('leaves', `lid=eq.${q(body.lid || '')}`, { raw: { deleted: true, deletedAt: nowText() } });
    return { ok: true };
  }
  if (p === '/api/followup/record') {
    const sid = body.studentId;
    if (!sid) return { ok: false, 错误: '缺少学员ID' };
    // followups 表 id 为 uuid；subject/creator 存进 raw（表结构无这两列），读取时从 raw 回退
    const row = {
      id: crypto.randomUUID(),
      student_id: sid,
      kind: body.type || '日常沟通',
      status: body.type || '日常沟通',
      note: body.content || body.note || '',
      created_at: new Date().toISOString(),
      raw: { ...body, subject: body.subject || '全科', creator: body.creator || '助教' }
    };
    await upsert('followups', row, 'id');
    await log('日常跟进', { 对象: body.studentName || sid, 变更: `${body.type || '日常沟通'}: ${(body.content || '').slice(0, 30)}` });
    return { ok: true, item: row };
  }
  if (p === '/api/enrollment/refund') {
    await patch('enrollments', `eid=eq.${q(body.eid || '')}`, { is_void: true, updated_at: new Date().toISOString() });
    // 退费退班同步落 leaves 消课台账（与请假同表，便于统一统计折算/消课金额）
    if (body.studentName || body.studentId) {
      await upsert('leaves', {
        lid: stableId('L'),
        student_id: body.studentId || null,
        student_name: body.studentName || '',
        class_name: body.className || '',
        leave_date: body.日期 || today(),
        reason: `退费退班：${body.reason || '未填原因'}`,
        refund_amount: Number(body.amount || 0),
        note: body.note || '由退费退班联动登记',
        created_at_text: nowText(),
        raw: { source: 'refund', ...body },
      }, 'lid');
    }
    await log('退费退班', { 对象: body.studentName || body.studentId || '', 班级: body.className || '', 变更: body.reason || '退费退班', reason: body.reason || '', refundAmount: body.amount || '', note: body.note || '' });
    return { ok: true };
  }
  // ===== 2026-09-08 转介绍：新建/更新，报名后归入助教流程 =====
  if (p === '/api/referral/record') {
    if (!body.referrer || !body.studentName) return { ok: false, 错误: '介绍家长与新生姓名必填' };
    const rid = stableId('R');
    // 总是生成提醒：有日期→约定日前一天提醒；无日期→本周五提醒去约
    const { tid: remindTid } = await linkReferralRemind(body, rid);
    const row = {
      rid,
      referrer: body.referrer, referrer_phone: body.referrerPhone || '',
      student_name: body.studentName, grade: body.grade || '',
      class_type: body.classType || '', subject: body.subject || '',
      eval_date: body.evalDate || '', eval_score: body.evalScore || '',
      trial_date: body.trialDate || '', note: body.note || '',
      status: body.status || '待测评', student_id: body.studentId || '',
      remind_tid: remindTid, creator: body.creator || '助教',
      created_at_text: nowText(),
    };
    await upsert('referrals', row, 'rid');
    await log('新增转介绍', { 对象: body.studentName, 变更: `介绍人:${body.referrer} 测评:${body.evalDate || '未定'}` });
    return { ok: true, item: { rid, 提醒待办: remindTid } };
  }
  if (p === '/api/referral/update') {
    if (!body.rid) return { ok: false, 错误: '缺少转介绍ID' };
    const fields = {
      referrer: body.referrer, referrer_phone: body.referrerPhone,
      student_name: body.studentName, grade: body.grade,
      class_type: body.classType, subject: body.subject,
      eval_date: body.evalDate, eval_score: body.evalScore,
      trial_date: body.trialDate, note: body.note,
      status: body.status, updated_at: new Date().toISOString(),
    };
    Object.keys(fields).forEach(k => { if (fields[k] === undefined) delete fields[k]; });
    await upsert('referrals', { rid: body.rid, ...fields }, 'rid');
    // 已报名 → 自动归入助教流程：回填正式学员 id + 在学员档案记一条跟进
    if (body.status === '已报名' && (body.studentId || body.studentName)) {
      let sid = body.studentId || '';
      if (!sid && body.studentName) {
        const m = d.students.find(s => s.name && body.studentName && s.name.trim() === body.studentName.trim());
        if (m) sid = m.id;
      }
      if (sid) {
        await upsert('referrals', { rid: body.rid, status: '已报名', student_id: sid }, 'rid');
        await upsert('followups', {
          id: crypto.randomUUID(), student_id: sid, kind: '续班沟通',
          status: '续班沟通', note: `【转介绍已报名】由 ${body.referrer || '介绍家长'} 转介绍，新生已报名，回到助教日常流程`,
          created_at: new Date().toISOString(),
          raw: { subject: '全科', creator: '助教', source: 'referral', rid: body.rid },
        }, 'id');
        await log('转介绍报名', { 对象: body.studentName || sid, 变更: `介绍人:${body.referrer || ''} 已报名归入助教流程` });
      }
    }
    await log('更新转介绍', { 对象: body.studentName || body.rid, 变更: `状态:${body.status || ''}` });
    return { ok: true };
  }
  if (p === '/api/referral/delete') {
    if (!body.rid) return { ok: false, 错误: '缺少转介绍ID' };
    const target = (d.referrals || []).find(r => r.rid === body.rid);
    // 连带删除该转介绍的提醒待办（若有）
    if (target && target.remind_tid) {
      await remove('todos', `tid=eq.${q(target.remind_tid)}`).catch(() => {});
    }
    await remove('referrals', `rid=eq.${q(body.rid)}`);
    await log('删除转介绍', { 对象: (target && target.student_name) || body.rid, 变更: '删除转介绍记录' });
    return { ok: true };
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
    const st = d.studentsById[body.id];
    if (!st) return { ok: false, 错误: '没有这个学员' };
    // 区分"未提交字段(保留旧值)"与"提交为空(明确清空)"：仅写 body 中显式提交的字段
    const upd = { updated_at: new Date().toISOString() };
    if ('姓名' in body) upd.name = body.姓名;
    if ('电话' in body) upd.phone = body.电话;
    if ('年级' in body) upd.grade = body.年级;
    if ('性别' in body) upd.gender = body.性别;
    if ('备注' in body) upd.note = body.备注;
    await patch('students', `id=eq.${q(body.id || '')}`, upd);
    // 联动同步：姓名/电话变化时，同步报名、反馈、家庭、订单的冗余字段，保证全系统同一口径
    const changed = {};
    if ('姓名' in body && body.姓名 && body.姓名 !== st.name) changed.name = body.姓名;
    if ('电话' in body && body.电话 && body.电话 !== (st.phone || '')) changed.phone = body.电话;
    if (changed.name) {
      await patch('enrollments', `student_id=eq.${q(body.id)}`, { student_name: changed.name });
      await patch('lesson_feedbacks', `student_id=eq.${q(body.id)}`, { student_name: changed.name });
      await patch('orders', `child_id=eq.${q(body.id)}`, { student_name: changed.name });
      if (st.family_id) {
        const fam = d.familiesById[st.family_id];
        if (fam && (!fam.source_name || fam.source_name === st.name)) {
          await patch('families', `family_id=eq.${q(st.family_id)}`, { source_name: changed.name });
        }
      }
    }
    if (changed.phone) {
      await patch('enrollments', `student_id=eq.${q(body.id)}`, { phone: changed.phone });
      if (st.family_id) {
        const fam = d.familiesById[st.family_id];
        if (fam) {
          await patch('families', `family_id=eq.${q(st.family_id)}`, { phone: changed.phone });
          await patch('orders', `family_id=eq.${q(st.family_id)}`, { phone: changed.phone });
        }
      }
    }
    await log('编辑学员', { 对象: body.id || '', 变更: body.姓名 || (changed.name ? `改名:${st.name}→${changed.name}` : '') });
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
    const old = d.enrollments.find(e => e.eid === body.eid);
    if (!old) return { ok: false, 错误: '没有这条报名记录' };
    const cls = body.班级 !== undefined ? (body.班级 || '') : (old.class_name || '');
    // 根据开课日期重算学期；未提供则用原有学期，保证 term 与 class 归属一致
    const term = (body.开课 && body.开课 !== old.start_date) ? termOf(body.开课) : (body.term || old.term || termOf(body.开课 || old.start_date || today()));
    const classId = body.班级 !== undefined && body.班级 !== old.class_name
      ? `CLS-${crypto.createHash('sha1').update(cls + term).digest('hex').slice(0, 10)}`
      : (old.class_id || '');
    const grade = body.年级 !== undefined ? body.年级 : old.grade;
    const subject = body.学科 !== undefined ? body.学科 : old.subject;
    const stRef = d.studentsById[old.student_id];
    const effGrade = grade || (stRef && stRef.grade) || gradeOfClass(cls);
    const effSubject = subject || normalizeSubject('', cls);
    // 同步班级主档（不存在则按稳定规则创建）
    if (classId) {
      await upsert('classes', { id: classId, class_name: cls, normalized_class_name: cls, term, grade: effGrade, subject: effSubject, campus: body.校区 !== undefined ? body.校区 : old.campus, teacher: body.老师 !== undefined ? body.老师 : old.teacher, start_date: body.开课 || old.start_date || today(), end_date: body.结课 || old.end_date || '', class_type: classType(cls), active_in_latest: true }, 'id').catch(() => {});
    }
    const patchObj = {
      class_name: cls, class_display_name: cls, normalized_class_name: cls, class_id: classId, term, term_name: term, grade: effGrade, subject: effSubject,
      start_date: body.开课 !== undefined ? body.开课 : (old.start_date || ''), end_date: body.结课 !== undefined ? body.结课 : (old.end_date || ''),
      teacher: body.老师 !== undefined ? body.老师 : (old.teacher || ''), campus: body.校区 !== undefined ? body.校区 : (old.campus || ''),
      fee_text: body.课费 !== undefined ? body.课费 : (old.fee_text || ''), amount_due: body.课费 !== undefined ? Number(body.课费 || 0) : (old.amount_due || 0),
      updated_at: new Date().toISOString(),
    };
    await patch('enrollments', `eid=eq.${q(body.eid || '')}`, patchObj);
    await log('编辑报名', { 对象: body.eid || '', 班级: cls });
    return { ok: true };
  }
  if (p === '/api/enrollment/void') {
    await patch('enrollments', `eid=eq.${q(body.eid || '')}`, { is_void: !!body.作废, updated_at: new Date().toISOString() });
    await log(body.作废 ? '作废报名' : '恢复报名', { 对象: body.eid || '' });
    return { ok: true };
  }
  // ===== 学员分层：保存/清除人工覆盖 =====
  if (p === '/api/student/segment') {
    if (!body.studentId) return { ok: false, 错误: '缺少 studentId' };
    const st = d.studentsById[body.studentId];
    if (!st) return { ok: false, 错误: '没有这个学员' };
    if (body.clear) {
      await patch('students', `id=eq.${q(body.studentId)}`, { segment_code: null, risk_level: null, risk_tags: '[]', segment_note: null, segment_updated_at: new Date().toISOString() });
      await log('清除分层覆盖', { 对象: st.name || body.studentId });
      const now = today();
      const seg = segmentStudent({ ...st, segment_code: '' }, d, now);
      return { ok: true, 人工覆盖: false, 分层: seg.分层, ...seg };
    }
    await patch('students', `id=eq.${q(body.studentId)}`, {
      segment_code: body.segmentCode || null,
      risk_level: body.riskLevel || null,
      risk_tags: JSON.stringify(body.riskTags || []),
      segment_note: body.note || null,
      segment_updated_at: new Date().toISOString(),
    });
    await log('保存分层覆盖', { 对象: st.name || body.studentId, 变更: `层级→${body.segmentCode || '跟随系统'}` });
    const now = today();
    const seg = segmentStudent({ ...st, segment_code: body.segmentCode || '' }, d, now);
    return { ok: true, 人工覆盖: true, 分层: seg.分层, ...seg };
  }
  // ===== 系统动作同步：将分层计算的待办落库（source_key 去重,批量upsert,每批≤50）=====
  if (p === '/api/segmentation/actions/sync') {
    let created = 0, existing = 0, skipped = 0;
    const nowTime = today();
    // 一次搜集所有已有 seg source_key 用于去重
    const existingKeys = new Set((d.todos || []).map(t => t.source_key || (t.raw && t.raw.source_key)).filter(Boolean));
    const batch = [];
    for (const st of d.students) {
      const seg = segmentStudent(st, d, nowTime);
      const actions = segmentationActions(st, seg, d);
      for (const act of actions) {
        if (existingKeys.has(act.sourceKey)) { existing++; continue; }
        if (!st.id) { skipped++; continue; }
        batch.push({
          tid: stableId('T'), title: act.title, kind: '跟进',
          student_id: st.id, student_name: st.name || '',
          class_name: '', note: act.rule,
          due_date: act.due, remind_at: '17:00', status: '待办',
          source_key: act.sourceKey, creator: '助教',
          created_at_text: nowText(), raw: { source: 'segmentation', rule: act.rule, source_key: act.sourceKey },
        });
        existingKeys.add(act.sourceKey);
        created++;
      }
    }
    // 批量 upsert 写入，每批 ≤50（踩坑#7：大数据量必须分批）
    for (let i = 0; i < batch.length; i += 50) {
      await upsert('todos', batch.slice(i, i + 50), 'tid').catch(() => { skipped += Math.min(50, batch.length - i); });
    }
    await log('同步分层动作', { 对象: '全部', 变更: `新增${created} 已有${existing} 跳过${skipped}` });
    return { ok: true, 新增: created, 已有: existing, 跳过: skipped };
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
      const ip = clientIp(req);
      if (loginBlocked(ip)) { await sleep(1000); return send(res, 429, { ok: false, 错误: '尝试过于频繁，请稍后再试' }); }
      if (!APP_PASSWORD || body.password === APP_PASSWORD) {
        loginAttempts.delete(ip);
        setSessionCookie(req, res);
        return send(res, 200, { ok: true });
      }
      loginHit(ip);
      await sleep(600);
      return send(res, 401, { ok: false, 错误: '密码不正确' });
    }
    if (p === '/api/auth/logout') { clearSessionCookie(req, res); return send(res, 200, { ok: true }); }
    // ===== 2026-09-08 Vercel Cron 下班前待办提醒（微信推送通道：Server酱/企业微信机器人）=====
    // 鉴权独立于会话：配置了 CRON_SECRET 则校验 Bearer 或 ?key=，否则要求已登录会话（便于手动测试）
    if (p === '/api/cron/remind' && req.method === 'GET') {
      const secret = process.env.CRON_SECRET || '';
      const authedCron = secret && (req.headers.authorization === `Bearer ${secret}` || u.query.key === secret);
      if (!authedCron && !isAuthed(req)) return send(res, 401, { ok: false, 错误: '未授权' });
      const cd = await getData();
      const nowD = today();
      const pend = (cd.todos || []).filter(t => t.status === '待办' && (t.due_date || nowD) <= nowD);
      if (!pend.length) return send(res, 200, { ok: true, pending: 0, pushed: false, msg: '无未办待办' });
      const overdue = pend.filter(t => (t.due_date || '') < nowD);
      const lines = pend.map(t => `- [${t.kind || '其他'}] ${t.title}${t.student_name ? `（${t.student_name}${t.class_name ? '/' + t.class_name : ''}）` : ''} · 截止 ${t.due_date}${(t.due_date || '') < nowD ? '【已逾期】' : ''}`);
      const title = `助教待办提醒：${pend.length}条未办${overdue.length ? `（${overdue.length}条已逾期）` : ''}`;
      const desp = `## 今日待办清单（${nowD}）\n\n${lines.join('\n')}\n\n> 打开助教工作台处理：https://zhujiao1111.vercel.app`;
      let pushed = false, channel = '', pushMsg = '';
      const sct = process.env.SCT_SENDKEY || '';
      const hook = process.env.WECHAT_WEBHOOK || '';
      try {
        if (sct) {
          const r = await fetch(`https://sctapi.ftqq.com/${sct}.send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, desp }) });
          pushed = r.ok; channel = 'serverchan'; pushMsg = await r.text().catch(() => '');
        } else if (hook) {
          const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: `**${title}**\n${lines.join('\n')}` } }) });
          pushed = r.ok; channel = 'wecom'; pushMsg = await r.text().catch(() => '');
        }
      } catch (e) { pushMsg = String(e && e.message || e); }
      await log('待办提醒推送', { 对象: `${pend.length}条未办`, 变更: pushed ? channel : '未配置推送通道' });
      return send(res, 200, { ok: true, pending: pend.length, overdue: overdue.length, pushed, channel, lines, pushMsg: String(pushMsg).slice(0, 200) });
    }
    if (!isAuthed(req)) return send(res, 401, { ok: false, 错误: '请先登录' });

    const d = await getData();
    const now = today();
    if (req.method === 'POST') {
      const result = await handlePost(p, await readBody(req), d);
      return send(res, result.ok === false ? 400 : 200, result);
    }

    if (p === '/api/health') return send(res, 200, { ok: true, students: d.students.length, enrollments: d.enrollments.length, classes: d.schedule.length, families: d.families.length, supabase: !!SUPABASE_URL });
    if (p === '/api/bootstrap') return send(res, 200, bootstrapData(d, now));
    if (p === '/api/followup/list') {
      const sid = u.query.studentId;
      let list = mapFollowups(d);
      if (sid) list = list.filter(f => f.studentId === sid);
      return send(res, 200, { ok: true, list });
    }
    if (p === '/api/leave/list') return send(res, 200, { ok: true, leaves: mapLeaves(d) });
    if (p === '/api/referral/list') return send(res, 200, { ok: true, referrals: mapReferrals(d) });
    // ===== 2026-09-08 讲次学情反馈查询（含正文，按学员/班级/讲次过滤）=====
    if (p === '/api/feedback/list') {
      let rows = await select('lesson_feedbacks', 'select=*&order=class_name.asc').catch(() => null);
      if (rows === null) return send(res, 200, { ok: true, list: [], msg: '反馈表未建，请先执行建表SQL' });
      const sid = u.query.studentId, cls = u.query.className, les = u.query.lesson;
      if (sid) rows = rows.filter(r => r.student_id === sid || (r.phone && sid === r.phone));
      if (cls) rows = rows.filter(r => r.class_name === cls);
      if (les) rows = rows.filter(r => r.lesson === les);
      // 催收看板：附带该班"应收反馈"在班人数（最新在册口径）
      let activeInClass;
      if (u.query.onlyActive && cls) {
        activeInClass = new Set(d.enrollments.filter(e => e.class_name === cls && activeEnrollment(e)).map(e => e.student_id)).size;
      }
      return send(res, 200, { ok: true, activeInClass, list: rows.map(r => ({ fid: r.fid, term: r.term, lesson: r.lesson, 讲次标题: r.lesson_title || '', 上课日期: r.lesson_date || '', studentId: r.student_id || '', 姓名: r.student_name, 班级: r.class_name, 老师: r.teacher, 学科: r.subject, 校区: r.campus, 状态: r.status, 正文: r.content || '', 备注: r.note || '' })) });
    }
    if (p === '/api/student') {
      const st = d.studentsById[u.query.id];
      if (!st) return send(res, 404, { ok: false, 错误: '没有这个学员' });
      const es = (d.enrsByStudent[st.id] || []).map(e => cnEnrollment(e, enrStatus(e, now)));
      const orders = d.orders.filter(o => orderBelongsToStudent(o, st)).map(cnOrder);
      const fam = d.familiesById[st.family_id];
      const kids = d.students.filter(s => s.family_id === st.family_id && s.id !== st.id).map(cnStudent);
      const validOrders = orders.filter(o => o.有效订单);
      const seg = segmentStudent(st, d, now);
	      return send(res, 200, { 基本: { ...cnStudent(st), 状态: studentStatus(d.enrsByStudent[st.id] || [], now) }, ...seg, 动作: segmentationActions(st, seg, d), 报名: es, 订单: orders, 有效订单: validOrders, 累计缴费: Math.round(validOrders.reduce((a, b) => a + Number(b.金额 || 0), 0)), 家庭: fam ? cnFamily(fam, d.students.filter(s => s.family_id === fam.family_id)) : null, 同家庭: kids });
    }
    if (p === '/api/family') {
      const fam = d.familiesById[u.query.id];
      if (!fam) return send(res, 404, { ok: false, 错误: '没有这个家庭' });
      const kids = d.students.filter(s => s.family_id === fam.family_id);
      const pending = d.enrollments.filter(e => e.family_id === fam.family_id && !e.student_id).map(e => cnEnrollment(e));
      const orders = d.orders.filter(o => o.family_id === fam.family_id).map(cnOrder);
      return send(res, 200, { 家庭: cnFamily(fam, kids), 孩子: kids.map(cnStudent), 待分配报名: pending, 订单: orders, 家庭累计缴费: Math.round(orders.filter(o => o.状态 === '已支付').reduce((a, b) => a + Number(b.金额 || 0), 0)) });
    }
    return send(res, 404, { ok: false, path: p, 错误: 'Not found' });
  } catch (e) {
    return send(res, 500, { ok: false, 错误: String(e && e.message || e) });
  }
};