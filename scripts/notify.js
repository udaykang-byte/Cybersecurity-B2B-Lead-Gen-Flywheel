#!/usr/bin/env node

/**
 * HOT Lead Notification System
 *
 * Reads a scored leads JSON file and sends notifications for HOT leads (score 8+).
 * Supports macOS native notifications and optional Slack webhook.
 *
 * Usage:
 *   node scripts/notify.js <leads-json-file>
 *   node scripts/notify.js GRC/Leads/leads-2026-03-11.json
 *
 * Slack setup (optional):
 *   Add SLACK_WEBHOOK_URL to your .env file
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import db from './lib/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length) {
                process.env[key.trim()] = valueParts.join('=').trim();
            }
        });
    }
} catch { /* ok */ }

function sendMacNotification(title, message) {
    const escaped = message.replace(/"/g, '\\"').replace(/'/g, "'\\''");
    const titleEscaped = title.replace(/"/g, '\\"');
    try {
        execSync(`osascript -e 'display notification "${escaped}" with title "${titleEscaped}" sound name "Glass"'`);
        return true;
    } catch {
        return false;
    }
}

function sendSlackNotification(webhookUrl, leads, sourceFile) {
    return new Promise((resolve) => {
        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `🔥 ${leads.length} HOT Lead(s) Found` }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Source:* \`${sourceFile}\``
                }
            }
        ];

        for (const lead of leads.slice(0, 5)) {
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Score ${lead.score}/10* — u/${lead.author}\n>${(lead.excerpt || '').slice(0, 200)}\n<${lead.url}|View on Reddit>`
                }
            });
        }

        if (leads.length > 5) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `_...and ${leads.length - 5} more HOT leads_` }
            });
        }

        const payload = JSON.stringify({ blocks });
        const url = new URL(webhookUrl);

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.write(payload);
        req.end();
    });
}

async function run() {
    const inputFile = process.argv[2];

    // When no file given: query Supabase for unnotified HOT leads (if configured)
    if (!inputFile) {
        if (db.isConfigured()) {
            console.log('No file provided — querying Supabase for unnotified HOT leads...');
            try {
                const rows = await db.select('reddit_leads', {
                    lead_tier: 'eq.HOT',
                    select:    'author,lead_score,excerpt,url,subreddit,topic',
                    order:     'lead_score.desc',
                    limit:     20
                });
                if (rows.length === 0) {
                    console.log('No HOT leads in Supabase. Nothing to notify.');
                    process.exit(0);
                }
                // Normalize to the shape the rest of run() expects
                const hotLeads = rows.map(r => ({
                    author:  r.author,
                    score:   r.lead_score,
                    tier:    'HOT',
                    excerpt: r.excerpt,
                    url:     r.url
                }));
                await sendNotifications(hotLeads, 'Supabase (reddit_leads)');
                return;
            } catch (err) {
                console.error(`Supabase query failed: ${err.message}`);
            }
        }

        console.log(`
HOT Lead Notifications

Usage:
  node scripts/notify.js <leads-json-file>

Examples:
  node scripts/notify.js GRC/Leads/leads-2026-03-11.json

Sends macOS notifications + optional Slack alerts for leads scoring 8+.
Set SLACK_WEBHOOK_URL in .env for Slack integration.
When no file is provided and Supabase is configured, queries reddit_leads for HOT leads.
        `);
        process.exit(0);
    }

    if (!fs.existsSync(inputFile)) {
        console.error(`File not found: ${inputFile}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    // Support both array format and object-with-leads format
    const leads = Array.isArray(data) ? data : (data.leads || data.hotLeads || []);
    const hotLeads = leads.filter(l => (l.tier === 'HOT' || l.score >= 8));

    await sendNotifications(hotLeads, inputFile);
}

async function sendNotifications(hotLeads, sourceLabel) {
    if (hotLeads.length === 0) {
        console.log('No HOT leads found (score 8+). No notifications sent.');
        return;
    }

    console.log(`\nFound ${hotLeads.length} HOT lead(s):\n`);
    hotLeads.forEach((lead, i) => {
        console.log(`  [${i + 1}] Score ${lead.score}/10 — u/${lead.author}`);
        console.log(`      ${(lead.excerpt || lead.reasoning || '').slice(0, 100)}`);
        console.log(`      ${lead.url || ''}`);
    });

    // macOS notification
    const macMsg = hotLeads.length === 1
        ? `Score ${hotLeads[0].score}/10 from u/${hotLeads[0].author}`
        : `${hotLeads.length} HOT leads — top score ${Math.max(...hotLeads.map(l => l.score))}/10`;
    const macSent = sendMacNotification('Reddit HOT Leads', macMsg);
    console.log(`\nmacOS notification: ${macSent ? 'sent' : 'failed'}`);

    // Slack notification
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
        const slackSent = await sendSlackNotification(webhookUrl, hotLeads, sourceLabel);
        console.log(`Slack notification: ${slackSent ? 'sent' : 'failed'}`);
    } else {
        console.log('Slack: skipped (no SLACK_WEBHOOK_URL in .env)');
    }
}

run();
