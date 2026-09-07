-- ============================================================
-- 苏E好学 · 助教工作台  2026-09-08 一键建表（反馈库 + 待办）
-- 执行方法（30秒）：
--   1. 打开 https://supabase.com/dashboard/project/sdrlxhfltyumcjvlqqlu/sql
--   2. 点「New query」，把本文件全部内容粘贴进去
--   3. 点右下角「Run」，看到 Success 即完成
-- 执行后告诉我一声，我立刻上传 299 份反馈并验证全链路。
-- ============================================================

-- 讲次学情反馈库：老师每讲给出的正式学员反馈（原汁原味正文）
create table if not exists lesson_feedbacks (
  fid text primary key,
  term text not null default '2026秋',
  lesson text not null,
  lesson_title text,
  lesson_date text,
  student_id text,
  student_name text,
  class_name text,
  teacher text,
  grade text,
  subject text,
  campus text,
  phone text,
  status text,
  content text,
  note text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists lesson_feedbacks_sid_idx on lesson_feedbacks(student_id, term, lesson);
create index if not exists lesson_feedbacks_class_idx on lesson_feedbacks(class_name);

-- 助教个人待办：临时接到、当下无法立即完成的动作
create table if not exists todos (
  tid text primary key,
  title text not null,
  kind text not null default '其他',
  student_id text,
  student_name text,
  class_name text,
  note text,
  due_date text,
  remind_at text,
  status text not null default '待办',
  done_text text,
  link_leave_lid text,
  creator text default '助教',
  done_at_text text,
  raw jsonb not null default '{}'::jsonb,
  created_at_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists todos_status_due_idx on todos(status, due_date);

alter table lesson_feedbacks enable row level security;
alter table todos enable row level security;
