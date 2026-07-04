#!/usr/bin/env node

/**
 * Scheduled Scraper — runs all Reddit + LinkedIn jobs defined in scrape-config.json
 *
 * Usage:
 *   node scripts/schedule.js                  Run all jobs now
 *   node scripts/schedule.js --install        Install weekly macOS launchd job
 *   node scripts/schedule.js --uninstall      Remove the launchd job
 *   node scripts/schedule.js --status         Show if the launchd job is installed
 *
 * Config: scrape-config.json in project root
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'data');

const CONFIG_PATH = path.join(projectRoot, 'scrape-config.json');
const PLIST_NAME = 'com.reddit-scrape.scheduled';
const PLIST_PATH = path.join(process.env.HOME, 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(`Config not found: ${CONFIG_PATH}`);
        console.error('Create scrape-config.json with your job definitions.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function runAllJobs() {
    const config = loadConfig();
    const { scrapeReddit } = await import('./reddit-scraper.js');

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Scheduled scrape — ${config.jobs.length} job(s)`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(50)}\n`);

    for (const job of config.jobs) {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`Job: ${job.topic}`);
        console.log(`${'─'.repeat(40)}`);

        try {
            let sinceCutoff = null;
            if (job.since) {
                const match = job.since.match(/^(\d+)([dhw])$/);
                if (match) {
                    const num = parseInt(match[1]);
                    const unit = match[2];
                    const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
                    sinceCutoff = new Date(Date.now() - num * ms);
                }
            }

            await scrapeReddit(
                job.urls,
                job.maxComments || 10,
                job.maxPosts || 10,
                job.sort || 'new',
                job.topic,
                sinceCutoff,
                job.parallel || 1
            );
        } catch (err) {
            console.error(`  Job "${job.topic}" failed: ${err.message}`);
        }
    }

    // ── LinkedIn Scans ──
    if (config.linkedinScans && config.linkedinScans.length > 0) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`LinkedIn scans — ${config.linkedinScans.length} job(s)`);
        console.log(`${'='.repeat(50)}\n`);

        for (const scan of config.linkedinScans) {
            console.log(`\n${'─'.repeat(40)}`);
            console.log(`LinkedIn: ${scan.script} — ${scan.topic}`);
            console.log(`${'─'.repeat(40)}`);

            try {
                if (scan.script === 'linkedin-jobs') {
                    const { scanLinkedInJobs } = await import('./linkedin-jobs.js');
                    let sinceCutoff = null;
                    if (scan.since) {
                        const match = scan.since.match(/^(\d+)([dhw])$/);
                        if (match) {
                            const num = parseInt(match[1]);
                            const unit = match[2];
                            const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
                            sinceCutoff = new Date(Date.now() - num * ms);
                        }
                    }
                    await scanLinkedInJobs({
                        topic: scan.topic,
                        category: scan.category || 'all',
                        maxResults: scan.maxResults || 25,
                        sinceCutoff,
                        scoreThreshold: scan.scoreThreshold || 0,
                        dryRun: false
                    });
                } else if (scan.script === 'linkedin-people') {
                    const { scanLinkedInPeople } = await import('./linkedin-people.js');
                    let sinceCutoff = new Date(Date.now() - 90 * 86400000);
                    const sinceLabel = scan.since || '90d';
                    if (scan.since) {
                        const match = scan.since.match(/^(\d+)([dhw])$/);
                        if (match) {
                            const num = parseInt(match[1]);
                            const unit = match[2];
                            const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
                            sinceCutoff = new Date(Date.now() - num * ms);
                        }
                    }
                    await scanLinkedInPeople({
                        topic: scan.topic,
                        category: scan.category || 'all',
                        maxResults: scan.maxResults || 25,
                        sinceCutoff,
                        sinceLabel,
                        dryRun: false
                    });
                } else if (scan.script === 'linkedin-companies' && scan.csvFile) {
                    const { scanLinkedInCompanies } = await import('./linkedin-companies.js');
                    await scanLinkedInCompanies({
                        csvFile: scan.csvFile,
                        topic: scan.topic,
                        maxCompanies: scan.maxCompanies || null,
                        skipScraped: scan.skipScraped || false,
                        dryRun: false
                    });
                }
            } catch (err) {
                console.error(`  LinkedIn scan "${scan.script} — ${scan.topic}" failed: ${err.message}`);
            }
        }
    }

    // ── LinkedIn Feed Scans ──
    if (config.linkedinFeedScans && config.linkedinFeedScans.length > 0) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`LinkedIn feed scans — ${config.linkedinFeedScans.length} job(s)`);
        console.log(`${'='.repeat(50)}\n`);

        for (const scan of config.linkedinFeedScans) {
            console.log(`\n${'─'.repeat(40)}`);
            console.log(`LinkedIn Feed: ${scan.topic}`);
            console.log(`${'─'.repeat(40)}`);

            try {
                if (scan.script === 'linkedin-feed') {
                    const { scanLinkedInFeed } = await import('./linkedin-feed.js');
                    await scanLinkedInFeed({
                        topic: scan.topic,
                        keywords: scan.keywords || null,
                        maxResults: scan.maxResults || 25,
                        since: scan.since || '7d',
                        scoreThreshold: scan.scoreThreshold || 0,
                        dryRun: false
                    });
                }
            } catch (err) {
                console.error(`  LinkedIn feed scan "${scan.topic}" failed: ${err.message}`);
            }
        }
    }

    // ── Account Signals + Parallel.ai/registry Enrichment ──
    if (config.accountSignalsRun && config.accountSignalsRun.csvFile) {
        const run = config.accountSignalsRun;
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Account signals enrichment — ${run.csvFile}`);
        console.log(`${'='.repeat(50)}\n`);

        try {
            const scriptPath = path.join(__dirname, 'account-signals.js');
            const csvPath = path.join(projectRoot, run.csvFile);
            const flags = run.enrich === false ? '--no-enrich' : '--enrich';
            const maxStr = run.maxCompanies ? ` --max-companies ${run.maxCompanies}` : '';
            const cmd = `node "${scriptPath}" "${csvPath}" ${flags}${maxStr}`;
            console.log(`  Running: ${cmd}`);
            execSync(cmd, { cwd: projectRoot, stdio: 'inherit' });
        } catch (err) {
            console.error(`  Account signals run failed: ${err.message}`);
        }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`All jobs complete: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(50)}\n`);
}

function installLaunchd() {
    const nodePath = execSync('which node', { encoding: 'utf8' }).trim();

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${path.join(__dirname, 'schedule.js')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(DATA_DIR, 'schedule-output.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(DATA_DIR, 'schedule-error.log')}</string>
</dict>
</plist>`;

    const dir = path.dirname(PLIST_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);

    try {
        execSync(`launchctl load ${PLIST_PATH}`);
        console.log('Scheduled job installed successfully.');
        console.log(`  Runs every Monday at 8:00 AM`);
        console.log(`  Plist: ${PLIST_PATH}`);
        console.log(`  Logs: ${path.join(DATA_DIR, 'schedule-output.log')}`);
    } catch (err) {
        console.error(`Failed to load launchd job: ${err.message}`);
    }
}

function uninstallLaunchd() {
    if (!fs.existsSync(PLIST_PATH)) {
        console.log('No scheduled job found.');
        return;
    }
    try {
        execSync(`launchctl unload ${PLIST_PATH}`);
    } catch { /* may not be loaded */ }
    fs.unlinkSync(PLIST_PATH);
    console.log('Scheduled job removed.');
}

function showStatus() {
    if (!fs.existsSync(PLIST_PATH)) {
        console.log('Status: NOT INSTALLED');
        console.log(`Run: node scripts/schedule.js --install`);
        return;
    }
    console.log('Status: INSTALLED');
    console.log(`  Plist: ${PLIST_PATH}`);
    console.log(`  Schedule: Every Monday at 8:00 AM`);

    const logFile = path.join(DATA_DIR, 'schedule-output.log');
    if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        console.log(`  Last log update: ${stat.mtime.toISOString()}`);
    }
}

// CLI
const arg = process.argv[2];

if (arg === '--install') {
    installLaunchd();
} else if (arg === '--uninstall') {
    uninstallLaunchd();
} else if (arg === '--status') {
    showStatus();
} else {
    runAllJobs();
}
