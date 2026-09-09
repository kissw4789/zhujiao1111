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
  // 2026-09-09 统一待办工作流附带表：全部走 selectSafe，迁移未执行时降级为空，不阻塞旧功能
  const [events, adj, trans, cals, wd] = await Promise.all([
    selectSafe('todo_events', 'select=*&order=occurred_at.desc&limit=1000'),
    selectSafe('schedule_adjustments', 'select=*&order=created_at.desc'),
    selectSafe('schedule_transfers', 'select=*&order=created_at.desc'),
    selectSafe('course_calendar_dates', 'select=*&order=lesson_date.asc'),
    selectSafe('assistant_workdays', 'select=*&id=eq.main'),
  ]);
  const studentsById = Object.fromEntries(students.map(s => [s.id, s]));
  const familiesById = Object.fromEntries(families.map(f => [f.family_id, f]));
  const enrsByStudent = {};
  enrollments.forEach(e => { if (e.student_id) (enrsByStudent[e.student_id] = enrsByStudent[e.student_id] || []).push(e); });
  return { students, families, enrollments, orders, schedule, outlines, followups, leaves, todos, feedbacks, referrals, events, adj, trans, cals, wd, studentsById, familiesById, enrsByStudent };
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
  return { 自动分层: autoCode, 自动分层名称: labels[autoCode], 分层: effectiveCode, 分层名称: labels[effectiveCode] || effectiveCode, 分层分数: score, 风险标签: tags, 分层依据: reasons, 最近跟进: last, 下次跟进: next, 未完成动作数: (d.todos || []).filter(t => t.student_id === st.id && WF_ACTIVE.includes(t.status || '待处理') && activeRule(t) !== 'arrears').length, 人工覆盖: !!manualCode, segmentVersion: st.segment_version != null ? Number(st.segment_version) : 1 };
}
function segmentationActions(st, seg, d) {
  // 2026-09-09 统一待办工作流：系统动作改由 reconcileTodos 统一生成
  // （周周期 / 请假后续 / 反馈批次 / 家庭核对 / 转介绍）；费用(arrears)停用自动生成（PRD §17.6）。
  // 本函数仅保留为旧字段兼容，恒返回空数组。
  return [];
}

// ============ 2026-09-09 统一待办工作流（PRD《待办工作流与分级联动统一改造》）============
// 状态机（§17.1 五态："已顺延"是操作事件不是状态；逾期是时间属性）
const WF_ACTIVE = ['待处理', '处理中', '已暂缓'];
const WF_TERMINAL = ['已完成', '已取消'];
const WF_BIZ = {
  weekly_followup: '跟进', leave_followup: '请假与补课', fb_collect: '课程与反馈',
  adjust: '调课与转班', transfer: '调课与转班', family_check: '家庭核对', manual: '手动事项',
};
// 处理模板注册表（§8）：结果码 → 完成语义；needNext=必须填下一次行动日期；cancel=直接取消（需原因）
const WF_TPL = {
  weekly_followup: {
    results: {
      contacted_reply: { label: '已联系且家长已回复', complete: true },
      contacted_wait: { label: '已联系等待回复', complete: false, needNext: true },
      no_answer: { label: '未接通', complete: false, needNext: true },
      skip_week: { label: '本周无需继续联系', cancel: true, needReason: true },
    },
    needContent: true,
  },
  leave_followup: {
    results: {
      reminded_replay: { label: '已提醒家长观看回放', complete: true },
      arranged_makeup: { label: '已安排补课', complete: true },
      confirmed_skip: { label: '已与家长确认无需补课', complete: true },
      other_done: { label: '已完成其他请假处理', complete: true },
      wait_reply: { label: '家长暂未回复', complete: false, needNext: true },
      no_answer: { label: '未接通', complete: false, needNext: true },
    },
  },
  fb_collect: {
    results: {
      reminded_teacher: { label: '已提醒老师', complete: false, needNext: true },
      partial_done: { label: '部分反馈已补齐', complete: false, needNext: true },
      all_done: { label: '全部反馈已完成', complete: true },
      all_excused: { label: '剩余学员合理免发', complete: true, needReason: true },
    },
  },
  family_check: { results: { resolved: { label: '全部归属已确认', complete: true } }, onlyViaBiz: true },
  adjust: {
    results: {
      adjusted: { label: '已完成本次调课', complete: true },
      wait_confirm: { label: '等待家长确认', complete: false, needNext: true },
      no_slot: { label: '暂无合适时间', complete: false, needNext: true },
    },
  },
  transfer: {
    results: {
      transferred: { label: '已完成转班', complete: true },
      wait_confirm: { label: '等待家长确认', complete: false, needNext: true },
      no_capacity: { label: '目标班无名额', complete: false, needNext: true },
      hold_off: { label: '暂不调整', cancel: true, needReason: true },
    },
  },
  manual: { results: { done: { label: '已完成', complete: true } }, freeText: true },
};

// 北京时间日期工具（统一以 'T12:00:00Z' 锚定，规避时区日期错位）
function dayOf(ds) { return new Date(String(ds || today()) + 'T12:00:00Z'); }
// ISO 周键（周一为一周起点，北京时间）：{yyyy}-W{ww}
function cnWeekKey(dateStr) {
  const base = dayOf(dateStr);
  const dow = base.getUTCDay();
  const monday = new Date(base.getTime() - ((dow + 6) % 7) * 86400000);
  const thu = new Date(monday.getTime() + 3 * 86400000);
  let y = thu.getUTCFullYear();
  let week = Math.floor((monday.getTime() - Date.UTC(y, 0, 1)) / 86400000 / 7) + 1;
  if (week < 1) { y -= 1; week = Math.floor((monday.getTime() - Date.UTC(y, 0, 1)) / 86400000 / 7) + 1; }
  return `${y}-W${String(week).padStart(2, '0')}`;
}
// 周周期截止（§17.2）：默认周五 17:00；周五17:00后进入→本周日17:00；周日17:00后→本周日23:59
function weeklyDue(now) {
  const d = dayOf(now);
  const dow = d.getUTCDay();
  const nowTime = cnNowIso().slice(11, 16);
  const plus = n => new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
  const sunday = plus((7 - dow) % 7);
  if (dow === 0) return nowTime >= '17:00' ? { due: sunday, remind: '23:59' } : { due: sunday, remind: '17:00' };
  if (dow === 5 && nowTime >= '17:00') return { due: sunday, remind: '17:00' };
  if (dow === 6) return { due: sunday, remind: '17:00' };
  return { due: plus((5 - dow + 7) % 7), remind: '17:00' };
}
function fridayOfThisWeek(now) {
  const d = dayOf(now);
  return new Date(d.getTime() + ((5 - d.getUTCDay() + 7) % 7) * 86400000).toISOString().slice(0, 10);
}
// 统一处理记录（事件追加，不物理删除；requestId 幂等键）
async function appendEvent(tid, ev) {
  const row = {
    eid: stableId('EVT'), tid, event_type: ev.event_type || 'note',
    from_status: ev.from_status || null, to_status: ev.to_status || null,
    result_code: ev.result_code || null, result_note: ev.result_note || null,
    next_action_date: ev.next_action || null, old_due_date: ev.old_due || null,
    new_due_date: ev.new_due || null, link_biz_id: ev.link_biz_id || null,
    request_id: ev.request_id || null, operator: ev.operator || '助教',
    occurred_at_text: nowText(), detail: ev.detail || {},
  };
  await upsert('todo_events', row, 'eid').catch(() => {});
}
async function patchTodo(t, fields) {
  const wf = await workflowReady();
  // 未迁移时不写新列（version/current_due_date/cancel_reason 等），只更新旧列 + status/done_text
  const target = wf ? fields : stripTodoNewCols(fields);
  const base = { updated_at: new Date().toISOString() };
  if (wf) base.version = (t.version || 1) + 1;
  await patch('todos', `tid=eq.${q(t.tid)}`, { ...target, ...base });
  Object.assign(t, fields, { version: (t.version || 1) + 1 });
}
function activeRule(t) { return (t.raw && t.raw.rule) || ''; }
function tSourceKey(t) { return t.source_key || (t.raw && t.raw.source_key) || ''; }

