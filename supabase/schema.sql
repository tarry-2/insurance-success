-- 인슈런스 석세스 프로그램 — Supabase 스키마 + RLS(역할 위계 자동 차단)
-- 실행: Supabase 대시보드 → SQL Editor 에 붙여넣고 Run
-- 역할: hq(본사) > branch(지점장) > team(팀장) > agent(설계사)

-- ────────────────────────────── 테이블 ──────────────────────────────
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique not null,
  manager_id uuid,
  created_at timestamptz default now()
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branches(id) on delete cascade,
  name text not null,
  code text unique not null,
  leader_id uuid,
  created_at timestamptz default now()
);

-- 회원 프로필 (auth.users 와 1:1, id = auth.uid())
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  phone text unique,
  role text not null check (role in ('hq','branch','team','agent')),
  branch_id uuid references branches(id),
  team_id uuid references teams(id),
  recruiter_id uuid,
  code text,                       -- 본인 추천인 코드(지점장·팀장)
  grade text default 'FC',
  goal_ape int default 300,
  consent jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  job text, income int default 0,
  birthday date, anniversary date, childbirth date, surgery date, discharge date, last_contact date,
  memo text,
  contracts jsonb default '[]'::jsonb,   -- [{product,monthly,status,unpaid,maturity}]
  created_at timestamptz default now()
);

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references profiles(id) on delete cascade,
  month text not null,                   -- 'YYYY-MM'
  product text, ape int default 0, commission int default 0,
  comm_status text default '예상',        -- 수령/미수/예상/환수
  created_at timestamptz default now()
);

create table if not exists recruits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  branch_id uuid, team_id uuid,
  name text not null, phone text,
  stage text default '가망',              -- 가망/면접/위촉/교육/정착
  source text, added_at date,
  week_act jsonb default '[]'::jsonb
);

create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  type text, hospital text, admit_date date, discharge_date date, amount int default 0,
  docs jsonb default '{}'::jsonb,
  status text default '서류준비'          -- 서류준비/접수/심사중/지급완료
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  owner_id uuid not null references profiles(id) on delete cascade,
  type text, name text, doc_date date, size int default 0,
  storage_path text,                     -- Supabase Storage 경로(실파일)
  created_at timestamptz default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  cat text, title text not null, body text,
  author_id uuid references profiles(id) on delete set null,
  by_name text, hot boolean default false,
  is_public boolean default false,       -- 외부 공개(SEO·성장퍼널)
  post_date date default current_date,
  created_at timestamptz default now()
);

create table if not exists app_settings (
  id int primary key default 1,
  doc_retention_months int default 0,    -- 0 = 무제한
  commission_rate int default 35
);
insert into app_settings(id) values (1) on conflict do nothing;

-- ────────────────────────────── RLS 헬퍼 ──────────────────────────────
-- 현재 로그인 유저가 "볼 수 있는" 소유자(profiles.id) 집합
create or replace function visible_owner_ids()
returns setof uuid language sql stable security definer set search_path=public as $$
  select p.id from profiles p, profiles me
  where me.id = auth.uid() and (
    me.role = 'hq'
    or (me.role = 'branch' and p.branch_id = me.branch_id)
    or (me.role = 'team'   and p.team_id   = me.team_id)
    or (me.role = 'agent'  and p.id = me.id)
  );
$$;

create or replace function my_role() returns text language sql stable security definer set search_path=public as $$
  select role from profiles where id = auth.uid();
$$;

-- ────────────────────────────── RLS 활성화 ──────────────────────────────
alter table profiles   enable row level security;
alter table branches   enable row level security;
alter table teams      enable row level security;
alter table customers  enable row level security;
alter table sales      enable row level security;
alter table recruits   enable row level security;
alter table claims     enable row level security;
alter table documents  enable row level security;
alter table posts      enable row level security;
alter table app_settings enable row level security;

-- 프로필: 내 스코프 안의 프로필 열람 / 본인 것 수정 / 가입시 insert
create policy prof_sel on profiles for select using (id in (select visible_owner_ids()));
create policy prof_ins on profiles for insert with check (id = auth.uid());
create policy prof_upd on profiles for update using (id = auth.uid() or my_role() in ('hq','branch'));

-- 지점/팀: 로그인 유저는 열람(가입 코드 검증 위해). 관리는 hq/branch.
create policy br_sel on branches for select using (true);
create policy br_all on branches for all using (my_role() in ('hq','branch')) with check (my_role() in ('hq','branch'));
create policy tm_sel on teams for select using (true);
create policy tm_all on teams for all using (my_role() in ('hq','branch','team')) with check (my_role() in ('hq','branch','team'));

-- 소유 데이터: 스코프(owner_id ∈ 볼 수 있는 집합)만. 쓰기는 본인 소유.
create policy cust_sel on customers for select using (owner_id in (select visible_owner_ids()));
create policy cust_mod on customers for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy sales_sel on sales for select using (agent_id in (select visible_owner_ids()));
create policy sales_mod on sales for all using (agent_id = auth.uid()) with check (agent_id = auth.uid());

create policy rec_sel on recruits for select using (owner_id in (select visible_owner_ids()));
create policy rec_mod on recruits for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy clm_sel on claims for select using (owner_id in (select visible_owner_ids()));
create policy clm_mod on claims for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy doc_sel on documents for select using (owner_id in (select visible_owner_ids()));
create policy doc_mod on documents for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 커뮤니티: 전 인원 열람, 작성은 로그인 유저(본인 글만 수정/삭제)
create policy post_sel on posts for select using (true);
create policy post_ins on posts for insert with check (author_id = auth.uid());
create policy post_upd on posts for update using (author_id = auth.uid() or my_role() = 'hq');

-- 설정: 열람 전체, 변경은 hq
create policy set_sel on app_settings for select using (true);
create policy set_upd on app_settings for update using (my_role() = 'hq');
