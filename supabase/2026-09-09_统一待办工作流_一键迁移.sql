-- ============================================================
-- 苏E好学 · 助教工作台  2026-09-09 统一待办工作流 一键迁移
-- 依据：《二期PRD_助教工作台待办工作流与分级联动统一改造_2026-09-09》§4/§6/§17
-- 执行方法（与既有 SOP 相同，约 1 分钟）：
--   1. 打开 https://supabase.com/dashboard/project/sdrlxhfltyumcjvlqqlu/sql
--   2. 点「New query」，把本文件全部内容粘贴进去
--   3. 点右下角「Run」，看到 Success 即完成
-- 特性：全部语句幂等（可重复执行）；不删除任何业务数据；文末附回滚 SQL（默认注释）。
-- ============================================================

-- ---------- 1. todos 表：统一待办工作流新列 ----------
alter table if exists public.todos
  add column if not exists business_type text,                -- 业务分类：跟进/请假与补课/课程与反馈/调课与转班/家庭核对/手动事项
  add column if not exists template text,                     -- 处理模板：weekly_followup/leave_followup/fb_collect/family_check/transfer/adjust/manual
  add column if not exists biz_ref jsonb not null default '{}'::jsonb,  -- 关联业务事实 {leaveId,fid,cycleKey,class,lesson,rid,...}
  add column if not exists source text not null default 'manual',       -- 来源：manual / system
  add column if not exists cycle_key text,                    -- 周期键：{yyyy}-W{ww}（北京时间周一为一周起点）
  add column if not exists first_due_date text,               -- 首次截止时间（不可覆盖）
  add column if not exists current_due_date text,             -- 当前截止时间（顺延时更新）
  add column if not exists next_action_date text,             -- 下次行动时间（等待回复/暂缓唤醒/再次联系）
  add column if not exists hold_reason text,                  -- 暂缓原因
  add column if not exists wake_date text,                    -- 暂缓唤醒日期（冗余存储，便于查询）
  add column if not exists cancel_reason text,                -- 取消原因
  add column if not exists seg_snapshot text,                 -- 生成时层级快照（S/A/B/C/NONE）
  add column if not exists version int not null default 1;    -- 乐观锁版本号（每次状态变更 +1）

create index if not exists todos_biz_status_idx   on public.todos(business_type, status);
create index if not exists todos_cycle_idx        on public.todos(cycle_key);
create index if not exists todos_next_action_idx on public.todos(next_action_date);
create index if not exists todos_source_key_idx2 on public.todos(source, status);

-- ---------- 2. 旧数据映射（PRD §17.6：旧状态"待办"→"待处理"；不伪造结构化结果） ----------
-- 首次截止=当前截止=旧 due_date；旧自由文本完成补记原样保留。
update public.todos
   set status = '待处理'
 where status = '待办';
update public.todos
   set first_due_date = due_date,
       current_due_date = due_date
 where first_due_date is null
   and due_date is not null;
update public.todos
   set business_type = case
         when (kind = '跟进' and source_key like 'seg:%') then '跟进'
         when kind = '请假' then '请假与补课'
         when kind in ('课程与反馈','反馈') then '课程与反馈'
         when kind in ('调课与转班','转班') then '调课与转班'
         when (kind = '跟进' and raw->>'source' = 'referral') then '跟进'
         else '手动事项'
       end,
       source = case when source_key is not null or raw->>'source' in ('segmentation','referral') then 'system' else 'manual' end,
       template = 'manual'
 where business_type is null;

