#!/usr/bin/env node

/**
 * Reddit Lead Scorer — Step 1 of 2
 *
 * Reads a scraped Reddit JSON file, pre-filters obvious non-leads,
 * and formats the remaining items into a structured text file for
 * Claude to analyze and score.
 *
 * Usage:
 *   node Skills/lead-scorer.js <scraped-json-file> [--topic <Name>] [--since <duration>]
 *
 * Examples:
 *   node Skills/lead-scorer.js IdentityManagement/Scrapes/scrape-2026-03-10T18-02.json --topic IdentityManagement
 *   node Skills/lead-scorer.js GRC/Scrapes/scrape-2026-03-10T16-42.json --topic GRC
 *
 * Output:
 *   With --topic:    <Topic>/pending-leads.txt  ← formatted for Claude analysis
 *   Without --topic: pending-leads-<slug>.txt
 *
 * Step 2:
 *   Ask Claude: "Score the leads in <pending-leads-file>"
 *   Claude will read the file, score each item, and write:
 *     With --topic:    <Topic>/Leads/leads-<timestamp>.json
 *                      <Topic>/Leads/leads-<timestamp>.md
 *     Without --topic: <slug>-leads.json / <slug>-leads.md
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
Reddit Lead Scorer — Step 1 of 2

Usage:
  node Skills/lead-scorer.js <scraped-json-file> [--topic <Name>]

Examples:
  node Skills/lead-scorer.js IdentityManagement/Scrapes/scrape-2026-03-10T18-02.json --topic IdentityManagement
  node Skills/lead-scorer.js GRC/Scrapes/scrape-2026-03-10T16-42.json --topic GRC

This formats the scraped data for Claude to score as leads.
After running, ask Claude: "Score the leads in <pending-leads-file>"
    `);
    process.exit(0);
}

// Parse --since value into a Date cutoff
function parseSinceCutoff(value) {
    const match = value.match(/^(\d+)([dhw])$/);
    if (match) {
        const num = parseInt(match[1]);
        const unit = match[2];
        const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
        return new Date(Date.now() - num * ms);
    }
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
    throw new Error(`Invalid --since value: "${value}". Use formats like 7d, 24h, 2w, or 2026-01-01`);
}

// Parse args
let inputFile = null;
let topic = null;
let sinceCutoff = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--topic') {
        topic = args[++i] || null;
    } else if (args[i] === '--since') {
        sinceCutoff = parseSinceCutoff(args[++i]);
    } else if (!inputFile) {
        inputFile = args[i];
    }
}

if (!inputFile) {
    console.error('Error: input file is required.');
    process.exit(1);
}

if (!fs.existsSync(inputFile)) {
    console.error(`Error: file not found: ${inputFile}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// --- Pre-filter rules ---

const BOT_AUTHORS = new Set(['automoderator', '[deleted]', '[removed]']);

// Phrases that indicate the person is a job/career seeker, student, or non-buyer
const NON_LEAD_PHRASES = [
    'how do i get into',
    'how to get into',
    'break into',
    'breaking into',
    'entry level',
    'entry-level',
    'new to this',
    'new to cybersecurity',
    'studying for',
    'what cert should',
    'which cert',
    'how do i start',
    'where do i start',
    'looking for a job',
    'job hunting',
    'career advice',
    'career path',
    'just graduated',
    'just started',
    'complete beginner',
    'total beginner',
    'i am a student',
    "i'm a student",
    'im a student',
    'boot camp',
    'bootcamp',
    'self studying',
    'self-studying',
];

// Buyer-signal phrases — if any match, never filter (even if non-lead phrases also match)
const BUYER_SIGNALS = [
    // General procurement language
    'we need', 'our team', 'our organization', 'our company', 'our org',
    'we\'re looking for a solution', 'vendor evaluation', 'rfp',
    'we\'re evaluating', 'we are evaluating', 'looking for a tool',
    'looking for a vendor', 'budget for', 'procurement',
    'we currently use', 'we\'re migrating', 'we are migrating',

    // PAM-specific procurement language
    'we need a pam', 'need pam', 'looking for pam', 'evaluating pam', 'comparing pam',
    'replace cyberark', 'replacing cyberark', 'cyberark alternative',
    'beyondtrust alternative', 'delinea alternative',
    'migrate from cyberark', 'moving away from cyberark',
    'sailpoint alternative', 'okta replacement',

    // Feature-level requirement language (high buying intent)
    'need session recording', 'need password vaulting', 'need credential vault',
    'need jit access', 'just-in-time access', 'zero standing privileges',
    'need to manage service accounts', 'service accounts are out of control',
    'privileged account discovery', 'need to rotate credentials',
    'need secrets management', 'managing secrets', 'kubernetes secrets',
    'hashicorp vault alternative', 'need to secure service accounts',

    // Org-level pain acknowledgment
    'our privileged accounts', 'our service accounts', 'our admin accounts',
    'we have no visibility into', 'we currently have no', 'we lack',
    'we got a finding', 'audit finding', 'audit requirement',
    'our auditors', 'compliance requirement',
    'our ciso wants', 'our ciso asked', 'security team asked',

    // Vendor access buying language
    'third-party vendor access', 'remote vendor access', 'contractor access',
    'need to control vendor access',
];

/**
 * Returns a filter reason string if the item is a non-lead, or null if it should be kept.
 * Reasons: 'bot', 'deleted', 'too_short', 'career_seeker'
 */
