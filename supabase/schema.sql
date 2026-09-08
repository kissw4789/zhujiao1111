-- 苏E好学 · 助教工作台 Supabase schema
-- Safe to run repeatedly. Secrets are not stored here.

create extension if not exists pgcrypto;

create table if not exists import_batches (
  batch_id text primary key,
  source_name text,
  source_path text,
  row_count integer not null default 0,
  class_count integer not null default 0,
  student_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists raw_roster_rows (
  batch_id text not null references import_batches(batch_id) on delete cascade,
  source_file text not null,
  row_index integer not null,
  source_class_id text,
  source_student_id text,
  class_name text,
  normalized_class_name text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (batch_id, source_file, row_index)
);

create table if not exists families (
  family_id text primary key,
  phone text,
  source_student_id text,
  source_name text,
  campus text,
  source_status text,
  needs_review boolean not null default false,
  pending_enrollments integer not null default 0,
  cluster_summary jsonb not null default '{}'::jsonb,
  last_sync_at text,
  migration_version text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists families_phone_idx on families(phone);
create unique index if not exists families_phone_uq on families(phone) where phone is not null and phone <> '';
create index if not exists families_source_student_id_idx on families(source_student_id);
create unique index if not exists families_source_student_id_uq on families(source_student_id) where source_student_id is not null and source_student_id <> '';

create table if not exists students (
  id text primary key,
  family_id text references families(family_id) on delete set null,
  source_student_id text,
  name text not null,
  phone text,
  gender text,
  grade text,
  english_name text,
  tags jsonb not null default '[]'::jsonb,
  intent text,
  note text,
  family_order integer,
  first_date text,
  recent_date text,
  enrollment_count integer not null default 0,
  source_name text,
  assignment_confirmed boolean not null default false,
  is_manual boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists students_family_id_idx on students(family_id);
create index if not exists students_source_student_id_idx on students(source_student_id);
create index if not exists students_name_idx on students(name);

create table if not exists classes (
  id text primary key,
  source_class_id text,
  class_name text not null,
  normalized_class_name text,
  term text,
  term_name text,
  grade text,
  subject text,
  campus text,
  teacher text,
  start_date text,
  end_date text,
  weekday text,
  time_range text,
  lecture_times text,
  capacity_text text,
  class_type text,
  raw jsonb not null default '{}'::jsonb,
  last_import_batch text references import_batches(batch_id) on delete set null,
  active_in_latest boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists classes_name_idx on classes(class_name);
create index if not exists classes_normalized_name_idx on classes(normalized_class_name);
create index if not exists classes_term_idx on classes(term);
create unique index if not exists classes_source_class_id_uq on classes(source_class_id) where source_class_id is not null;

create table if not exists enrollments (
  eid text primary key,
  student_id text references students(id) on delete set null,
  source_student_id text,
  family_id text references families(family_id) on delete set null,
  class_id text references classes(id) on delete set null,
  student_name text,
  phone text,
  class_name text not null,
  class_display_name text,
  normalized_class_name text,
  grade text,
  subject text,
  term text,
  term_name text,
  campus text,
  teacher text,
  time_range text,
  lecture_times text,
  start_date text,
  end_date text,
  source_status text,
  assignment_status text,
  display_status text,
  capacity_text text,
  amount_due numeric,
  book_fee numeric,
  arrears numeric,
  fee_text text,
  is_void boolean not null default false,
  is_manual boolean not null default false,
  active_in_latest boolean not null default true,
  last_import_batch text references import_batches(batch_id) on delete set null,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists enrollments_student_id_idx on enrollments(student_id);
create index if not exists enrollments_family_id_idx on enrollments(family_id);
create index if not exists enrollments_class_id_idx on enrollments(class_id);
create index if not exists enrollments_source_student_id_idx on enrollments(source_student_id);
create index if not exists enrollments_term_idx on enrollments(term);
create index if not exists enrollments_active_idx on enrollments(active_in_latest, is_void);

create table if not exists orders (
  id text primary key,
  order_no text,
  family_id text references families(family_id) on delete set null,
  child_id text references students(id) on delete set null,
  source_student_id text,
  student_name text,
  phone text,
  campus text,
  teacher text,
  term text,
  product text,
  ordered_at text,
  paid_at text,
  amount numeric,
  payment_method text,
  payment_status text,
  assignment_status text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists orders_family_id_idx on orders(family_id);
create index if not exists orders_child_id_idx on orders(child_id);
create index if not exists orders_phone_idx on orders(phone);

create table if not exists schedule_items (
  schedule_id text primary key,
  class_no text,
  class_id text references classes(id) on delete set null,
  class_name text,
  normalized_class_name text,
  term text,
  weekday text,
  time_range text,
  course text,
  subject text,
  grade text,
  teacher text,
  teacher_full_name text,
  campus text,
  room text,
  source text,
  class_type text,
  enrolled_count integer not null default 0,
  start_date text,
  end_date text,
  raw jsonb not null default '{}'::jsonb,
  last_import_batch text references import_batches(batch_id) on delete set null,
  active_in_latest boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists schedule_items_term_idx on schedule_items(term);
create index if not exists schedule_items_class_id_idx on schedule_items(class_id);
create index if not exists schedule_items_normalized_name_idx on schedule_items(normalized_class_name);

create table if not exists course_outlines (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists followups (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  term text,
  student_id text references students(id) on delete cascade,
  status text,
  note text,
  next_followup_date text,
  source_key text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists followups_source_key_uq on followups(source_key) where source_key is not null;
create index if not exists followups_student_kind_idx on followups(student_id, kind, term);

create table if not exists leaves (
  lid text primary key,
  student_id text references students(id) on delete set null,
  student_name text,
  class_name text,
  leave_date text,
  reason text,
  refund_amount numeric,
  note text,
  raw jsonb not null default '{}'::jsonb,
  created_at_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists leaves_student_id_idx on leaves(student_id);

create table if not exists class_progress (
  class_name text primary key,
  lecture_no integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists family_assignment_rules (
  family_id text references families(family_id) on delete cascade,
  grade_key text not null,
  child_id text references students(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (family_id, grade_key)
);

create table if not exists op_logs (
  id bigserial primary key,
  source_hash text unique,
  logged_at text,
  action text,
  target text,
  class_name text,
  change text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists op_logs_logged_at_idx on op_logs(logged_at);

-- ============ 2026-09-08 新增：讲次学情反馈库 + 助教待办 ============
-- 讲次学情反馈：老师每讲给出的正式学员反馈（原汁原味正文），与学员档案关联
create table if not exists lesson_feedbacks (
  fid text primary key,                -- 例：FB-2026秋-L1-12535964
  term text not null default '2026秋',
  lesson text not null,                -- 例：第1讲
  lesson_title text,                   -- 例：圆柱与圆锥初步
  lesson_date text,                    -- 上课日期
  student_id text,
  student_name text,
  class_name text,
  teacher text,
  grade text,
  subject text,
  campus text,
  phone text,
  status text,                         -- 已出反馈/小明班免发/周三未开课/请假缺课/免发未到课/试听刚报未上
  content text,                        -- 反馈正文（原汁原味，不删改）
  note text,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists lesson_feedbacks_sid_idx on lesson_feedbacks(student_id, term, lesson);
create index if not exists lesson_feedbacks_class_idx on lesson_feedbacks(class_name);

-- 助教个人待办：临时接到、当下无法立即完成的动作（请假/调课/退费/跟进等）
create table if not exists todos (
  tid text primary key,                -- 例：T-xxx
  title text not null,                 -- 一句话待办，例：给张三登记9/10请假
  kind text not null default '其他',   -- 请假/调课/退费/跟进/反馈催收/其他
  student_id text,
  student_name text,
  class_name text,
  note text,
  due_date text,                       -- 截止/应办日期 YYYY-MM-DD
  remind_at text,                      -- 提醒时刻 HH:MM（当天下班前提醒）
  status text not null default '待办', -- 待办/已完成/已取消
  done_text text,                      -- 完成时补记（例：已登记请假并折算）
  link_leave_lid text,                 -- 联动生成的请假单 lid（若有）
  creator text default '助教',
  done_at_text text,
  raw jsonb not null default '{}'::jsonb,
  created_at_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists todos_status_due_idx on todos(status, due_date);

-- ============ 2026-09-08 新增：转介绍跟进（学员转介绍由助教沟通） ============
create table if not exists referrals (
  rid text primary key,                -- 例：R-xxx
  referrer text not null,              -- 介绍家长（哪位家长介绍的）
  referrer_phone text,                 -- 介绍家长电话（选填）
  student_name text,                   -- 新生姓名
  grade text,                          -- 学员年级
  class_type text,                     -- 班型：创新班/尖子班
  subject text,                        -- 学科：数学/物理
  eval_date text,                      -- 约定的测评日期 YYYY-MM-DD
  eval_score text,                     -- 测评分数（测评后填写）
  trial_date text,                     -- 试听课日期 YYYY-MM-DD（如需试听）
  note text,                           -- 助教备注
  status text not null default '待测评', -- 待测评/已测评待试听/待报名/已报名/已流失
  student_id text,                     -- 报名后回填正式学员 id（回到助教流程）
  remind_tid text,                     -- 关联的提醒待办 tid（选填）
  creator text default '助教',
  created_at_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists referrals_status_idx on referrals(status);
create index if not exists referrals_rid_idx on referrals(rid);
create index if not exists referrals_student_id_idx on referrals(student_id);

alter table import_batches enable row level security;
alter table raw_roster_rows enable row level security;
alter table families enable row level security;
alter table students enable row level security;
alter table classes enable row level security;
alter table enrollments enable row level security;
alter table orders enable row level security;
alter table schedule_items enable row level security;
alter table course_outlines enable row level security;
alter table followups enable row level security;
alter table leaves enable row level security;
alter table class_progress enable row level security;
alter table family_assignment_rules enable row level security;
alter table op_logs enable row level security;
alter table lesson_feedbacks enable row level security;
alter table todos enable row level security;
alter table referrals enable row level security;