-- ---------- 3. todo_events：统一处理记录（事件追加，不物理删除） ----------
create table if not exists public.todo_events (
  eid text primary key,
  tid text not null,
  event_type text not null,             -- create/status/process/complete/snooze/hold/cancel/reopen/sync/note
  from_status text,
  to_status text,
  result_code text,                     -- 模板化结果码（contacted_reply/arranged_makeup/...）
  result_note text,
  next_action_date text,
  old_due_date text,
  new_due_date text,
  link_biz_id text,                     -- 关联业务记录（followup id / leave lid / fid ...）
  request_id text,                      -- 幂等键：同 requestId 重复提交返回原结果
  operator text default '助教',
  occurred_at timestamptz not null default now(),
  occurred_at_text text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists todo_events_tid_idx on public.todo_events(tid, occurred_at);
create unique index if not exists todo_events_request_uq on public.todo_events(tid, request_id) where request_id is not null;
alter table public.todo_events enable row level security;

-- ---------- 4. 课次与课历（PRD §17.5：稳定课次 ID；日期数据待原图转写后导入，禁止猜测） ----------
create table if not exists public.course_calendar_dates (
  cid text primary key,                 -- 稳定课次ID：CC-{term}-{classKey}-{lessonNo}
  term text not null,
  class_name text not null,
  class_id text,
  lesson_no text not null,              -- 第1讲/第2讲...
  lesson_date date not null,            -- 实际上课日期（来自课历原图转写）
  start_time text,
  end_time text,
  status text not null default '正常',  -- 正常/调课/停课/补课
  source text,                          -- 导入来源与版本
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(term, class_name, lesson_no)
);
create index if not exists ccd_date_idx on public.course_calendar_dates(lesson_date);
alter table public.course_calendar_dates enable row level security;

-- 助教工作日配置（PRD §17.5：助教工作日须独立配置，不能假设周末休息）
create table if not exists public.assistant_workdays (
  id text primary key default 'main',
  config jsonb not null default '{}'::jsonb,   -- {"workdays":[1..7],"holidays":[],"extra":[]}
  updated_at timestamptz,
  updated_at_text text
);
alter table public.assistant_workdays enable row level security;

-- ---------- 5. 家庭核对轮次（E13：核对完成后新报名可开启新一轮，不被旧完成键压住） ----------
alter table if exists public.families
  add column if not exists review_round int not null default 1;
update public.families set review_round = 1 where review_round is null or review_round < 1;

-- ---------- 5b. 分级保存幂等（PRD §17.3：requestId + 版本号，重试返回原结果，冲突 409） ----------
alter table if exists public.students
  add column if not exists segment_version int not null default 0,
  add column if not exists segment_request_id text;

-- ---------- 5c. 临时调课 / 正式转班 业务事实表（PRD §8.3/§8.4：两者不得混为一种数据操作） ----------
create table if not exists public.schedule_adjustments (
  aid text primary key,
  student_id text not null,
  student_name text,
  class_name text,
  orig_date text,
  new_date text,
  new_class text,
  scope text,                            -- 生效范围说明（本次/某段）
  confirm_status text not null default '待确认',  -- 待确认/已确认/暂无合适时间/暂缓
  reason text,
  raw jsonb not null default '{}'::jsonb,
  created_at_text text,
  created_at timestamptz not null default now()
);
create index if not exists schedule_adjustments_sid_idx on public.schedule_adjustments(student_id);
alter table public.schedule_adjustments enable row level security;

create table if not exists public.schedule_transfers (
  xid text primary key,
  student_id text not null,
  student_name text,
  from_class text not null,
  to_class text not null,
  effective_date text,                   -- 生效日期：仅改变未来归属，历史讲次不动
  status text not null default '等待确认',        -- 等待确认/已完成/目标班无名额/暂不调整
  reason text,
  eid text,                              -- 关联报名记录
  raw jsonb not null default '{}'::jsonb,
  created_at_text text,
  created_at timestamptz not null default now()
);
create index if not exists schedule_transfers_sid_idx on public.schedule_transfers(student_id);
alter table public.schedule_transfers enable row level security;

-- ---------- 6. 验证查询（执行后应看到 Success；可手动跑验证段） ----------
-- select count(*) from todos where status='待办';             -- 应为 0
-- select count(*) from todos where status='待处理';           -- 应等于原"待办"数
-- select count(*) from todo_events;                            -- 应为 0（新表）
-- select count(*) from course_calendar_dates;                  -- 应为 0（等课历原图转写后导入）
-- select column_name from information_schema.columns where table_name='students' and column_name='segment_version';  -- 应有 1 行

-- ============================================================
-- 回滚 SQL（仅在未来确认需要回退时手工执行；会删除新表并还原状态映射，业务数据不删）
-- drop table if exists public.todo_events;
-- drop table if exists public.course_calendar_dates;
-- drop table if exists public.assistant_workdays;
-- drop table if exists public.schedule_adjustments;
-- drop table if exists public.schedule_transfers;
-- alter table public.todos
--   drop column if exists business_type, drop column if exists template, drop column if exists biz_ref,
--   drop column if exists source, drop column if exists cycle_key, drop column if exists first_due_date,
--   drop column if exists current_due_date, drop column if exists next_action_date,
--   drop column if exists hold_reason, drop column if exists wake_date,
--   drop column if exists cancel_reason, drop column if exists seg_snapshot, drop column if exists version;
-- alter table public.families drop column if exists review_round;
-- alter table public.students drop column if exists segment_version, drop column if exists segment_request_id;
-- update public.todos set status='待办' where status='待处理';
-- ============================================================
