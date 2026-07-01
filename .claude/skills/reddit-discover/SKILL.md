---
name: reddit-discover
description: Find new relevant subreddits from existing scrape data
---

Run the subreddit discovery tool. Analyzes existing scrape data to find new relevant subreddits by examining where active users also participate and which subreddits are cross-referenced in discussions.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/discover-subreddits.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node scripts/discover-subreddits.js <Topic> [--keywords "term1,term2"]

Examples:
  node scripts/discover-subreddits.js IdentityManagement
  node scripts/discover-subreddits.js GRC --keywords "SOC2,compliance,audit"
```

After discovery completes:
1. Report the discovered subreddits ranked by relevance
2. Suggest adding the top ones to the next `/reddit-scrape` run
