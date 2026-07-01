---
name: account-qualification
description: "Systematically evaluate whether a target account is worth pursuing. Scoring frameworks, qualification criteria, and prioritization models that prevent wasted outreach on bad-fit prospects."
---

# Account Qualification

## When to Use
- Evaluating a new lead list before launching campaigns
- Prioritizing which accounts to target first from a large TAM
- Building qualification workflows for SDRs or AI enrichment pipelines
- Deciding whether to continue pursuing an account after no initial response

## Framework

### The Qualification Stack

Account qualification happens at three levels. Each level adds confidence but also adds cost (time, data credits, manual research). Match the depth to the deal value.

```
Level 1: Automated Screening (seconds per account)
    Filters: firmographic + technographic data
    Purpose: Remove obvious disqualifiers
    Output: "Pass" or "Fail" — binary

Level 2: Enriched Scoring (minutes per account)
    Adds: intent signals, hiring data, funding status
    Purpose: Rank and tier qualified accounts
    Output: Score (0-100) + Tier assignment

Level 3: Deep Qualification (30-60 min per account)
    Adds: manual research, contact mapping, trigger analysis
    Purpose: Build account plan for Tier 1 targets
    Output: Full account brief + recommended approach
```

**When to use each level:**
- Level 1: Every lead, always. This is your spam prevention layer.
- Level 2: Leads that pass Level 1 (typically 40-60% of your list).
- Level 3: Only Tier 1 and high-value Tier 2 accounts (top 5-15% of your list).

---

### Level 1: Automated Screening

Run every lead through these binary filters before any outreach:

#### Hard Disqualifiers (Instant Remove)

| Filter | Disqualify If | Rationale |
|--------|--------------|-----------|
| **Company size** | Outside your serviceable range | Can't serve them / can't afford you |
| **Industry** | In an excluded vertical | Regulatory, ethical, or capability reasons |
| **Geography** | In a restricted market | Can't sell there (legal, timezone, language) |
| **Existing customer** | Already in your CRM as active | Don't cold email your own customers |
| **Competitor** | They are a direct competitor | Creates awkwardness, unlikely to buy |
| **Email validity** | Invalid/catch-all email | Hurts deliverability if you send |
| **Do-not-contact list** | Previously opted out or requested removal | Legal compliance (CAN-SPAM, GDPR) |
| **Duplicate** | Already in an active campaign | Don't double-email prospects |

#### Soft Disqualifiers (Flag for Review)

| Filter | Flag If | Action |
|--------|---------|--------|
| **Company age < 1 year** | Very early stage, may not have budget | Move to nurture, not outbound |
| **No website** | Can't verify legitimacy | Research manually before including |
| **Generic email only** | No personal email found | Lower priority, but don't auto-remove |
| **Title mismatch** | Title doesn't match target persona | Check manually — titles vary widely |

---

### Level 2: Enriched Scoring

For accounts that pass Level 1, build a composite score across four dimensions:

#### The FITS Framework

| Dimension | What It Measures | Weight | Scoring Range |
|-----------|-----------------|--------|---------------|
| **F — Firmographic Fit** | Does the company match your ICP? | 25% | 0-25 points |
| **I — Intent Signals** | Is the company in-market now? | 35% | 0-35 points |
| **T — Technographic Match** | Does their stack indicate fit? | 20% | 0-20 points |
| **S — Structural Readiness** | Can they actually buy and implement? | 20% | 0-20 points |

**Total: 100 points**

#### Firmographic Fit Scoring (25 points)

| Attribute | Tier 1 Points | Tier 2 Points | Tier 3 Points |
|-----------|---------------|---------------|---------------|
| Company size in sweet spot | 8 | 5 | 2 |
| Revenue in target range | 5 | 3 | 1 |
| Industry is primary vertical | 5 | 3 | 1 |
| Growth stage matches | 5 | 3 | 1 |
| Geography is primary market | 2 | 1 | 0 |

#### Intent Signal Scoring (35 points)

| Signal | Points | Detection Method |
|--------|--------|-----------------|
| Hiring for role your product serves | 10 | Job board monitoring |
| Recent funding (< 6 months) | 8 | Crunchbase, news alerts |
| Evaluating competitors (G2, review sites) | 10 | Intent data providers |
| Leadership change in target dept | 5 | LinkedIn alerts |
| Website visits (if available) | 7 | Website tracking |
| Content engagement (webinar, guide download) | 5 | Marketing automation |

#### Technographic Match Scoring (20 points)

| Signal | Points | Detection Method |
|--------|--------|-----------------|
| Uses your integration partners | 6 | BuiltWith, tech detection |
| Uses a competitor (displacement opportunity) | 8 | Tech detection, G2 reviews |
| Recently adopted adjacent tech | 4 | Job descriptions, tech detection |
| Tech sophistication matches your buyer | 2 | Overall stack analysis |

#### Structural Readiness Scoring (20 points)

| Signal | Points | How to Assess |
|--------|--------|--------------|
| Has the right budget authority title | 6 | LinkedIn search |
| Team size indicates need | 4 | Company data, job postings |
| Not in a buying freeze (no layoffs) | 4 | News, LinkedIn |
| Short sales cycle indicators | 3 | Company stage, deal size |
| Decision committee is small (< 5 people) | 3 | Company size/stage proxy |

#### Tier Assignment

