# Reddit Lead Finder — Team Guide

## What This Tool Does

This tool finds potential customers on Reddit who are talking about problems we solve. It searches cybersecurity subreddits, pulls in real conversations, and uses AI to score each person as a potential lead.

**The 5 topic areas we track:**

| Topic | What We're Looking For |
|-------|----------------------|
| **IAM** (Identity & Access Management) | People struggling with SSO, user provisioning, identity governance, IGA |
| **PAM** (Privileged Access Management) | People managing admin accounts, evaluating CyberArk/BeyondTrust/Delinea, JIT access, session recording, service accounts |
| **DevSecOps** | Engineers managing secrets management, Kubernetes vault, cloud IAM, credential rotation |
| **GRC** (Governance, Risk & Compliance) | People dealing with compliance audits (SOX, HIPAA, PCI DSS), risk frameworks, policy management |
| **Governance** | People discussing security strategy, board reporting, security program maturity |

**What counts as a "lead":** Someone whose organization could benefit from our cybersecurity services. They might be complaining about a manual process, asking for tool recommendations, or describing a pain point we can solve.

---

## One-Time Setup

### 1. Get your Apify API token

1. Go to [console.apify.com](https://console.apify.com)
2. Sign up or log in
3. Go to **Settings > Integrations**
4. Copy your **API Token**

### 2. Set up your environment file

In the project folder, you'll see a file called `.env.example`. Make a copy of it called `.env`:

```bash
cp .env.example .env
```

Open `.env` and paste your Apify token:

```
APIFY_API_TOKEN=apify_api_XXXXXXXXXXXXXXXXXXXXX
```

### 3. (Recommended) Set up Supabase as the data layer

Supabase stores all scraped data, scored leads, and signals in one place — enabling cross-topic deduplication and unified account views.

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **Settings > API** and copy your **Project URL** and **service_role** key
3. Add to `.env`:
   ```
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   ```
4. In the Supabase **SQL Editor**, paste and run the full contents of `supabase/migrations/001_initial_schema.sql`

> **What it enables:** All scrapers automatically dedup against Supabase instead of local `.seen-urls.json` files. Scored leads sync with `supabase-sync.js`. The `notify.js` script can query HOT leads directly from Supabase when no file is given.

### 4. (Optional) Set up Parallel.ai for company news enrichment

Parallel.ai is the primary news source for `account-signals.js` — it powers breach, funding, CISO-change, M&A, and compliance-signal research. Used automatically unless you pass `--no-enrich`.

1. Install the CLI: `npm install -g parallel-web-cli` (or `brew install parallel-web/tap/parallel-cli`). If the npm global bin directory isn't on your `PATH`, point the adapter at the binary in `.env` instead:
   ```
   PARALLEL_CLI=/absolute/path/to/parallel-cli   # e.g. ~/.npm-global/bin/parallel-cli
   ```
2. Authenticate with `parallel-cli login`, or set the key directly in `.env`:
   ```
   PARALLEL_API_KEY=your_parallel_api_key_here
   ```

### 5. (Optional) Set up research engines for deep prospect research

`enrich-leads.js` supports two research engines — Perplexity and Exa. Use one or both:

**Perplexity (`--research` flag):**

1. Go to [docs.perplexity.ai](https://docs.perplexity.ai/) and sign up
2. Go to API Settings → create an API key
3. Add it to `.env`:

```
PERPLEXITY_API_KEY=pplx-xxxxxxxxxxxxxxxxxxxx
```

> **Cost:** ~$0.005 per query. A typical enrichment run with 10 users costs ~$0.10 for the Perplexity portion.

**Exa (`--exa` flag):**

1. Go to [exa.ai](https://exa.ai/) and sign up
2. Add it to `.env`:

```
EXA_API_KEY=your_exa_api_key_here
```

Also used by `account-signals.js` as a secondary lookup source. Optional Sherlock username-discovery is available if the `sherlock` CLI is installed locally.

### 6. (Optional) Set up Slack notifications

If you want to get Slack alerts when HOT leads are found, add your Slack webhook URL to `.env`:

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

---

## The Workflow

There are 7 steps. Steps 1-5 cover the Reddit pipeline. Step 6 adds LinkedIn signal scanning. Step 7 qualifies accounts across all signals.

```
Reddit:    Step 1: Scrape  →  Step 2: Filter  →  Step 3: Score  →  Step 3b: Sync to Supabase
LinkedIn:  Step 6: Scan LinkedIn (Jobs / People / Companies / Feed)
                                    ↓
                           Supabase (all signals)
                                    ↓
                    Step 7: Account Signals (Parallel.ai/Exa + registries) → Qualify Accounts
                                    ↓
           Step 4: Review  →  Step 5: Enrich  →  Notify HOT Leads
```

---

### Step 1: Scrape Reddit

**What you're doing:** Pulling recent posts and comments from Reddit about a specific topic.

**Pick a topic and copy-paste the command:**

#### GRC
```bash
node scripts/reddit-scraper.js \
  "https://www.reddit.com/r/grc/" \
  "https://www.reddit.com/r/cybersecurity/search/?q=GRC&sort=top&t=year" \
  --topic GRC --max-posts 15 --since 30d
```

#### IAM (Identity & Access Management)
```bash
node scripts/reddit-scraper.js \
  "https://www.reddit.com/r/IdentityManagement/" \
  "https://www.reddit.com/r/cybersecurity/search/?q=identity+access+management" \
  --topic IdentityManagement --max-posts 15 --since 30d
```

#### PAM (Privileged Access Management)
```bash
node scripts/reddit-scraper.js \
  "https://www.reddit.com/r/cybersecurity/search/?q=privileged+access+management" \
  "https://www.reddit.com/r/cybersecurity/search/?q=CyberArk+OR+BeyondTrust+OR+Delinea+privileged" \
  "https://www.reddit.com/r/sysadmin/search/?q=privileged+access+management" \
  "https://www.reddit.com/r/sysadmin/search/?q=password+vaulting+OR+service+account+management" \
  "https://www.reddit.com/r/netsec/search/?q=zero+standing+privileges+OR+just-in-time+access" \
  --topic PAM --max-posts 20 --since 30d
```

#### DevSecOps (Secrets Management / Cloud PAM)
```bash
node scripts/reddit-scraper.js \
  "https://www.reddit.com/r/devops/search/?q=secrets+management+OR+credential+rotation" \
  "https://www.reddit.com/r/devops/search/?q=hashicorp+vault+OR+service+account" \
  "https://www.reddit.com/r/kubernetes/search/?q=secrets+management+OR+vault+secrets" \
  "https://www.reddit.com/r/aws/search/?q=IAM+OR+secrets+manager+OR+privileged+access" \
  --topic DevSecOps --max-posts 15 --since 30d
```

#### Governance
```bash
node scripts/reddit-scraper.js \
  "https://www.reddit.com/r/grc/" \
  "https://www.reddit.com/r/cybersecurity/search/?q=security+governance" \
  --topic Governance --max-posts 10 --since 30d
```

**What the options mean:**

| Option | What it does | Example |
|--------|-------------|---------|
| `--topic NAME` | Which folder to save results to | `--topic GRC` |
| `--max-posts N` | How many posts to grab per URL | `--max-posts 15` |
| `--max-comments N` | How many comments to grab per URL | `--max-comments 10` |
| `--since DURATION` | Only get posts from the last X days/hours/weeks | `--since 7d`, `--since 24h`, `--since 2w` |
| `--sort ORDER` | How to sort results | `--sort top`, `--sort new` |
| `--parallel N` | Scrape multiple URLs at the same time (faster) | `--parallel 3` |

**What to expect:** You'll see a progress counter as it scrapes. When done, it shows a summary like:

```
Results saved to: data/GRC/Scrapes/scrape-2026-03-11T14-30.json

=== SUMMARY ===
Total items (deduplicated): 51
Posts: 6
Comments: 45
```

**Where results go:** `data/<Topic>/Scrapes/` subfolder.

> **Tip:** If you're scraping multiple URLs and want it to go faster, add `--parallel 3` to scrape 3 URLs at the same time.

> **Tip:** The tool automatically remembers what it already scraped. If you run the same topic again later, it won't grab duplicate posts.

---

### Step 2: Filter the Data

**What you're doing:** Removing noise — bots, students asking career questions, deleted posts — so Claude only sees real potential leads.

**Copy-paste this command** (replace the file path with your actual scrape file):

```bash
node scripts/lead-scorer.js data/GRC/Scrapes/scrape-2026-03-11T14-30.json --topic GRC
```

> **How to find the file path:** After Step 1, the tool prints "Results saved to: ..." — use that path.

**What to expect:** A breakdown showing what was filtered:

```
Pre-filter results:
  Total items in file: 51
  Filtered out: 9
    Bots/automoderator: 3
    Deleted/removed:    2
    Too short (<30ch):  1
    Career seekers:     3
  Remaining for Claude to score: 42

Formatted 42 items → data/GRC/pending-leads.txt
```

**Where results go:** Creates `data/<Topic>/pending-leads.txt`. This is what Claude will read next.

> **Optional:** Add `--since 7d` to also remove posts older than 7 days.

---

### Step 3: Score the Leads with Claude

**What you're doing:** Asking Claude AI to read through each post/comment and rate it as a potential lead.

**Open Claude and paste this exact prompt:**

```
Score the leads in data/GRC/pending-leads.txt

For each item, score it 1-10 as a B2B lead for our cybersecurity services
(IAM, GRC, PAM, and security governance).

Score criteria:
- 8-10 (HOT): They work at a company, have decision-making power, and are
  actively looking for solutions we offer. Reach out immediately.
- 5-7 (WARM): They're a practitioner in our space with pain points, but
  aren't actively buying yet. Worth tracking.
- 1-4 (COLD): Mentioned something relevant but unlikely to become a customer.

For each lead include:
- score and tier (HOT/WARM/COLD)
- author and subreddit
- a short excerpt of what they said
- why you gave that score
- a suggested outreach message (personalized to their specific pain point)

Save the results as:
- data/GRC/Leads/leads-2026-03-11.json (structured data)
- data/GRC/Leads/leads-2026-03-11.md (readable report)
```

> **Change the topic/date as needed.** Replace `GRC` with your topic name, and use today's date.

**What Claude creates:**

1. **A readable report** (`leads-2026-03-11.md`) — Open this to review leads
2. **A data file** (`leads-2026-03-11.json`) — Used by the notification tool

---

### Step 3b: Sync Scored Leads to Supabase

After Claude scores leads and saves the JSON file, push the results to Supabase:

```bash
node scripts/supabase-sync.js data/GRC/Leads/leads-2026-04-02.json
```

This updates `lead_score`, `lead_tier`, `excerpt`, `reasoning`, and `suggested_outreach` for each lead in Supabase. Leads already in the database are updated; new ones are inserted.

> **Requires:** `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `.env` (see Setup step 3).

---

### Step 4: Review the Leads

Open the markdown report in your topic's `Leads/` folder. Here's what a lead looks like:

---

#### Example: HOT Lead

> **[1] u/RaNdomMSPPro — Score: 8/10**
> Type: Comment · r/cybersecurity
>
> *"GRC is the sort of work that is ripe for efficiency. We often have all the info, then have to waste days inputting it into someplace else to get the output. Then manually update every quarter or year."*
>
> **Why this is a lead:** Directly articulates a pain point — manual data entry and quarterly updating is wasted effort. Works in MSP/GRC space. Primed for a pitch around GRC automation and managed services.
>
> **Suggested outreach:** "You've nailed the problem. We help teams eliminate that manual input cycle — integrations that pull live data so your reports update automatically. Worth a 15-min call?"

---

#### Example: WARM Lead

> **[2] u/mageevilwizardington — Score: 7/10**
> Type: Comment · r/cybersecurity
>
> *"People want to make GRC staff accountable only when there is a regulatory compliance matter. But management does not understand that a strong GRC strategy should rule the operational and technical aspects."*
>
> **Why this is a lead:** Senior strategic frustration — GRC treated as a reactive checkbox, not an operational framework. Likely advises leadership on GRC programs.
>
> **Suggested outreach:** "You're describing exactly why reactive GRC fails. We help orgs embed GRC into operational processes before audits hit. Happy to share how we've done this for similar companies."

---

### How to Read the Scores

| Score | Tier | What It Means | What To Do |
|-------|------|--------------|------------|
| **8-10** | HOT | This person works at a company and is actively looking for solutions we offer. They have buying power or influence. | **Reach out now.** Use the suggested pitch as a starting point. Personalize it. |
| **5-7** | WARM | They work in our space and have real pain points, but aren't actively shopping for a solution right now. | **Add to your nurture list.** Follow them, engage with their posts, reach out when timing is right. |
| **1-4** | COLD | They mentioned something relevant but are unlikely to become a customer. Could be a student, career-changer, or casual observer. | **Skip** unless you have extra time. |

### What Each Field Means

| Field | What It Tells You |
|-------|------------------|
| **Author** | Their Reddit username. Click through to see their post history and learn more about them. |
| **Subreddit** | Which community they posted in. |
| **Excerpt** | The most relevant part of what they wrote. |
| **Why** / **Reasoning** | Why Claude gave this score — what signals indicate they're a lead. |
| **Suggested Pitch** | A draft outreach message tailored to their specific situation. **Always customize before sending.** |
| **URL** | Direct link to their post or comment on Reddit. |

---

### Step 5: Enrich Leads for Outreach

**What you're doing:** Scraping the full Reddit history of your HOT and WARM leads, then researching them to find company names, job titles, and contact info (LinkedIn, email) for actual outreach.

There are two modes:

#### Mode A: Scrape + Manual Claude Research (no Perplexity key needed)

Scrapes Reddit profiles and creates a file for Claude to analyze manually:

```bash
node scripts/enrich-leads.js data/IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --tiers HOT
```

This creates `pending-enrichment.txt`. Then ask Claude to analyze it (see prompt below).

#### Mode B: Fully Automated with Perplexity Research (recommended)

Scrapes Reddit profiles **and** automatically researches each prospect using Perplexity Sonar AI — finds LinkedIn profiles, real names, company info, and emails:

```bash
node scripts/enrich-leads.js data/IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --tiers HOT --research
```

> **Requires:** `PERPLEXITY_API_KEY` in your `.env` file (see Setup step 3).

#### Mode C: Research Only (use cached profiles)

If you already scraped profiles and just want to run the Perplexity research step:

```bash
node scripts/enrich-leads.js data/IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --tiers HOT --research-only
```

This skips Apify (no scraping cost) and uses the profile data already saved in `Profiles/`.

**All options:**

| Option | What it does | Example |
|--------|-------------|---------|
| `--topic NAME` | Which folder to save results to | `--topic GRC` |
| `--tiers TIERS` | Which lead tiers to enrich | `--tiers HOT` or `--tiers HOT,WARM` |
| `--max-users N` | Cap how many users to scrape (cost control) | `--max-users 5` |
| `--max-items N` | Max Reddit posts/comments per user | `--max-items 50` |
| `--skip-scraped` | Skip users already in Profiles/ folder | |
| `--research` | Enable Perplexity deep research after scraping | |
| `--research-only` | Skip scraping, run Perplexity research on cached profiles | |
| `--exa` | Use Exa.ai instead of Perplexity for deep research | |

**What to expect with `--research`:**

```
Will scrape 2 user profile(s)
Estimated cost: ~$0.60 (100 items/user at $0.003/result)

[1/2] Scraping u/foxhelp (HOT)...
[1/2]   Fetched 100 items
[1/2]   Saved to data/IdentityManagement/Profiles/foxhelp.json

--- Perplexity Deep Research ---
[1/2] Extracting signals for u/foxhelp...
[1/2]   Company hints: public sector, Alberta, 100k+ accounts
[1/2]   Role hints: IAM engineer, 6 years experience
[1/2] Researching u/foxhelp via Perplexity Sonar...
[1/2]   LinkedIn: found
[1/2]   Company: confirmed

Enriched reports saved:
  data/IdentityManagement/Enriched/enriched-2026-03-17.json
  data/IdentityManagement/Enriched/enriched-2026-03-17.md
```

**How the automated research works:**

1. **Signal extraction** — Analyzes each user's Reddit posts locally for company hints ("at my org", "we use"), role hints ("I manage", "as an engineer"), location clues, tech stack mentions, and vendor affiliation flags
2. **Perplexity Sonar query** — Feeds those signals into a targeted research prompt: *"Find the LinkedIn profile and employer of this IAM professional in Alberta, Canada who works at a 100k+ account public sector org..."*
3. **Result parsing** — Extracts LinkedIn URLs, emails, real names, and company confirmations from Perplexity's AI-synthesized response
4. **Vendor detection** — Automatically flags and skips users who repeatedly promote specific products (likely vendor/marketing accounts)

**If not using `--research`, ask Claude manually:**

```
Enrich the leads in data/IdentityManagement/pending-enrichment.txt

For each user, analyze their Reddit history and extract:
- Company/employer, job title, industry, location
- Technologies they use, pain points, buying signals
- Then web search for their LinkedIn profile and email

Save results as:
- data/IdentityManagement/Enriched/enriched-2026-03-14.json
- data/IdentityManagement/Enriched/enriched-2026-03-14.md
```

**Where results go:** `data/<Topic>/Profiles/` (raw data) and `data/<Topic>/Enriched/` (final reports).

> **Tip:** Use `--max-users 2 --tiers HOT` for a cheap first test run (~$0.60 for Apify + ~$0.02 for Perplexity).

> **Tip:** Use `--skip-scraped` on reruns to avoid re-scraping users you already have data for.

> **Tip:** Use `--research-only` after the first run to re-research with zero Apify cost.

---

## Step 6: LinkedIn Signal Scanning

**What you're doing:** Scanning LinkedIn for hiring signals, new security leadership hires, and company intelligence — the highest-ROI signal sources according to the Intent Signals Playbook.

There are **3 separate tools**, each targeting a different LinkedIn signal source:

### Tool 1: LinkedIn Jobs Scanner (`linkedin-jobs.js`)

Searches LinkedIn job postings for cybersecurity hiring signals. Extracts competitor tools, compliance frameworks, and pain language from job descriptions.

```bash
node scripts/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=IAM+Engineer&f_TPR=r604800" --topic IdentityManagement
```

> **Note:** `linkedin-jobs.js` accepts one or more LinkedIn Jobs search URLs as positional arguments, then applies scoring locally. Use LinkedIn's job search to build the URL (filter by keyword, location, recency), then pass it here.

**Signal categories extracted from each posting:**

| Category | What It Searches For |
|----------|---------------------|
| `iam` | IAM Engineer, Okta admin, SailPoint, Zero Trust architect |
| `grc` | GRC Analyst, SOC 2, HIPAA, ISO 27001, CMMC compliance |
| `pam` | CyberArk, BeyondTrust, privileged access, JIT access |
| `ciso` | CISO, VP InfoSec, Director InfoSec, Head of Cybersecurity |
| `all` | Run all categories (default) |

**What it extracts from each job posting:**
- **Competitor tools** in the JD (Okta, CyberArk, SailPoint, etc.) = active buyer, proven budget
- **Compliance frameworks** cited (SOC 2, HIPAA, ISO 27001) = compliance pressure
- **Pain language** ("manual," "lack of visibility," "access sprawl") = buying signal
- **Company segment** by employee count: A (1000+), B (100-999), C (<100)

**Scoring:** Each signal gets a score out of 50 using the playbook's system. Multiple signals from the same company create "signal stacks" with higher combined scores.

> **Tip:** Use `--dry-run` first to see what queries will run without spending Apify credits.

> **Tip:** Use `--count 5 --dry-run` first to preview what will be scraped before spending credits.

### Tool 2: LinkedIn People Scanner (`linkedin-people.js`)

Finds new CISO/IT Director/Security Manager hires. The playbook identifies a **90-day vendor selection window** after a new security leader is hired.

```bash
node scripts/linkedin-people.js --topic IdentityManagement --category ciso --since 90d
```

**Categories:**

| Category | Who It Finds |
|----------|-------------|
| `ciso` | CISO, Chief Information Security Officer, vCISO |
| `director` | VP InfoSec, Director InfoSec, Head of Cybersecurity/Identity |
| `manager` | Security Manager, IT Security Manager, Compliance Officer |
| `all` | All role types (default) |

### Tool 3: LinkedIn Company Enrichment (`linkedin-companies.js`)

Enriches a CSV of target company LinkedIn URLs. Scrapes company pages for employee count, growth signals, compliance certifications, and security specialties.

```bash
node scripts/linkedin-companies.js target-accounts.csv --topic IdentityManagement
```

**CSV format — two options:**

**URL-only (one per line, no header):**
```
https://linkedin.com/company/acme-corp
https://linkedin.com/company/globex
```

**With metadata (LinkedIn URL is the unique key):**
```csv
company_name,linkedin_url,industry,employee_count,segment
Acme Corp,https://linkedin.com/company/acme-corp,SaaS,1500,A
Globex,https://linkedin.com/company/globex,Healthcare,200,B
```

The script auto-detects the LinkedIn URL column and merges your CSV metadata with scraped data.

> **Tip:** Use `--max-companies 5 --dry-run` to preview what will be scraped.

> **Tip:** Use `--skip-scraped` to avoid re-scraping companies from previous runs.

### LinkedIn Options Reference

| Option | Script(s) | What it does |
|--------|-----------|-------------|
| `--topic <Name>` | All 3 | Topic directory for output |
| `--category <cat>` | people only | Filter role type (ciso, director, manager, all) |
| `--max-results <N>` | jobs, people | Max results per query (default: 25) |
| `--max-companies <N>` | companies | Cap companies to scrape |
| `--since <duration>` | jobs, people | Recency filter (e.g., 7d, 30d, 90d) |
| `--score-threshold <N>` | jobs | Only output signals scoring >= N |
| `--skip-scraped` | companies | Skip previously scraped companies |
| `--dry-run` | All 3 | Print what would run without calling Apify |

### Playbook Scoring System

Each signal is scored out of 50 based on the Intent Signals Playbook:

| Signal | Base Score | Bonus | Priority |
|--------|-----------|-------|----------|
| Hiring CISO + IAM engineer (same company) | 42 | +5 if competitor tool in JD | Critical — 24hr |
| SOC 2 audit + hiring compliance role | 40 | +3 if Vanta/Drata detected | Critical — 48hr |
| New CISO hired (within 90 days) | 35 | +5 if no IAM vendor detected | High — 3-day |
| Competitor tool in job posting | 32 | +5 if multiple postings | High — week 1 |
| Hiring Security/GRC role | 25 | +3 if compliance framework cited | Medium |
| LinkedIn post about access pain | 22 | +5 if person identified | Medium |

**Where results go:** `data/<Topic>/LinkedIn/` folder with JSON + markdown reports.

---

## Step 7: Account Signals

**What you're doing:** Taking a CSV of target companies and running them through every signal source at once — news research, breach/compliance registries, job boards, LinkedIn enrichment, and existing local scan data — then scoring, stacking, and ranking them so you know exactly who to contact first.

```bash
node scripts/account-signals.js target-accounts.csv
```

**Signal sources fanned out per account:**

| Source | What it finds |
|--------|---------------|
| Parallel.ai news (`parallel-news`) | Breach/ransomware, funding, CISO hires, M&A — primary news source, requires `parallel-cli` + `PARALLEL_API_KEY` |
| Exa.ai news (`exa-news`) | Same categories as Parallel, used as an alternate/secondary provider |
| HHS OCR breach portal (`hhs-breach`) | Confirmed healthcare breach disclosures |
| Maine AG breach registry (`maine-ag-breach`) | State-level breach notifications (upstream database offline since mid-2026 — reported under "Sources unavailable" until it returns) |
| SEC EDGAR full-text search (`sec-edgar`) | 8-K Item 1.05 breach disclosures, Form D funding filings |
| ransomware.live (`ransomware-watch`) | Public ransomware victim listings |
| Job boards (`job-boards`) | Greenhouse/Lever/Ashby postings — competitor tools, compliance frameworks, and CISO/IAM/GRC hiring signals in the JD |
| Local scans (`local-scans`) | Rolls in existing LinkedIn jobs/people/feed scan data already saved under `data/` |

Each source runs independently — if one fails (missing auth, upstream outage, rate limit), the run keeps going. Failed sources for an account are listed under **"Sources unavailable this run"** in that account's brief instead of crashing the pipeline.

**Options:**

```
--client <name>      Client config from clients/<name>.json (default: default)
--min-score <N>      Only include accounts scoring >= N (default: 15)
--max-companies <N>  Only process the first N accounts from the CSV
--no-enrich          Skip news/registry/job-board adapters (local data only, faster, free)
--no-linkedin        Skip LinkedIn Apify company enrichment
--no-people          Skip decision-maker discovery
--no-notify          Skip Slack/macOS notifications
--dry-run            Show the plan without making API calls
```

**Per-client configuration (`clients/<name>.json`):** Scoring weights (`signalDefs`, with per-type `base` points and `halfLifeDays` decay), signal stacks, tier thresholds, competitor company lists, and news search queries are all defined per client instead of hardcoded. Pass `--client acme` to load `clients/acme.json`; omit it to use `clients/default.json`. Copy `clients/default.json` to start a new client config.

**Supabase schema:** Account signals persist through `supabase/migrations/002_signal_hub.sql` (run it in the SQL Editor after `001_initial_schema.sql`). It adds a normalized `signal_events` table, a `runs` audit table, score snapshots, and feedback fields (`contacted_at`, `replied`, `meeting`, `outcome`) on `companies` for tracking outreach outcomes.

**Where results go:**

```
data/AccountSignals/<timestamp>/
├── ranked-accounts.md      ← Tier-sorted report — open this first
├── ranked-accounts.json    ← Same data, machine-readable
└── accounts/
    └── <company-slug>.md   ← Per-account brief: signals, score breakdown, stacks, decision-makers, and any unavailable sources
```

> **Tip:** Run `--dry-run` first to see which accounts, adapters, and client config will be used without spending any API calls.

> **Tip:** `--no-enrich --no-linkedin --no-people` runs entirely on local data — useful for a fast, free smoke test.

---

## Getting Notifications for HOT Leads

After Claude scores the leads, run:

```bash
node scripts/notify.js data/GRC/Leads/leads-2026-03-11.json
```

This will:
- Send a **macOS notification** to your screen for each HOT lead
- Send a **Slack message** (if you set up `SLACK_WEBHOOK_URL` in `.env`)

If Supabase is configured, you can also notify for all HOT leads in the database (no file needed):

```bash
node scripts/notify.js
```

---

## Bonus Tools

### Run all topics at once (with account signal enrichment)

Instead of scraping each topic one by one, run them all:

```bash
node scripts/schedule.js
```

This reads `scrape-config.json` and runs in order:
1. All Reddit scrapes (IAM, PAM, DevSecOps, GRC, Governance)
2. All LinkedIn job + people scans
3. All LinkedIn feed scans
4. **Account signals enrichment** (Parallel.ai/Exa news + registries + job boards) — if `accountSignalsRun` is set in `scrape-config.json`

To enable the account signals step, edit `scrape-config.json` and set `"accountSignalsRun"`:
```json
"accountSignalsRun": {
  "csvFile": "target-accounts.csv",
  "enrich": true,
  "maxCompanies": 20
}
```

### Set up weekly auto-scraping

Want it to run automatically every Monday at 8 AM?

```bash
node scripts/schedule.js --install
```

Check if it's installed:
```bash
node scripts/schedule.js --status
```

Remove it:
```bash
node scripts/schedule.js --uninstall
```

### See trends over time

After you've done several scrapes for a topic, see what's changing:

```bash
node scripts/trends.js GRC
```

This shows you:
- Are discussions growing or shrinking?
- What new keywords are trending?
- Which authors keep showing up? (Good people to build relationships with)

### Find new subreddits to scrape

Discover new communities based on what's mentioned in your existing scrapes:

```bash
node scripts/discover-subreddits.js GRC
```

Add `--keywords` to filter by specific terms:
```bash
node scripts/discover-subreddits.js IdentityManagement --keywords "SSO,SAML,Okta"
```

---

## URL Cheat Sheet

Use these URLs with `reddit-scraper.js`. You can mix and match — put multiple URLs in one command.

### Subreddit URLs (browse the whole community)

| URL | What It Covers |
|-----|---------------|
| `https://www.reddit.com/r/grc/` | GRC discussions |
| `https://www.reddit.com/r/IdentityManagement/` | IAM / IGA discussions |
| `https://www.reddit.com/r/cybersecurity/` | Broad cybersecurity |
| `https://www.reddit.com/r/sysadmin/` | IT admins (PAM, access control, service accounts) |
| `https://www.reddit.com/r/netsec/` | Security engineers (zero trust, JIT access, PAM architecture) |
| `https://www.reddit.com/r/devops/` | DevSecOps (secrets management, credential rotation) |
| `https://www.reddit.com/r/kubernetes/` | Kubernetes secrets management |
| `https://www.reddit.com/r/aws/` | Cloud IAM, AWS Secrets Manager, cloud PAM |
| `https://www.reddit.com/r/SecurityCareerAdvice/` | Security professionals |

### Search URLs (find specific topics across subreddits)

| URL | What It Searches For |
|-----|---------------------|
| `https://www.reddit.com/r/cybersecurity/search/?q=GRC` | GRC in r/cybersecurity |
| `https://www.reddit.com/r/cybersecurity/search/?q=identity+access+management` | IAM in r/cybersecurity |
| `https://www.reddit.com/r/cybersecurity/search/?q=identity+governance+OR+IGA` | IGA/identity governance |
| `https://www.reddit.com/r/cybersecurity/search/?q=security+governance` | Governance topics |
| `https://www.reddit.com/r/cybersecurity/search/?q=privileged+access+management` | PAM in r/cybersecurity |
| `https://www.reddit.com/r/cybersecurity/search/?q=CyberArk+OR+BeyondTrust+OR+Delinea+privileged` | PAM vendor comparisons |
| `https://www.reddit.com/r/sysadmin/search/?q=privileged+access+management` | PAM in r/sysadmin |
| `https://www.reddit.com/r/sysadmin/search/?q=password+vaulting+OR+credential+vault` | Credential management |
| `https://www.reddit.com/r/sysadmin/search/?q=service+account+management+OR+orphaned+accounts` | Service account pain |
| `https://www.reddit.com/r/netsec/search/?q=zero+standing+privileges+OR+least+privilege` | Zero trust / JIT access |
| `https://www.reddit.com/r/devops/search/?q=secrets+management+OR+credential+rotation` | Secrets management |
| `https://www.reddit.com/r/cybersecurity/search/?q=SOX+compliance+access+controls` | SOX compliance PAM |
| `https://www.reddit.com/r/cybersecurity/search/?q=PCI+DSS+privileged+access` | PCI DSS PAM |
| `https://www.reddit.com/r/cybersecurity/search/?q=HIPAA+access+management` | HIPAA compliance |

### Creating your own search URLs

To search for a custom term, use this format:

```
https://www.reddit.com/r/SUBREDDIT/search/?q=YOUR+SEARCH+TERMS
```

- Replace `SUBREDDIT` with the community name
- Replace spaces with `+`
- Use `OR` between terms to match any of them
- Example: `https://www.reddit.com/r/cybersecurity/search/?q=SOC+2+compliance+OR+ISO+27001`

To search across ALL of Reddit:
```
https://www.reddit.com/search/?q=YOUR+SEARCH+TERMS
```

---

## Where Everything Gets Saved

```
Your Project Folder/
├── data/                     ← ALL generated output lives here
│   ├── GRC/
│   │   ├── Scrapes/              ← Raw data from Reddit (Step 1)
│   │   │   └── scrape-2026-03-11T14-30.json
│   │   ├── Leads/                ← Scored leads (Step 3)
│   │   │   ├── leads-2026-03-11.json
│   │   │   └── leads-2026-03-11.md    ← Open this to review leads
│   │   ├── Profiles/             ← Reddit user profile data (Step 5)
│   │   │   └── Constant-Angle-4777.json
│   │   ├── Enriched/             ← Contact info & outreach data (Step 5)
│   │   │   ├── enriched-2026-03-11.json
│   │   │   └── enriched-2026-03-11.md  ← Open this for outreach info
│   │   ├── pending-leads.txt     ← Formatted data for Claude (Step 2)
│   │   └── pending-enrichment.txt ← Profile data for Claude (Step 5)
│   │
│   ├── IdentityManagement/       ← Same structure for each topic
│   │   ├── Scrapes/
│   │   ├── Leads/
│   │   ├── Profiles/
│   │   ├── Enriched/
│   │   └── LinkedIn/             ← LinkedIn signal scan results (Step 6)
│   │       ├── jobs-2026-03-19T14-30.json
│   │       ├── jobs-2026-03-19T14-30.md
│   │       ├── people-2026-03-19T15-00.json
│   │       ├── people-2026-03-19T15-00.md
│   │       ├── companies-2026-03-19T15-30.json
│   │       ├── companies-2026-03-19T15-30.md
│   │       └── .seen-urls.json   ← Local dedup fallback (replaced by Supabase when configured)
│   │
│   ├── PAM/
│   ├── DevSecOps/
│   ├── Governance/
│   ├── scrape-history.jsonl      ← Log of all Reddit scrape runs
│   ├── linkedin-history.jsonl    ← Log of all LinkedIn scan runs
│   └── enrichment-history.jsonl  ← Log of all enrichment runs
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Error: APIFY_API_TOKEN is not set"** | Open `.env` and make sure your token is there. No spaces around the `=` sign. |
| **Got 0 results** | Try using `--sort top` instead of the default. Some search URLs return 0 with `--sort new`. |
| **"Invalid Reddit URL"** | Make sure the URL starts with `https://www.reddit.com/` and points to a subreddit (`/r/...`) or search (`/search`). |
| **All items were filtered out** | The pre-filter removed everything. Try a different scrape file, or drop the `--since` flag to include older posts. |
| **Scrape is taking forever** | Apify jobs can take 1-5 minutes depending on how much data there is. If it times out after 5 minutes, try reducing `--max-posts` and `--max-comments`. |
| **"Failed to start scrape: HTTP 429"** | You've hit the Apify rate limit. The tool will automatically retry — just wait. If it keeps failing, wait a few minutes before trying again. |
| **"PERPLEXITY_API_KEY is not set"** | Add your Perplexity API key to `.env`. Get one at [docs.perplexity.ai](https://docs.perplexity.ai/). |
| **Perplexity research returned no results** | The prospect may be too anonymous. The script will still output Reddit-based signals. Try the manual Claude enrichment approach instead. |
| **"Supabase not configured"** | Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to `.env`. Scripts still work without Supabase — they fall back to local `.seen-urls.json` files. |
| **Supabase upsert returns 401/403** | Make sure you're using the `service_role` key (not the `anon` key) for write operations. The anon key is read-only. |
| **"parallel-cli failed" / `parallel-cli: command not found`** | Install with `npm install -g parallel-web-cli`. If the npm global bin isn't on `PATH`, set `PARALLEL_CLI=/path/to/parallel-cli` in `.env`. Then run `parallel-cli login` or set `PARALLEL_API_KEY` in `.env`. The Parallel.ai source shows up under "Sources unavailable this run" in the brief if it's still not authed — it won't crash the run. |

---

## Quick Reference

| What You Want To Do | Command |
|---------------------|---------|
| Scrape GRC subreddits | `node scripts/reddit-scraper.js "https://www.reddit.com/r/grc/" --topic GRC --since 7d` |
| Filter a scrape file for scoring | `node scripts/lead-scorer.js data/GRC/Scrapes/scrape-XXXX.json --topic GRC` |
| Check for HOT leads | `node scripts/notify.js data/GRC/Leads/leads-XXXX.json` |
| Enrich leads for outreach | `node scripts/enrich-leads.js data/GRC/Leads/leads-XXXX.json --topic GRC` |
| Enrich only HOT leads | `node scripts/enrich-leads.js data/GRC/Leads/leads-XXXX.json --topic GRC --tiers HOT` |
| Enrich with auto-research | `node scripts/enrich-leads.js data/GRC/Leads/leads-XXXX.json --topic GRC --tiers HOT --research` |
| Re-research cached profiles | `node scripts/enrich-leads.js data/GRC/Leads/leads-XXXX.json --topic GRC --research-only` |
| **LinkedIn: Scan job postings** | `node scripts/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=IAM+Engineer" --topic IdentityManagement` |
| **LinkedIn: Find new CISOs** | `node scripts/linkedin-people.js --topic IdentityManagement --category ciso` |
| **LinkedIn: Enrich companies** | `node scripts/linkedin-companies.js accounts.csv --topic IdentityManagement` |
| LinkedIn: Dry run (no cost) | `node scripts/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=IAM+Engineer" --dry-run` |
| **Sync scored leads to Supabase** | `node scripts/supabase-sync.js data/GRC/Leads/leads-XXXX.json` |
| **Notify HOT leads from Supabase** | `node scripts/notify.js` |
| Run all topics at once | `node scripts/schedule.js` |
| Auto-scrape every Monday | `node scripts/schedule.js --install` |
| See trends for a topic | `node scripts/trends.js GRC` |
| Find new subreddits | `node scripts/discover-subreddits.js GRC` |