// 周周期任务（§5.1/§17.2）：确保 S/A 学员本周实例；同周完成不补建（E02）；跨周未结束被覆盖（E05）；
// 仅因改级取消的实例可重启原 tid（E03）；source_key 唯一索引兜底并发（E01/E17）
async function ensureWeeklyTodo(stu, seg, d, now) {
  if (!['S', 'A'].includes(seg.分层)) return { created: 0 };
  const cycle = cnWeekKey(now);
  const skey = `seg:${stu.id}:weekly_followup:${cycle}`;
  const existing = (d.todos || []).find(t => tSourceKey(t) === skey);
  if (existing) {
    if ((existing.seg_snapshot || '') !== seg.分层) { try { await patchTodo(existing, { seg_snapshot: seg.分层 }); } catch (e) {} }
    return { created: 0, tid: existing.tid };
  }
  const activeWeekly = (d.todos || []).find(t => t.student_id === stu.id && (((t.raw && t.raw.template) === 'weekly_followup') || tSourceKey(t).includes(':weekly_followup:')) && WF_ACTIVE.includes(t.status || '待处理'));
  if (activeWeekly) {
    await appendEvent(activeWeekly.tid, { event_type: 'sync', to_status: activeWeekly.status, result_note: `本周（${cycle}）维护被跨周事项覆盖，不重复生成`, detail: { coveredCycle: cycle } });
    return { created: 0, covered: 1, tid: activeWeekly.tid };
  }
  const { due, remind } = weeklyDue(now);
  const reusable = (d.todos || []).find(t => t.student_id === stu.id && (((t.raw && t.raw.template) === 'weekly_followup') || tSourceKey(t).includes(':weekly_followup:')) && t.status === '已取消' && (t.cancel_reason || '') === '分级变化自动取消');
  if (reusable) {
    const from = reusable.status;
    await patchTodo(reusable, { status: '待处理', source_key: skey, cycle_key: cycle, seg_snapshot: seg.分层, due_date: due, current_due_date: due, first_due_date: due, remind_at: remind, cancel_reason: null, title: `${seg.分层}级本周跟进 · ${stu.name}`, note: `周期跟进 ${cycle}` });
    await appendEvent(reusable.tid, { event_type: 'reopen', from_status: from, to_status: '待处理', result_note: `恢复 ${seg.分层} 层级，重启原事项用于 ${cycle}`, detail: { cycle } });
    return { created: 1, reused: reusable.tid };
  }
  const tid = stableId('T');
  const row = { tid, title: `${seg.分层}级本周跟进 · ${stu.name}`, kind: '跟进', business_type: '跟进', template: 'weekly_followup', source: 'system', student_id: stu.id, student_name: stu.name || '', class_name: '', note: `周期跟进 ${cycle}`, due_date: due, remind_at: remind, status: '待处理', source_key: skey, cycle_key: cycle, seg_snapshot: seg.分层, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { cycleKey: cycle, studentId: stu.id }, raw: { source: 'system', template: 'weekly_followup', rule: 'weekly_followup', source_key: skey, cycle } };
  try {
    await writeTodoRow(row);
  } catch (e) {
    const dup = (d.todos || []).find(t => tSourceKey(t) === skey);
    if (dup) return { created: 0, tid: dup.tid };
    throw e;
  }
  await appendEvent(tid, { event_type: 'create', to_status: '待处理', detail: { cycle, due } });
  d.todos.push(row);
  return { created: 1, tid };
}

// 请假后续（§8.2/§17.4）：按条生成 leave:{lid}:followup；撤销请假自动取消未处理后续
async function syncLeaveFollowups(d, now) {
  let created = 0, cancelled = 0;
  for (const l of (d.leaves || [])) {
    if (l.raw && l.raw.deleted) continue;
    if (String(l.reason || '').startsWith('退费退班')) continue; // 退费来源不触发请假后续
    const skey = `leave:${l.lid}:followup`;
    if ((d.todos || []).some(t => tSourceKey(t) === skey)) continue;
    const due = new Date(dayOf(l.leave_date || now).getTime() + 86400000).toISOString().slice(0, 10);
    const tid = stableId('T');
    const row = { tid, title: `请假后续 · ${l.student_name || ''}（${l.leave_date || ''} 请假）`, kind: '请假', business_type: '请假与补课', template: 'leave_followup', source: 'system', student_id: l.student_id || null, student_name: l.student_name || '', class_name: l.class_name || '', note: `确认回放/补课安排（原因：${l.reason || '未填'}）`, due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { leaveId: l.lid }, raw: { source: 'system', template: 'leave_followup', rule: 'leave_followup', source_key: skey, leaveId: l.lid } };
    try { await writeTodoRow(row); } catch (e) { const dup = (d.todos || []).find(t => tSourceKey(t) === skey); if (dup) continue; throw e; }
    await appendEvent(tid, { event_type: 'create', to_status: '待处理', result_note: '请假登记联动生成后续事项' });
    d.todos.push(row);
    created++;
  }
  for (const l of (d.leaves || [])) {
    if (!(l.raw && l.raw.deleted)) continue;
    const skey = `leave:${l.lid}:followup`;
    const t = (d.todos || []).find(x => tSourceKey(x) === skey && WF_ACTIVE.includes(x.status || '待处理'));
    if (t) {
      await patchTodo(t, { status: '已取消', cancel_reason: '请假已撤销，后续事项自动取消', done_at_text: nowText() });
      await appendEvent(t.tid, { event_type: 'cancel', from_status: t.status, to_status: '已取消', result_code: 'leave_revoked', result_note: '请假撤销自动取消未处理后续' });
      cancelled++;
    }
  }
  return { created, cancelled };
}

// 反馈批次（§5.4/§8.5/E09/E10）：按 学期|班级|讲次 生成 fb_collect；应收名单来自当次有效名单快照；
// 全部完成/合理免发自动完成；反馈被撤销自动重开原事项（不建第二条）
async function syncFeedbackBatches(d, now) {
  const created = [], completed = [], reopened = [];
  const combos = {};
  (d.feedbacks || []).forEach(f => { if (!f.class_name || !f.lesson) return; const k = `${f.term || TERM}|${f.class_name}|${f.lesson}`; (combos[k] = combos[k] || []).push(f); });
  for (const key of Object.keys(combos)) {
    const [term, cls, lesson] = key.split('|');
    const rows = combos[key];
    if (rows.every(r => r.status === '周三未开课')) continue; // 尚未开课不算欠交（E09）
    const roster = [...new Set(d.enrollments.filter(e => e.class_name === cls && activeEnrollment(e)).map(e => e.student_id))];
    if (!roster.length) continue;
    const bySid = {}; roster.forEach(sid => { bySid[sid] = '待反馈'; });
    const EXCUSED = ['小明班免发', '免发未到课', '试听刚报未上', '请假缺课'];
    rows.forEach(r => { if (r.student_id && bySid[r.student_id] !== undefined) bySid[r.student_id] = r.status || '待反馈'; });
    let done = 0, excused = 0, pending = 0;
    Object.values(bySid).forEach(s => { if (s === '已出反馈') done++; else if (EXCUSED.includes(s)) excused++; else pending++; });
    const skey = `feedback:${term}:${classKey(cls)}:${lesson}:collection`;
    const existing = (d.todos || []).find(t => tSourceKey(t) === skey);
    const progress = `已反馈${done}/${done + excused + pending}${excused ? `·免发${excused}` : ''}·待${pending}`;
    if (!existing && pending > 0) {
      const due = await nextWorkdayDate(d, now);
      const tid = stableId('T');
      const row = { tid, title: `反馈催收 · ${cls} ${lesson}（待 ${pending} 人）`, kind: '反馈催收', business_type: '课程与反馈', template: 'fb_collect', source: 'system', class_name: cls, note: progress, due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { term, class: cls, lesson }, raw: { source: 'system', template: 'fb_collect', rule: 'fb_collect', source_key: skey, term, class: cls, lesson } };
      try { await writeTodoRow(row); } catch (e) { const dup = (d.todos || []).find(t => tSourceKey(t) === skey); if (dup) { existing = dup; } else throw e; }
      if (!existing) { await appendEvent(tid, { event_type: 'create', to_status: '待处理', detail: { progress } }); d.todos.push(row); created.push(skey); continue; }
    }
    if (existing) {
      if (pending === 0 && existing.status !== '已完成') {
        await patchTodo(existing, { status: '已完成', done_text: `反馈全部完成/合理免发（${progress}）`, done_at_text: nowText() });
        await appendEvent(existing.tid, { event_type: 'complete', from_status: existing.status, to_status: '已完成', result_code: 'auto_all_done', result_note: progress });
        completed.push(skey);
      } else if (pending > 0 && existing.status === '已完成') {
        await patchTodo(existing, { status: '待处理', done_text: '', done_at_text: '' });
        await appendEvent(existing.tid, { event_type: 'reopen', from_status: '已完成', to_status: '待处理', result_note: `反馈状态变化自动重开（${progress}）`, request_id: `rev-${now}` });
        reopened.push(skey);
      } else if (pending > 0 && existing.note !== progress) {
        await patchTodo(existing, { note: progress, title: `反馈催收 · ${cls} ${lesson}（待 ${pending} 人）` });
      }
    }
  }
  return { created, completed, reopened };
}

