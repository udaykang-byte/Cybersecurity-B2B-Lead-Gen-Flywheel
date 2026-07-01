#!/usr/bin/env node

/**
 * Account Signal Scoring
 *
 * Account-centric signal intelligence. Takes a list of target companies, gathers
 * all available signals (LinkedIn enrichment, Exa.ai news, HHS OCR breach data,
 * existing local job/feed scans), scores each account using the calibrated playbook
 * model, detects high-value signal stacks, and ranks accounts by urgency.
 *
 * CSV Input:
 *   Accepts a CSV with a LinkedIn company URL column (same format as linkedin-companies).
 *   - URL-only:  one URL per line
 *   - With metadata: company_name,linkedin_url,...
 *
 * Usage:
 *   node scripts/account-signals.js <csv-file> [options]
 *
 * Options:
 *   --min-score <N>         Only include accounts scoring >= N (default: 15)
 *   --no-enrich             Skip Exa.ai research, use local data only (faster)
 *   --no-linkedin           Skip LinkedIn Apify enrichment
 *   --no-notify             Skip Slack notifications
 *   --dry-run               Show plan without making API calls
 *
 * Examples:
 *   node scripts/account-signals.js target-accounts.csv
 *   node scripts/account-signals.js accounts.csv --min-score 28 --no-enrich
 *   node scripts/account-signals.js urls.csv --dry-run
 *
 * Environment:
 *   Requires APIFY_API_TOKEN and EXA_API_KEY in .env
 *   Optional: SLACK_WEBHOOK_URL for notifications
 *
 * Output:
 *   AccountSignals/<timestamp>/ranked-accounts.md
 *   AccountSignals/<timestamp>/ranked-accounts.json
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { searchCompanyNews, isConfigured as isDiscogenConfigured } from './lib/discogen.js';
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

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

// ── Playbook Signal Scoring Model ──
// Base scores out of 50, sourced from the Intent Signals Playbook
const SIGNAL_DEFS = {
    breach_announced:        { base: 45, bonusField: 'ciso_identified',      bonusPts: 5,  label: 'Breach/ransomware announced' },
    hiring_ciso_and_iam:     { base: 42, bonusField: 'competitor_in_jd',     bonusPts: 5,  label: 'Hiring CISO + simultaneously hiring IAM engineer' },
    soc2_and_compliance:     { base: 40, bonusField: 'vanta_drata_detected', bonusPts: 3,  label: 'SOC 2 audit in progress + hiring compliance role' },
    cyber_insurance_funding: { base: 38, bonusField: 'security_hire_open',   bonusPts: 4,  label: 'Cyber insurance trigger + funding event' },
    new_ciso_hired:          { base: 35, bonusField: 'no_iam_vendor',        bonusPts: 5,  label: 'New CISO hired (within 90 days)' },
    funding_bc_soc2:         { base: 33, bonusField: 'hiring_compliance',    bonusPts: 4,  label: 'Funding (Series B/C) + SOC 2 pressure' },
    competitor_in_jd:        { base: 32, bonusField: 'multiple_postings',    bonusPts: 5,  label: 'Competitor tool detected in job posting' },
    cloud_migration:         { base: 28, bonusField: 'security_hire_open',   bonusPts: 4,  label: 'Cloud migration announcement' },
    ma_activity:             { base: 28, bonusField: 'both_in_icp',          bonusPts: 4,  label: 'M&A activity announced' },
    hiring_security_grc:     { base: 25, bonusField: 'compliance_framework', bonusPts: 3,  label: 'Hiring IT Security/GRC role' },
    social_pain_post:        { base: 22, bonusField: 'person_identified',    bonusPts: 5,  label: 'Reddit/LinkedIn post about access pain' },
    funding_a_only:          { base: 18, bonusField: 'regulated_industry',   bonusPts: 5,  label: 'Funding (Series A) only' },
    content_consumption:     { base: 15, bonusField: 'iam_pam_specific',     bonusPts: 3,  label: 'Content consumption signal' },
};

// High-value signal stacks — if all signals in a stack are detected, use combined score
const SIGNAL_STACKS = [
    { signals: ['breach_announced', 'hiring_ciso_and_iam'],  combined: 50, label: 'Breach disclosed + CISO role open',               meaning: "In crisis mode AND rebuilding — perfect" },
    { signals: ['new_ciso_hired', 'competitor_in_jd'],        combined: 47, label: 'New CISO hired + CyberArk/SailPoint job posting', meaning: "New leader auditing the stack, budget confirmed" },
    { signals: ['soc2_and_compliance', 'funding_bc_soc2'],    combined: 45, label: 'SOC 2 in progress + Vanta in JD + Series B',      meaning: "Classic mid-market compliance-driven buyer" },
    { signals: ['ma_activity', 'hiring_security_grc'],        combined: 43, label: 'PE acquisition + IAM/GRC role opening',           meaning: "PE firm mandating controls post-acquisition" },
    { signals: ['breach_announced', 'hiring_security_grc'],   combined: 43, label: 'HIPAA breach + hiring compliance manager',        meaning: "Remediation mode = urgent buyer" },
    { signals: ['funding_bc_soc2', 'soc2_and_compliance'],    combined: 40, label: 'Series C + enterprise customer demanding SOC 2',  meaning: "Pipeline pressure = budget pressure" },
    { signals: ['hiring_security_grc', 'competitor_in_jd'],   combined: 40, label: 'CMMC requirement + PAM job posting',              meaning: "Federal contract at risk = non-negotiable buy" },
    { signals: ['hiring_security_grc', 'social_pain_post'],   combined: 38, label: 'Hiring access management + LinkedIn pain post',   meaning: "Problem confirmed at person level" },
];

// Urgency tiers
function getTier(score) {
    if (score >= 35) return { tier: 'CRITICAL', action: '24-48hr outreach', emoji: '🔴' };
    if (score >= 28) return { tier: 'HIGH',     action: '3-day / week 1 outreach', emoji: '🟠' };
    if (score >= 22) return { tier: 'MEDIUM',   action: 'Next batch', emoji: '🟡' };
    if (score >= 15) return { tier: 'LOW',      action: 'Monitor list', emoji: '🟢' };
    return { tier: 'SKIP', action: 'No action', emoji: '⚪' };
}

// Competitor tools that indicate displacement opportunity (found in prospect JDs = good signal)
const PAM_COMPETITORS = ['cyberark', 'beyondtrust', 'delinea', 'thycotic', 'centrify', 'sailpoint', 'saviynt', 'one identity', 'balabit'];
const IAM_TOOLS = ['okta', 'ping identity', 'auth0', 'azure ad', 'microsoft entra', 'active directory'];
const COMPLIANCE_TOOLS = ['vanta', 'drata', 'secureframe', 'tugboat logic', 'anecdotes'];
const COMPLIANCE_FRAMEWORKS = ['soc 2', 'soc2', 'iso 27001', 'hipaa', 'cmmc', 'fedramp', 'pci dss', 'nist', 'hitrust', 'nerc cip'];

// ── Competitor Company Blocklist ──
// These are companies that SELL competing products — we would never reach out to sell to them.
// They are disqualified before any scoring or API calls are made.
const COMPETITOR_COMPANIES = [
    // PAM / Privileged Access
    { name: 'cyberark',       slugs: ['cyberark'] },
    { name: 'beyondtrust',    slugs: ['beyondtrust'] },
    { name: 'delinea',        slugs: ['delinea'] },
    { name: 'thycotic',       slugs: ['thycotic'] },
    { name: 'centrify',       slugs: ['centrify'] },
    { name: 'balabit',        slugs: ['balabit', 'one-identity'] },
    // IGA / Identity Governance
    { name: 'sailpoint',      slugs: ['sailpoint'] },
    { name: 'saviynt',        slugs: ['saviynt'] },
    { name: 'one identity',   slugs: ['oneidentity', 'one-identity'] },
    // IAM / SSO
    { name: 'okta',           slugs: ['okta', 'okta-inc'] },
    { name: 'ping identity',  slugs: ['pingidentity', 'ping-identity'] },
    { name: 'auth0',          slugs: ['auth0'] },
    { name: 'forgerock',      slugs: ['forgerock'] },
    // Compliance Automation
    { name: 'vanta',          slugs: ['vanta'] },
    { name: 'drata',          slugs: ['drata'] },
    { name: 'secureframe',    slugs: ['secureframe'] },
    // Other Security Vendors (direct competitors or adjacent)
    { name: 'crowdstrike',    slugs: ['crowdstrike'] },
    { name: 'palo alto networks', slugs: ['paboroalto-networks', 'palo-alto-networks'] },
    { name: 'zscaler',        slugs: ['zscaler'] },
    { name: 'hashicorp',      slugs: ['hashicorp'] },
    { name: 'conjur',         slugs: ['cyberark'] },  // CyberArk owns Conjur
];

function isCompetitorCompany(name, companyUrl) {
    const nameLower = (name || '').toLowerCase().trim();
    const urlSlug = (companyUrl.match(/\/company\/([^/]+)/)?.[1] || '').toLowerCase();

    for (const comp of COMPETITOR_COMPANIES) {
        // Match by name
        if (nameLower && (nameLower === comp.name || nameLower.includes(comp.name) || comp.name.includes(nameLower))) {
            return comp.name;
        }
        // Match by LinkedIn URL slug
        if (urlSlug && comp.slugs.some(s => urlSlug === s || urlSlug.includes(s))) {
            return comp.name;
        }
    }
    return null;
}

// ── HTTP Helper ──
function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ── HHS OCR Breach Data ──
// Downloads and caches the public HHS breach report CSV
let hhsBreachCache = null;

async function loadHHSBreachData() {
    if (hhsBreachCache !== null) return hhsBreachCache;

    const cacheFile = path.join(__dirname, '..', '.hhs-breach-cache.json');

    // Use cached file if < 24 hours old
    if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
        if (ageHours < 24) {
            try {
                hhsBreachCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                return hhsBreachCache;
            } catch { /* fall through to refresh */ }
        }
    }

    // Fetch HHS breach data via Discogen
    if (!isDiscogenConfigured()) {
        hhsBreachCache = [];
        return [];
    }

    console.log('  Fetching HHS OCR breach data via Discogen...');
    try {
        const signals = await searchCompanyNews('HHS OCR HIPAA breach notification', 'hhs.gov', { numResults: 10 });
        const entries = signals.map(s => ({
            title: s.title || '',
            url: s.url || '',
            text: (s.summary || '').slice(0, 500),
            publishedDate: s.published_at || ''
        }));
        hhsBreachCache = entries;
        fs.writeFileSync(cacheFile, JSON.stringify(entries, null, 2));
        return entries;
    } catch {
        hhsBreachCache = [];
        return [];
    }
}

