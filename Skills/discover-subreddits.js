#!/usr/bin/env node

/**
 * Subreddit Discovery Tool
 *
 * Analyzes your existing scrape data to find new relevant subreddits
 * by examining where active users also participate, and which subreddits
 * are cross-referenced in discussions.
 *
 * Usage:
 *   node Skills/discover-subreddits.js <Topic> [--keywords "term1,term2"]
 *   node Skills/discover-subreddits.js GRC
 *   node Skills/discover-subreddits.js IdentityManagement --keywords "SSO,SAML,Okta"
 */

import fs from 'fs';
import path from 'path';

function extractSubredditMentions(text) {
    const mentions = [];
    const regex = /\br\/([A-Za-z0-9_]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        mentions.push(match[1].toLowerCase());
    }
    return mentions;
}

function analyzeScrapesForSubreddits(scrapesDir) {
    const files = fs.readdirSync(scrapesDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('.'));

    const subredditMentions = {};
    const knownSubreddits = new Set();
    const authorSubreddits = {};

    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(scrapesDir, file), 'utf8'));

        // Track known subreddits from our own scrapes
        for (const post of (data.posts || [])) {
            if (post.subreddit) knownSubreddits.add(post.subreddit.toLowerCase());

            // Find r/subreddit mentions in bodies and titles
            const text = (post.body || '') + ' ' + (post.title || '');
            const mentions = extractSubredditMentions(text);
            for (const sub of mentions) {
                subredditMentions[sub] = (subredditMentions[sub] || 0) + 1;
            }

            // Track which subreddits each author posts in
            if (post.author && post.subreddit) {
                if (!authorSubreddits[post.author]) authorSubreddits[post.author] = new Set();
                authorSubreddits[post.author].add(post.subreddit.toLowerCase());
            }
        }

        for (const comment of (data.comments || [])) {
            const text = comment.body || '';
            const mentions = extractSubredditMentions(text);
            for (const sub of mentions) {
                subredditMentions[sub] = (subredditMentions[sub] || 0) + 1;
            }
        }
    }

    return { subredditMentions, knownSubreddits, authorSubreddits, fileCount: files.length };
}

function run() {
    const topic = process.argv[2];
    let extraKeywords = [];

    for (let i = 3; i < process.argv.length; i++) {
        if (process.argv[i] === '--keywords' && process.argv[i + 1]) {
            extraKeywords = process.argv[i + 1].split(',').map(k => k.trim().toLowerCase());
            i++;
        }
    }

    if (!topic) {
        console.log(`
Subreddit Discovery — find new relevant communities

Usage:
  node Skills/discover-subreddits.js <Topic> [--keywords "term1,term2"]

Examples:
  node Skills/discover-subreddits.js GRC
  node Skills/discover-subreddits.js IdentityManagement --keywords "SSO,SAML,Okta"

Analyzes your existing scrapes to find subreddits mentioned in discussions.
        `);
        process.exit(0);
    }

    const scrapesDir = path.join(topic, 'Scrapes');
    if (!fs.existsSync(scrapesDir)) {
        console.error(`No scrapes directory found: ${scrapesDir}`);
        console.error(`Run some scrapes first: node Skills/reddit-scraper.js <url> --topic ${topic}`);
        process.exit(1);
    }

    const { subredditMentions, knownSubreddits, authorSubreddits, fileCount } = analyzeScrapesForSubreddits(scrapesDir);

    console.log(`\n${'='.repeat(55)}`);
    console.log(`  SUBREDDIT DISCOVERY: ${topic}`);
    console.log(`  Analyzed ${fileCount} scrape file(s)`);
    console.log(`${'='.repeat(55)}`);

    // Known subreddits
    console.log(`\n--- Currently Scraped Subreddits ---\n`);
    for (const sub of [...knownSubreddits].sort()) {
        console.log(`  r/${sub}`);
    }

    // New subreddits discovered from mentions
    const newSubreddits = Object.entries(subredditMentions)
        .filter(([sub]) => !knownSubreddits.has(sub))
        .sort((a, b) => b[1] - a[1]);

    if (newSubreddits.length > 0) {
        console.log(`\n--- Discovered Subreddits (mentioned in discussions) ---\n`);
        console.log(`  ${'Subreddit'.padEnd(30)} ${'Mentions'.padStart(9)}`);
        console.log(`  ${'─'.repeat(41)}`);
        newSubreddits.slice(0, 20).forEach(([sub, count]) => {
            const relevance = count >= 3 ? ' ★ HIGH' : count >= 2 ? ' • MED' : '';
            console.log(`  r/${sub.padEnd(27)} ${String(count).padStart(9)}${relevance}`);
        });
    }

    // Keyword-matched subreddits
    if (extraKeywords.length > 0) {
        const keywordMatches = newSubreddits.filter(([sub]) =>
            extraKeywords.some(kw => sub.includes(kw))
        );
        if (keywordMatches.length > 0) {
            console.log(`\n--- Keyword Matches (${extraKeywords.join(', ')}) ---\n`);
            keywordMatches.forEach(([sub, count]) => {
                console.log(`  r/${sub.padEnd(27)} ${String(count).padStart(9)} mentions`);
            });
        }
    }

    // Author overlap analysis
    const multiSubAuthors = Object.entries(authorSubreddits)
        .filter(([_, subs]) => subs.size >= 2)
        .sort((a, b) => b[1].size - a[1].size);

    if (multiSubAuthors.length > 0) {
        console.log(`\n--- Authors Active in Multiple Subreddits ---\n`);
        multiSubAuthors.slice(0, 10).forEach(([author, subs]) => {
            console.log(`  u/${author}: ${[...subs].map(s => `r/${s}`).join(', ')}`);
        });
    }

    // Suggestions
    const highRelevance = newSubreddits.filter(([_, count]) => count >= 2);
    if (highRelevance.length > 0) {
        console.log(`\n--- Suggested URLs to Add ---\n`);
        highRelevance.slice(0, 5).forEach(([sub]) => {
            console.log(`  https://www.reddit.com/r/${sub}/`);
        });
        console.log(`\n  Add these to scrape-config.json or use directly with reddit-scraper.js`);
    }

    console.log(`\n${'='.repeat(55)}\n`);
}

run();
