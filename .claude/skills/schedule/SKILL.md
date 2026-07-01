---
name: schedule
description: Run all scheduled Reddit and LinkedIn scrapes from config, or manage the weekly schedule
---

Run the scheduler. Executes all Reddit and LinkedIn jobs defined in scrape-config.json. Can also install/uninstall a macOS launchd job for weekly automation.

Arguments provided: $ARGUMENTS

Run:
```bash
node Skills/schedule.js $ARGUMENTS
```

If no arguments provided, run all scheduled jobs:
```
Usage: node Skills/schedule.js [options]

Options:
  (no args)     Run all scheduled scrape jobs now
  --install     Install weekly macOS launchd schedule
  --uninstall   Remove the launchd schedule
  --status      Check if the schedule is installed and when it last ran
```

After the run completes:
1. Report which jobs ran and their results (posts scraped, signals found, etc.)
2. Report any failures or skipped jobs
3. Show the output file paths for each completed job
