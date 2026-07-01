---
name: linkedin-feed
description: Monitor LinkedIn post feed for keyword-based buying signals (IAM/PAM/GRC/DevSecOps)
---

Run the LinkedIn feed keyword monitor. Searches LinkedIn posts for practitioners discussing pain points, evaluating tools, or announcing identity/security projects. Scores each post for buying intent (HOT/WARM/COLD).

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/linkedin-feed.js $ARGUMENTS
```

If no arguments provided, show usage and ask which topic to scan:
```
Usage: node Skills/linkedin-feed.js [keyword1] [keyword2...] [options]

Options:
  --topic <Name>          Topic directory for output (IdentityManagement, PAM, GRC, DevSecOps)
  --count <N>             Max posts per keyword (default: 25)
  --since <duration>      Date filter: 7d, 30d, etc.
  --score-threshold <N>   Only output posts scoring >= N (default: 0)
  --dry-run               Print keywords + actor info, no Apify call

Examples:
  node Skills/linkedin-feed.js --topic IdentityManagement --count 25
  node Skills/linkedin-feed.js "evaluating PAM tools" "CyberArk alternative" --topic PAM
  node Skills/linkedin-feed.js --topic GRC --since 7d
```

After the scan completes:
1. Report: total posts found, HOT/WARM/COLD distribution per keyword
2. Highlight any active evaluations or tool comparisons (highest intent — score 7+)
3. Surface posts from decision-makers (CISO, Director, VP) separately
4. Open the markdown report for review
5. Suggest running `/qualify-accounts` on HOT leads for ICP fit scoring