async function checkHHSBreach(companyName) {
    const data = await loadHHSBreachData();
    const nameLower = companyName.toLowerCase();
    const nameParts = nameLower.split(/\s+/).filter(w => w.length > 3);

    for (const entry of data) {
        const entryText = (entry.title + ' ' + entry.text).toLowerCase();
        if (nameLower.length > 3 && entryText.includes(nameLower)) {
            return { found: true, source: entry.title, url: entry.url, date: entry.publishedDate };
        }
        // Partial match on significant words
        const matchCount = nameParts.filter(p => entryText.includes(p)).length;
        if (matchCount >= 2 && nameParts.length >= 2) {
            return { found: true, source: entry.title, url: entry.url, date: entry.publishedDate, partial: true };
        }
    }
    return { found: false };
}

// ── LinkedIn Apify Enrichment ──
async function startLinkedInActorRun(companyUrls) {
    const body = { urls: companyUrls, minDelay: 2, maxDelay: 5 };
    const postData = JSON.stringify(body);
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/curious_coder~linkedin-company-scraper/runs`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${APIFY_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await makeRequest(options, postData);
        if (response.status === 201) return response.data;
        if (RETRYABLE_STATUSES.has(response.status) && attempt < 2) {
            await new Promise(r => setTimeout(r, [2000, 8000][attempt]));
            continue;
        }
        throw new Error(`LinkedIn actor start failed: HTTP ${response.status}`);
    }
}

async function waitForActorRun(runId) {
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/actor-runs/${runId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    };

    for (let i = 0; i < 60; i++) {
        const response = await makeRequest(options);
        const status = response.data?.data?.status;
        process.stdout.write(`\r  LinkedIn enrichment: ${status} (${i + 1}/60)  `);
        if (status === 'SUCCEEDED') { process.stdout.write('\n'); return response.data.data; }
        if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
            process.stdout.write('\n');
            throw new Error(`LinkedIn actor ${status}`);
        }
        const delay = Math.min(3000 * Math.pow(1.3, i), 15000);
        await new Promise(r => setTimeout(r, delay));
    }
    throw new Error('Timeout waiting for LinkedIn enrichment');
}

async function getActorResults(datasetId) {
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

function normalizeCompanyUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'company' && parts[1]) {
            return `https://www.linkedin.com/company/${parts[1]}`;
        }
    } catch { /* as-is */ }
    return url;
}