// 家庭核对（§8.6/E12/E13）：按家庭去重 + 轮次键，部分确认不结束，新问题可开新一轮
async function syncFamilyReviews(d, now) {
  let created = 0, completed = 0;
  const pendingByFam = {};
  d.enrollments.forEach(e => { if (e.family_id && !e.student_id) (pendingByFam[e.family_id] = pendingByFam[e.family_id] || []).push(e); });
  for (const fam of d.families) {
    const round = fam.review_round || 1;
    const skey = `family:${fam.family_id}:assignment_review:r${round}`;
    const existing = (d.todos || []).find(t => tSourceKey(t) === skey);
    const pend = pendingByFam[fam.family_id] || [];
    if (pend.length && !existing) {
      const due = fridayOfThisWeek(now);
      const tid = stableId('T');
      const row = { tid, title: `家庭归属确认 · ${fam.source_name || fam.family_id}（待确认 ${pend.length} 条）`, kind: '家庭核对', business_type: '家庭核对', template: 'family_check', source: 'system', note: `第 ${round} 轮核对`, due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { familyId: fam.family_id, round }, raw: { source: 'system', template: 'family_check', rule: 'family_check', source_key: skey, family_id: fam.family_id, round } };
      try { await writeTodoRow(row); } catch (e) { const dup = (d.todos || []).find(t => tSourceKey(t) === skey); if (dup) { existing = dup; } else throw e; }
      if (!existing) { await appendEvent(tid, { event_type: 'create', to_status: '待处理' }); d.todos.push(row); created++; continue; }
    }
    if (!pend.length && existing && existing.status === '待处理') {
      await patchTodo(existing, { status: '已完成', done_text: '全部待确认报名已分配', done_at_text: nowText() });
      await appendEvent(existing.tid, { event_type: 'complete', from_status: '待处理', to_status: '已完成', result_code: 'auto_resolved' });
      completed++;
    }
  }
  return { created, completed };
}

// 暂缓唤醒（§6.5/§17.1）：到达唤醒日期自动恢复暂缓前非终态
async function wakeOverdueHolds(d, now) {
  let woken = 0;
  for (const t of (d.todos || [])) {
    if (t.status !== '已暂缓') continue;
    const wake = t.wake_date || (t.raw && t.raw.wake_date) || t.next_action_date || '';
    if (wake && wake <= now) {
      const pre = (t.raw && t.raw.pre_hold_status) || '待处理';
      await patchTodo(t, { status: pre, hold_reason: null });
      await appendEvent(t.tid, { event_type: 'process', from_status: '已暂缓', to_status: pre, result_note: `到达唤醒日期 ${wake}，自动恢复` });
      woken++;
    }
  }
  return woken;
}

