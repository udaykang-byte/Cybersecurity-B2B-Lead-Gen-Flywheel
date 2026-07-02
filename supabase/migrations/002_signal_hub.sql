-- ============================================================
-- Signal Hub — Migration: 002_signal_hub
-- Normalized signal events, run audit, score snapshots, views.
-- Run in the Supabase SQL editor after 001_initial_schema.sql.
-- ============================================================

-- Companies: domain becomes the canonical key; feedback fields for outcome capture
alter table companies add column if not exists domain text;
alter table companies add column if not exists contacted_at timestamptz;
alter table companies add column if not exists replied boolean;
alter table companies add column if not exists meeting boolean;
alter table companies add column if not exists outcome text;  -- e.g. 'closed_won', 'closed_lost', 'no_response'
do $$ begin
    alter table companies add constraint companies_domain_key unique (domain);
exception when duplicate_table then null; when duplicate_object then null; end $$;

-- Normalized signal events (append-only)
create table if not exists signal_events (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    client          text not null default 'default',
    type            text not null,          -- canonical SIGNAL_TYPES key
    evidence        text,
    url             text,
    source          text not null,          -- adapter name
    confidence      float not null default 1.0,
    base_points     int not null,
    half_life_days  int not null,
    observed_at     date not null,
    created_at      timestamptz not null default now()
);
create unique index if not exists signal_events_dedup
    on signal_events(company_id, type, coalesce(url, ''));
create index if not exists signal_events_company_idx on signal_events(company_id);
create index if not exists signal_events_observed_idx on signal_events(observed_at desc);

-- Run audit — one row per on-demand orchestrator run
create table if not exists runs (
    id                   uuid primary key default gen_random_uuid(),
    client               text not null default 'default',
    started_at           timestamptz not null default now(),
    finished_at          timestamptz,
    companies_processed  int default 0,
    adapter_status       jsonb default '{}'::jsonb,   -- { "sec-edgar": {"ok": 4, "failed": 1, "error": "..."} }
    notes                text
);

-- Score snapshots
create table if not exists account_signal_scores (
    id           uuid primary key default gen_random_uuid(),
    run_id       uuid references runs(id) on delete set null,
    company_id   uuid not null references companies(id) on delete cascade,
    client       text not null default 'default',
    score        int not null,
    tier         text not null,
    is_stack     boolean default false,
    stack_label  text,
    breakdown    jsonb default '[]'::jsonb,
    flagged      jsonb default '[]'::jsonb,
    scored_at    timestamptz not null default now()
);
create index if not exists account_signal_scores_company_idx on account_signal_scores(company_id, scored_at desc);

-- Views: latest score per company; hot accounts feed the notifier and client exports
create or replace view v_account_scores as
    select distinct on (s.company_id)
        c.name, c.domain, c.linkedin_url, c.website, c.industry, c.employee_count,
        c.contacted_at, c.replied, c.meeting, c.outcome,
        s.company_id, s.client, s.score, s.tier, s.is_stack, s.stack_label,
        s.breakdown, s.flagged, s.scored_at
    from account_signal_scores s
    join companies c on c.id = s.company_id
    order by s.company_id, s.scored_at desc;

create or replace view v_hot_accounts as
    select * from v_account_scores where score >= 28;
