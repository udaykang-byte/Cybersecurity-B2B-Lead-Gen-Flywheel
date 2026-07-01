#!/usr/bin/env node

/**
 * Reddit Scraper using Apify
 *
 * Usage:
 *   node scripts/reddit-scraper.js <url1> [url2] [--topic <Name>] [--sort top|new|relevance] [--max-comments N] [--max-posts N] [--since <duration>] [--parallel N]
 *
 * Examples:
 *   node scripts/reddit-scraper.js "https://www.reddit.com/r/IdentityManagement/" --topic IdentityManagement
 *
 *   node scripts/reddit-scraper.js \
 *     "https://www.reddit.com/r/grc/" \
 *     "https://www.reddit.com/r/cybersecurity/search/?q=GRC&sort=top&t=year" \
 *     --topic GRC --sort top --max-posts 15
 *
 * URL Strategy (use direct subreddit URLs — subreddit-scoped search URLs return 0):
 *   IAM:        https://www.reddit.com/r/IdentityManagement/
 *               https://www.reddit.com/r/cybersecurity/search/?q=identity+access+management
 *   GRC:        https://www.reddit.com/r/grc/
 *               https://www.reddit.com/r/SecurityCareerAdvice/search/?q=GRC
 *   PAM:        https://www.reddit.com/r/sysadmin/search/?q=privileged+access+management
 *               https://www.reddit.com/search/?q=CyberArk+OR+BeyondTrust+privileged
 *   Governance: https://www.reddit.com/r/grc/
 *               https://www.reddit.com/r/cybersecurity/search/?q=security+governance
 *
 * Note: Multiple URLs are run as separate Apify jobs and merged into one output file.
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *
 * Output:
 *   With --topic:    <Topic>/Scrapes/scrape-<timestamp>.json
 *   Without --topic: scrape-<slug>-<timestamp>.json (current directory)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './lib/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

// Load .env if available
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
} catch (e) {
    // .env not found, continue
}

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
if (!APIFY_TOKEN) {
    console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
    process.exit(1);
}

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function startScrape(url, maxComments = 10, maxPosts = 10, sort = 'top', skipComments = false) {
    const body = {
        debugMode: false,
        ignoreStartUrls: false,
        includeNSFW: true,
        maxComments: skipComments ? 0 : maxComments,
        maxCommunitiesCount: 2,
        maxItems: 50,
        maxPostCount: maxPosts,
        maxUserCount: 2,
        proxy: {
            useApifyProxy: true,
            apifyProxyGroups: ["RESIDENTIAL"]
        },
        scrollTimeout: 40,
        searchComments: false,
        searchCommunities: false,
        searchPosts: true,
        searchUsers: false,
        skipComments: skipComments,
        skipCommunity: false,
        skipUserPosts: false,
        sort: sort,
        startUrls: [{ url }]
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/trudax~reddit-scraper-lite/runs`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${APIFY_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const maxRetries = 3;
    const backoffDelays = [2000, 8000, 32000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await makeRequest(options, postData);

        if (response.status === 201) {
            return response.data;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries - 1) {
            const delay = backoffDelays[attempt];
            console.log(`  API returned ${response.status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }

        throw new Error(`Failed to start scrape: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}\n  Check your Apify dashboard for details.`);
    }
}

async function waitForCompletion(runId) {
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/actor-runs/${runId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    };

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
        const response = await makeRequest(options);
        const status = response.data?.data?.status;

        process.stdout.write(`\r  Status: ${status} (${attempts + 1}/${maxAttempts})`);

        if (status === 'SUCCEEDED') {
            process.stdout.write('\n');
            return response.data.data;
        }

        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            process.stdout.write('\n');
            const runData = response.data?.data || {};
            const msg = runData.statusMessage || 'No details available';
            throw new Error(`Scrape ${status}: ${msg}\n  Check run at: https://console.apify.com/actors/runs/${runId}`);
        }

        const delay = Math.min(3000 * Math.pow(1.3, attempts), 15000);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
    }

    throw new Error('Timeout waiting for scrape to complete');
}

async function getResults(datasetId) {
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/datasets/${datasetId}/items`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    };

    const response = await makeRequest(options);
    return response.data;
}

// When Supabase is configured, supabaseSeenUrls is a pre-loaded Set of already-stored URLs.
// Falls back to .seen-urls.json when Supabase is not configured.
function mergeAndFormat(allResults, sinceCutoff = null, topic = null, minAgeCutoff = null, skipDedup = false, supabaseSeenUrls = null) {
    const useSupabaseDedup = supabaseSeenUrls !== null;
    // Only use .seen-urls.json when Supabase is not available
    const seenUrlsFile = (!skipDedup && topic && !useSupabaseDedup) ? path.join(DATA_DIR, topic, 'Scrapes', '.seen-urls.json') : null;
    let previouslySeen = useSupabaseDedup ? supabaseSeenUrls : new Set();
    if (seenUrlsFile) {
        try {
            const existing = JSON.parse(fs.readFileSync(seenUrlsFile, 'utf8'));
            previouslySeen = new Set(existing);
        } catch { /* first run */ }
    }

    const seenUrls = new Set(previouslySeen);
    const merged = [];
    let filteredByDate = 0;
    let filteredByMinAge = 0;
    let duplicatesSkipped = 0;

    for (const item of allResults) {
        if (!skipDedup && item.url && previouslySeen.has(item.url)) {
            duplicatesSkipped++;
            continue;
        }
        if (!skipDedup && item.url && seenUrls.has(item.url)) continue;
        if (sinceCutoff && item.createdAt && new Date(item.createdAt) < sinceCutoff) {
            filteredByDate++;
            continue;
        }
        // min-age: skip items that are too fresh (newer than minAgeCutoff)
        if (minAgeCutoff && item.createdAt && item.dataType === 'post' && new Date(item.createdAt) > minAgeCutoff) {
            filteredByMinAge++;
            continue;
        }
        if (!skipDedup && item.url) seenUrls.add(item.url);
        merged.push(item);
    }

    // Save updated seen URLs (only when not using Supabase dedup)
    if (seenUrlsFile) {
        const dir = path.dirname(seenUrlsFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(seenUrlsFile, JSON.stringify([...seenUrls], null, 2));
    }

    if (duplicatesSkipped > 0) {
        console.log(`  Cross-run dedup: ${duplicatesSkipped} previously scraped items skipped`);
    }

    if (filteredByDate > 0) {
        console.log(`  Filtered by date: ${filteredByDate} items older than cutoff`);
    }

    if (filteredByMinAge > 0) {
        console.log(`  Filtered by min-age: ${filteredByMinAge} posts too recent (< min-age threshold)`);
    }

    const formatted = {
        summary: {
            totalItems: merged.length,
            posts: merged.filter(r => r.dataType === 'post').length,
            comments: merged.filter(r => r.dataType === 'comment').length,
            filteredByDate,
            filteredByMinAge
        },
        posts: [],
        comments: []
    };

    merged.forEach(item => {
        if (item.dataType === 'post') {
            formatted.posts.push({
                title: item.title,
                author: item.username,
                subreddit: (item.communityName || '').replace(/^r\//, ''),
                url: item.url,
                score: item.numberOfUpvotes,
                numComments: item.numberOfComments,
                createdAt: item.createdAt,
                body: item.body || item.text || ''
            });
        } else if (item.dataType === 'comment') {
            formatted.comments.push({
                author: item.username,
                body: item.body || item.text || '',
                score: item.numberOfUpvotes,
                createdAt: item.createdAt,
                postTitle: item.postTitle || '',
                url: item.url
            });
        }
    });

    return formatted;
}

/**
 * Parse a --since value like "7d", "30d", "24h", or "2026-01-01" into a Date cutoff.
 */
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

function validateRedditUrl(url) {
    try {
        const u = new URL(url);
        const validHosts = ['www.reddit.com', 'reddit.com', 'old.reddit.com'];
        if (!validHosts.includes(u.hostname)) {
            return `Invalid hostname "${u.hostname}" — expected reddit.com`;
        }
        if (!u.pathname.startsWith('/r/') && !u.pathname.startsWith('/search') && !u.pathname.startsWith('/user/')) {
            return `Unexpected path "${u.pathname}" — expected /r/, /search, or /user/`;
        }
        return null; // valid
    } catch {
        return `Invalid URL format: ${url}`;
    }
}

// Derive a short slug from the first URL for the output filename (fallback when no --topic)
function urlToSlug(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const sub = parts[1] || 'reddit';
        const q = u.searchParams.get('q');
        const querySlug = q ? '-' + q.replace(/[^a-z0-9]+/gi, '-').slice(0, 20) : '';
        return (sub + querySlug).toLowerCase();
    } catch {
        return 'reddit';
    }
}