// 旧 seg:风险事件待办：条件解除自动关闭（不删除）；费用类保留原状态仅退出默认队列（§17.6）
async function cancelClearedRiskTodos(d, now) {
  let n = 0;
  const recentLeave = sid => d.leaves.some(l => l.student_id === sid && !(l.raw && l.raw.deleted) && !(l.raw && l.raw.source === 'refund') && String(l.leave_date || '') >= new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
  const pendingFb = sid => d.feedbacks.some(f => f.student_id === sid && f.term === TERM && f.status && f.status !== '已出反馈' && !['小明班免发', '免发未到课', '试听刚报未上', '请假缺课', '周三未开课'].includes(f.status));
  const famNeed = famId => { const f = d.familiesById[famId]; return !!(f && f.needs_review); };
  const refPending = sid => (d.referrals || []).some(r => (r.student_id === sid) && !['已报名', '已流失'].includes(r.status));
  for (const t of (d.todos || [])) {
    if (t.status !== '待处理') continue;
    const rule = activeRule(t) || String(tSourceKey(t).split(':')[2] || '');
    if (rule === 'arrears') continue;
    if (!['absence', 'feedback', 'family_review', 'referral'].includes(rule)) continue;
    let cleared = false;
    if (rule === 'absence' && !recentLeave(t.student_id)) cleared = true;
    if (rule === 'feedback' && !pendingFb(t.student_id)) cleared = true;
    if (rule === 'family_review' && !famNeed((d.studentsById[t.student_id] || {}).family_id)) cleared = true;
    if (rule === 'referral' && !refPending(t.student_id)) cleared = true;
    if (cleared) {
      await patchTodo(t, { status: '已取消', cancel_reason: '业务条件已解除，系统自动关闭', done_at_text: nowText() });
      await appendEvent(t.tid, { event_type: 'cancel', from_status: '待处理', to_status: '已取消', result_code: 'auto_condition_cleared' });
      n++;
    }
  }
  return n;
}

// 暂缓唤醒：小量且不频繁，保持串行即可（通常远小于 30s）

// 助教工作日配置（§17.5）：未配置时使用"课后次日 17:00"并明确该默认策略
let __wdCache = { t: 0, cfg: null };
async function workdayConfig(d) {
  if (Date.now() - __wdCache.t < 60000 && __wdCache.cfg) return __wdCache.cfg;
  let cfg = { workdays: [1, 2, 3, 4, 5, 6, 0], holidays: [], extra: [], configured: false };
  try {
    const rows = (d && d.wd !== undefined) ? d.wd : await selectSafe('assistant_workdays', 'select=*&id=eq.main');
    const c = rows && rows[0] && rows[0].config;
    if (c && Array.isArray(c.workdays) && c.workdays.length) { cfg = { workdays: c.workdays, holidays: c.holidays || [], extra: c.extra || [], configured: true }; }
  } catch (e) {}
  __wdCache = { t: Date.now(), cfg };
  return cfg;
}
async function nextWorkdayDate(d, now) {
  const cfg = await workdayConfig(d);
  const base = dayOf(now);
  for (let i = 1; i <= 14; i++) {
    const day = new Date(base.getTime() + i * 86400000);
    const ds = day.toISOString().slice(0, 10);
    const dow = day.getUTCDay();
    if ((cfg.holidays || []).includes(ds)) continue;
    if ((cfg.extra || []).includes(ds)) return ds;
    if ((cfg.workdays || []).includes(dow)) return ds;
  }
  return new Date(base.getTime() + 86400000).toISOString().slice(0, 10);
}

// 统一对账入口：Cron / 手动同步 / 分级保存后收敛到这一个函数（幂等）
let __wfReady = null; // 统一待办工作流迁移是否已执行（列存在性探测，进程内缓存）
async function workflowReady() {
  if (__wfReady !== null) return __wfReady;
  try {
    await sb('todos?select=tid,business_type,source,cycle_key&limit=1');
    __wfReady = true;
  } catch (e) {
    const msg = String(e && e.message || e);
    __wfReady = /PGRST(204|205|206)|Could not find the (column|field)/i.test(msg) ? false : true;
  }
  return __wfReady;
}
const WF_MIGRATE_HINT = '统一待办工作流迁移尚未执行，请先在 Supabase SQL Editor 执行 supabase/2026-09-09_统一待办工作流_一键迁移.sql（1分钟），再使用新功能';
// 状态归一：旧"待办"→"待处理"，缺省"待处理"
const normalizeWf = s => (s === '待办' ? '待处理' : (s || '待处理'));
// 新待办列：迁移未执行时回退旧表结构（只写旧列，状态映射回旧'待办'），保证老功能不瘫痪
const TODO_NEW_COLS = ['business_type', 'template', 'source', 'cycle_key', 'first_due_date', 'current_due_date', 'next_action_date', 'hold_reason', 'wake_date', 'cancel_reason', 'seg_snapshot', 'version', 'biz_ref'];
function stripTodoNewCols(r) {
  const keep = {};
  Object.keys(r || {}).forEach(k => { if (!TODO_NEW_COLS.includes(k)) keep[k] = r[k]; });
  if (r && r.status === '待处理') keep.status = '待办';
  return keep;
}
async function writeTodoRow(row) {
  const wf = await workflowReady();
  const target = wf ? row : stripTodoNewCols(row);
  await upsert('todos', target, 'tid');
  return target;
}

async function reconcileTodos(d, now, opts = {}) {
  const sum = { 唤醒: 0, 新增周期: 0, 取消周期: 0, 新增反馈批次: 0, 完成反馈批次: 0, 重开反馈批次: 0, 新增家庭核对: 0, 完成家庭核对: 0, 新增请假后续: 0, 取消请假后续: 0, 关闭失效: 0, 失败: 0 };
  try { sum.唤醒 = await wakeOverdueHolds(d, now); } catch (e) { sum.失败++; }
  const targets = opts.studentId ? (d.students || []).filter(s => s.id === opts.studentId) : (d.students || []);
  // 大批量时按批并发（Serverless 30s 预算：逐学员串行会超时；每批 25 个并行，幂等靠 source_key 唯一索引兜底）
  const BATCH = opts.studentId ? targets.length : 25;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    await Promise.all(slice.map(async (stu) => {
      try {
        const seg = segmentStudent(stu, d, now);
        const weeklies = (d.todos || []).filter(t => t.student_id === stu.id && (((t.raw && t.raw.template) === 'weekly_followup') || tSourceKey(t).includes(':weekly_followup:')));
        if (['S', 'A'].includes(seg.分层)) {
          const r = await ensureWeeklyTodo(stu, seg, d, now);
          if (r && r.created) sum.新增周期++;
        } else {
          for (const t of weeklies) {
            if (t.status === '待处理') {
              await patchTodo(t, { status: '已取消', cancel_reason: '分级变化自动取消', done_at_text: nowText() });
              await appendEvent(t.tid, { event_type: 'cancel', from_status: '待处理', to_status: '已取消', result_note: `分级调整为 ${seg.分层}，未开始的周期跟进自动取消（处理中/已暂缓及风险事项保留）` });
              sum.取消周期++;
            }
          }
        }
      } catch (e) { sum.失败++; }
    }));
  }
  if (!opts.studentId) {
    try { const r = await syncLeaveFollowups(d, now); sum.新增请假后续 = r.created; sum.取消请假后续 = r.cancelled; } catch (e) { sum.失败++; }
    try { const r = await syncFeedbackBatches(d, now); sum.新增反馈批次 = r.created.length; sum.完成反馈批次 = r.completed.length; sum.重开反馈批次 = r.reopened.length; } catch (e) { sum.失败++; }
    try { const r = await syncFamilyReviews(d, now); sum.新增家庭核对 = r.created; sum.完成家庭核对 = r.completed; } catch (e) { sum.失败++; }
    try { sum.关闭失效 = await cancelClearedRiskTodos(d, now); } catch (e) { sum.失败++; }
  }
  return sum;
}
// 单学员版本（分级保存后原子对账，PRD §7.3）
async function reconcileStudentTodos(stu, d, now) {
  const sum = { 新增: 0, 已取消: 0, 保留: 0, 失败: 0 };
  const seg = segmentStudent(stu, d, now);
  const weeklies = (d.todos || []).filter(t => t.student_id === stu.id && (((t.raw && t.raw.template) === 'weekly_followup') || tSourceKey(t).includes(':weekly_followup:')));
  if (['S', 'A'].includes(seg.分层)) {
    try { const r = await ensureWeeklyTodo(stu, seg, d, now); if (r.created) sum.新增++; else sum.保留++; } catch (e) { sum.失败++; }
  } else {
    for (const t of weeklies) {
      if (t.status === '待处理') {
        try { await patchTodo(t, { status: '已取消', cancel_reason: '分级变化自动取消', done_at_text: nowText() }); await appendEvent(t.tid, { event_type: 'cancel', from_status: '待处理', to_status: '已取消', result_note: `分级调整为 ${seg.分层}，未开始的周期跟进自动取消` }); sum.已取消++; } catch (e) { sum.失败++; }
      } else if (WF_ACTIVE.includes(t.status || '待处理')) sum.保留++;
    }
  }
  return { seg, sum };
}
// 分级保存的幂等/版本校验（§17.3）
async function segmentSaveWrapper(stu, body, d, now) {
  const ALLOWED = ['S', 'A', 'B', 'C', 'NONE'];
  const wf = await workflowReady();
  const reqId = String(body.requestId || '').trim();
  const clear = !!body.clear;
  const code = String(body.segmentCode || '').trim();
  if (!clear && code && !ALLOWED.includes(code)) return { ok: false, 错误: `未知层级 ${code}，仅允许 S/A/B/C/NONE 或跟随系统` };
  if (body.version !== undefined && Number(body.version) !== Number(stu.segment_version || 0)) return { ok: false, __status: 409, 错误: '版本冲突：该学员分层已被其他操作更新，请刷新后重试' };
  if (reqId && reqId === (stu.segment_request_id || '')) {
    const seg = segmentStudent(stu, d, now);
    return { ok: true, replayed: true, 人工覆盖: !!stu.segment_code, 分层: seg.分层, 自动分层: seg.自动分层, ...seg, 待办同步: { 新增: 0, 已取消: 0, 保留: 0, 失败: 0, 说明: '重复请求，返回原结果' } };
  }
  // 未执行迁移时：回退旧表结构（不写 segment_version 等新列），仅保存层级/标签/备注
  const upd = wf
    ? { segment_code: clear ? null : (code || null), segment_updated_at: new Date().toISOString(), segment_version: (stu.segment_version || 0) + 1, segment_request_id: reqId || null }
    : { segment_code: clear ? null : (code || null), segment_updated_at: new Date().toISOString() };
  if (!clear) { upd.risk_level = body.riskLevel || null; upd.risk_tags = JSON.stringify(body.riskTags || []); upd.segment_note = body.note || null; }
  // 取消覆盖不自动清除独立人工标签/备注（§17.3）：clear 仅清层级
  await patch('students', `id=eq.${q(body.studentId)}`, upd);
  await log(clear ? '清除分层覆盖' : '保存分层覆盖', { 对象: stu.name || body.studentId, 变更: `${clear ? '跟随系统' : ('层级→' + (code || '跟随系统'))}${reqId ? ' · req:' + reqId.slice(0, 8) : ''}` });
  const merged = { ...stu, segment_code: clear ? '' : code, segment_version: (stu.segment_version || 0) + 1 };
  let sync = null, syncErr = '';
  try { sync = await reconcileStudentTodos(merged, d, now); } catch (e) { syncErr = String(e && e.message || e); }
  const seg = segmentStudent(merged, d, now);
  if (syncErr) return { ok: false, __status: 502, 错误: `分层已保存，但待办同步失败：${syncErr}。系统不会伪装成功，请稍后重试同步（幂等不会产生重复待办）`, syncFailed: true, studentId: body.studentId };
  return { ok: true, 人工覆盖: !clear && !!code, 分层: seg.分层, 自动分层: seg.自动分层, ...seg, 待办同步: sync.sum };
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
  // ===== 2026-09-09 统一待办工作流：首页改为"今天先做什么"（PRD §11）=====
  const todos = (d.todos || []).filter(t => activeRule(t) !== 'arrears'); // 费用类退出默认队列（§17.6），历史可在排除范围查询
  const stOf = t => t.status || '待处理';
  const curDue = t => t.current_due_date || t.due_date || '';
  const nextAct = t => t.next_action_date || '';
  const isOver = t => (stOf(t) === '待处理' || stOf(t) === '处理中') && curDue(t) && curDue(t) < now;
  const dueToday = t => WF_ACTIVE.includes(stOf(t)) && curDue(t) === now;
  const holdDue = t => stOf(t) === '已暂缓' && (t.wake_date || nextAct(t)) && (t.wake_date || nextAct(t)) <= now;
  const mustDo = todos.filter(t => isOver(t) || dueToday(t) || holdDue(t));
  const end7 = new Date(Date.now() + CN_TZ + 7 * 86400000).toISOString().slice(0, 10);
  const next7 = todos.filter(t => WF_ACTIVE.includes(stOf(t)) && curDue(t) > now && curDue(t) <= end7).sort((a, b) => String(curDue(a)).localeCompare(String(curDue(b))));
  // 需要跟进的学员（进入条件，非全量 S/A，PRD §11.5）
  const needMap = {};
  const addNeed = (sid, why) => { if (sid) (needMap[sid] = needMap[sid] || []).push(why); };
  mustDo.forEach(t => addNeed(t.student_id, `待办「${t.title}」${curDue(t) < now ? '已逾期' : curDue(t) === now ? '今日到期' : '暂缓到期'}`));
  todos.filter(t => WF_ACTIVE.includes(stOf(t)) && nextAct(t) && nextAct(t) <= now && !mustDo.includes(t)).forEach(t => addNeed(t.student_id, `下次行动 ${nextAct(t)} 已到期`));
  const nextByStu = {};
  (d.followups || []).forEach(f => {
    const nx = f.next_followup_date || (f.raw && f.raw.next_followup_date) || '';
    if (nx && (!nextByStu[f.student_id] || nx < nextByStu[f.student_id])) nextByStu[f.student_id] = nx; // 取最早的未结束行动
  });
  Object.keys(nextByStu).forEach(sid => { if (nextByStu[sid] < now) addNeed(sid, `承诺跟进 ${nextByStu[sid]} 已逾期`); });
  // 分层概览（辅助入口，不充当今日任务，PRD §11.7）
  const segCount = { S: 0, A: 0, B: 0, C: 0, NONE: 0 };
  d.students.forEach(s => { const c = segmentStudent(s, d, now).分层 || ''; if (segCount[c] !== undefined) segCount[c]++; });
  // 反馈进度（可行动信息，不展示技术说明，PRD §11.6）
  const fbProgress = (feedbackMeta(d) || [])
    .map(m => {
      const clsPending = Object.entries(m.classes || {}).filter(([c, v]) => (v.done || 0) < (v.total || 0)).map(([c]) => c);
      return { lesson: m.lesson, lessonTitle: m.lessonTitle || '', done: (m.byStatus || {})['已出反馈'] || 0, total: m.total || 0, pendingClasses: clsPending };
    })
    .filter(x => x.total > 0);
  // 今日已处理（收起式区域）
  const doneToday = todos.filter(t => stOf(t) === '已完成' && String(t.done_at_text || '').slice(0, 10) === now);
  const todoLite = t => ({ tid: t.tid, 标题: t.title, 类型: t.business_type || t.kind || '手动事项', studentId: t.student_id || '', 姓名: t.student_name || '', 班级: t.class_name || '', 截止: curDue(t), 状态: stOf(t), 下次行动: nextAct(t), 备注: t.note || '' });
  return {
    今天: now,
    星期: weekday,
    当期: cur,
    看板: { 当期在读: active.length, 当期班级: classes.size, 去重学生: kids.size },
    今日排课: todayClasses,
    今日待办: [
      { type: '今天必须处理', count: mustDo.length, text: `今天必须处理 ${mustDo.length} 条（逾期 ${todos.filter(isOver).length}）` },
      { type: '已暂缓到期', count: todos.filter(holdDue).length, text: '' },
      { type: '反馈批次未收齐', count: todos.filter(t => (t.template || '') === 'fb_collect' && WF_ACTIVE.includes(stOf(t))).length, text: '' },
    ],
    今天必须处理: mustDo.map(todoLite),
    未来7天: next7.map(todoLite),
    需要跟进的学员: Object.keys(needMap).map(sid => ({ studentId: sid, name: ((d.studentsById[sid] || {}).name) || '', reasons: [...new Set(needMap[sid])].slice(0, 3) })),
    分层概览: segCount,
    反馈进度: fbProgress,
    今日已处理: doneToday.map(todoLite),
    今日已处理数: doneToday.length,
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
  const norm = s => (s === '待办' ? '待处理' : (s || '待处理'));
  return (d.todos || []).map(t => {
    const skey = tSourceKey(t);
    return {
      tid: t.tid,
      标题: t.title || '',
      类型: t.business_type || t.kind || '手动事项',
      studentId: t.student_id || '',
      姓名: t.student_name || '',
      班级: t.class_name || '',
      备注: t.note || '',
      截止: t.current_due_date || t.due_date || '',
      首次截止: t.first_due_date || t.due_date || '',
      下次行动: t.next_action_date || '',
      提醒: t.remind_at || '',
      状态: norm(t.status),
      完成补记: t.done_text || '',
      联动请假单: t.link_leave_lid || '',
      创建: t.created_at_text || t.created_at || '',
      完成时间: t.done_at_text || '',
      businessType: t.business_type || '',
      template: t.template || (t.raw && t.raw.template) || 'manual',
      source: t.source || (skey ? 'system' : 'manual'),
      cycleKey: t.cycle_key || '',
      segSnapshot: t.seg_snapshot || '',
      rule: activeRule(t),
      wakeDate: t.wake_date || '',
      holdReason: t.hold_reason || '',
      cancelReason: t.cancel_reason || '',
      version: t.version || 1,
      bizRef: t.biz_ref || {},
    };
  });
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
  (d.feedbacks || []).filter(f => !f.term || f.term === TERM).forEach(f => {
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
  const wf = await workflowReady();
  let item = {
    tid, title, kind: '跟进', student_id: body.studentId || null, student_name: body.studentName || '',
    class_name: '', note, due_date: due, remind_at: body.remindAt || '17:00',
    status: '待处理', creator: '助教', created_at_text: nowText(), raw: { source: 'referral', rid },
  };
  if (wf) item = { ...item, business_type: '跟进', template: 'manual', source: 'system', source_key: `referral:${rid}:remind`, first_due_date: due, current_due_date: due };
  await writeTodoRow(item);
  return { tid, evalDate: '', trialDate: '' };
}
async function handlePost(p, body, d) {
  const wf = await workflowReady();
  // ===== 2026-09-08 助教个人待办 =====
  if (p === '/api/todo/record') {
    if (!body.标题) return { ok: false, 错误: '待办标题必填' };
    let sid = body.studentId || '';
    if (!sid && body.姓名) {
      const m = d.students.find(s => s.name && body.姓名 && s.name.trim() === body.姓名.trim());
      if (m) sid = m.id;
    }
    // 统一登记入口（PRD §17.4）：勾选"同时登记请假"→ 落请假事实 + 创建 leaveId 绑定的后续待办（事务同一入口）
    if (body.登记请假 && body.姓名 && body.班级) {
      const lid = stableId('L');
      await upsert('leaves', { lid, student_id: sid || null, student_name: body.姓名, class_name: body.班级, leave_date: body.日期 || today(), reason: body.原因 || body.备注 || '', refund_amount: Number(body.折算金额 || 0), note: '由待办入口统一登记', created_at_text: nowText(), raw: body }, 'lid');
      await log('登记请假', { 对象: body.姓名, 班级: body.班级, 变更: body.日期 || today() });
      // 请假后续事项：leave:{lid}:followup，幂等由 source_key 唯一索引兜底
      const skey = `leave:${lid}:followup`;
      const due = new Date(dayOf(body.日期 || today()).getTime() + 86400000).toISOString().slice(0, 10);
      const t2 = {
        tid: stableId('T'), title: `请假后续 · ${body.姓名}（${body.日期 || today()} 请假）`, kind: '请假', business_type: '请假与补课', template: 'leave_followup', source: 'system',
        student_id: sid || null, student_name: body.姓名 || '', class_name: body.班级 || '', note: '确认回放/补课安排', due_date: due, remind_at: '17:00',
        status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(),
        biz_ref: { leaveId: lid }, raw: { source: 'system', template: 'leave_followup', rule: 'leave_followup', source_key: skey, leaveId: lid },
      };
      try { await writeTodoRow(t2); } catch (e) { /* 重复提交被 source_key 唯一索引拦截，幂等返回 */ }
      return { ok: true, item: { tid: t2.tid, 联动请假单: lid } };
    }
    // 手动待办：默认待处理，business_type 由类型映射
    const bizMap = { '跟进': '跟进', '请假': '请假与补课', '请假与补课': '请假与补课', '调课': '调课与转班', '调课与转班': '调课与转班', '反馈催收': '课程与反馈', '课程与反馈': '课程与反馈', '家庭核对': '家庭核对', '其他': '手动事项', '手动事项': '手动事项' };
    const biz = bizMap[body.类型] || '手动事项';
    const due = body.截止 || today();
    const tid = stableId('T');
    const item = {
      tid, title: body.标题, kind: body.类型 || '其他', business_type: biz, template: 'manual', source: 'manual',
      student_id: sid || null, student_name: body.姓名 || '', class_name: body.班级 || '', note: body.备注 || '',
      due_date: due, first_due_date: due, current_due_date: due, remind_at: body.提醒 || '', status: '待处理',
      creator: '助教', created_at_text: nowText(), raw: body,
    };
    await writeTodoRow(item);
    await appendEvent(tid, { event_type: 'create', to_status: '待处理', result_note: '手动新增待办' });
    await log('新增待办', { 对象: body.姓名 || body.标题, 班级: body.班级 || '', 变更: `${biz} · ${due}` });
    return { ok: true, item: { tid } };
  }
  if (p === '/api/todo/process') {
    // 统一处理：complete/process/snooze/hold/cancel/reopen + 模板化结果码 + requestId 幂等（PRD §12.3）
    const tid = String(body.tid || '').trim();
    if (!tid) return { ok: false, 错误: '缺少tid' };
    const todo = (d.todos || []).find(t => t.tid === tid);
    if (!todo) return { ok: false, 错误: '没有这条待办' };
    const action = String(body.action || 'complete').trim();
    const reqId = String(body.requestId || '').trim();
    // 幂等：同 tid+requestId 重放返回原结果
    if (reqId) {
      const hit = (d.events || []).filter(e => e.tid === tid && e.request_id === reqId).sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))[0];
      if (hit) return { ok: true, replayed: true, event: hit, 状态: todo.status || '待处理', tid };
    }
    const tplName = body.template || todo.template || (todo.raw && todo.raw.template) || 'manual';
    const tpl = WF_TPL[tplName];
    if (!tpl) return { ok: false, 错误: `未知处理模板 ${tplName}` };
    const from = todo.status || '待处理';
    if (WF_TERMINAL.includes(from) && action !== 'reopen') return { ok: false, 错误: `事项已${from}，如需修改请使用重开` };
    const note = String(body.resultNote || body.note || '').trim();
    const nextDate = String(body.nextDate || '').trim();
    const reason = String(body.reason || '').trim();
    let to = from, fields = {}, evExtra = {}, def = null;
    if (action === 'complete' || action === 'process') {
      const rc = String(body.resultCode || '').trim();
      def = tpl.results[rc];
      if (!def) return { ok: false, 错误: `模板 ${tplName} 不支持结果码 ${rc || '(空)'}` };
      if (tpl.needContent && !note) return { ok: false, 错误: '跟进内容必填' };
      if (def.cancel) {
        if (!def.needReason || !reason) return { ok: false, 错误: `「${def.label}」属于人工豁免/取消，必须写明原因` };
        to = '已取消'; fields = { status: to, cancel_reason: reason, done_at_text: nowText() };
      } else if (action === 'process' || !def.complete) {
        if (def.needNext && !nextDate) return { ok: false, 错误: `「${def.label}」必须填写下一次行动日期` };
        to = def.complete && action === 'process' ? '已完成' : '处理中';
        fields = { status: to, next_action_date: nextDate || todo.next_action_date || null, done_at_text: to === '已完成' ? nowText() : (todo.done_at_text || '') };
      } else {
        to = '已完成'; fields = { status: to, done_text: `${def.label}${note ? ' · ' + note : ''}`, done_at_text: nowText(), next_action_date: nextDate || null };
      }
      // 周期跟进：有效沟通写 followups 业务事实（§8.1）
      if (tplName === 'weekly_followup' && (def.complete || rc === 'contacted_wait' || rc === 'no_answer') && note) {
        const fr = { id: crypto.randomUUID(), student_id: todo.student_id, kind: '家长沟通', status: '家长沟通', note, created_at: new Date().toISOString(), raw: { subject: '全科', creator: '助教', source: 'todo', tid, cycleKey: todo.cycle_key || '', resultCode: rc } };
        await upsert('followups', fr, 'id');
        evExtra.link_biz_id = fr.id;
        (d.followups || []).push(fr);
      }
      // 请假后续完成时回写 leaves 处理备注（业务事实保留）
      if (tplName === 'leave_followup' && to === '已完成' && todo.biz_ref && todo.biz_ref.leaveId) {
        await patch('leaves', `lid=eq.${q(todo.biz_ref.leaveId)}`, { note: `请假后续已处理：${def.label}` }).catch(() => {});
      }
    } else if (action === 'snooze') {
      if (!body.newDate) return { ok: false, 错误: '顺延必须填写新截止日期' };
      if (!reason) return { ok: false, 错误: '顺延必须填写原因' };
      to = from;
      fields = { current_due_date: body.newDate, remind_at: body.remindAt || todo.remind_at || '17:00' };
      evExtra = { old_due: todo.current_due_date || todo.due_date || '', new_due: body.newDate, result_note: reason };
    } else if (action === 'hold') {
      if (!body.wakeDate) return { ok: false, 错误: '暂缓必须填写唤醒日期' };
      if (!reason) return { ok: false, 错误: '暂缓必须填写原因' };
      to = '已暂缓';
      fields = { status: to, hold_reason: reason, wake_date: body.wakeDate, next_action_date: body.wakeDate };
      await patch('todos', `tid=eq.${q(tid)}`, { raw: { ...(todo.raw || {}), pre_hold_status: from } }).catch(() => {});
    } else if (action === 'cancel') {
      if (!reason) return { ok: false, 错误: '取消必须填写原因' };
      to = '已取消'; fields = { status: to, cancel_reason: reason, done_at_text: nowText() };
    } else if (action === 'reopen') {
      if (!reason) return { ok: false, 错误: '重开/修正必须填写原因' };
      to = '待处理'; fields = { status: to, done_text: '', done_at_text: '' }; evExtra.result_note = reason;
    } else return { ok: false, 错误: `不支持的动作 ${action}` };
    // family_check 完成守卫（§8.6/E12）：家庭仍有待确认报名不能伪造完成
    if (tplName === 'family_check' && to === '已完成') {
      const fidm = todo.biz_ref && todo.biz_ref.familyId;
      const pend = d.enrollments.filter(e => e.family_id === fidm && !e.student_id).length;
      if (pend > 0) return { ok: false, 错误: `该家庭仍有 ${pend} 条待确认报名，请先在家庭档案完成分配` };
    }
    // fb_collect 完成守卫（§8.5/E09）：服务端按应收名单校验，不漏报
    if (tplName === 'fb_collect' && to === '已完成') {
      const br = todo.biz_ref || {};
      const roster = [...new Set(d.enrollments.filter(e => e.class_name === br.class && activeEnrollment(e)).map(e => e.student_id))];
      const rows = (d.feedbacks || []).filter(f => f.class_name === br.class && f.lesson === br.lesson && (f.term || TERM) === (br.term || TERM));
      const EXCUSED = ['小明班免发', '免发未到课', '试听刚报未上', '请假缺课'];
      const remained = roster.filter(sid => !rows.some(r => r.student_id === sid && r.status === '已出反馈') && !rows.some(r => r.student_id === sid && EXCUSED.includes(r.status)));
      if (remained.length) return { ok: false, 错误: `仍有 ${remained.length} 名应收学员未完成反馈且未免发，不能标记完成（服务端校验）` };
    }
    await patchTodo(todo, fields);
    const evType = action === 'snooze' ? 'snooze' : action === 'hold' ? 'hold' : action === 'cancel' ? 'cancel' : action === 'reopen' ? 'reopen' : to === '已完成' ? 'complete' : 'process';
    await appendEvent(tid, { event_type: evType, from_status: from, to_status: to, result_code: body.resultCode || null, result_note: note || reason || evExtra.result_note || '', next_action: fields.next_action_date || null, old_due: evExtra.old_due || null, new_due: evExtra.new_due || null, link_biz_id: evExtra.link_biz_id || null, request_id: reqId || null, detail: { template: tplName } });
    // 一次沟通关联多条任务（E08）：仅同模板同学员的周周期任务逐项判定，不盲目全完成
    const links = Array.isArray(body.linkTids) ? body.linkTids.filter(x => x && x !== tid) : [];
    for (const lt of links) {
      const t2 = (d.todos || []).find(t => t.tid === lt);
      if (!t2 || !WF_ACTIVE.includes(t2.status || '待处理')) continue;
      if ((t2.raw && t2.raw.template) === 'weekly_followup' && t2.student_id === todo.student_id && to === '已完成' && note) {
        await patchTodo(t2, { status: '已完成', done_text: `同一次有效沟通关联完成：${note.slice(0, 30)}`, done_at_text: nowText() });
        await appendEvent(t2.tid, { event_type: 'complete', from_status: t2.status, to_status: '已完成', result_code: 'linked_complete', result_note: '由关联沟通完成', link_biz_id: evExtra.link_biz_id || null });
      } else {
        await appendEvent(t2.tid, { event_type: 'note', to_status: t2.status, result_note: `关联沟通记录：${(todo.title || '').slice(0, 30)}`, link_biz_id: evExtra.link_biz_id || null });
      }
    }
    await log('处理待办', { 对象: todo.title || tid, 变更: `${action} → ${to}${fields.done_text ? ' · ' + String(fields.done_text).slice(0, 40) : ''}` });
    return { ok: true, 状态: to, tid, template: tplName };
  }
  if (p === '/api/todo/done') {
    // 老接口兼容：走手动模板完成
    if (!body.tid) return { ok: false, 错误: '缺少tid' };
    const todo = (d.todos || []).find(t => t.tid === body.tid);
    if (!todo || WF_TERMINAL.includes(todo.status || '待处理')) return { ok: false, 错误: todo ? `事项已${todo.status}` : '没有这条待办' };
    const note = String(body.完成补记 || '').trim();
    const from = todo.status || '待处理';
    await patchTodo(todo, { status: '已完成', done_text: note || '已完成', done_at_text: nowText() });
    await appendEvent(todo.tid, { event_type: 'complete', from_status: from, to_status: '已完成', result_code: 'legacy_done', result_note: note });
    await log('完成待办', { 对象: body.标题 || body.tid, 变更: note });
    return { ok: true };
  }
  if (p === '/api/todo/delete') {
    if (!body.tid) return { ok: false, 错误: '缺少tid' };
    const todo = (d.todos || []).find(t => t.tid === body.tid);
    if (!todo || WF_TERMINAL.includes(todo.status || '待处理')) return { ok: false, 错误: todo ? `事项已${todo.status}` : '没有这条待办' };
    const reason = String(body.原因 || '手动取消').trim();
    const from = todo.status || '待处理';
    await patchTodo(todo, { status: '已取消', cancel_reason: reason, done_at_text: nowText() });
    await appendEvent(todo.tid, { event_type: 'cancel', from_status: from, to_status: '已取消', result_code: 'manual_cancel', result_note: reason });
    await log('取消待办', { 对象: body.标题 || body.tid, 变更: reason });
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
    // 2026-09-09 统一待办工作流：登记成功即创建 leaveId 绑定的后续事项（§17.4 统一登记入口）
    let followupTid = '';
    const skey = `leave:${item.lid}:followup`;
    if (!(d.todos || []).some(t => tSourceKey(t) === skey)) {
      const due = new Date(dayOf(item.leave_date || today()).getTime() + 86400000).toISOString().slice(0, 10);
      const t2 = { tid: stableId('T'), title: `请假后续 · ${item.student_name}（${item.leave_date || today()} 请假）`, kind: '请假', business_type: '请假与补课', template: 'leave_followup', source: 'system', student_id: item.student_id || null, student_name: item.student_name || '', class_name: item.class_name || '', note: `确认回放/补课安排（原因：${item.reason || '未填'}）`, due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { leaveId: item.lid }, raw: { source: 'system', template: 'leave_followup', rule: 'leave_followup', source_key: skey, leaveId: item.lid } };
      try { await writeTodoRow(t2); await appendEvent(t2.tid, { event_type: 'create', to_status: '待处理', result_note: '请假登记联动生成后续事项' }); followupTid = t2.tid; } catch (e) { /* 唯一键兜底 */ }
    }
    return { ok: true, item, 后续待办: followupTid || '已存在' };
  }
  if (p === '/api/leave/delete') {
    await patch('leaves', `lid=eq.${q(body.lid || '')}`, { raw: { deleted: true, deletedAt: nowText() } });
    // 2026-09-09：请假撤销自动取消未处理的后续事项（已完成记录留存撤销事件）
    const skey = `leave:${body.lid}:followup`;
    const t = (d.todos || []).find(x => tSourceKey(x) === skey && WF_ACTIVE.includes(x.status || '待处理'));
    if (t) {
      await patchTodo(t, { status: '已取消', cancel_reason: '请假已撤销，后续事项自动取消', done_at_text: nowText() });
      await appendEvent(t.tid, { event_type: 'cancel', from_status: t.status, to_status: '已取消', result_code: 'leave_revoked', result_note: '请假撤销自动取消未处理后续' });
    }
    return { ok: true, 取消后续: !!t };
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
  // ===== 2026-09-09 学员分层：保存/清除人工覆盖（PRD §17.3：枚举校验+requestId幂等+版本冲突+待办同步摘要）=====
  if (p === '/api/student/segment') {
    if (!body.studentId) return { ok: false, 错误: '缺少 studentId' };
    const st = d.studentsById[body.studentId];
    if (!st) return { ok: false, 错误: '没有这个学员' };
    return await segmentSaveWrapper(st, body, d, today());
  }
  // ===== 2026-09-09 系统动作同步：统一对账（周周期/请假后续/反馈批次/家庭核对/唤醒/失效关闭）=====
  if (p === '/api/segmentation/actions/sync') {
    const sum = await reconcileTodos(d, today(), { studentId: body.studentId || '' });
    await log('同步系统待办', { 对象: body.studentId || '全部', 变更: JSON.stringify(sum) });
    return { ok: true, 对账: sum, 说明: '统一待办工作流对账（幂等可重复执行）' };
  }
  // ===== 2026-09-09 临时调课（事件型，不覆盖长期报名；§8.3/§17.4）=====
  if (p === '/api/schedule/adjust') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    if (!body.studentId || !body.origDate) return { ok: false, 错误: '缺少学员或原课程日期' };
    const st = d.studentsById[body.studentId]; if (!st) return { ok: false, 错误: '没有这个学员' };
    const aid = stableId('ADJ');
    await upsert('schedule_adjustments', { aid, student_id: st.id, student_name: st.name, class_name: body.class || '', orig_date: body.origDate, new_date: body.newDate || '', new_class: body.newClass || '', scope: body.scope || '本次', confirm_status: '待确认', reason: body.reason || '', created_at_text: nowText(), raw: body }, 'aid');
    const due = body.due || today();
    const skey = `adjust:${aid}:processing`;
    const tid = stableId('T');
    const row = {
      tid, title: `临时调课 · ${st.name}${body.class ? `（${body.class}）` : ''}`, kind: '调课', business_type: '调课与转班', template: 'adjust', source: 'system',
      student_id: st.id, student_name: st.name, class_name: body.class || '', note: `原 ${body.origDate}${body.newDate ? ` → 新 ${body.newDate}` : ''}`,
      due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { aid }, raw: { source: 'system', template: 'adjust', rule: 'adjust', source_key: skey, aid },
    };
    await writeTodoRow(row);
    await appendEvent(tid, { event_type: 'create', to_status: '待处理', result_note: '临时调课登记' });
    await log('临时调课登记', { 对象: st.name, 变更: `${body.origDate} → ${body.newDate || '待定'}` });
    return { ok: true, aid, tid };
  }
  // ===== 2026-09-09 正式转班（§8.4/§17.4：按生效日期只改未来归属，历史讲次不动）=====
  if (p === '/api/schedule/transfer') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    if (!body.studentId || !body.fromClass || !body.toClass) return { ok: false, 错误: '缺少学员或原班/目标班' };
    const st = d.studentsById[body.studentId]; if (!st) return { ok: false, 错误: '没有这个学员' };
    if (body.toClass === body.fromClass) return { ok: false, 错误: '目标班不能与原班相同' };
    // 目标班必须真实存在（来自排课或报名数据），阻止无效确认（§17.4）
    const targetExists = d.schedule.some(r => r.class_name === body.toClass || (r.class_no || '') === body.toClass) || d.enrollments.some(e => e.class_name === body.toClass);
    if (!targetExists) return { ok: false, 错误: `目标班「${body.toClass}」不存在（未在排课或报名数据中找到），请先建班` };
    const xid = stableId('TX');
    await upsert('schedule_transfers', { xid, student_id: st.id, student_name: st.name, from_class: body.fromClass, to_class: body.toClass, effective_date: body.effectiveDate || today(), status: body.status || '等待确认', reason: body.reason || '', eid: body.eid || '', created_at_text: nowText(), raw: body }, 'xid');
    const due = body.effectiveDate || today();
    const skey = `transfer:${xid}:processing`;
    const tid = stableId('T');
    const row = {
      tid, title: `正式转班 · ${st.name}（${body.fromClass} → ${body.toClass}）`, kind: '转班', business_type: '调课与转班', template: 'transfer', source: 'system',
      student_id: st.id, student_name: st.name, class_name: body.fromClass, note: `生效 ${due}${body.reason ? ' · ' + body.reason : ''}`,
      due_date: due, remind_at: '17:00', status: '待处理', source_key: skey, first_due_date: due, current_due_date: due, creator: '系统', created_at_text: nowText(), biz_ref: { xid, fromClass: body.fromClass, toClass: body.toClass }, raw: { source: 'system', template: 'transfer', rule: 'transfer', source_key: skey, xid },
    };
    await writeTodoRow(row);
    await appendEvent(tid, { event_type: 'create', to_status: '待处理', result_note: '正式转班登记' });
    await log('正式转班登记', { 对象: st.name, 变更: `${body.fromClass} → ${body.toClass} · ${due}` });
    return { ok: true, xid, tid };
  }
  // ===== 2026-09-09 转班确认：已完成 → 按生效日期更新报名（只改未来归属；历史反馈/已发生讲次不动）=====
  if (p === '/api/schedule/transfer/confirm') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    if (!body.xid) return { ok: false, 错误: '缺少转班ID' };
    const tr = (d.trans || []).find(x => x.xid === body.xid);
    if (!tr) return { ok: false, 错误: '没有这条转班记录' };
    const st = d.studentsById[tr.student_id];
    if (!st) return { ok: false, 错误: '没有这个学员' };
    const toClass = body.toClass || tr.to_class;
    const tgt = d.schedule.find(r => r.class_name === toClass) || d.enrollments.find(e => e.class_name === toClass);
    const term = termOf(tr.effective_date || today(), tr.raw && tr.raw.term);
    await upsert('schedule_transfers', { xid: tr.xid, status: '已完成', to_class: toClass, raw: { ...(tr.raw || {}), confirmAt: nowText(), by: '助教' } }, 'xid');
    // 更新该生当期报名（按生效日期只改未来归属；历史 lesson_feedbacks 不在本次改写）
    const enr = (d.enrsByStudent[st.id] || []).filter(e => e.class_name === tr.from_class && !e.is_void);
    for (const e of enr) {
      const effTerm = e.term || term;
      const classId = `CLS-${crypto.createHash('sha1').update(toClass + effTerm).digest('hex').slice(0, 10)}`;
      await patch('enrollments', `eid=eq.${q(e.eid)}`, {
        class_name: toClass, class_display_name: toClass, normalized_class_name: toClass, class_id: classId,
        teacher: (tgt && (tgt.老师 || tgt.teacher)) || e.teacher || '', campus: (tgt && (tgt.校区 || tgt.campus)) || e.campus || '',
        subject: (tgt && (tgt.学科 || tgt.subject)) || e.subject || '', updated_at: new Date().toISOString(),
      });
      await log('转班完成', { 对象: st.name, 班级: toClass, 变更: `${tr.from_class} → ${toClass} · 生效 ${tr.effective_date || '今日'}` });
    }
    // 完成对应转班待办（biz_ref.xid 匹配）
    const t = (d.todos || []).find(x => (x.biz_ref && x.biz_ref.xid) === tr.xid && WF_ACTIVE.includes(x.status || '待处理'));
    if (t) {
      await patchTodo(t, { status: '已完成', done_text: `转班完成：${tr.from_class} → ${toClass}`, done_at_text: nowText() });
      await appendEvent(t.tid, { event_type: 'complete', from_status: t.status, to_status: '已完成', result_code: 'transferred' });
    }
    return { ok: true, 已转班: enr.length, tid: t ? t.tid : '' };
  }
  // ===== 2026-09-09 家庭归属分配（§8.6/E12/E13）：分配待确认报名给学员后自动完成家庭核对轮次 =====
  if (p === '/api/family/assign') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    if (!body.eid || !body.studentId) return { ok: false, 错误: '缺少 eid/studentId' };
    const e = d.enrollments.find(x => x.eid === body.eid);
    const st = d.studentsById[body.studentId];
    if (!e) return { ok: false, 错误: '没有这条报名记录' };
    if (!st) return { ok: false, 错误: '没有这个学员' };
    if (e.student_id && e.student_id !== st.id) return { ok: false, 错误: '该报名已归属其他学员，请刷新' };
    await patch('enrollments', `eid=eq.${q(body.eid)}`, { student_id: st.id, source_student_id: st.source_student_id || st.id, student_name: st.name, phone: st.phone || '', assignment_status: '已确认' });
    const famId = st.family_id || e.family_id;
    const remain = d.enrollments.filter(x => x.family_id === famId && !x.student_id && x.eid !== body.eid).length;
    await log('家庭归属分配', { 对象: st.name, 班级: e.class_name || '', 变更: `eid:${body.eid} · 剩余待确认 ${remain}` });
    if (!remain) {
      // 全部确认 → needs_review=false 且 round+1，下次新问题可开新一轮（E13）
      await patch('families', `family_id=eq.${q(famId)}`, { needs_review: false, review_round: ((d.familiesById[famId] || {}).review_round || 1) + 1 });
      const skey = `family:${famId}:assignment_review:r${(d.familiesById[famId] || {}).review_round || 1}`;
      const t = (d.todos || []).find(x => tSourceKey(x) === skey && WF_ACTIVE.includes(x.status || '待处理'));
      if (t) {
        await patchTodo(t, { status: '已完成', done_text: '全部待确认报名已分配', done_at_text: nowText() });
        await appendEvent(t.tid, { event_type: 'complete', from_status: t.status, to_status: '已完成', result_code: 'auto_resolved' });
      }
    }
    return { ok: true, 剩余待确认: remain, famId };
  }
  // ===== 2026-09-09 课历导入（§17.5）：行级校验，缺日期/班级/讲次禁止导入（禁止猜测日期）=====
  if (p === '/api/calendar/import') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return { ok: false, 错误: 'rows 为空' };
    const items = rows.map(r => ({
      cid: `CC-${r.term || TERM}-${classKey(r.class || '')}-${r.lesson || ''}`,
      term: r.term || TERM, class_name: r.class || '', lesson_no: r.lesson || '',
      lesson_date: r.date || '', start_time: r.start || '', end_time: r.end || '',
      status: r.status || '正常', source: r.source || '手工导入', raw: r,
    }));
    const bad = items.filter(x => !x.class_name || !x.lesson_no || !x.lesson_date);
    if (bad.length) return { ok: false, 错误: `${bad.length} 行缺班级/讲次/日期，禁止猜测导入（PRD §17.5）` };
    if (body.dryRun) return { ok: true, dryRun: true, count: items.length, preview: items.slice(0, 50) };
    for (let i = 0; i < items.length; i += 50) await upsert('course_calendar_dates', items.slice(i, i + 50), 'term,class_name,lesson_no');
    await log('课历导入', { 对象: `${items.length} 课次`, 变更: `${items[0].term} · 来源 ${items[0].source || '手工'}` });
    return { ok: true, imported: items.length };
  }
  // ===== 2026-09-09 助教工作日配置保存（§17.5：默认"课后次日 17:00"已注明，此处可显式配置）=====
  if (p === '/api/assistant/workday') {
    if (!wf) return { ok: false, __status: 400, 错误: WF_MIGRATE_HINT };
    if (!Array.isArray(body.workdays) || !body.workdays.length) return { ok: false, 错误: 'workdays 必须是数组' };
    const cfg = { workdays: body.workdays.map(Number).filter(n => n >= 0 && n <= 7), holidays: body.holidays || [], extra: body.extra || [] };
    if (!cfg.workdays.length) return { ok: false, 错误: '至少保留一个工作日' };
    await upsert('assistant_workdays', { id: 'main', config: cfg, updated_at: new Date().toISOString(), updated_at_text: nowText() }, 'id');
    __wdCache = { t: 0, cfg: null }; // 失效缓存
    await log('配置助教工作日', { 对象: 'main', 变更: cfg.workdays.sort((a, b) => a - b).join(',') });
    return { ok: true, config: cfg };
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
    // ===== 2026-09-09 Vercel Cron 待办提醒：先对账后提醒（PRD §17.5）=====
    // 鉴权独立于会话：配置了 CRON_SECRET 则校验 Bearer 或 ?key=，否则要求已登录会话（便于手动测试）
    // 防重入：模块级内存时间戳锁（Serverless 单实例尽力而为），业务幂等由 source_key/唯一索引兜底（E17）
    if (p === '/api/cron/remind' && req.method === 'GET') {
      const secret = process.env.CRON_SECRET || '';
      const authedCron = secret && (req.headers.authorization === `Bearer ${secret}` || u.query.key === secret);
      if (!authedCron && !isAuthed(req)) return send(res, 401, { ok: false, 错误: '未授权' });
      const nowMs = Date.now();
      if (nowMs - (global.__cronLastRunTs || 0) < 60000) return send(res, 200, { ok: true, skipped: true, msg: '1分钟内已执行过，跳过（防重入）' });
      global.__cronLastRunTs = nowMs;
      const nowD = today();
      let syncSum = null, syncErr = '', syncFailed = false;
      try {
        const cd0 = await getData();
        syncSum = await reconcileTodos(cd0, nowD, {});
      } catch (e) { syncFailed = true; syncErr = String(e && e.message || e); }
      const cd = await getData(); // 对账后再取最新（serverless 无缓存，直接重取）
      const fet = cd.todos || [];
      const pend = fet.filter(t => WF_ACTIVE.includes(t.status || '待处理') && (t.current_due_date || t.due_date || nowD) <= nowD && activeRule(t) !== 'arrears');
      if (syncFailed && !pend.length) return send(res, 207, { ok: true, syncFailed, syncErr, pending: -1, pushed: false, msg: '对账失败，工作安排暂未更新，请稍后重试' });
      if (!pend.length) return send(res, 200, { ok: true, sync: syncSum, pending: 0, pushed: false, msg: '无未办待办' });
      const overdue = pend.filter(t => (t.current_due_date || t.due_date || '') < nowD);
      const lines = pend.map(t => `- [${t.business_type || t.kind || '其他'}] ${t.title}${t.student_name ? `（${t.student_name}${t.class_name ? '/' + t.class_name : ''}）` : ''} · 截止 ${t.current_due_date || t.due_date}${((t.current_due_date || t.due_date || '')) < nowD ? '【已逾期】' : ''}`);
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
      await log(syncFailed ? '待办提醒(对账失败)' : '待办提醒(对账成功)', { 对象: `${pend.length}条未办`, 变更: pushed ? channel : '未配置推送通道' });
      return send(res, 200, { ok: true, sync: syncSum, syncFailed, pending: pend.length, overdue: overdue.length, pushed, channel, lines, pushMsg: String(pushMsg).slice(0, 200) });
    }
    if (!isAuthed(req)) return send(res, 401, { ok: false, 错误: '请先登录' });

    const d = await getData();
    const now = today();
    if (req.method === 'POST') {
      const result = await handlePost(p, await readBody(req), d);
      return send(res, result.ok === false ? (result.__status || 400) : 200, result);
    }
    // ===== 2026-09-09 待办历史分页（§17.6：历史服务端分页，不塞 bootstrap）=====
    if (p === '/api/todo/history') {
      const page = Math.max(1, Number(u.query.page || 1) || 1);
      const size = Math.min(100, Math.max(1, Number(u.query.size || 20) || 20));
      const status = String(u.query.status || 'all');
      const type = String(u.query.type || '');
      const kw = String(u.query.q || '').trim().toLowerCase();
      const excludeArrears = u.query.includeExcluded !== '1';
      let rows = (d.todos || []).slice().sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      if (status !== 'all') rows = rows.filter(t => (t.status || '待处理') === status);
      if (type) rows = rows.filter(t => (t.business_type || t.kind || '') === type);
      if (kw) rows = rows.filter(t => (t.title || '').toLowerCase().includes(kw) || (t.student_name || '').toLowerCase().includes(kw) || (t.class_name || '').toLowerCase().includes(kw));
      if (excludeArrears) rows = rows.filter(t => activeRule(t) !== 'arrears');
      const total = rows.length;
      const slice = rows.slice((page - 1) * size, page * size);
      return send(res, 200, { ok: true, total, page, size, list: mapTodos({ todos: slice }) });
    }
    // ===== 2026-09-09 待办详情（#todo/{tid} 直链：返回事项 + 处理记录）=====
    if (p === '/api/todo/detail') {
      const tid = String(u.query.id || '').trim();
      if (!tid) return send(res, 400, { ok: false, 错误: '缺少id' });
      const t = (d.todos || []).find(x => x.tid === tid);
      if (!t) return send(res, 404, { ok: false, 错误: '没有这条待办' });
      const evs = (d.events || []).filter(e => e.tid === tid).sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')));
      return send(res, 200, { ok: true, item: mapTodos({ todos: [t] })[0], events: evs });
    }
    // ===== 2026-09-09 课历日期（§17.5）：返回已导入的课次清单 =====
    if (p === '/api/calendar/dates') {
      const term = String(u.query.term || '');
      const cls = String(u.query.className || '');
      let rows = (d.cals || []).slice();
      if (term) rows = rows.filter(r => r.term === term);
      if (cls) rows = rows.filter(r => r.class_name === cls);
      return send(res, 200, { ok: true, count: rows.length, list: rows.map(r => ({ cid: r.cid, term: r.term, class_name: r.class_name, lesson_no: r.lesson_no, lesson_date: r.lesson_date, start_time: r.start_time, end_time: r.end_time, status: r.status, source: r.source })) });
    }
    // ===== 2026-09-09 助教工作日配置（§17.5）=====
    if (p === '/api/assistant/workday' && req.method === 'GET') {
      const cfg = await workdayConfig(d);
      return send(res, 200, { ok: true, config: cfg });
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
      // 学期隔离（PRD 10.1）：显式传 term 则过滤；未传默认当前学期，传 all 则不过滤
      const tq = u.query.term;
      const effTerm = tq === 'all' ? '' : (tq || TERM);
      if (sid) rows = rows.filter(r => r.student_id === sid || (r.phone && sid === r.phone));
      if (effTerm) rows = rows.filter(r => r.term === effTerm);
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