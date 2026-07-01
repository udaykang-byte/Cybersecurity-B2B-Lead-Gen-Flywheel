---
name: qualify-accounts
description: Qualify companies against ICP using the FITS framework (Firmographic, Intent, Technographic, Structural). Works with any pipeline output — LinkedIn jobs, people, companies, or Reddit enrichment.
---

# Account Qualification — FITS Scoring

Qualify companies from pipeline output against the ICP. Score each company 0-100 using the FITS framework, assign tiers, and recommend actions.

**Arguments provided:** $ARGUMENTS

## Step 1: Parse Input

Detect the input type from `$ARGUMENTS`:

- **JSON file path** (e.g., `IAM-Jobs-2026-03-20/LinkedIn/jobs-2026-03-19T22-41.json`):
  Read the file. Extract unique companies by deduplicating on `companyUrl`.
  For jobs JSON: group all signals by company, so each company has the full picture of all its job postings.
  For companies JSON: each entry is already one company.
  For people JSON: group by company.

- **LinkedIn company URL(s)** (e.g., `https://www.linkedin.com/company/tko`):
  Qualify with whatever data is in the URL itself (limited — only firmographic scoring will be partial). Note this in the output.

If no arguments provided, show:
```
Usage:
  /qualify-accounts <json-file>                    Score companies from pipeline output
  /qualify-accounts <linkedin-company-url>         Score a single company (limited data)

Examples:
  /qualify-accounts IAM-Jobs-2026-03-20/LinkedIn/jobs-2026-03-19T22-41.json
  /qualify-accounts IdentityManagement/LinkedIn/companies-2026-03-20.json
  /qualify-accounts https://www.linkedin.com/company/tkogroup
```

## Step 2: Level 1 Screening

Run every company through hard disqualifiers. Mark as `FAIL` and skip FITS scoring if any apply:

| Filter | Disqualify If |
|--------|--------------|
| **Company size** | `companySize` < 20 employees (too small to have security budget) |
| **Competitor** | Company is a cybersecurity/IAM vendor themselves (check `companyDescription`, `industries`, `specialties`) |
| **Staffing agency** | Company is a staffing/recruiting firm posting on behalf of clients (check company name, description for "staffing", "recruiting", "consulting firm") |

