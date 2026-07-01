-- ============================================================
-- Reddit Lead Finder — Supabase Schema
-- Migration: 001_initial_schema
-- ============================================================
-- Run this in your Supabase SQL editor or via supabase db push.
-- All deduplication is enforced via UNIQUE constraints; scripts
-- use ON CONFLICT DO NOTHING / DO UPDATE instead of local .seen-urls.json files.
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. companies — master company registry
-- Deduped by linkedin_url. All signal tables FK to this.
-- ============================================================
create table if not exists companies (
    id              uuid primary key default gen_random_uuid(),
    name            text,
    linkedin_url    text unique,          -- normalized: https://linkedin.com/company/slug
    website         text,
    industry        text,
    employee_count  int,
    segment         text,                 -- A (1000+), B (100-999), C (<100)
    location        text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    last_seen_at    timestamptz not null default now()
);

create index if not exists companies_linkedin_url_idx on companies(linkedin_url);
create index if not exists companies_name_idx on companies(lower(name));

-- ============================================================
-- 2. job_signals — LinkedIn job postings
-- ============================================================
create table if not exists job_signals (
    id                  uuid primary key default gen_random_uuid(),
    company_id          uuid references companies(id) on delete set null,
    source              text not null default 'linkedin-jobs',
    category            text,             -- iam, grc, pam, ciso, security, other
    type                text,             -- hiring-ciso, hiring-iam-engineer, etc.
    title               text,
    url                 text unique not null,
    location            text,
    current_tools       text[] default '{}',
    frameworks          text[] default '{}',
    pain_language       text[] default '{}',
    base_score          int,
    total_score         int,
    urgency             text,             -- Critical, High, Medium, Low
    urgency_window      text,
    outreach_angle      text,
    suggested_message   text,
    key_requirements    text[] default '{}',
    seniority_level     text,
    company_size        int,
    description_summary text,
    posted_at           timestamptz,
    detected_at         timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create index if not exists job_signals_company_id_idx on job_signals(company_id);
create index if not exists job_signals_total_score_idx on job_signals(total_score desc);
create index if not exists job_signals_urgency_idx on job_signals(urgency);
create index if not exists job_signals_detected_at_idx on job_signals(detected_at desc);

-- ============================================================
-- 3. people_signals — LinkedIn executive hires (CISO, Director, etc.)
-- ============================================================
create table if not exists people_signals (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid references companies(id) on delete set null,
    source          text not null default 'linkedin-people',
    type            text,                 -- new-ciso-hired, new-vp-hired, etc.
    name            text,
    title           text,
    role            text,                 -- CISO, VP, Director, Manager
    profile_url     text unique,
    location        text,
    industry        text,
    base_score      int,
    total_score     int,
    urgency         text,
    urgency_window  text,
    outreach_angle  text,
    suggested_message text,
    detected_at     timestamptz not null default now(),
    created_at      timestamptz not null default now()
);

create index if not exists people_signals_company_id_idx on people_signals(company_id);
create index if not exists people_signals_total_score_idx on people_signals(total_score desc);
create index if not exists people_signals_detected_at_idx on people_signals(detected_at desc);

-- ============================================================
-- 4. feed_signals — LinkedIn feed posts (buying signals)
-- ============================================================
create table if not exists feed_signals (
    id                  uuid primary key default gen_random_uuid(),
    company_id          uuid references companies(id) on delete set null,  -- nullable
    source              text not null default 'linkedin-feed',
    keyword             text,
    author_name         text,
    author_headline     text,
    author_url          text,
    url                 text unique not null,
    post_text           text,
    score               int,
    tier                text,             -- HOT, WARM, COLD
    intent_level        text,             -- discussion, project, question, evaluation
    noise_type          text,             -- vendor-promo, recruiter, null
    tools_mentioned     text[] default '{}',
    pain_keywords       text[] default '{}',
    author_role_tier    text,             -- decision-maker, user, unknown
    posted_at           timestamptz,
    detected_at         timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create index if not exists feed_signals_company_id_idx on feed_signals(company_id);
create index if not exists feed_signals_tier_idx on feed_signals(tier);
create index if not exists feed_signals_detected_at_idx on feed_signals(detected_at desc);

-- ============================================================
-- 5. reddit_leads — scraped + scored Reddit posts/comments
-- ============================================================
create table if not exists reddit_leads (
    id                  uuid primary key default gen_random_uuid(),
    topic               text,             -- IdentityManagement, PAM, GRC, etc.
    author              text,
    subreddit           text,
    url                 text unique not null,
    type                text,             -- POST, COMMENT
    title               text,
    body                text,
    reddit_score        int,              -- post upvote score
    num_comments        int,
    scraped_at          timestamptz not null default now(),
    created_at          timestamptz,      -- original post creation time
    -- Scoring fields (null until Claude scores and supabase-sync.js is run)
    lead_score          int,              -- 1-10
    lead_tier           text,             -- HOT, WARM, COLD
    excerpt             text,
    reasoning           text,
    suggested_outreach  text,
    scored_at           timestamptz,
    synced_from         text              -- path of source leads JSON file
);

create index if not exists reddit_leads_topic_idx on reddit_leads(topic);
create index if not exists reddit_leads_lead_tier_idx on reddit_leads(lead_tier);
create index if not exists reddit_leads_lead_score_idx on reddit_leads(lead_score desc);
create index if not exists reddit_leads_scraped_at_idx on reddit_leads(scraped_at desc);
create index if not exists reddit_leads_url_topic_idx on reddit_leads(url, topic);

-- ============================================================
-- 6. news_signals — Discogen enrichment results per company
-- ============================================================
create table if not exists news_signals (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    source          text not null default 'discogen',
    type            text,                 -- breach, funding, ciso_change, m&a, cloud_migration, compliance
    title           text,
    url             text,
    summary         text,
    published_at    timestamptz,
    points          int,
    confidence      float,
    detected_at     timestamptz not null default now(),
    unique(company_id, url)
);

create index if not exists news_signals_company_id_idx on news_signals(company_id);
create index if not exists news_signals_type_idx on news_signals(type);
create index if not exists news_signals_detected_at_idx on news_signals(detected_at desc);

-- ============================================================
-- 7. account_scores — FITS qualification results
-- ============================================================
create table if not exists account_scores (
    id                  uuid primary key default gen_random_uuid(),
    company_id          uuid not null references companies(id) on delete cascade,
    scored_at           timestamptz not null default now(),
    fits_f              int,              -- Firmographic (max 25)
    fits_i              int,              -- Intent (max 35)
    fits_t              int,              -- Technographic (max 20)
    fits_s              int,              -- Structural (max 20)
    total_score         int,
    tier                int,              -- 1, 2, 3, 4, or null for DQ
    tier_label          text,             -- Bullseye, Strong Fit, Good Fit, Stretch, DQ
    recommended_action  text,
    top_signals         text[] default '{}',
    outreach_angle      text,
    input_source        text              -- which CSV/file triggered this scoring run
);

create index if not exists account_scores_company_id_idx on account_scores(company_id);
create index if not exists account_scores_total_score_idx on account_scores(total_score desc);
create index if not exists account_scores_tier_idx on account_scores(tier);
create index if not exists account_scores_scored_at_idx on account_scores(scored_at desc);

-- ============================================================
-- 8. enriched_contacts — enriched Reddit user profiles
-- ============================================================
create table if not exists enriched_contacts (
    id                  uuid primary key default gen_random_uuid(),
    reddit_username     text unique not null,
    company             text,
    company_confidence  text,             -- low, medium, high
    role                text,
    role_confidence     text,
    industry            text,
    location            text,
    tech_stack          text[] default '{}',
    pain_points         text[] default '{}',
    buying_signals      text[] default '{}',
    linkedin_url        text,
    email               text,
    company_website     text,
    contact_confidence  text,
    do_not_contact      boolean default false,
    competitor_flag     text,
    perplexity_research text,
    exa_research        text,
    enriched_at         timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists enriched_contacts_username_idx on enriched_contacts(reddit_username);
create index if not exists enriched_contacts_company_idx on enriched_contacts(lower(company));

-- ============================================================
-- Row Level Security (RLS)
-- Anon key: read-only. Service role key: full access.
-- ============================================================
alter table companies         enable row level security;
alter table job_signals       enable row level security;
alter table people_signals    enable row level security;
alter table feed_signals      enable row level security;
alter table reddit_leads      enable row level security;
alter table news_signals      enable row level security;
alter table account_scores    enable row level security;
alter table enriched_contacts enable row level security;

-- Allow anon reads (for reporting/dashboards)
create policy "anon_read_companies"         on companies         for select using (true);
create policy "anon_read_job_signals"       on job_signals       for select using (true);
create policy "anon_read_people_signals"    on people_signals    for select using (true);
create policy "anon_read_feed_signals"      on feed_signals      for select using (true);
create policy "anon_read_reddit_leads"      on reddit_leads      for select using (true);
create policy "anon_read_news_signals"      on news_signals      for select using (true);
create policy "anon_read_account_scores"    on account_scores    for select using (true);
create policy "anon_read_enriched_contacts" on enriched_contacts for select using (true);

-- Service role gets full access (bypasses RLS — no explicit policy needed for service key)
-- Scripts should use SUPABASE_SERVICE_KEY for write operations.
