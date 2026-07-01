#!/usr/bin/env node

/**
 * LinkedIn People Signal Scanner
 *
 * Searches LinkedIn for new CISO/IT Director/Security Manager hires using Apify.
 * The playbook identifies a 90-day vendor selection window after a new security
 * leader is hired — this script finds those hires and scores them.
 *
 * Usage:
 *   node Skills/linkedin-people.js [options]
 *
 * Options:
 *   --topic <Name>          Topic directory for output (default: auto)
 *   --category <cat>        Role filter: ciso, director, manager, all (default: all)
 *   --since <duration>      Job change recency filter (default: 90d)
 *   --max-results <N>       Max results per search (default: 25)
 *   --dry-run               Print queries without calling Apify
 *
 * Examples:
 *   node Skills/linkedin-people.js --topic IdentityManagement --category ciso --since 90d
 *   node Skills/linkedin-people.js --category director --max-results 10
 *   node Skills/linkedin-people.js --dry-run
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *
 * Output:
 *   <Topic>/LinkedIn/people-<timestamp>.json
 *   <Topic>/LinkedIn/people-<timestamp>.md
 *   linkedin-history.jsonl (audit log)
 */

import https from 'https';
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
} catch (e) {
    // .env not found, continue
}

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ── Apify Actor ──
const ACTOR_ID = 'harvestapi~linkedin-profile-search';
const ACTOR_URL = 'https://apify.com/harvestapi/linkedin-profile-search';

// ── Playbook People Search Queries ──
const SEARCH_QUERIES = {
    ciso: [
        'CISO',
        'Chief Information Security Officer',
        'vCISO virtual CISO'
    ],
    director: [
        'VP Information Security',
        'Director of Information Security',
        'Director of Cybersecurity',
        'Head of Cybersecurity',
        'Head of Identity'
    ],
    manager: [
        'Security Manager',
        'IT Security Manager',
        'Compliance Officer',
        'Identity and Access Management Manager'
    ]
};

// ── Role Classification ──
function classifyRole(title, headline) {
    const text = ((title || '') + ' ' + (headline || '')).toLowerCase();

    if (/\b(ciso|chief information security officer|vciso|virtual ciso)\b/.test(text)) {
        return 'CISO';
    }
    if (/\b(vp|vice president).*(?:information|cyber).*security\b/.test(text)) {
        return 'VP';
    }
    if (/\b(director).*(?:information|cyber|it).*security\b/.test(text) || /\bhead of (?:cyber|information|identity)\b/.test(text)) {
        return 'Director';
    }
    if (/\b(manager|lead).*(?:security|compliance|identity|iam|grc)\b/.test(text)) {
        return 'Manager';
    }
    if (/\b(compliance officer|compliance director)\b/.test(text)) {
        return 'Compliance';
    }
    return 'Other';
}

// ── Scoring (from playbook) ──
const ROLE_SCORES = {
    'CISO':       { base: 35, urgency: 'High',   window: '3-day' },
    'VP':         { base: 33, urgency: 'High',   window: '3-day' },
    'Director':   { base: 30, urgency: 'High',   window: 'week 1' },
    'Manager':    { base: 25, urgency: 'Medium', window: 'next batch' },
    'Compliance': { base: 25, urgency: 'Medium', window: 'next batch' },
    'Other':      { base: 20, urgency: 'Medium', window: 'next batch' }
};

const BONUSES = {
    noIAMVendorDetected: 5,
    recentJobChange:     3,
    targetIndustry:      3
};

// ── Target Industries ──
const TARGET_INDUSTRIES = [
    'financial services', 'fintech', 'healthcare', 'healthtech',
    'saas', 'software', 'technology', 'defense', 'government',
    'insurance', 'banking', 'pharmaceutical', 'biotech',
    'energy', 'manufacturing', 'retail', 'e-commerce'
];

// ── Outreach Templates ──
const OUTREACH_TEMPLATES = {
    'CISO': {
        angle: 'CISO 90-day priorities',
        opener: 'Most CISOs spend their first 90 days auditing privileged access and identity governance. We help new security leaders accelerate that assessment.',
        cta: 'Happy to share what we\'re seeing across the space.'
    },
    'VP': {
        angle: 'Security leadership priorities',
        opener: 'New VPs of security typically inherit identity and access debt that\'s been accumulating. We help security leaders get visibility fast.',
        cta: 'Worth connecting to compare notes?'
    },
    'Director': {
        angle: 'Security program build-out',
        opener: 'Directors building out security programs often find identity governance is the first gap to close. We help teams accelerate that process.',
        cta: 'Happy to share our approach.'
    },
    'Manager': {
        angle: 'Operational security',
        opener: 'Security managers dealing with access management at scale know it\'s a constant challenge. We help teams automate the manual parts.',
        cta: 'Would a 15-min call be useful?'
    },
    'Compliance': {
        angle: 'Compliance implementation',
        opener: 'Compliance frameworks require identity controls — but implementing them is harder than passing the audit. We bridge that gap.',
        cta: 'Can share what other companies got dinged on.'
    },
    'Other': {
        angle: 'Security professional',
        opener: 'Security professionals in new roles often reassess their identity and access management stack. We help teams navigate that evaluation.',
        cta: 'Worth a conversation?'
    }
};

