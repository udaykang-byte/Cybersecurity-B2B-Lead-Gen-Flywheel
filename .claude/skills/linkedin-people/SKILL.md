---
name: linkedin-people
description: Find new CISO/Director/Security Manager hires on LinkedIn (90-day window)
---

Run the LinkedIn people signal scanner. Finds new security leadership hires on LinkedIn — the playbook identifies a 90-day vendor selection window after a new CISO/Director is hired. Scores each hire based on role seniority and company profile.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/linkedin-people.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node scripts/linkedin-people.js [options]

Options:
  --topic <Name>          Topic directory for output (default: auto)
  --category <cat>        Role filter: ciso, director, manager, all (default: all)
  --since <duration>      Job change recency filter (default: 90d)
  --max-results <N>       Max results per search (default: 25)
  --dry-run               Print queries without calling Apify

Examples:
  node scripts/linkedin-people.js --topic IdentityManagement --category ciso --since 90d
  node scripts/linkedin-people.js --category director --max-results 10
```

After the scan completes:
1. Report: people found, role distribution (CISO/VP/Director/Manager), score distribution
2. Highlight anyone in the 90-day vendor selection window
3. Open the markdown report for review