// ── CSV Parser ──
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current); current = '';
        } else {
            current += char;
        }
    }
    values.push(current);
    return values;
}

function parseAccountsCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('CSV file is empty');

    const firstLine = lines[0];
    const isUrlOnly = /^https?:\/\/.*linkedin\.com\/company\//i.test(firstLine);

    if (isUrlOnly) {
        return lines
            .filter(l => /linkedin\.com\/company\//i.test(l))
            .map(l => ({ companyUrl: normalizeCompanyUrl(l), name: '', metadata: {} }));
    }

    const headers = parseCSVLine(firstLine).map(h => h.trim().toLowerCase());
    const urlIdx = (() => {
        const aliases = ['linkedin_url', 'linkedin', 'company_url', 'url', 'linkedin_company_url'];
        for (let i = 0; i < headers.length; i++) {
            const h = headers[i].replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            if (aliases.includes(h)) return i;
        }
        // fallback: find by content
        if (lines.length > 1) {
            const row = parseCSVLine(lines[1]);
            for (let i = 0; i < row.length; i++) {
                if (/linkedin\.com\/company\//i.test(row[i])) return i;
            }
        }
        return -1;
    })();

    if (urlIdx === -1) throw new Error('No LinkedIn company URL column found in CSV');

    const nameIdx = headers.indexOf('company_name') !== -1 ? headers.indexOf('company_name') :
                    headers.indexOf('name') !== -1 ? headers.indexOf('name') : -1;

    const accounts = [];
    for (let i = 1; i < lines.length; i++) {
        const vals = parseCSVLine(lines[i]);
        const url = (vals[urlIdx] || '').trim();
        if (!url || !/linkedin\.com\/company\//i.test(url)) continue;
        const metadata = {};
        headers.forEach((h, j) => { if (j !== urlIdx && vals[j]) metadata[h] = vals[j].trim(); });
        accounts.push({
            companyUrl: normalizeCompanyUrl(url),
            name: (nameIdx >= 0 ? vals[nameIdx] : '') || '',
            metadata
        });
    }
    return accounts;
}

// ── Local Data Cross-Reference ──
function findLocalJobSignals(companyName, companyUrl) {
    const results = { signals: [], tools: [], frameworks: [], painLanguage: [], postCount: 0 };
    const rootDir = path.join(__dirname, '..');
    const nameLower = companyName.toLowerCase();
    const urlSlug = (companyUrl.match(/\/company\/([^/]+)/)?.[1] || '').toLowerCase();

    // Scan all jobs JSON files
    const jobFiles = [];
    try {
        const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'))
            .map(d => d.name);
        for (const dir of dirs) {
            const linkedinDir = path.join(rootDir, dir, 'LinkedIn');
            if (!fs.existsSync(linkedinDir)) continue;
            const files = fs.readdirSync(linkedinDir).filter(f => f.startsWith('jobs-') && f.endsWith('.json'));
            jobFiles.push(...files.map(f => path.join(linkedinDir, f)));
        }
    } catch { /* ok */ }

    for (const file of jobFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const signals = data.signals || [];
            for (const s of signals) {
                const sCompany = (s.company || '').toLowerCase();
                const sUrl = normalizeCompanyUrl(s.companyUrl || '').toLowerCase();
                const matched = (nameLower && sCompany.includes(nameLower)) ||
                                (nameLower && nameLower.includes(sCompany) && sCompany.length > 4) ||
                                (urlSlug && sUrl.includes(urlSlug));
                if (!matched) continue;

                results.postCount++;
                if (s.type) results.signals.push(s.type);
                if (s.currentTools) results.tools.push(...s.currentTools);
                if (s.frameworks) results.frameworks.push(...s.frameworks);
                if (s.painLanguage) results.painLanguage.push(...s.painLanguage);
            }
        } catch { /* skip bad files */ }
    }

    // Deduplicate
    results.tools = [...new Set(results.tools)];
    results.frameworks = [...new Set(results.frameworks)];
    results.painLanguage = [...new Set(results.painLanguage)];
    results.signals = [...new Set(results.signals)];
    return results;
}

function findLocalFeedSignals(companyName) {
    const results = { hotPosts: 0, warmPosts: 0, toolsMentioned: [], painKeywords: [] };
    const rootDir = path.join(__dirname, '..');
    const nameLower = companyName.toLowerCase();
    if (!nameLower) return results;

    try {
        const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
        for (const dir of dirs) {
            const linkedinDir = path.join(rootDir, dir, 'LinkedIn');
            if (!fs.existsSync(linkedinDir)) continue;
            const files = fs.readdirSync(linkedinDir).filter(f => f.startsWith('feed-') && f.endsWith('.json'));
            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(linkedinDir, f), 'utf8'));
                    for (const post of (data.posts || [])) {
                        const text = (post.text || '').toLowerCase();
                        const author = (post.authorName || '').toLowerCase();
                        if (!text.includes(nameLower) && !author.includes(nameLower)) continue;
                        if (post.tier === 'HOT') results.hotPosts++;
                        else if (post.tier === 'WARM') results.warmPosts++;
                        if (post.toolsMentioned) results.toolsMentioned.push(...post.toolsMentioned);
                        if (post.painKeywords) results.painKeywords.push(...post.painKeywords);
                    }
                } catch { /* skip */ }
            }
        }
    } catch { /* ok */ }

    results.toolsMentioned = [...new Set(results.toolsMentioned)];
    results.painKeywords = [...new Set(results.painKeywords)];
    return results;
}