function getNonLeadReason(item) {
    const author = (item.author || '').toLowerCase();
    if (BOT_AUTHORS.has(author)) return 'bot';

    const body = (item.body || '').toLowerCase();
    const title = (item.title || '').toLowerCase();
    const text = body + ' ' + title;

    if (text.trim().length < 30) return 'too_short';
    if (body === '[deleted]' || body === '[removed]') return 'deleted';
    if (body.startsWith('[removed by reddit]') || body.startsWith('sorry, this post has been removed')) return 'deleted';
    if (!body.trim() && !title.trim()) return 'deleted';

    // Check for buyer signals first — these override non-lead phrases
    const hasBuyerSignal = BUYER_SIGNALS.some(phrase => text.includes(phrase));
    if (hasBuyerSignal) return null;

    // Require 2+ non-lead phrase matches to filter (reduces false positives)
    const matchCount = NON_LEAD_PHRASES.filter(phrase => text.includes(phrase)).length;
    if (matchCount >= 2) return 'career_seeker';

    return null;
}

// --- Format items for Claude ---

function slugFromFile(filename) {
    return path.basename(filename, '.json')
        .replace(/^(reddit-scrape-|scrape-)/, '')
        .replace(/[-_]\d{4}-\d{2}-\d{2}.*$/, '')
        .toLowerCase();
}

const allItems = [];
const filterStats = { bot: 0, deleted: 0, too_short: 0, career_seeker: 0, too_old: 0 };

for (const post of (data.posts || [])) {
    if (sinceCutoff && post.createdAt && new Date(post.createdAt) < sinceCutoff) {
        filterStats.too_old++;
        continue;
    }
    const reason = getNonLeadReason({ ...post, body: post.body, title: post.title });
    if (reason) {
        filterStats[reason]++;
    } else {
        allItems.push({ type: 'post', ...post });
    }
}

for (const comment of (data.comments || [])) {
    if (sinceCutoff && comment.createdAt && new Date(comment.createdAt) < sinceCutoff) {
        filterStats.too_old++;
        continue;
    }
    const reason = getNonLeadReason({ ...comment, body: comment.body, title: '' });
    if (reason) {
        filterStats[reason]++;
    } else {
        allItems.push({ type: 'comment', ...comment });
    }
}

const totalOriginal = (data.posts || []).length + (data.comments || []).length;
const filtered = totalOriginal - allItems.length;

console.log(`\nPre-filter results:`);
console.log(`  Total items in file: ${totalOriginal}`);
console.log(`  Filtered out: ${filtered}`);
console.log(`    Bots/automoderator: ${filterStats.bot}`);
console.log(`    Deleted/removed:    ${filterStats.deleted}`);
console.log(`    Too short (<30ch):  ${filterStats.too_short}`);
console.log(`    Career seekers:     ${filterStats.career_seeker}`);
if (filterStats.too_old > 0) {
    console.log(`    Too old (--since):  ${filterStats.too_old}`);
}
console.log(`  Remaining for Claude to score: ${allItems.length}`);

if (allItems.length === 0) {
    console.log('\nNo items to score after filtering. Try a different scrape file.');
    process.exit(0);
}

// --- Write structured text file for Claude ---

let outputFile;
if (topic) {
    outputFile = path.join(topic, 'pending-leads.txt');
} else {
    const slug = slugFromFile(inputFile);
    outputFile = `pending-leads-${slug}.txt`;
}

const label = topic || slugFromFile(inputFile);

const lines = [];
lines.push(`REDDIT LEAD SCORING REQUEST`);
lines.push(`Source file: ${inputFile}`);
lines.push(`Topic: ${label}`);
lines.push(`Items to score: ${allItems.length}`);
lines.push(`Pre-filtered: ${filtered} (bots, job-seekers, students)`);
lines.push(`\nContext: We are a B2B cybersecurity services company specializing in`);
lines.push(`IAM, GRC, PAM, and security governance. Score each item as a potential`);
lines.push(`lead — someone whose organization could benefit from our services.`);
lines.push(`\n${'='.repeat(60)}\n`);

allItems.forEach((item, i) => {
    lines.push(`[${i + 1}] TYPE: ${item.type.toUpperCase()} | AUTHOR: u/${item.author} | SUBREDDIT: r/${item.subreddit || 'unknown'}`);
    if (item.type === 'post') {
        lines.push(`TITLE: "${item.title}"`);
    }
    const bodyPreview = (item.body || '').slice(0, 1200).replace(/\n+/g, ' ').trim();
    if (bodyPreview) {
        lines.push(`BODY: ${bodyPreview}${(item.body || '').length > 1200 ? '...' : ''}`);
    }
    lines.push(`URL: ${item.url}`);
    lines.push(`---`);
});

fs.writeFileSync(outputFile, lines.join('\n'));

console.log(`\nFormatted ${allItems.length} items → ${outputFile}`);
console.log(`\n${'─'.repeat(50)}`);
console.log(`Step 2: Ask Claude to score the leads:`);
console.log(`  "Score the leads in ${outputFile}"`);
if (topic) {
    console.log(`  Claude will save results to ${topic}/Leads/`);
}
console.log(`${'─'.repeat(50)}\n`);