| Score Range | Tier | Action |
|-------------|------|--------|
| 80-100 | Tier 1: Bullseye | Multi-channel, hyper-personalized |
| 60-79 | Tier 2: Strong Fit | Signal-based personalization |
| 40-59 | Tier 3: Good Fit | Bucket personalization |
| 20-39 | Tier 4: Stretch | Small batch test only |
| 0-19 | Disqualified | Remove from list |

---

### Level 3: Deep Qualification (Tier 1 Only)

For your highest-value targets, build a full account brief:

#### Account Brief Template

```
ACCOUNT BRIEF: {{companyName}}
Qualification Score: {{score}}/100 (Tier {{tier}})
Date: {{date}}
Researcher: {{name}}

--- COMPANY OVERVIEW ---
Company: {{companyName}}
Website: {{url}}
Industry: {{industry}}
Size: {{employees}} employees
Revenue: {{revenue}} (estimated)
Stage: {{fundingStage}}
Founded: {{year}}
HQ: {{location}}

--- WHY THIS ACCOUNT ---
Primary signal: {{strongestSignal}}
Secondary signals: {{additionalSignals}}
Timing rationale: {{whyNow}}

--- CONTACT MAP ---
| Name | Title | Role in Deal | LinkedIn | Email |
|------|-------|-------------|----------|-------|
| ___ | ___ | Economic Buyer | ___ | ___ |
| ___ | ___ | Champion | ___ | ___ |
| ___ | ___ | Influencer | ___ | ___ |

--- RECOMMENDED APPROACH ---
Lead with persona: {{primaryContact}}
Opening angle: {{angle}}
Personalization hook: {{specificHook}}
Expected objection: {{likelyObjection}}
Proof point to use: {{bestCaseStudy}}

--- COMPETITIVE CONTEXT ---
Current solution: {{currentTool}}
Likely alternatives they'll evaluate: {{competitors}}
Our positioning: {{differentiator}}
```

---

### Re-Qualification: When to Stop Pursuing

Not every qualified account will respond. Here's when to move on:

| Scenario | Action | When to Re-engage |
|----------|--------|-------------------|
| No reply after full sequence (4 steps) | Pause. Move to nurture. | Re-engage only with a NEW signal |
| Replied "not interested" | Remove from active campaigns | Never re-engage on same angle. Wait 6+ months with new signal only |
| Replied "not now" | Add to time-based nurture | Re-engage in 30-60 days with new value |
| Replied "talk to someone else" (referral) | Contact the referral immediately | This is a win, not a rejection |
| Bounced email | Find alternate contact or remove | Only re-engage if you find a valid contact |
| Company went through major change (layoffs, merger) | Re-score the account | May upgrade or disqualify based on change |

---

### Batch Qualification Workflow

For processing large lists (1,000+ leads) efficiently:

```
Step 1: Import raw list
    ↓
Step 2: Run Level 1 automated screening
    → Remove disqualified (typically 20-40% of list)
    ↓
Step 3: Enrich remaining leads
    → Add firmographic, technographic, intent data
    ↓
Step 4: Run Level 2 FITS scoring
    → Assign tiers (Tier 1-4 or DQ)
    ↓
Step 5: Review Tier 1 accounts
    → Build account briefs (Level 3)
    → Validate contact data
    ↓
Step 6: Route to campaigns
    → Tier 1 → Multi-channel sequence
    → Tier 2 → Signal-based email sequence
    → Tier 3 → Bucket personalization email sequence
    → Tier 4 → Test batch (validate before scaling)
```

**Expected conversion through the funnel:**
- Raw list: 5,000 leads
- After Level 1 screening: 3,000-4,000 (60-80% pass)
- Tier 1: 150-500 (5-10%)
- Tier 2: 600-1,200 (20-30%)
- Tier 3: 1,200-2,000 (40-50%)
- Tier 4 or DQ: remainder

## Templates

### Quick Qualification Scorecard
```
Account: {{companyName}}
Date: {{date}}

Level 1 Screening: [ ] PASS  [ ] FAIL
  Reason if fail: ___

FITS Score:
  F (Firmographic):  ___/25
  I (Intent):        ___/35
  T (Technographic): ___/20
  S (Structural):    ___/20
  TOTAL:             ___/100

Tier Assignment: ___
Recommended Action: ___
Priority Signal: ___
```

## Tips
- Qualification is an investment, not a cost. Every minute spent qualifying saves 10 minutes of wasted outreach on bad-fit accounts.
- The most common qualification mistake: over-weighting firmographics and under-weighting intent. A small company that's actively hiring for your use case is a better prospect than a large company with no buying signals.
- Build your qualification scoring model from closed-won data, not assumptions. Which attributes did your actual customers have when they bought? Those are your highest-weight factors.
- Intent signals decay fast. A job posting from 3 months ago is stale. A funding round from 6 months ago is old news. Recency matters — weight recent signals 2x over older ones.
- When in doubt, qualify OUT. It's better to email 1,000 highly qualified leads than 5,000 mediocre ones. Your reply rate, deliverability, and team efficiency all improve with a tighter list.
- Qualification criteria should be different for different campaign types. An ABM campaign (5-50 accounts) needs Level 3 qualification. A scaled outbound campaign (5,000 accounts) only needs Level 1-2.

---

*Progressive disclosure: load industry-specific qualification benchmarks and data provider integrations only when qualifying accounts for a specific campaign.*