async function scrapeReddit(urls, maxComments = 10, maxPosts = 10, sort = 'new', topic = null, sinceCutoff = null, parallel = 1, postsOnly = false, minAgeCutoff = null) {
    const scrapeStartTime = Date.now();
    console.log(`\nStarting Reddit scrape — ${urls.length} URL(s)`);
    if (topic) console.log(`Topic: ${topic}`);
    if (postsOnly) console.log('Mode: Posts only (comments skipped)');
    if (minAgeCutoff) console.log(`Min age: posts newer than ${minAgeCutoff.toISOString().slice(0, 10)} will be skipped`);
    console.log(`Sort: ${sort} | Max comments per URL: ${postsOnly ? 0 : maxComments} | Max posts per URL: ${maxPosts}\n`);

    const allRawResults = [];

    async function scrapeOneUrl(url, index) {
        const label = `[${index + 1}/${urls.length}]`;
        console.log(`${label} ${url}`);
        try {
            const runData = await startScrape(url, maxComments, maxPosts, sort, postsOnly);
            const runId = runData.data.id;
            console.log(`${label}   Run ID: ${runId}`);

            const completedRun = await waitForCompletion(runId);
            const datasetId = completedRun.defaultDatasetId;

            const results = await getResults(datasetId);
            if (Array.isArray(results)) {
                console.log(`${label}   Fetched ${results.length} items`);
                return results;
            } else {
                console.log(`${label}   Warning: unexpected result format`);
                return [];
            }
        } catch (err) {
            console.error(`${label}   Error: ${err.message}`);
            return [];
        }
    }

    if (parallel > 1 && urls.length > 1) {
        // Concurrency-limited parallel execution
        const executing = new Set();
        const results = [];
        for (let i = 0; i < urls.length; i++) {
            const p = scrapeOneUrl(urls[i], i).then(r => { executing.delete(p); return r; });
            executing.add(p);
            results.push(p);
            if (executing.size >= parallel) await Promise.race(executing);
        }
        const allResults = await Promise.all(results);
        for (const r of allResults) allRawResults.push(...r);
    } else {
        // Sequential (default)
        for (let i = 0; i < urls.length; i++) {
            const results = await scrapeOneUrl(urls[i], i);
            allRawResults.push(...results);
        }
    }

    // Pre-load seen URLs from Supabase when configured (replaces .seen-urls.json)
    let supabaseSeenUrls = null;
    if (db.isConfigured() && topic) {
        try {
            const candidateUrls = allRawResults.map(r => r.url).filter(Boolean);
            supabaseSeenUrls = await db.exists('reddit_leads', 'url', candidateUrls);
            if (supabaseSeenUrls.size > 0) {
                console.log(`  Supabase dedup: ${supabaseSeenUrls.size} already-stored URLs will be skipped`);
            }
        } catch (err) {
            console.warn(`  Supabase dedup check failed (${err.message}), falling back to .seen-urls.json`);
        }
    }

    const formatted = mergeAndFormat(allRawResults, sinceCutoff, topic, minAgeCutoff, false, supabaseSeenUrls);

    // Determine output path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filePrefix = postsOnly ? 'posts' : 'scrape';
    let outputFile;

    if (topic) {
        const dir = path.join(DATA_DIR, topic, 'Scrapes');
        fs.mkdirSync(dir, { recursive: true });
        outputFile = path.join(dir, `${filePrefix}-${timestamp}.json`);
    } else {
        const slug = urlToSlug(urls[0]);
        outputFile = `${filePrefix}-${slug}-${timestamp}.json`;
    }

    fs.writeFileSync(outputFile, JSON.stringify(formatted, null, 2));

    // Sync new items to Supabase
    if (db.isConfigured() && (formatted.posts.length > 0 || formatted.comments.length > 0)) {
        try {
            const rows = [
                ...formatted.posts.map(p => ({
                    topic:        topic || null,
                    author:       p.author,
                    subreddit:    p.subreddit,
                    url:          p.url,
                    type:         'POST',
                    title:        p.title || null,
                    body:         p.body || null,
                    reddit_score: p.score || 0,
                    num_comments: p.numComments || 0,
                    created_at:   p.createdAt || null,
                    scraped_at:   new Date().toISOString()
                })),
                ...formatted.comments.map(c => ({
                    topic:        topic || null,
                    author:       c.author,
                    subreddit:    null,
                    url:          c.url,
                    type:         'COMMENT',
                    title:        c.postTitle || null,
                    body:         c.body || null,
                    reddit_score: c.score || 0,
                    created_at:   c.createdAt || null,
                    scraped_at:   new Date().toISOString()
                }))
            ].filter(r => r.url);
            await db.upsert('reddit_leads', rows, 'url');
            console.log(`  Supabase: ${rows.length} item(s) synced to reddit_leads`);
        } catch (err) {
            console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
        }
    }

    console.log(`\nResults saved to: ${outputFile}`);
    console.log('\n=== SUMMARY ===');
    console.log(`Total items (deduplicated): ${formatted.summary.totalItems}`);
    console.log(`Posts: ${formatted.summary.posts}`);
    console.log(`Comments: ${formatted.summary.comments}`);

    if (formatted.posts.length > 0) {
        console.log('\n=== TOP POSTS ===');
        formatted.posts.slice(0, 3).forEach((post, i) => {
            console.log(`\n[${i + 1}] ${post.title}`);
            console.log(`    r/${post.subreddit} | u/${post.author} | ${post.numComments} comments`);
            console.log(`    ${post.url}`);
        });
    }

    if (formatted.comments.length > 0) {
        console.log('\n=== TOP COMMENTS ===');
        formatted.comments.slice(0, 5).forEach((comment, i) => {
            console.log(`\n[${i + 1}] u/${comment.author}`);
            console.log(comment.body.slice(0, 300) + (comment.body.length > 300 ? '...' : ''));
        });
    }

    if (topic) {
        console.log(`\n${'─'.repeat(50)}`);
        if (postsOnly) {
            console.log(`Next step — score posts, then fetch comments for relevant ones:`);
            console.log(`  1. node scripts/lead-scorer.js "${outputFile}" --topic ${topic}`);
            console.log(`  2. node scripts/reddit-scraper.js --fetch-comments <leads.json> --topic ${topic}`);
        } else {
            console.log(`Next step — score leads:`);
            console.log(`  node scripts/lead-scorer.js "${outputFile}" --topic ${topic}`);
        }
        console.log(`${'─'.repeat(50)}\n`);
    }

    // Append to audit log
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        topic: topic || null,
        urls,
        totalItems: formatted.summary.totalItems,
        posts: formatted.summary.posts,
        comments: formatted.summary.comments,
        filteredByDate: formatted.summary.filteredByDate,
        outputFile,
        durationMs: Date.now() - scrapeStartTime
    });
    const logPath = path.join(DATA_DIR, 'scrape-history.jsonl');
    fs.appendFileSync(logPath, logEntry + '\n');

    return formatted;
}