Flag but don't disqualify:
- No `companyUrl` (can't enrich later)
- `companySize` is 0 or missing (data gap, not a disqualifier)

## Step 3: FITS Scoring

For each company that passes Level 1, score across four dimensions. Use ONLY the data present in the input file — do not make API calls or read other files.

### F — Firmographic Fit (25 points)

| Attribute | Tier 1 (full pts) | Tier 2 (partial) | Tier 3 (minimal) | Data Field |
|-----------|-------------------|-------------------|-------------------|------------|
| Company size sweet spot | **8** if 100-5,000 | **5** if 5,000-50,000 | **2** if 50-99 or >50,000 | `companySize` |
| Revenue estimate | **5** if mid-market+ | **3** if growth stage | **1** if early/unknown | Infer from `companySize` + `industries` |
| Industry is primary vertical | **5** if fintech, healthcare, SaaS, defense, gov | **3** if insurance, banking, pharma, biotech | **1** if energy, mfg, retail | `industries` |
| Growth stage | **5** if scaling/growing | **3** if established | **1** if unknown | `headcountClue`, `companyDescription` |
| Geography | **2** if US | **1** if UK/CA/AU | **0** if other/unknown | `location` |

If `companySize` is missing/0, score Size as 0 and note "data gap" in rationale.

### I — Intent Signals (35 points)

| Signal | Points | How to Score | Data Field |
|--------|--------|-------------|------------|
| Hiring for role our product serves | **10** if hiring-iam/pam/grc/ciso, **5** if hiring-security-role, **0** if hiring-other | `type` field |
| Evaluating competitors | **10** if 2+ competitor tools, **6** if 1 tool, **0** if none | `currentTools` |
| Hiring velocity (multiple postings) | **5** if company has 3+ signals, **3** if 2 signals, **0** if 1 | Count signals per company |
| Compliance pressure | **5** if 2+ frameworks, **3** if 1 framework, **0** if none | `frameworks` |
| Pain language strength | **5** if 2+ pain phrases, **3** if 1 phrase, **0** if none | `painLanguage` |
| PAM-specific intent bonus | **+2** (bonus on top of above) if JD explicitly mentions "privileged access management" or "PAM", or frameworks include NERC CIP/RBI/SEBI/FISMA, or pain includes "hardcoded credentials"/"service account sprawl"/"standing access"/"lateral movement" | `painLanguage`, `frameworks`, JD text |

### T — Technographic Match (20 points)

Score **only the highest-matching row** — do not add rows together (max 20 pts total including the compliance and sophistication rows).

| Signal | Points | How to Score | Data Field |
|--------|--------|-------------|------------|
| Uses a PAM competitor (displacement opp) | **8** if cyberark/beyondtrust/delinea/thycotic/wallix/arcon/senhasegura | `currentTools` |
| Uses an IGA/IAM competitor | **6** if sailpoint/saviynt/oracle identity/omada/ibm isim/ibm igm | `currentTools` |
| Uses an adjacent SSO/IAM tool (expansion opp) | **4** if okta/ping identity/forgerock/onelogin/secureauth/centrify/thales | `currentTools` |
| Uses a DevOps secrets tool (cloud PAM opp) | **4** if hashicorp vault/conjur/akeyless/doppler/infisical | `currentTools` |
| Uses legacy Microsoft identity (no PAM) | **3** if azure ad/active directory/microsoft entra (without PAM tool) | `currentTools` |
| Uses our integration partners | **6** if azure ad/active directory/microsoft entra (Microsoft ecosystem), **3** if auth0/ping | `currentTools` |
| Compliance journey (adjacent tech) | **4** if frameworks + pain language both present | `frameworks` + `painLanguage` |
| Tech sophistication | **2** if `keyRequirements` mentions certifications (CISSP, CISA, etc.) or 5+ years experience | `keyRequirements` |

> **Note:** For the displacement/expansion rows, pick the highest-scoring tool detected. The integration partners row stacks with the compliance/sophistication rows.

### S — Structural Readiness (20 points)

| Signal | Points | How to Score | Data Field |
|--------|--------|-------------|------------|
| Budget authority likely exists | **6** if `seniorityLevel` is Director+ or `type` is hiring-ciso | `seniorityLevel`, `type` |
| Team size indicates need | **4** if `companySize` 200+ (big enough for dedicated security) | `companySize` |
| No buying freeze | **4** if actively hiring (they are, since we found job postings) | Always 4 for jobs data |
| Short sales cycle | **3** if `companySize` < 2,000 (smaller = faster decisions) | `companySize` |
| Small decision committee | **3** if `companySize` < 500 | `companySize` |

## Step 4: Tier Assignment

| Score | Tier | Label | Recommended Action |
|-------|------|-------|-------------------|
| 80-100 | 1 | Bullseye | Multi-channel, hyper-personalized outreach. Build full account brief. |
| 60-79 | 2 | Strong Fit | Signal-based personalized outreach. Prioritize in next campaign. |
| 40-59 | 3 | Good Fit | Bucket personalization. Include in scaled outbound. |
| 20-39 | 4 | Stretch | Small batch test only. Monitor for stronger signals. |
| 0-19 | DQ | Disqualified | Remove from list. |

## Step 5: Generate Output

### Determine the topic directory
- If input file is under a topic folder (e.g., `IAM-Jobs-2026-03-20/LinkedIn/...`), use that topic.
- Otherwise use "Qualified" as the default.

### Write two files to `<Topic>/Qualified/`:

**`qualified-<timestamp>.json`:**
```json
{
  "meta": {
    "source": "qualify-accounts",
    "qualifiedAt": "<ISO date>",
    "inputFile": "<path to input>",
    "companiesEvaluated": <N>,
    "level1Failed": <N>,
    "byTier": { "tier1": <N>, "tier2": <N>, "tier3": <N>, "tier4": <N>, "dq": <N> }
  },
  "accounts": [
    {
      "company": "<name>",
      "companyUrl": "<linkedin URL>",
      "companyWebsite": "<website>",
      "companySize": <N>,
      "segment": "<A/B/C>",
      "industries": "<industry>",
      "level1": { "pass": true, "flags": ["<any soft flags>"] },
      "fits": {
        "F": { "score": <N>, "max": 25, "rationale": "<why>" },
        "I": { "score": <N>, "max": 35, "rationale": "<why>" },
        "T": { "score": <N>, "max": 20, "rationale": "<why>" },
        "S": { "score": <N>, "max": 20, "rationale": "<why>" }
      },
      "totalScore": <N>,
      "tier": <1-4 or "DQ">,
      "tierLabel": "<label>",
      "recommendedAction": "<action>",
      "topSignals": ["<signal1>", "<signal2>"],
      "outreachAngle": "<from jobs data if available>",
      "suggestedMessage": "<from jobs data if available>"
    }
  ]
}
```

**`qualified-<timestamp>.md`:** Human-readable report:

```markdown
# Account Qualification Report — <date>

**Input:** <file path>
**Companies evaluated:** <N> | **Level 1 failed:** <N>
**Tier 1:** <N> | **Tier 2:** <N> | **Tier 3:** <N> | **Tier 4:** <N> | **DQ:** <N>

## Summary

| Company | Size | Industry | FITS Score | Tier | Top Signal |
|---------|------|----------|-----------|------|------------|
| ... | ... | ... | .../100 | ... | ... |

## Tier 1: Bullseye
<For each Tier 1 company: full FITS breakdown, all signals, recommended approach>

## Tier 2: Strong Fit
<For each: company, score, key signals, outreach angle>

## Tier 3: Good Fit
<Brief table>

## Tier 4: Stretch
<Brief table>

## Level 1 Failures
<Companies that failed screening and why>
```

## Step 6: Report Results

After writing output:
1. Report the tier distribution
2. Highlight Tier 1 and Tier 2 companies with their scores and top signals
3. Show the output file paths
4. For Tier 1 companies, suggest next steps:
   - Run `/linkedin-companies` to enrich further
   - Run `/linkedin-people` to find decision-makers
   - Build outreach sequence based on the signals

## ICP Configuration

These parameters define "good fit" for this business (B2B cybersecurity / IAM / GRC / PAM services):

**Sweet-spot company size:** 100-5,000 employees
**Primary industries:** Financial services, Fintech, Healthcare, Healthtech, SaaS, Software, Technology, Defense, Government
**Secondary industries:** Insurance, Banking, Pharmaceutical, Biotech
**Primary geography:** United States
**Secondary geography:** UK, Canada, Australia
**Target buyer roles:** CISO, VP Security, Director of Security, Head of IAM, Director of IAM, Head of PAM, Privileged Access Manager, Identity Security Manager, IAM Architect, Security Architect, Director of Compliance, VP IT Security
**Product categories:** Identity & Access Management, Privileged Access Management, GRC, Compliance

**PAM competitor tools (highest displacement value):** CyberArk, BeyondTrust, Delinea, Thycotic, Wallix, Senhasegura, Arcon
**IGA/IAM competitor tools (displacement):** SailPoint, Saviynt, Oracle Identity, IBM ISIM, IBM IGM, Omada Identity
**Adjacent tools (expansion opp — have IAM but not PAM):** Okta, ForgeRock, OneLogin, Ping Identity, SecureAuth, Centrify, Thales
**DevOps secrets tools (cloud PAM expansion opp):** HashiCorp Vault, Conjur, Doppler, Akeyless, Infisical
**Integration partners:** Microsoft Entra, Azure AD, Active Directory, Auth0

**Level 1 competitor disqualification — add to vendor check:** Wallix, Senhasegura, Arcon, StrongDM, HashiCorp, Omada Identity (in addition to standard IAM/cybersecurity vendors)

## Reference

Full qualification methodology: `Account Qualification/SKILL.md` (FITS framework, Level 1-3 details, re-qualification rules, batch workflow)