// ── HTTP Helper ──
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

// ── Apify Helpers ──
async function startActorRun(query, maxResults) {
    const body = {
        keyword: query,
        maxResults: maxResults,
        proxy: {
            useApifyProxy: true
        }
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/${ACTOR_ID}/runs`,
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

        throw new Error(`Failed to start actor run: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}\n  Actor: ${ACTOR_URL}`);
    }
}

async function waitForCompletion(runId, label = '') {
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

        process.stdout.write(`\r${label}  Status: ${status} (${attempts + 1}/${maxAttempts})`);

        if (status === 'SUCCEEDED') {
            process.stdout.write('\n');
            return response.data.data;
        }

        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            process.stdout.write('\n');
            const msg = response.data?.data?.statusMessage || 'No details';
            throw new Error(`Actor run ${status}: ${msg}\n  Check: https://console.apify.com/actors/runs/${runId}`);
        }

        const delay = Math.min(3000 * Math.pow(1.3, attempts), 15000);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
    }

    throw new Error('Timeout waiting for actor run to complete');
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
    return Array.isArray(response.data) ? response.data : [];
}

// ── Signal Extraction ──
function isRecentJobChange(profile, sinceCutoff) {
    // Check various fields that might indicate when someone started their current role
    const startDate = profile.currentCompanyJoinDate || profile.startDate || profile.joinedDate || '';
    if (startDate) {
        const parsed = new Date(startDate);
        if (!isNaN(parsed.getTime())) {
            return parsed >= sinceCutoff;
        }
    }
    // If no date available, include them but flag as unconfirmed
    return null; // null = unknown
}

function detectTargetIndustry(profile) {
    const text = ((profile.industry || '') + ' ' + (profile.company || '') + ' ' +
        (profile.headline || '') + ' ' + (profile.summary || '')).toLowerCase();
    return TARGET_INDUSTRIES.filter(ind => text.includes(ind));
}

function extractPeopleSignals(results, sinceCutoff) {
    const signals = [];

    for (const person of results) {
        const name = person.name || person.fullName || '';
        const title = person.title || person.currentTitle || person.headline || '';
        const headline = person.headline || '';
        const company = person.company || person.currentCompany || '';
        const companyUrl = person.companyUrl || person.companyLinkedinUrl || '';
        const profileUrl = person.profileUrl || person.url || person.linkedinUrl || '';
        const location = person.location || '';
        const industry = person.industry || '';

        const role = classifyRole(title, headline);
        const recentChange = isRecentJobChange(person, sinceCutoff);
        const targetIndustries = detectTargetIndustry(person);

        // Score
        const rule = ROLE_SCORES[role];
        let baseScore = rule.base;
        let urgency = rule.urgency;
        let window = rule.window;
        const bonuses = [];

        if (recentChange === true) {
            bonuses.push({ reason: 'confirmed recent job change', points: BONUSES.recentJobChange });
        }
        if (targetIndustries.length > 0) {
            bonuses.push({ reason: `target industry: ${targetIndustries[0]}`, points: BONUSES.targetIndustry });
        }
        // noIAMVendor bonus: applied by default since we can't detect vendor from profile alone
        // (would need to cross-reference with jobs data)

        const totalScore = Math.min(50, baseScore + bonuses.reduce((sum, b) => sum + b.points, 0));

        // Outreach
        const template = OUTREACH_TEMPLATES[role];

        signals.push({
            id: `li-person-${signals.length + 1}`,
            source: 'linkedin-people',
            type: `new-${role.toLowerCase()}-hired`,
            name,
            role,
            title,
            headline,
            company,
            companyUrl: normalizeCompanyUrl(companyUrl),
            profileUrl,
            location,
            industry,
            detectedAt: new Date().toISOString(),
            recentJobChange: recentChange,
            targetIndustries,
            baseScore,
            bonuses,
            totalScore,
            urgency,
            urgencyWindow: window,
            outreachAngle: template.angle,
            suggestedMessage: template.opener + ' ' + template.cta
        });
    }

    return signals;
}

function normalizeCompanyUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(Boolean);
        if (pathParts[0] === 'company' && pathParts[1]) {
            return `https://www.linkedin.com/company/${pathParts[1]}`;
        }
    } catch { /* return as-is */ }
    return url;
}

// ── Deduplication ──
function loadSeenUrls(topic) {
    const seenFile = topic ? path.join(topic, 'LinkedIn', '.seen-urls.json') : null;
    if (!seenFile) return { seen: new Set(), file: null };
    try {
        const existing = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
        return { seen: new Set(existing), file: seenFile };
    } catch {
        return { seen: new Set(), file: seenFile };
    }
}

function saveSeenUrls(seenSet, seenFile) {
    if (!seenFile) return;
    const dir = path.dirname(seenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...seenSet], null, 2));
}

// ── Output Generation ──
function buildOutputJSON(signals, meta) {
    const byUrgency = { High: 0, Medium: 0 };
    const byRole = {};

    for (const s of signals) {
        byUrgency[s.urgency] = (byUrgency[s.urgency] || 0) + 1;
        byRole[s.role] = (byRole[s.role] || 0) + 1;
    }

    return {
        meta: {
            ...meta,
            signalsExtracted: signals.length,
            byUrgency,
            byRole
        },
        signals: signals.sort((a, b) => b.totalScore - a.totalScore)
    };
}