// ── fetch-comments mode ──────────────────────────────────────────────────────

function extractPostUrlsFromLeads(leadsFile, tiers) {
    if (!fs.existsSync(leadsFile)) {
        console.error(`Error: leads file not found: ${leadsFile}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    if (!data.leads || !Array.isArray(data.leads)) {
        console.error('Error: invalid leads file — expected { meta, leads: [...] }');
        process.exit(1);
    }

    const postUrls = new Set();
    for (const lead of data.leads) {
        if (!tiers.has(lead.tier)) continue;
        const url = lead.url;
        if (!url) continue;

        if ((lead.type || '').toUpperCase() === 'POST') {
            postUrls.add(url);
        } else {
            // Comment URL pattern: /r/sub/comments/POST_ID/POST_TITLE/COMMENT_ID/
            // Strip the comment ID to get the parent post URL
            const match = url.match(/(https:\/\/www\.reddit\.com\/r\/[^\/]+\/comments\/[^\/]+\/[^\/]+\/)/);
            if (match) {
                postUrls.add(match[1]);
            } else {
                // Fallback: use as-is (Apify can handle comment URLs too)
                postUrls.add(url);
            }
        }
    }

    return { postUrls: [...postUrls], meta: data.meta };
}

async function fetchCommentsForLeads(leadsFile, topic, tiers, maxComments = 50) {
    const fetchStartTime = Date.now();
    const { postUrls, meta } = extractPostUrlsFromLeads(leadsFile, tiers);

    if (postUrls.length === 0) {
        console.log(`No ${[...tiers].join('/')} leads found in ${leadsFile}`);
        return;
    }

    console.log(`\nFetching comments for ${postUrls.length} post(s) from ${[...tiers].join('/')} leads`);
    console.log(`Max comments per post: ${maxComments}\n`);

    // Load original posts from the source scrape file referenced in leads metadata
    let existingPosts = [];
    const sourceScrape = meta?.source;
    if (sourceScrape && fs.existsSync(sourceScrape)) {
        try {
            const sourceData = JSON.parse(fs.readFileSync(sourceScrape, 'utf8'));
            existingPosts = sourceData.posts || [];
            console.log(`Loaded ${existingPosts.length} original posts from ${sourceScrape}`);
        } catch {
            console.log(`Warning: could not load source scrape from ${sourceScrape}`);
        }
    }

    const allRawResults = [];

    for (let i = 0; i < postUrls.length; i++) {
        const url = postUrls[i];
        const label = `[${i + 1}/${postUrls.length}]`;
        console.log(`${label} ${url}`);
        try {
            const runData = await startScrape(url, maxComments, 1, 'new', false);
            const runId = runData.data.id;
            console.log(`${label}   Run ID: ${runId}`);

            const completedRun = await waitForCompletion(runId);
            const datasetId = completedRun.defaultDatasetId;
            const results = await getResults(datasetId);
            if (Array.isArray(results)) {
                console.log(`${label}   Fetched ${results.length} items`);
                allRawResults.push(...results);
            }
        } catch (err) {
            console.error(`${label}   Error: ${err.message}`);
        }

        if (i < postUrls.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Merge: existing posts + freshly fetched posts+comments
    // skipDedup=true since we're fetching specific posts on demand
    const freshFormatted = mergeAndFormat(allRawResults, null, null, null, true);

    // Combine: deduplicate posts by URL (prefer existing post data), add all comments
    const postByUrl = new Map();
    for (const p of existingPosts) {
        if (p.url) postByUrl.set(p.url, p);
    }
    for (const p of freshFormatted.posts) {
        if (p.url && !postByUrl.has(p.url)) postByUrl.set(p.url, p);
    }

    const combined = {
        summary: {
            totalItems: postByUrl.size + freshFormatted.comments.length,
            posts: postByUrl.size,
            comments: freshFormatted.comments.length,
            filteredByDate: 0,
            filteredByMinAge: 0
        },
        posts: [...postByUrl.values()],
        comments: freshFormatted.comments
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    let outputFile;
    if (topic) {
        const dir = path.join(DATA_DIR, topic, 'Scrapes');
        fs.mkdirSync(dir, { recursive: true });
        outputFile = path.join(dir, `scrape-${timestamp}.json`);
    } else {
        outputFile = `scrape-comments-${timestamp}.json`;
    }

    fs.writeFileSync(outputFile, JSON.stringify(combined, null, 2));

    console.log(`\nResults saved to: ${outputFile}`);
    console.log('\n=== SUMMARY ===');
    console.log(`Posts: ${combined.summary.posts}`);
    console.log(`Comments fetched: ${combined.summary.comments}`);

    if (topic) {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`Next step — re-score with comments included:`);
        console.log(`  node scripts/lead-scorer.js "${outputFile}" --topic ${topic}`);
        console.log(`${'─'.repeat(50)}\n`);
    }

    // Audit log
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        mode: 'fetch-comments',
        topic: topic || null,
        leadsFile,
        postUrls,
        posts: combined.summary.posts,
        comments: combined.summary.comments,
        outputFile,
        durationMs: Date.now() - fetchStartTime
    });
    const logPath = path.join(DATA_DIR, 'scrape-history.jsonl');
    fs.appendFileSync(logPath, logEntry + '\n');

    return combined;
}

// CLI arg parsing
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0) {
    console.log(`
Reddit Scraper using Apify

Usage:
  node scripts/reddit-scraper.js <url1> [url2] [--topic <Name>] [--sort top|new|relevance]
    [--max-comments N] [--max-posts N] [--since <duration>] [--parallel N]
    [--posts-only] [--min-age N] [--fetch-comments <leads.json>]

Multiple URLs are run as separate Apify jobs and merged + deduplicated into one output file.

Options:
  --topic <Name>            Organize output into topic directories
  --sort <order>            Sort order: top, new, relevance (default: new)
  --max-comments N          Max comments per URL (default: 10)
  --max-posts N             Max posts per URL (default: 10)
  --since <duration>        Filter out posts older than N (e.g., 7d, 24h, 2w, or 2026-01-01)
  --min-age N               Skip posts newer than N days (default: none). Use with --posts-only
                            to ensure posts have had time to accumulate comments.
  --parallel N              Scrape N URLs concurrently (max 5, default: 1)
  --posts-only              Fetch posts only (no comments). Saves Apify cost in Phase 1.
                            Output file is named posts-<timestamp>.json
  --fetch-comments <file>   Phase 2: fetch comments for HOT/WARM posts in a scored leads JSON.
                            Merges with the original posts and outputs scrape-<timestamp>.json.
  --tiers <HOT,WARM>        Tiers to include in --fetch-comments (default: HOT,WARM)

Two-phase workflow (recommended):
  Phase 1 — posts only, min 7 days old:
    node scripts/reddit-scraper.js "https://www.reddit.com/r/IdentityManagement/" \\
      --topic IdentityManagement --posts-only --min-age 7

  Score:
    node scripts/lead-scorer.js IdentityManagement/Scrapes/posts-<timestamp>.json \\
      --topic IdentityManagement

  Phase 2 — fetch comments for HOT/WARM posts only:
    node scripts/reddit-scraper.js \\
      --fetch-comments IdentityManagement/Leads/leads-<date>.json \\
      --topic IdentityManagement

  Enrich:
    node scripts/enrich-leads.js IdentityManagement/Leads/leads-<date>.json \\
      --topic IdentityManagement --exa --sherlock

Examples:
  Single URL with topic (standard):
    node scripts/reddit-scraper.js "https://www.reddit.com/r/IdentityManagement/" --topic IdentityManagement

  Multi-URL, parallel, recent only:
    node scripts/reddit-scraper.js \\
      "https://www.reddit.com/r/grc/" \\
      "https://www.reddit.com/r/cybersecurity/search/?q=GRC&sort=top&t=year" \\
      --topic GRC --max-posts 15 --since 30d --parallel 3

URL Strategy:
  IAM:        https://www.reddit.com/r/IdentityManagement/
              https://www.reddit.com/r/cybersecurity/search/?q=identity+access+management
  GRC:        https://www.reddit.com/r/grc/
              https://www.reddit.com/r/SecurityCareerAdvice/search/?q=GRC
  PAM:        https://www.reddit.com/r/sysadmin/search/?q=privileged+access+management
              https://www.reddit.com/search/?q=CyberArk+OR+BeyondTrust
  Governance: https://www.reddit.com/r/grc/
              https://www.reddit.com/r/cybersecurity/search/?q=security+governance
    `);
    process.exit(0);
}

const urls = [];
let sort = 'new';
let maxComments = 10;
let maxPosts = 10;
let topic = null;
let sinceCutoff = null;
let parallel = 1;
let postsOnly = false;
let minAgeCutoff = null;
let fetchCommentsFile = null;
let tiers = new Set(['HOT', 'WARM']);

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('https://')) {
        urls.push(arg);
    } else if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--sort') {
        sort = rawArgs[++i] || 'top';
    } else if (arg === '--max-comments') {
        maxComments = parseInt(rawArgs[++i]) || 10;
    } else if (arg === '--max-posts') {
        maxPosts = parseInt(rawArgs[++i]) || 10;
    } else if (arg === '--since') {
        sinceCutoff = parseSinceCutoff(rawArgs[++i]);
    } else if (arg === '--parallel') {
        parallel = Math.min(Math.max(parseInt(rawArgs[++i]) || 1, 1), 5);
    } else if (arg === '--posts-only') {
        postsOnly = true;
    } else if (arg === '--min-age') {
        const days = parseInt(rawArgs[++i]) || 7;
        minAgeCutoff = new Date(Date.now() - days * 86400000);
    } else if (arg === '--fetch-comments') {
        fetchCommentsFile = rawArgs[++i] || null;
    } else if (arg === '--tiers') {
        const val = rawArgs[++i] || 'HOT,WARM';
        tiers = new Set(val.split(',').map(t => t.trim().toUpperCase()));
    }
}

// --fetch-comments mode: Phase 2
if (fetchCommentsFile) {
    if (!topic) {
        console.error('Error: --topic is required with --fetch-comments.');
        process.exit(1);
    }
    fetchCommentsForLeads(fetchCommentsFile, topic, tiers, maxComments || 50);
} else {
    if (urls.length === 0) {
        console.error('Error: at least one Reddit URL is required (or use --fetch-comments <leads.json>).');
        process.exit(1);
    }

    // Validate all URLs before spending Apify credits
    const invalidUrls = urls.map(u => ({ url: u, error: validateRedditUrl(u) })).filter(r => r.error);
    if (invalidUrls.length > 0) {
        console.error('\nInvalid Reddit URL(s):');
        invalidUrls.forEach(({ url, error }) => console.error(`  ${url}\n    → ${error}`));
        process.exit(1);
    }

    scrapeReddit(urls, maxComments, maxPosts, sort, topic, sinceCutoff, parallel, postsOnly, minAgeCutoff);
}

export { scrapeReddit };
