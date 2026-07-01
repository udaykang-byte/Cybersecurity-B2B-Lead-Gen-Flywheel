---
name: reddit-trends
description: Analyze Reddit scrape trends over time for a topic
---

Run the trend analysis tool. Analyzes all scrapes for a topic over time to surface volume trends, rising keywords, and recurring authors for relationship-building.

Arguments provided: $ARGUMENTS

Run:
```bash
node scripts/trends.js $ARGUMENTS
```

If no arguments provided, show usage:
```
Usage: node scripts/trends.js <Topic>

Examples:
  node scripts/trends.js IdentityManagement
  node scripts/trends.js GRC
```

After analysis completes:
1. Report the key trends: volume changes, rising/falling topics, hot keywords
2. Highlight recurring authors who could be relationship-building targets
3. Suggest adjusting scrape queries based on trending topics