function generateMarkdownReport(signals, meta) {
    const lines = [];
    const date = new Date().toISOString().split('T')[0];

    lines.push(`# LinkedIn People — New Hires Report (${date})`);
    lines.push('');
    lines.push(`**Topic:** ${meta.topic} | **Category:** ${meta.category} | **Queries run:** ${meta.queriesRun}`);
    lines.push(`**People found:** ${signals.length} | **Recency filter:** ${meta.sinceLabel || '90d'}`);
    lines.push('');

    // Group by urgency
    const byUrgency = { High: [], Medium: [] };
    for (const s of signals) {
        if (byUrgency[s.urgency]) byUrgency[s.urgency].push(s);
        else byUrgency.Medium.push(s);
    }

    lines.push('## Summary');
    lines.push('');
    lines.push('| Role | Count |');
    lines.push('|------|-------|');
    const roleCounts = {};
    for (const s of signals) roleCounts[s.role] = (roleCounts[s.role] || 0) + 1;
    for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${role} | ${count} |`);
    }
    lines.push('');

    for (const [urgencyLevel, urgencySignals] of Object.entries(byUrgency)) {
        if (urgencySignals.length === 0) continue;

        lines.push(`## ${urgencyLevel} Priority`);
        lines.push('');

        for (const s of urgencySignals.sort((a, b) => b.totalScore - a.totalScore)) {
            lines.push(`### ${s.name || 'Unknown'} — ${s.role}`);
            lines.push(`**Score:** ${s.totalScore}/50 | **Window:** ${s.urgencyWindow}`);
            lines.push(`**Title:** ${s.title}`);
            if (s.company) lines.push(`**Company:** ${s.company}`);
            if (s.location) lines.push(`**Location:** ${s.location}`);
            if (s.industry) lines.push(`**Industry:** ${s.industry}`);
            if (s.profileUrl) lines.push(`**LinkedIn:** ${s.profileUrl}`);
            if (s.companyUrl) lines.push(`**Company page:** ${s.companyUrl}`);
            lines.push('');

            if (s.recentJobChange === true) {
                lines.push('**Confirmed recent job change** (within 90-day vendor selection window)');
            } else if (s.recentJobChange === null) {
                lines.push('*Job change date not confirmed — verify manually*');
            }

            if (s.targetIndustries.length > 0) {
                lines.push(`**Target industry match:** ${s.targetIndustries.join(', ')}`);
            }

            if (s.bonuses.length > 0) {
                lines.push(`**Score bonuses:** ${s.bonuses.map(b => `+${b.points} (${b.reason})`).join(', ')}`);
            }

            lines.push('');
            lines.push(`**Outreach angle:** ${s.outreachAngle}`);
            lines.push(`> ${s.suggestedMessage}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    return lines.join('\n');
}

function appendAuditLog(entry) {
    const logPath = path.join(__dirname, '..', 'linkedin-history.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ── Since Parser ──
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
    throw new Error(`Invalid --since value: "${value}". Use formats like 90d, 30d, 2w`);
}

// ── Main ──
async function scanLinkedInPeople(options) {
    const { topic, category, maxResults, sinceCutoff, sinceLabel, dryRun } = options;
    const startTime = Date.now();

    const categories = category === 'all' ? Object.keys(SEARCH_QUERIES) : [category];
    const queries = [];
    for (const cat of categories) {
        if (!SEARCH_QUERIES[cat]) {
            console.error(`Error: unknown category "${cat}". Valid: ${Object.keys(SEARCH_QUERIES).join(', ')}, all`);
            process.exit(1);
        }
        for (const q of SEARCH_QUERIES[cat]) {
            queries.push({ query: q, category: cat });
        }
    }

    console.log(`\nLinkedIn People Signal Scanner`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Topic: ${topic || 'auto'}`);
    console.log(`Category: ${category}`);
    console.log(`Queries: ${queries.length}`);
    console.log(`Max results per query: ${maxResults}`);
    console.log(`Recency filter: ${sinceLabel}`);
    console.log(`Actor: ${ACTOR_ID}`);
    console.log(`${'─'.repeat(40)}\n`);

    if (dryRun) {
        console.log('DRY RUN — no Apify calls will be made.\n');
        console.log(`Actor page: ${ACTOR_URL}`);
        console.log(`\nQueries that would be run:\n`);
        for (let i = 0; i < queries.length; i++) {
            const q = queries[i];
            console.log(`  [${i + 1}] (${q.category}) ${q.query}`);
        }
        console.log(`\nEstimated Apify cost: ~$${(queries.length * maxResults * 0.02 / 50).toFixed(2)}-$${(queries.length * maxResults * 0.05 / 50).toFixed(2)}`);
        console.log(`\nTo run for real, remove --dry-run`);
        return;
    }

    if (!APIFY_TOKEN) {
        console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
        process.exit(1);
    }

    const { seen: fileSeenUrls, file: seenFile } = loadSeenUrls(topic);
    let supabaseSeenUrls = null;
    let dupCount = 0;
    const allSignals = [];
    let totalResults = 0;

    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const label = `[${i + 1}/${queries.length}]`;

        console.log(`${label} Searching: ${q.query}`);

        try {
            const runData = await startActorRun(q.query, maxResults);
            const runId = runData.data.id;
            console.log(`${label}   Run ID: ${runId}`);

            const completedRun = await waitForCompletion(runId, label);
            const datasetId = completedRun.defaultDatasetId;

            const results = await getResults(datasetId);
            console.log(`${label}   Fetched ${results.length} results`);
            totalResults += results.length;

            // Dedup by profile URL — use Supabase when configured
            if (db.isConfigured() && !supabaseSeenUrls) {
                try {
                    const candidateUrls = results.map(r => r.profileUrl || r.url || r.linkedinUrl || '').filter(Boolean);
                    supabaseSeenUrls = await db.exists('people_signals', 'profile_url', candidateUrls);
                } catch (err) {
                    console.warn(`  Supabase dedup check failed (${err.message}), using .seen-urls.json`);
                }
            }
            const effectiveSeen = supabaseSeenUrls || fileSeenUrls;

            const deduped = results.filter(r => {
                const profileUrl = r.profileUrl || r.url || r.linkedinUrl || '';
                if (profileUrl && effectiveSeen.has(profileUrl)) {
                    dupCount++;
                    return false;
                }
                if (profileUrl && !supabaseSeenUrls) fileSeenUrls.add(profileUrl);
                return true;
            });

            const signals = extractPeopleSignals(deduped, sinceCutoff);

            // Filter by confirmed recent job change if date is available
            const filtered = signals.filter(s => s.recentJobChange !== false);

            allSignals.push(...filtered);

        } catch (err) {
            console.error(`${label}   Error: ${err.message}`);
        }

        if (i < queries.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (dupCount > 0) {
        console.log(`\nCross-run dedup: ${dupCount} previously seen profiles skipped`);
    }

    if (!supabaseSeenUrls) saveSeenUrls(fileSeenUrls, seenFile);

    // Output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const outputTopic = topic || 'LinkedIn';
    const dir = path.join(outputTopic, 'LinkedIn');
    fs.mkdirSync(dir, { recursive: true });

    const jsonFile = path.join(dir, `people-${timestamp}.json`);
    const mdFile = path.join(dir, `people-${timestamp}.md`);

    const meta = {
        topic: outputTopic,
        source: 'linkedin-people',
        category,
        sinceLabel,
        scannedAt: new Date().toISOString().split('T')[0],
        queriesRun: queries.length,
        totalResults,
        durationMs: Date.now() - startTime
    };

    const outputJSON = buildOutputJSON(allSignals, meta);
    fs.writeFileSync(jsonFile, JSON.stringify(outputJSON, null, 2));

    const mdContent = generateMarkdownReport(allSignals, meta);
    fs.writeFileSync(mdFile, mdContent);

    // Sync to Supabase
    if (db.isConfigured() && allSignals.length > 0) {
        try {
            // Upsert companies
            const companyMap = {};
            const uniqueCompanies = [...new Map(
                allSignals.filter(s => s.companyUrl).map(s => [s.companyUrl, s])
            ).values()];
            for (const s of uniqueCompanies) {
                try {
                    const id = await db.findOrCreateCompany({
                        name:        s.company,
                        linkedin_url: s.companyUrl,
                        industry:    s.industry || null
                    });
                    companyMap[s.companyUrl] = id;
                } catch { /* continue */ }
            }

            // Upsert people_signals
            const signalRows = allSignals.filter(s => s.profileUrl).map(s => ({
                company_id:        companyMap[s.companyUrl] || null,
                source:            'linkedin-people',
                type:              s.type,
                name:              s.name,
                title:             s.title,
                role:              s.role,
                profile_url:       s.profileUrl,
                location:          s.location || null,
                industry:          s.industry || null,
                base_score:        s.baseScore,
                total_score:       s.totalScore,
                urgency:           s.urgency,
                urgency_window:    s.urgencyWindow || null,
                outreach_angle:    s.outreachAngle || null,
                suggested_message: s.suggestedMessage || null,
                detected_at:       s.detectedAt
            }));
            await db.upsert('people_signals', signalRows, 'profile_url');
            console.log(`  Supabase: ${signalRows.length} people signal(s) + ${uniqueCompanies.length} company record(s) synced`);
        } catch (err) {
            console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
        }
    }

    appendAuditLog({
        timestamp: new Date().toISOString(),
        script: 'linkedin-people',
        topic: outputTopic,
        category,
        queriesRun: queries.length,
        totalResults,
        signalsFound: allSignals.length,
        high: allSignals.filter(s => s.urgency === 'High').length,
        medium: allSignals.filter(s => s.urgency === 'Medium').length,
        outputFile: jsonFile,
        durationMs: Date.now() - startTime
    });

    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Total profiles found:  ${totalResults}`);
    console.log(`Signals extracted:     ${allSignals.length}`);
    console.log(`  High priority:  ${allSignals.filter(s => s.urgency === 'High').length}`);
    console.log(`  Medium:         ${allSignals.filter(s => s.urgency === 'Medium').length}`);

    const roleCounts = {};
    for (const s of allSignals) roleCounts[s.role] = (roleCounts[s.role] || 0) + 1;
    console.log(`\nBy role:`);
    for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${role}: ${count}`);
    }

    console.log(`\nSaved to:`);
    console.log(`  ${jsonFile}`);
    console.log(`  ${mdFile}`);
    console.log(`${'='.repeat(50)}\n`);

    return outputJSON;
}

