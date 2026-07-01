---
name: reddit-scrape
description: Scrape Reddit posts and comments from subreddit URLs using Apify
---

Run the Reddit scraper. This scrapes posts and comments from Reddit URLs via the Apify Reddit Scraper actor. Multiple URLs are run as separate jobs and merged into one output file.

**Recommended two-phase workflow** (saves cost, better signal):
- Phase 1: `--posts-only --min-age 7` — fetch posts ≥7 days old (skip comments)
- Score the posts
- Phase 2: `--fetch-comments <leads.json>` — fetch comments only for HOT/WARM posts

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/reddit-scraper.js $ARGUMENTS
```

If no arguments provided, show the usage and ask what to scrape:
```
Usage: node Skills/reddit-scraper.js <url1> [url2] [options]
       node Skills/reddit-scraper.js --fetch-comments <leads.json> --topic <Name>

Options:
  --topic <Name>            Topic directory for output (e.g., IdentityManagement, GRC)
  --sort <method>           Sort: top, new, relevance (default: new)
  --max-comments <N>        Max comments per post (default: 10)
  --max-posts <N>           Max posts per URL (default: 15)
  --since <duration>        Only include posts from last N days (e.g., 7d, 30d)
  --min-age <N>             Skip posts newer than N days (use 7 to wait for comment buildup)
  --posts-only              Phase 1: fetch posts only, no comments. Output: posts-<timestamp>.json
  --fetch-comments <file>   Phase 2: fetch comments for HOT/WARM posts from a scored leads JSON
  --tiers <HOT,WARM>        Which tiers to fetch comments for (default: HOT,WARM)
  --parallel <N>            Run N URLs in parallel (default: 1)

Common URLs:
  IAM:        https://www.reddit.com/r/IdentityManagement/
  GRC:        https://www.reddit.com/r/grc/
  Cyber:      https://www.reddit.com/r/cybersecurity/
  SysAdmin:   https://www.reddit.com/r/sysadmin/
```

After the scrape completes:
1. Report the number of posts and comments scraped, and the output file path
2. If `--posts-only`: suggest running `/reddit-score` then `--fetch-comments` as next steps
3. If `--fetch-comments`: suggest running `/reddit-score` on the combined output
4. Otherwise: suggest running `/reddit-score` on the output file as the next step