// ── Discogen News Research per Company ──

async function researchCompanySignals(companyName, domain = null) {
    if (!isDiscogenConfigured() || !companyName) return {};

    const signals = await searchCompanyNews(companyName, domain, { numResults: 15 });

    // Map Discogen signal types to the shape detectSignals() expects
    const typeMap = {
        'breach':          'breach',
        'funding':         'funding',
        'ciso_change':     'ciso',
        'compliance':      'soc2',
        'cloud_migration': 'cloudMigration',
        'm&a':             'ma'
    };

    const results = {
        breach: null, funding: null, ciso: null,
        soc2: null, cloudMigration: null, ma: null, hipaaOcr: null
    };

    for (const signal of signals) {
        const key = typeMap[signal.type];
        if (key && !results[key]) {
            results[key] = {
                title:         signal.title,
                url:           signal.url,
                snippet:       signal.summary || '',
                publishedDate: signal.published_at || '',
                verified:      true
            };
        }
    }

    return results;
}

// ── Signal Detection Logic ──

// Helper: build a structured evidence entry with source URL
function newsEvidence(label, newsItem) {
    return {
        text: `${label}: ${newsItem.title}`,
        source: newsItem.url,
        date: newsItem.publishedDate || null
    };
}

function detectSignals(account, linkedinData, jobSignals, feedSignals, newsResults, hhsBreach) {
    const detected = new Set();
    const evidence = {};    // key → { text, source?, date? } or boolean for bonus flags

    const allText = [
        linkedinData?.description || '',
        linkedinData?.specialties?.join(' ') || '',
        jobSignals.tools.join(' '),
        jobSignals.frameworks.join(' '),
        jobSignals.painLanguage.join(' '),
    ].join(' ').toLowerCase();

    // --- breach_announced ---
    const hasBreachNews = newsResults.breach && (
        newsResults.breach.snippet.toLowerCase().includes('breach') ||
        newsResults.breach.snippet.toLowerCase().includes('ransomware') ||
        newsResults.breach.snippet.toLowerCase().includes('attack')
    );
    const hasHHSBreach = hhsBreach?.found;
    if (hasBreachNews || hasHHSBreach) {
        detected.add('breach_announced');
        evidence.breach_announced = hasHHSBreach
            ? { text: `HHS OCR breach: ${hhsBreach.source}`, source: hhsBreach.url || '', date: hhsBreach.date || null }
            : newsEvidence('Breach', newsResults.breach);
    }

    // --- hiring_ciso_and_iam ---
    const hasCISOHiring = jobSignals.signals.some(s => s.includes('ciso') || s.includes('chief-information-security'));
    const hasIAMHiring = jobSignals.signals.some(s => s.includes('iam') || s.includes('identity') || s.includes('pam'));
    if (hasCISOHiring && hasIAMHiring) {
        detected.add('hiring_ciso_and_iam');
        evidence.hiring_ciso_and_iam = { text: `CISO + IAM hiring (${jobSignals.postCount} postings)`, source: 'local-jobs' };
    }

    // --- soc2_and_compliance ---
    const hasSOC2 = allText.includes('soc 2') || allText.includes('soc2') || newsResults.soc2;
    const hasComplianceHire = jobSignals.signals.some(s => s.includes('compliance') || s.includes('grc'));
    const hasVantaDrata = jobSignals.tools.some(t => ['vanta', 'drata', 'secureframe'].includes(t));
    if (hasSOC2 && hasComplianceHire) {
        detected.add('soc2_and_compliance');
        const soc2Source = newsResults.soc2 ? newsEvidence('SOC 2', newsResults.soc2) : { text: 'SOC 2 in profiles + compliance hiring', source: 'local-jobs' };
        evidence.soc2_and_compliance = soc2Source;
        if (hasVantaDrata) evidence.vanta_drata_detected = true;
    }

    // --- new_ciso_hired ---
    const hasCISOHiredNews = newsResults.ciso && (
        newsResults.ciso.snippet.toLowerCase().includes('hired') ||
        newsResults.ciso.snippet.toLowerCase().includes('appointed') ||
        newsResults.ciso.snippet.toLowerCase().includes('joins') ||
        newsResults.ciso.snippet.toLowerCase().includes('new ciso')
    );
    if (hasCISOHiredNews) {
        detected.add('new_ciso_hired');
        evidence.new_ciso_hired = newsEvidence('CISO hired', newsResults.ciso);
        const hasIAMVendor = jobSignals.tools.some(t => PAM_COMPETITORS.some(c => t.includes(c)));
        if (!hasIAMVendor) evidence.no_iam_vendor = true;
    }

    // --- funding_bc_soc2 ---
    const hasFundingBC = newsResults.funding && (
        newsResults.funding.snippet.toLowerCase().includes('series b') ||
        newsResults.funding.snippet.toLowerCase().includes('series c') ||
        newsResults.funding.snippet.toLowerCase().includes('series d')
    );
    if (hasFundingBC) {
        if (hasSOC2) {
            detected.add('funding_bc_soc2');
            evidence.funding_bc_soc2 = newsEvidence('Funding', newsResults.funding);
            if (hasComplianceHire) evidence.hiring_compliance = true;
        } else {
            detected.add('cyber_insurance_funding');
            evidence.cyber_insurance_funding = newsEvidence('Series B/C funding', newsResults.funding);
            if (hasCISOHiring || hasIAMHiring) evidence.security_hire_open = true;
        }
    }

    // --- funding_a_only ---
    const hasFundingA = newsResults.funding && (
        newsResults.funding.snippet.toLowerCase().includes('series a') ||
        newsResults.funding.snippet.toLowerCase().includes('seed')
    );
    if (hasFundingA && !hasFundingBC && !detected.has('funding_bc_soc2')) {
        detected.add('funding_a_only');
        evidence.funding_a_only = newsEvidence('Series A/Seed', newsResults.funding);
        const industry = (linkedinData?.industry || account.metadata?.industry || '').toLowerCase();
        const regulatedIndustries = ['healthcare', 'financial', 'fintech', 'banking', 'insurance', 'pharma', 'biotech', 'defense', 'government'];
        if (regulatedIndustries.some(i => industry.includes(i))) evidence.regulated_industry = true;
    }

    // --- competitor_in_jd ---
    const hasCompetitorTools = jobSignals.tools.some(t => PAM_COMPETITORS.some(c => t.includes(c)));
    if (hasCompetitorTools) {
        detected.add('competitor_in_jd');
        const competitors = jobSignals.tools.filter(t => PAM_COMPETITORS.some(c => t.includes(c)));
        evidence.competitor_in_jd = { text: `Competitor tools in JDs: ${competitors.join(', ')}`, source: 'local-jobs' };
        if (jobSignals.postCount >= 3) evidence.multiple_postings = true;
    }

    // --- cloud_migration ---
    const hasCloudMigration = newsResults.cloudMigration && (
        newsResults.cloudMigration.snippet.toLowerCase().includes('migrat') ||
        newsResults.cloudMigration.snippet.toLowerCase().includes('cloud')
    );
    if (hasCloudMigration) {
        detected.add('cloud_migration');
        evidence.cloud_migration = newsEvidence('Cloud migration', newsResults.cloudMigration);
        if (hasCISOHiring || hasIAMHiring) evidence.security_hire_open = true;
    }

    // --- ma_activity ---
    const hasMA = newsResults.ma && (
        newsResults.ma.snippet.toLowerCase().includes('acqui') ||
        newsResults.ma.snippet.toLowerCase().includes('merger') ||
        newsResults.ma.snippet.toLowerCase().includes('private equity') ||
        newsResults.ma.snippet.toLowerCase().includes('pe firm')
    );
    if (hasMA) {
        detected.add('ma_activity');
        evidence.ma_activity = newsEvidence('M&A', newsResults.ma);
    }

    // --- hiring_security_grc ---
    const hasSecurityGRCHire = jobSignals.signals.some(s =>
        s.includes('security') || s.includes('grc') || s.includes('compliance') || s.includes('iam') || s.includes('pam')
    );
    if (hasSecurityGRCHire && !detected.has('hiring_ciso_and_iam')) {
        detected.add('hiring_security_grc');
        const complianceFramework = jobSignals.frameworks.some(f =>
            COMPLIANCE_FRAMEWORKS.some(cf => f.includes(cf))
        );
        evidence.hiring_security_grc = { text: `Job signals: ${jobSignals.signals.slice(0, 3).join(', ')} (${jobSignals.postCount} postings)`, source: 'local-jobs' };
        if (complianceFramework) evidence.compliance_framework = true;
    }

    // --- social_pain_post ---
    if (feedSignals.hotPosts > 0 || feedSignals.warmPosts > 0) {
        detected.add('social_pain_post');
        evidence.social_pain_post = { text: `LinkedIn feed: ${feedSignals.hotPosts} HOT, ${feedSignals.warmPosts} WARM posts`, source: 'local-feed' };
        if (feedSignals.hotPosts > 0) evidence.person_identified = true;
    }

    return { detected: [...detected], evidence };
}