// ── CLI ──
const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`
LinkedIn People Signal Scanner

Finds new CISO/IT Director/Security Manager hires on LinkedIn.
The playbook identifies a 90-day vendor selection window after hire.

Usage:
  node Skills/linkedin-people.js [options]

Options:
  --topic <Name>          Topic directory for output (default: auto)
  --category <cat>        Role filter: ciso, director, manager, all (default: all)
  --since <duration>      Job change recency filter (default: 90d)
  --max-results <N>       Max results per search (default: 25)
  --dry-run               Print queries without calling Apify

Examples:
  node Skills/linkedin-people.js --topic IdentityManagement --category ciso
  node Skills/linkedin-people.js --category director --max-results 10
  node Skills/linkedin-people.js --dry-run

Playbook role categories:
  ciso      CISO, Chief Information Security Officer, vCISO
  director  VP InfoSec, Director InfoSec, Head of Cybersecurity/Identity
  manager   Security Manager, IT Security Manager, Compliance Officer, IAM Manager
  all       Run all categories
    `);
    process.exit(0);
}

let topic = null;
let category = 'all';
let maxResults = 25;
let sinceLabel = '90d';
let sinceCutoff = new Date(Date.now() - 90 * 86400000); // Default: 90 days
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--category') {
        category = (rawArgs[++i] || 'all').toLowerCase();
    } else if (arg === '--max-results') {
        maxResults = parseInt(rawArgs[++i]) || 25;
    } else if (arg === '--since') {
        sinceLabel = rawArgs[++i];
        sinceCutoff = parseSinceCutoff(sinceLabel);
    } else if (arg === '--dry-run') {
        dryRun = true;
    }
}

scanLinkedInPeople({ topic, category, maxResults, sinceCutoff, sinceLabel, dryRun });

export { scanLinkedInPeople };
