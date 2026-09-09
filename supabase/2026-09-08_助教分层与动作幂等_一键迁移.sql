-- 2026-09-08 助教工作台：分层、风险标签与系统动作幂等迁移
-- 可重复执行；不修改现有业务数据。

alter table if exists public.students
  add column if not exists segment_code text,
  add column if not exists risk_level text,
  add column if not exists risk_tags jsonb not null default '[]'::jsonb,
  add column if not exists segment_note text,
  add column if not exists segment_updated_at timestamptz;

alter table if exists public.todos
  add column if not exists source_key text;

create unique index if not exists todos_source_key_uq
  on public.todos(source_key)
  where source_key is not null;

create index if not exists students_segment_idx
  on public.students(segment_code, risk_level);

create index if not exists students_family_idx
  on public.students(family_id);

alter table if exists public.students enable row level security;
alter table if exists public.todos enable row level security;
