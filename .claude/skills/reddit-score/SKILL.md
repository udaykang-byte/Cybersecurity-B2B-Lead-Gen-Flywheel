---
name: reddit-score
description: Pre-filter scraped Reddit data and format for lead scoring
---

Run the Reddit lead scorer (Step 1 of 2). Reads a scraped Reddit JSON file, pre-filters obvious non-leads, and formats remaining items into a structured text file for Claude to score.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/lead-scorer.js $ARGUMENTS
```

If no arguments provided, show usage and look for recent scrape files:
```
Usage: node scripts/lead-scorer.js <scraped-json-file> [--topic <Name>] [--since <duration>]

Examples:
  node scripts/lead-scorer.js IdentityManagement/Scrapes/scrape-2026-03-20.json --topic IdentityManagement
  node scripts/lead-scorer.js GRC/Scrapes/scrape-2026-03-20.json --topic GRC
```

After Step 1 completes:
1. Report how many items passed the pre-filter and the output file path (pending-leads.txt)
2. Automatically proceed to Step 2: Read the pending-leads.txt file and score each lead
3. Score leads on a 1-10 scale, classify as HOT (8+), WARM (5-7), or COLD (1-4)
4. Write scored output to `<Topic>/Leads/leads-<timestamp>.json` and `.md`
5. Report the score distribution and highlight any HOT leads
6. **Run the Supabase sync:** `node scripts/supabase-sync.js <Topic>/Leads/leads-<timestamp>.json` to push scores into Supabase
7. Suggest running `/reddit-enrich` on HOT/WARM leads as the next step

## PAM-Specific Scoring Guidance

Use this domain knowledge when scoring posts from PAM, DevSecOps, or IAM topics.

### Automatic HOT (score 8-10) — score these high regardless of other signals:
- Post compares specific PAM vendors: CyberArk, BeyondTrust, Delinea, Thycotic, Wallix, Senhasegura
- Post asks for alternatives to an existing PAM/IAM tool (competitor displacement signal)
- Post describes a compliance audit finding related to privileged access or identity
- Post asks about "just-in-time access", "zero standing privileges", "privileged session recording", "break-glass access" — these are advanced feature evaluations indicating serious procurement
- Post describes unmanaged service accounts, orphaned accounts, or credential sprawl **at their organization** (use of "we", "our", "my company")
- Post references a specific environment (PAM for AWS, PAM for Active Directory, secrets management in Kubernetes, PAM for OT/ICS)

### WARM (score 5-7) — pain without active buying:
- Post describes privileged access problems at their org but no evaluation language
- Post asks how to implement least privilege or access reviews manually (DIY before buying)
- Post discusses a PAM-related incident (ransomware, lateral movement, insider threat) that happened to them
- Post discusses compliance frameworks (SOX, HIPAA, PCI DSS, NIST, NERC CIP) and mentions access controls as a gap

### COLD (score 1-4) — educational / no org context:
- Post asks "what is PAM" or "how does PAM work" generally
- Post asks about PAM certifications or career paths in PAM
- Post discusses PAM academically without organizational "we" language
- Post is a vendor or consultant promoting their own services

### Score Adjusters:
**+1 to +2 if:**
- Mentions specific environment: hybrid cloud, Active Directory, Azure, AWS, SAP, OT/ICS, industrial systems
- Mentions specific compliance driver: SOX, PCI DSS, HIPAA, NERC CIP, CMMC, FedRAMP, RBI, SEBI
- Practitioner role signals in post history or flair (sysadmin, IAM architect, security engineer)
- Post has strong engagement (replies indicate peers recognize the problem as real)

**-1 to -2 if:**
- Post originated in r/ITCareerQuestions, r/cscareerquestions, or similar job communities
- Poster identifies themselves as a vendor, consultant, or MSP in the thread
- No "we" / "our" / organizational language anywhere — person is asking for themselves only
