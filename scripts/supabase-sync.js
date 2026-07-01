#!/usr/bin/env node

/**
 * Supabase Sync — Push Scored Reddit Leads to Supabase
 *
 * Reads a scored leads JSON file (output of the /reddit-score skill) and upserts
 * each lead's score, tier, and outreach data into the reddit_leads table.
 *
 * Run after Claude scores leads:
 *   node scripts/supabase-sync.js GRC/Leads/leads-2026-04-02.json
 *
 * What it does:
 *   - For each lead in the JSON, updates the matching reddit_leads row (matched by URL)
 *   - Sets: lead_score, lead_tier, excerpt, reasoning, suggested_outreach, scored_at, synced_from
 *   - If a lead URL doesn't exist in reddit_leads yet (scored without prior scrape sync),
 *     it inserts the full row including the body/author/topic
 *
 * Environment:
 *   Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in .env
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './lib/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env ──
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length) {
                process.env[key.trim()] = valueParts.join('=').trim();
            }
        });
    }
} catch { /* ok */ }

function showUsage() {
    console.log(`
Usage: node scripts/supabase-sync.js <leads-json-file>

Pushes Claude-scored Reddit leads into the Supabase reddit_leads table.
Run this after the /reddit-score skill saves a leads JSON file.

Examples:
  node scripts/supabase-sync.js GRC/Leads/leads-2026-04-02.json
  node scripts/supabase-sync.js IdentityManagement/Leads/leads-2026-04-01.json

What gets updated in Supabase:
  - lead_score, lead_tier, excerpt, reasoning, suggested_outreach
  - scored_at (timestamp), synced_from (source file path)

Requires: SUPABASE_URL and SUPABASE_SERVICE_KEY in .env
`);
}

async function syncLeadsFile(leadsFilePath) {
    if (!db.isConfigured()) {
        console.error('Error: Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to .env');
        process.exit(1);
    }

    // Resolve file path
    const absPath = path.isAbsolute(leadsFilePath)
        ? leadsFilePath
        : path.join(process.cwd(), leadsFilePath);

    if (!fs.existsSync(absPath)) {
        console.error(`Error: File not found: ${absPath}`);
        process.exit(1);
    }

    // Parse leads JSON
    let fileData;
    try {
        fileData = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
        console.error(`Error: Could not parse JSON from ${absPath}: ${err.message}`);
        process.exit(1);
    }

    // Normalize: supports both array and { meta, leads: [...] } formats
    const leads = Array.isArray(fileData)
        ? fileData
        : Array.isArray(fileData.leads)
            ? fileData.leads
            : [];

    if (leads.length === 0) {
        console.log('No leads found in file. Nothing to sync.');
        return;
    }

    const meta = fileData.meta || {};
    const topic = meta.topic || path.basename(path.dirname(path.dirname(absPath)));
    const scoredAt = meta.scoredAt || new Date().toISOString();

    console.log(`\nSyncing ${leads.length} scored leads from: ${path.basename(absPath)}`);
    console.log(`Topic: ${topic} | Scored at: ${scoredAt}\n`);

    let updated = 0;
    let inserted = 0;
    let errors = 0;
    const tierCounts = { HOT: 0, WARM: 0, COLD: 0 };

    for (const lead of leads) {
        const url = lead.url;
        if (!url) { errors++; continue; }

        const tier = (lead.tier || '').toUpperCase();
        if (tierCounts[tier] !== undefined) tierCounts[tier]++;

        const patch = {
            lead_score:         lead.score || null,
            lead_tier:          tier || null,
            excerpt:            lead.excerpt || null,
            reasoning:          lead.reasoning || null,
            suggested_outreach: lead.suggestedOutreach || lead.suggested_outreach || lead.outreach || null,
            scored_at:          scoredAt,
            synced_from:        leadsFilePath
        };

        try {
            // Try to update existing row first (matched by url)
            const existing = await db.select('reddit_leads', {
                url:    `eq.${url}`,
                select: 'id',
                limit:  1
            });

            if (existing.length > 0) {
                await db.update('reddit_leads', { url: `eq.${url}` }, patch);
                updated++;
            } else {
                // Row doesn't exist yet — insert full record
                // (can happen if reddit-scraper.js ran before Supabase was configured)
                await db.upsert('reddit_leads', {
                    topic,
                    author:             lead.author || null,
                    subreddit:          lead.subreddit ? lead.subreddit.replace(/^r\//, '') : null,
                    url,
                    type:               lead.type || 'COMMENT',
                    title:              lead.title || null,
                    body:               lead.excerpt || null,
                    scraped_at:         new Date().toISOString(),
                    ...patch
                }, 'url');
                inserted++;
            }
        } catch (err) {
            console.warn(`  Warning: Failed to sync ${url}: ${err.message}`);
            errors++;
        }
    }

    console.log(`\n=== SYNC COMPLETE ===`);
    console.log(`Updated: ${updated} | Inserted: ${inserted} | Errors: ${errors}`);
    console.log(`HOT: ${tierCounts.HOT} | WARM: ${tierCounts.WARM} | COLD: ${tierCounts.COLD}`);

    if (errors > 0) {
        console.log(`\nNote: ${errors} lead(s) failed to sync. Check that SUPABASE_SERVICE_KEY has write access.`);
    }

    console.log(`\nQuery in Supabase:`);
    console.log(`  SELECT author, lead_score, lead_tier, excerpt FROM reddit_leads`);
    console.log(`  WHERE lead_tier = 'HOT' ORDER BY lead_score DESC;`);
    console.log();
}

// ── CLI ──
const args = process.argv.slice(2);
const leadsFile = args.find(a => !a.startsWith('--'));

if (!leadsFile) {
    showUsage();
    process.exit(1);
}

await syncLeadsFile(leadsFile);