// ── Score an Account ──
function scoreAccount(detectedSignals, evidence) {
    const detected = new Set(detectedSignals);

    // Check for stacks first
    let stackMatch = null;
    for (const stack of SIGNAL_STACKS) {
        if (stack.signals.every(s => detected.has(s))) {
            if (!stackMatch || stack.combined > stackMatch.combined) {
                stackMatch = stack;
            }
        }
    }

    if (stackMatch) {
        return {
            score: stackMatch.combined,
            stackLabel: stackMatch.label,
            stackMeaning: stackMatch.meaning,
            isStack: true,
            breakdown: []
        };
    }

    // Sum individual signal scores
    let total = 0;
    const breakdown = [];
    for (const sigKey of detectedSignals) {
        const def = SIGNAL_DEFS[sigKey];
        if (!def) continue;
        let pts = def.base;
        if (evidence[def.bonusField]) {
            pts += def.bonusPts;
            breakdown.push({ signal: def.label, base: def.base, bonus: def.bonusPts, total: pts, bonusReason: def.bonusField });
        } else {
            breakdown.push({ signal: def.label, base: def.base, bonus: 0, total: pts });
        }
        total += pts;
    }

    // Cap at 50
    total = Math.min(total, 50);
    return { score: total, stackLabel: null, stackMeaning: null, isStack: false, breakdown };
}

