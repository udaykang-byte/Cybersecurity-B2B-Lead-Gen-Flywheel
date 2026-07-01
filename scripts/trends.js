#!/usr/bin/env node

/**
 * Reddit Scrape Trend Analysis
 *
 * Analyzes all scrapes for a topic over time to surface:
 *   - Volume trends (posts/comments per scrape)
 *   - Rising keywords and topics
 *   - Recurring authors (relationship-building targets)
 *
 * Usage:
 *   node scripts/trends.js <Topic>
 *   node scripts/trends.js GRC
 *   node scripts/trends.js IdentityManagement
 */

import fs from 'fs';
import path from 'path';

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'its', 'this', 'that', 'was',
    'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'not',
    'no', 'so', 'if', 'my', 'me', 'i', 'we', 'you', 'your', 'they', 'them',
    'he', 'she', 'his', 'her', 'our', 'just', 'like', 'get', 'got', 'also',
    'about', 'any', 'all', 'what', 'when', 'how', 'who', 'which', 'where',
    'than', 'then', 'there', 'here', 'more', 'some', 'very', 'much', 'most',
    'only', 'even', 'still', 'over', 'into', 'out', 'up', 'down', 'one',
    'two', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'wouldn\'t', 'can\'t',
    'need', 'know', 'think', 'make', 'going', 'really', 'want', 'use', 'using',
    'been', 'work', 'way', 'well', 'things', 'thing', 'lot', 'many', 'good',
    'new', 'see', 'look', 'time', 'people', 'something', 'right', 'same',
]);

function extractKeywords(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function analyzeFile(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const filename = path.basename(filePath);

    // Extract date from filename: scrape-2026-03-10T16-42.json
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : 'unknown';

    const allText = [];
    const authors = [];

    for (const post of (data.posts || [])) {
        allText.push(post.title || '', post.body || '');
        if (post.author) authors.push(post.author);
    }
    for (const comment of (data.comments || [])) {
        allText.push(comment.body || '');
        if (comment.author) authors.push(comment.author);
    }

    const keywords = extractKeywords(allText.join(' '));
    const keywordCounts = {};
    for (const kw of keywords) {
        keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
    }

    return {
        file: filename,
        date,
        posts: (data.posts || []).length,
        comments: (data.comments || []).length,
        totalItems: (data.summary?.totalItems) || (data.posts || []).length + (data.comments || []).length,
        authors,
        keywordCounts,
    };
}

function run() {
    const topic = process.argv[2];

    if (!topic) {
        console.log(`
Trend Analysis — analyze scrapes over time

Usage:
  node scripts/trends.js <Topic>

Examples:
  node scripts/trends.js GRC
  node scripts/trends.js IdentityManagement
        `);
        process.exit(0);
    }

    const scrapesDir = path.join(topic, 'Scrapes');
    if (!fs.existsSync(scrapesDir)) {
        console.error(`No scrapes directory found: ${scrapesDir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(scrapesDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('.'))
        .sort();

    if (files.length === 0) {
        console.error(`No scrape files found in ${scrapesDir}`);
        process.exit(1);
    }

    console.log(`\n${'='.repeat(55)}`);
    console.log(`  TREND ANALYSIS: ${topic}`);
    console.log(`  ${files.length} scrape(s) analyzed`);
    console.log(`${'='.repeat(55)}`);

    const analyses = files.map(f => analyzeFile(path.join(scrapesDir, f)));

    // Volume trends
    console.log(`\n--- Volume Over Time ---\n`);
    console.log(`  ${'Date'.padEnd(12)} ${'Posts'.padStart(6)} ${'Comments'.padStart(9)} ${'Total'.padStart(7)}`);
    console.log(`  ${'─'.repeat(36)}`);
    for (const a of analyses) {
        console.log(`  ${a.date.padEnd(12)} ${String(a.posts).padStart(6)} ${String(a.comments).padStart(9)} ${String(a.totalItems).padStart(7)}`);
    }

    // Aggregate keyword frequencies across all scrapes
    const totalKeywords = {};
    const recentKeywords = {};
    const olderKeywords = {};
    const midpoint = Math.floor(analyses.length / 2);

    analyses.forEach((a, idx) => {
        const target = idx >= midpoint ? recentKeywords : olderKeywords;
        for (const [kw, count] of Object.entries(a.keywordCounts)) {
            totalKeywords[kw] = (totalKeywords[kw] || 0) + count;
            target[kw] = (target[kw] || 0) + count;
        }
    });

    // Top keywords overall
    const topKeywords = Object.entries(totalKeywords)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

    console.log(`\n--- Top Keywords (all scrapes) ---\n`);
    topKeywords.forEach(([kw, count], i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${kw.padEnd(25)} (${count})`);
    });

    // Rising keywords (higher frequency in recent vs older scrapes)
    if (analyses.length >= 2) {
        const rising = [];
        for (const [kw, recentCount] of Object.entries(recentKeywords)) {
            const olderCount = olderKeywords[kw] || 0;
            if (recentCount >= 3 && recentCount > olderCount * 1.5) {
                rising.push({ keyword: kw, recent: recentCount, older: olderCount });
            }
        }
        rising.sort((a, b) => (b.recent - b.older) - (a.recent - a.older));

        if (rising.length > 0) {
            console.log(`\n--- Rising Topics (recent vs older scrapes) ---\n`);
            rising.slice(0, 10).forEach(({ keyword, recent, older }) => {
                const change = older === 0 ? 'NEW' : `+${Math.round((recent / older - 1) * 100)}%`;
                console.log(`  ${keyword.padEnd(25)} ${String(recent).padStart(4)} recent vs ${String(older).padStart(4)} older  (${change})`);
            });
        }
    }

    // Recurring authors across scrapes
    const authorAppearances = {};
    for (const a of analyses) {
        const uniqueAuthors = new Set(a.authors);
        for (const author of uniqueAuthors) {
            if (!authorAppearances[author]) authorAppearances[author] = [];
            authorAppearances[author].push(a.date);
        }
    }

    const recurring = Object.entries(authorAppearances)
        .filter(([_, dates]) => dates.length >= 2)
        .sort((a, b) => b[1].length - a[1].length);

    if (recurring.length > 0) {
        console.log(`\n--- Recurring Authors (appeared in 2+ scrapes) ---\n`);
        recurring.slice(0, 15).forEach(([author, dates]) => {
            console.log(`  u/${author.padEnd(22)} ${dates.length} appearances  (${dates.join(', ')})`);
        });
        console.log(`\n  These authors are active in this space — good relationship targets.`);
    }

    console.log(`\n${'='.repeat(55)}\n`);
}

run();
