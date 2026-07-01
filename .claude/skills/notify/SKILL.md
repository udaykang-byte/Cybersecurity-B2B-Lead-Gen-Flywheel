---
name: notify
description: Send macOS and Slack notifications for HOT leads (score 8+)
---

Run the notification system. Reads a scored leads JSON file and sends notifications for HOT leads (score 8+) via macOS native notifications and optional Slack webhook.

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/notify.js $ARGUMENTS
```

If no arguments provided, show usage and look for recent leads files:
```
Usage: node Skills/notify.js <leads-json-file>

Examples:
  node Skills/notify.js IdentityManagement/Leads/leads-2026-03-20.json
  node Skills/notify.js GRC/Leads/leads-2026-03-20.json

Slack setup (optional): Add SLACK_WEBHOOK_URL to .env
```

After notifications are sent:
1. Report how many HOT leads were notified
2. Confirm which channels received notifications (macOS, Slack)