// ── Slack Notification ──
function sendSlackNotification(accounts) {
    return new Promise((resolve) => {
        if (!SLACK_WEBHOOK) { resolve(false); return; }

        const critical = accounts.filter(a => a.tier.tier === 'CRITICAL');
        const high = accounts.filter(a => a.tier.tier === 'HIGH');
        const total = critical.length + high.length;

        if (total === 0) { resolve(false); return; }

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `Account Signal Report — ${total} accounts need outreach` }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${critical.length} CRITICAL* (24-48hr) | *${high.length} HIGH* (week 1)`
                }
            }
        ];

        const toShow = [...critical, ...high].slice(0, 6);
        for (const a of toShow) {
            const sigList = a.detectedSignals.slice(0, 2).map(s => SIGNAL_DEFS[s]?.label || s).join(', ');
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${a.tier.emoji} *${a.name || a.companyUrl}* — Score ${a.score}/50\n>${a.isStack ? a.stackLabel : sigList}\n<${a.companyUrl}|View on LinkedIn>`
                }
            });
        }

        if (total > 6) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${total - 6} more_` } });
        }

        const payload = JSON.stringify({ blocks });
        const url = new URL(SLACK_WEBHOOK);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };

        const req = https.request(options, (res) => resolve(res.statusCode === 200));
        req.on('error', () => resolve(false));
        req.write(payload);
        req.end();
    });
}

function sendMacNotification(title, message) {
    const escaped = message.replace(/"/g, '\\"');
    const titleEsc = title.replace(/"/g, '\\"');
    try {
        execSync(`osascript -e 'display notification "${escaped}" with title "${titleEsc}" sound name "Glass"'`);
        return true;
    } catch { return false; }
}

// ── Output Generation ──
function generateMarkdownReport(rankedAccounts, meta, disqualified = []) {
    const date = new Date().toISOString().split('T')[0];
    const lines = [];

    lines.push(`# Account Signal Report — ${date}`);
    lines.push('');
    lines.push(`**Input:** ${meta.csvFile} | **Total:** ${meta.totalInCSV} | **Disqualified:** ${meta.disqualified} | **Scored:** ${meta.totalAccounts} | **Above ${meta.minScore}:** ${rankedAccounts.length}`);
    lines.push('');

    // Summary table
    const tiers = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
    for (const a of rankedAccounts) {
        if (tiers[a.tier.tier]) tiers[a.tier.tier].push(a);
    }

    lines.push('## Summary');
    lines.push('');
    lines.push('| Tier | Count | Action |');
    lines.push('|------|-------|--------|');
    lines.push(`| 🔴 CRITICAL | ${tiers.CRITICAL.length} | 24-48hr outreach |`);
    lines.push(`| 🟠 HIGH | ${tiers.HIGH.length} | 3-day / week 1 outreach |`);
    lines.push(`| 🟡 MEDIUM | ${tiers.MEDIUM.length} | Next batch |`);
    lines.push(`| 🟢 LOW | ${tiers.LOW.length} | Monitor list |`);
    lines.push('');

    // Ranked accounts by tier
    const tierOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    let rank = 1;

    for (const tierName of tierOrder) {
        const tierAccounts = tiers[tierName];
        if (!tierAccounts.length) continue;

        const t = getTier(tierAccounts[0].score);
        lines.push(`## ${t.emoji} ${tierName} — ${t.action}`);
        lines.push('');

        for (const a of tierAccounts) {
            const li = linkedinInfo(a.linkedinData);
            lines.push(`### ${rank}. ${a.name || extractCompanySlug(a.companyUrl)} — Score: ${a.score}/50`);
            rank++;

            if (a.isStack) {
                lines.push(`**Signal Stack:** ${a.stackLabel}`);
                lines.push(`**Why now:** ${a.stackMeaning}`);
            } else {
                lines.push(`**Top signals:** ${a.detectedSignals.slice(0, 3).map(s => SIGNAL_DEFS[s]?.label || s).join(', ')}`);
            }

            if (li) lines.push(`**Company:** ${li}`);
            lines.push(`**LinkedIn:** ${a.companyUrl}`);

            // Evidence
            if (Object.keys(a.evidence).length > 0) {
                lines.push('**Evidence:**');
                for (const [key, val] of Object.entries(a.evidence)) {
                    if (typeof val === 'string') lines.push(`  - ${val}`);
                }
            }

            // Signal breakdown
            if (!a.isStack && a.breakdown.length > 0) {
                lines.push('**Score breakdown:**');
                for (const b of a.breakdown) {
                    const bonusTxt = b.bonus > 0 ? ` (+${b.bonus} bonus: ${b.bonusReason})` : '';
                    lines.push(`  - ${b.signal}: ${b.base}${bonusTxt} = ${b.total} pts`);
                }
            }

            // Local data
            if (a.jobSignals.postCount > 0) {
                lines.push(`**Job postings matched:** ${a.jobSignals.postCount}`);
                if (a.jobSignals.tools.length) lines.push(`**Tools in JDs:** ${a.jobSignals.tools.join(', ')}`);
                if (a.jobSignals.frameworks.length) lines.push(`**Compliance frameworks:** ${a.jobSignals.frameworks.join(', ')}`);
            }

            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    // Disqualified section
    if (disqualified.length > 0) {
        lines.push('## ⛔ DISQUALIFIED — Competitor Companies');
        lines.push('');
        lines.push('These accounts were excluded before scoring — they are competitor/vendor companies we do not sell to.');
        lines.push('');
        lines.push('| Company | LinkedIn | Reason |');
        lines.push('|---------|----------|--------|');
        for (const dq of disqualified) {
            lines.push(`| ${dq.name} | ${dq.companyUrl} | ${dq.reason} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function linkedinInfo(data) {
    if (!data) return '';
    const parts = [];
    if (data.employeeCount) parts.push(`${data.employeeCount.toLocaleString()} employees`);
    if (data.industry) parts.push(data.industry);
    if (data.headquarters) parts.push(data.headquarters);
    return parts.join(' | ');
}

function extractCompanySlug(url) {
    return url.match(/\/company\/([^/]+)/)?.[1]?.replace(/-/g, ' ') || url;
}

// ── Main ──
async function run(options) {
    const { csvFile, minScore, noEnrich, noLinkedIn, noNotify, dryRun } = options;
    const startTime = Date.now();

    console.log(`\nAccount Signal Scoring`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Input:      ${csvFile}`);
    console.log(`Min score:  ${minScore}`);
    console.log(`Exa.ai:     ${noEnrich ? 'disabled' : (EXA_KEY ? 'enabled' : 'no key')}`);
    console.log(`LinkedIn:   ${noLinkedIn ? 'disabled' : (APIFY_TOKEN ? 'enabled' : 'no key')}`);
    console.log(`${'─'.repeat(40)}\n`);

    // Parse CSV
    const accounts = parseAccountsCSV(csvFile);
    console.log(`Accounts loaded: ${accounts.length}`);

    if (dryRun) {
        console.log('\nDRY RUN — no API calls will be made\n');
        for (const a of accounts) {
            const comp = isCompetitorCompany(a.name, a.companyUrl);
            const flag = comp ? ` ⛔ DQ (${comp})` : '';
            console.log(`  ${a.name || extractCompanySlug(a.companyUrl)} — ${a.companyUrl}${flag}`);
        }
        const dqCount = accounts.filter(a => isCompetitorCompany(a.name, a.companyUrl)).length;
        if (dqCount) console.log(`\n  ${dqCount} competitor(s) will be disqualified`);
        return;
    }

    if (!accounts.length) {
        console.log('No valid LinkedIn company URLs found in CSV. Exiting.');
        return;
    }

    // Pre-load HHS breach data once
    let hhsData = {};
    if (!noEnrich && EXA_KEY) {
        console.log('Pre-loading HHS OCR breach data...');
        await loadHHSBreachData();
    }

    // LinkedIn enrichment (batch all at once, skip competitors)
    const linkedinResults = {};
    if (!noLinkedIn && APIFY_TOKEN) {
        const urls = accounts
            .filter(a => !isCompetitorCompany(a.name, a.companyUrl))
            .map(a => a.companyUrl);
        console.log(`\nRunning LinkedIn enrichment for ${urls.length} companies...`);
        try {
            const batchSize = 10;
            for (let i = 0; i < urls.length; i += batchSize) {
                const batch = urls.slice(i, i + batchSize);
                const runData = await startLinkedInActorRun(batch);
                const runId = runData.data.id;
                const completed = await waitForActorRun(runId);
                const results = await getActorResults(completed.defaultDatasetId);
                for (const r of results) {
                    const url = normalizeCompanyUrl(r.url || r.linkedinUrl || r.companyUrl || '');
                    if (url) linkedinResults[url] = r;
                }
                if (i + batchSize < urls.length) await new Promise(r => setTimeout(r, 2000));
            }
            console.log(`LinkedIn enrichment complete: ${Object.keys(linkedinResults).length} results`);
        } catch (err) {
            console.error(`LinkedIn enrichment failed: ${err.message}`);
        }
    }

    // Process each account
    const scoredAccounts = [];
    const disqualified = [];
    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const slug = account.name || extractCompanySlug(account.companyUrl);
        console.log(`\n[${i + 1}/${accounts.length}] ${slug}`);

        // ── Competitor Check — DQ before any API calls ──
        const competitorMatch = isCompetitorCompany(account.name, account.companyUrl);
        if (competitorMatch) {
            console.log(`  ⛔ DISQUALIFIED — competitor company (${competitorMatch})`);
            disqualified.push({ name: slug, companyUrl: account.companyUrl, reason: `Competitor: ${competitorMatch}` });
            continue;
        }

        // Get LinkedIn data
        const linkedinData = linkedinResults[account.companyUrl] || null;
        if (linkedinData) {
            account.name = account.name || linkedinData.name || linkedinData.companyName || slug;
            console.log(`  LinkedIn: ${linkedinData.employeeCount || '?'} employees, ${linkedinData.industry || 'unknown industry'}`);
        }

        // Cross-reference local job/feed data
        const jobSignals = findLocalJobSignals(account.name || slug, account.companyUrl);
        const feedSignals = findLocalFeedSignals(account.name || slug);
        if (jobSignals.postCount > 0) console.log(`  Local jobs: ${jobSignals.postCount} matching postings`);
        if (feedSignals.hotPosts + feedSignals.warmPosts > 0) {
            console.log(`  Local feed: ${feedSignals.hotPosts} HOT, ${feedSignals.warmPosts} WARM posts`);
        }

        // Discogen news research
        let newsResults = {};
        let hhsBreach = { found: false };
        if (!noEnrich && isDiscogenConfigured() && account.name) {
            console.log(`  Researching ${account.name} via Discogen...`);
            const domain = linkedinData?.website ? new URL(linkedinData.website).hostname.replace('www.', '') : null;
            newsResults = await researchCompanySignals(account.name, domain);
            hhsBreach = await checkHHSBreach(account.name);
            if (hhsBreach.found) console.log(`  HHS OCR breach detected!`);

            const newsHits = Object.values(newsResults).filter(Boolean).length;
            if (newsHits > 0) console.log(`  Discogen: ${newsHits}/6 signal types returned results`);
        }

        // Detect signals
        const { detected, evidence } = detectSignals(account, linkedinData, jobSignals, feedSignals, newsResults, hhsBreach);

        // Score
        const { score, stackLabel, stackMeaning, isStack, breakdown } = scoreAccount(detected, evidence);
        const tier = getTier(score);

        console.log(`  Score: ${score}/50 [${tier.tier}] — ${detected.length} signal(s) detected`);

        scoredAccounts.push({
            companyUrl: account.companyUrl,
            name: account.name || slug,
            metadata: account.metadata,
            linkedinData,
            jobSignals,
            feedSignals,
            newsResults,
            hhsBreach,
            detectedSignals: detected,
            evidence,
            score,
            tier,
            stackLabel,
            stackMeaning,
            isStack,
            breakdown
        });
    }

    // Filter and rank
    const ranked = scoredAccounts
        .filter(a => a.score >= minScore)
        .sort((a, b) => b.score - a.score);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Total in CSV:      ${accounts.length}`);
    if (disqualified.length > 0) {
        console.log(`Disqualified:      ${disqualified.length} (competitors)`);
        for (const dq of disqualified) console.log(`  ⛔ ${dq.name} — ${dq.reason}`);
    }
    console.log(`Accounts scored:   ${scoredAccounts.length}`);
    console.log(`Above min score (${minScore}): ${ranked.length}`);

    const tierCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const a of ranked) { if (tierCounts[a.tier.tier] !== undefined) tierCounts[a.tier.tier]++; }
    console.log(`CRITICAL: ${tierCounts.CRITICAL} | HIGH: ${tierCounts.HIGH} | MEDIUM: ${tierCounts.MEDIUM} | LOW: ${tierCounts.LOW}`);

    if (ranked.length > 0) {
        console.log(`\nTop accounts:`);
        for (const a of ranked.slice(0, 5)) {
            console.log(`  ${a.tier.emoji} ${a.name} — ${a.score}/50 [${a.isStack ? a.stackLabel : a.detectedSignals.slice(0, 2).map(s => SIGNAL_DEFS[s]?.label || s).join(', ')}]`);
        }
    }

    // Save output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const outDir = path.join(__dirname, '..', `AccountSignals/${timestamp}`);
    fs.mkdirSync(outDir, { recursive: true });

    const meta = {
        csvFile: path.basename(csvFile),
        scannedAt: new Date().toISOString(),
        totalInCSV: accounts.length,
        disqualified: disqualified.length,
        totalAccounts: scoredAccounts.length,
        ranked: ranked.length,
        minScore,
        tierCounts,
        durationMs: Date.now() - startTime
    };

    const jsonOut = { meta, disqualified, accounts: ranked };
    const jsonFile = path.join(outDir, 'ranked-accounts.json');
    const mdFile = path.join(outDir, 'ranked-accounts.md');

    fs.writeFileSync(jsonFile, JSON.stringify(jsonOut, null, 2));
    fs.writeFileSync(mdFile, generateMarkdownReport(ranked, meta, disqualified));

    console.log(`\nSaved to:`);
    console.log(`  ${jsonFile}`);
    console.log(`  ${mdFile}`);

    // Sync to Supabase
    if (db.isConfigured() && ranked.length > 0) {
        try {
            let companiesSynced = 0;
            let scoresSynced = 0;
            let newsSynced = 0;

            for (const account of ranked) {
                // Upsert company
                let companyId = null;
                if (account.companyUrl) {
                    try {
                        companyId = await db.findOrCreateCompany({
                            name:           account.name,
                            linkedin_url:   account.companyUrl,
                            website:        account.linkedinData?.website || null,
                            industry:       account.linkedinData?.industry || null,
                            employee_count: account.linkedinData?.employeeCount || null,
                            segment:        account.linkedinData?.segment || null
                        });
                        companiesSynced++;
                    } catch { /* continue */ }
                }

                // Write news_signals from Discogen results
                if (companyId && account.newsResults) {
                    const newsRows = Object.entries(account.newsResults)
                        .filter(([, v]) => v && v.url)
                        .map(([key, v]) => ({
                            company_id:   companyId,
                            source:       'discogen',
                            type:         key,
                            title:        v.title || null,
                            url:          v.url,
                            summary:      v.snippet || null,
                            published_at: v.publishedDate || null,
                            points:       (SIGNAL_DEFS[key]?.base || 10),
                            confidence:   v.verified ? 0.85 : 0.6
                        }));
                    if (newsRows.length > 0) {
                        try {
                            await db.upsert('news_signals', newsRows, 'company_id,url');
                            newsSynced += newsRows.length;
                        } catch { /* continue */ }
                    }
                }

                // Write account_scores (FITS scoring not done here — use qualify-accounts skill)
                // Write the signal-based urgency score instead
                if (companyId) {
                    try {
                        const topSignals = account.detectedSignals
                            .slice(0, 5)
                            .map(s => SIGNAL_DEFS[s]?.label || s);
                        await db.insert('account_scores', {
                            company_id:         companyId,
                            total_score:        account.score,
                            tier_label:         account.tier.tier,
                            recommended_action: account.tier.action,
                            top_signals:        topSignals,
                            outreach_angle:     account.isStack ? account.stackLabel : (topSignals[0] || null),
                            input_source:       path.basename(csvFile)
                        });
                        scoresSynced++;
                    } catch { /* continue */ }
                }
            }

            console.log(`  Supabase: ${companiesSynced} companies, ${scoresSynced} account scores, ${newsSynced} news signals synced`);
        } catch (err) {
            console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
        }
    }

    // Notifications
    if (!noNotify) {
        const notifyAccounts = ranked.filter(a => ['CRITICAL', 'HIGH'].includes(a.tier.tier));
        if (notifyAccounts.length > 0) {
            const macMsg = notifyAccounts.length === 1
                ? `${notifyAccounts[0].name} — Score ${notifyAccounts[0].score}/50`
                : `${notifyAccounts.length} accounts need outreach (top: ${notifyAccounts[0].name})`;
            sendMacNotification('Account Signals', macMsg);

            const slackSent = await sendSlackNotification(notifyAccounts);
            if (SLACK_WEBHOOK) console.log(`Slack: ${slackSent ? 'sent' : 'failed'}`);
        }
    }

    console.log(`${'='.repeat(50)}\n`);
    return jsonOut;
}

// ── CLI ──
const rawArgs = process.argv.slice(2);

if (!rawArgs.length || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`
Account Signal Scoring

Takes a list of target companies, gathers signals from LinkedIn, Exa.ai news,
HHS OCR breach data, and existing local job/feed scans. Scores each account
using the Intent Signals Playbook model and ranks by urgency tier.

Usage:
  node scripts/account-signals.js <csv-file> [options]

CSV Format:
  URL-only (no header):
    https://linkedin.com/company/acme-corp

  With metadata (auto-detects LinkedIn URL column):
    company_name,linkedin_url,industry
    Acme Corp,https://linkedin.com/company/acme-corp,SaaS

Options:
  --min-score <N>     Only include accounts scoring >= N (default: 15)
  --no-enrich         Skip Exa.ai research, use local data only (faster)
  --no-linkedin       Skip LinkedIn Apify enrichment
  --no-notify         Skip Slack/macOS notifications
  --dry-run           Show accounts without making API calls

Scoring tiers:
  CRITICAL (35-50): 24-48hr outreach
  HIGH     (28-34): 3-day / week 1 outreach
  MEDIUM   (22-27): Next batch
  LOW      (15-21): Monitor list

Examples:
  node scripts/account-signals.js target-accounts.csv
  node scripts/account-signals.js accounts.csv --min-score 28
  node scripts/account-signals.js urls.csv --no-enrich --dry-run
    `);
    process.exit(0);
}

let csvFile = null;
let minScore = 15;
let noEnrich = false;
let noLinkedIn = false;
let noNotify = false;
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--min-score') { minScore = parseInt(rawArgs[++i]) || 15; }
    else if (arg === '--no-enrich') { noEnrich = true; }
    else if (arg === '--no-linkedin') { noLinkedIn = true; }
    else if (arg === '--no-notify') { noNotify = true; }
    else if (arg === '--dry-run') { dryRun = true; }
    else if (!arg.startsWith('--') && !csvFile) { csvFile = arg; }
}

if (!csvFile) {
    console.error('Error: CSV file path is required as the first argument.');
    console.error('  Usage: node scripts/account-signals.js <csv-file>');
    process.exit(1);
}

if (!fs.existsSync(csvFile)) {
    console.error(`Error: File not found: ${csvFile}`);
    process.exit(1);
}

run({ csvFile, minScore, noEnrich, noLinkedIn, noNotify, dryRun });

export { run };
