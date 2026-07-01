#!/usr/bin/env node

/**
 * LinkedIn Company Enrichment Scanner
 *
 * Scrapes LinkedIn company pages from a CSV of target accounts using Apify.
 * Extracts employee count, growth signals, compliance certifications, and
 * security hiring patterns. Merges scraped data with any metadata from the CSV.
 *
 * CSV Input:
 *   Accepts a CSV with a LinkedIn company URL column as the unique identifier.
 *   Supports two formats:
 *   - URL-only:  one URL per line (no header needed)
 *   - Full metadata:  company_name,linkedin_url,industry,employee_count,segment,...
 *   The script auto-detects the LinkedIn URL column.
 *
 * Usage:
 *   node scripts/linkedin-companies.js <csv-file> [options]
 *
 * Options:
 *   --topic <Name>          Topic directory for output (default: auto)
 *   --max-companies <N>     Cap how many companies to scrape (default: all)
 *   --skip-scraped          Skip companies already in LinkedIn/ output folder
 *   --dry-run               Print companies to scrape without calling Apify
 *
 * Examples:
 *   node scripts/linkedin-companies.js target-accounts.csv --topic IdentityManagement
 *   node scripts/linkedin-companies.js accounts.csv --max-companies 10 --dry-run
 *   node scripts/linkedin-companies.js urls-only.csv --topic GRC --skip-scraped
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *
 * Output:
 *   <Topic>/LinkedIn/companies-<timestamp>.json
 *   <Topic>/LinkedIn/companies-<timestamp>.md
 *   linkedin-history.jsonl (audit log)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
const ACTOR_ID = 'curious_coder~linkedin-company-scraper';
const ACTOR_URL = 'https://apify.com/curious_coder/linkedin-company-scraper';

// ── Company Signals ──
const COMPLIANCE_KEYWORDS = [
    'soc 2', 'soc2', 'iso 27001', 'hipaa', 'cmmc', 'fedramp',
    'pci dss', 'gdpr', 'ccpa', 'nist', 'hitrust'
];

const SECURITY_SPECIALTIES = [
    'cybersecurity', 'information security', 'identity', 'access management',
    'compliance', 'governance', 'risk management', 'data protection',
    'cloud security', 'network security', 'zero trust'
];

// ── Scoring ──
const SIGNAL_SCORES = {
    'employee-growth-20pct':          { base: 28, urgency: 'Medium', window: 'next batch' },
    'employee-growth-50pct':          { base: 32, urgency: 'High',   window: 'week 1' },
    'compliance-cert-announcement':   { base: 25, urgency: 'Medium', window: 'next batch' },
    'security-specialty':             { base: 20, urgency: 'Medium', window: 'next batch' },
    'recently-founded':               { base: 18, urgency: 'Low',    window: 'monitor' },
    'large-enterprise':               { base: 15, urgency: 'Low',    window: 'monitor' }
};

const BONUSES = {
    securitySpecialty:    3,
    complianceMentioned:  3,
    targetIndustry:       3,
    highGrowth:           5
};

const TARGET_INDUSTRIES = [
    'financial services', 'fintech', 'healthcare', 'healthtech',
    'saas', 'software', 'technology', 'defense', 'government',
    'insurance', 'banking', 'pharmaceutical', 'biotech'
];

// ── Outreach Templates ──
const OUTREACH_TEMPLATES = {
    'employee-growth': {
        angle: 'Scaling identity infrastructure',
        opener: 'Rapid growth often means identity sprawl — new employees, new tools, and access that\'s hard to track. We help scaling companies get ahead of that.',
        cta: 'Worth a 15-min call?'
    },
    'compliance-cert': {
        angle: 'Compliance maintenance',
        opener: 'Maintaining compliance certifications requires continuous identity controls — not just an annual audit check. We help teams automate that.',
        cta: 'Can share what other companies in your space are doing.'
    },
    'security-focus': {
        angle: 'Security-focused company',
        opener: 'Companies with a security focus still often have identity governance gaps internally. We help security-aware organizations close that loop.',
        cta: 'Would a conversation be useful?'
    },
    'default': {
        angle: 'Identity and access management',
        opener: 'As organizations grow, managing who has access to what becomes one of the hardest operational challenges. We help companies solve that.',
        cta: 'Worth connecting?'
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
async function startActorRun(companyUrls) {
    const body = {
        urls: companyUrls,
        minDelay: 2,
        maxDelay: 5
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

// ── Jobs JSON Parser ──
function parseJobsJSON(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    const signals = json.signals || [];
    const seen = new Set();
    const companies = [];
    for (const s of signals) {
        const url = s.companyUrl ? normalizeCompanyUrl(s.companyUrl) : null;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        companies.push({
            companyUrl: url,
            csvMetadata: {
                company_name: s.company || '',
                industry: s.industries || '',
                employee_count: s.companySize ? String(s.companySize) : '',
                segment: s.segment || '',
                website: s.companyWebsite || ''
            }
        });
    }
    return { companies, hasMetadata: true };
}

// ── CSV Parser ──
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

    if (lines.length === 0) {
        throw new Error('CSV file is empty');
    }

    // Check if first line is a URL (no header) or a header row
    const firstLine = lines[0];
    const isUrlOnly = /^https?:\/\/.*linkedin\.com\/company\//i.test(firstLine);

    if (isUrlOnly) {
        // Format A: URL-only, one per line
        const companies = [];
        for (const line of lines) {
            const url = line.trim();
            if (/linkedin\.com\/company\//i.test(url)) {
                companies.push({
                    companyUrl: normalizeCompanyUrl(url),
                    csvMetadata: {}
                });
            }
        }
        return { companies, hasMetadata: false };
    }

    // Format B: CSV with headers
    // Split header and detect LinkedIn URL column
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine);
    const urlColIndex = detectLinkedInUrlColumn(headers, lines.length > 1 ? parseCSVLine(lines[1]) : []);

    if (urlColIndex === -1) {
        throw new Error('Could not find a LinkedIn company URL column in the CSV.\n  Expected a column with header like: linkedin_url, linkedin, company_url, url\n  Or a column containing linkedin.com/company/ URLs');
    }

    const companies = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const url = (values[urlColIndex] || '').trim();

        if (!url || !/linkedin\.com\/company\//i.test(url)) continue;

        // Build metadata from other columns
        const metadata = {};
        for (let j = 0; j < headers.length; j++) {
            if (j !== urlColIndex && values[j]) {
                const key = headers[j].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                metadata[key] = values[j].trim();
            }
        }

        companies.push({
            companyUrl: normalizeCompanyUrl(url),
            csvMetadata: metadata
        });
    }

    return { companies, hasMetadata: true };
}

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current);
    return values;
}

function detectLinkedInUrlColumn(headers, firstRow) {
    // Check header names
    const urlHeaders = ['linkedin_url', 'linkedin', 'company_url', 'url', 'linkedin_company_url', 'company_linkedin'];
    for (let i = 0; i < headers.length; i++) {
        const h = headers[i].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (urlHeaders.includes(h)) return i;
    }

    // Check first data row for LinkedIn URL pattern
    for (let i = 0; i < firstRow.length; i++) {
        if (/linkedin\.com\/company\//i.test(firstRow[i])) return i;
    }

    return -1;
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

// ── Signal Extraction ──
function segmentCompany(employeeCount) {
    if (!employeeCount || employeeCount <= 0) return 'Unknown';
    if (employeeCount >= 1000) return 'A';
    if (employeeCount >= 100) return 'B';
    return 'C';
}

function extractCompanySignals(companyData, csvMetadata) {
    const name = companyData.name || companyData.companyName || csvMetadata.company_name || csvMetadata.name || '';
    const description = (companyData.description || companyData.about || '').toLowerCase();
    const specialties = (companyData.specialties || []).map(s => s.toLowerCase());
    const industry = companyData.industry || csvMetadata.industry || '';
    const employeeCount = companyData.employeeCount || companyData.staffCount ||
        parseInt(csvMetadata.employee_count || csvMetadata.employees || '0') || 0;
    const headquarters = companyData.headquarters || companyData.location || csvMetadata.location || '';
    const founded = companyData.founded || csvMetadata.founded || '';
    const website = companyData.website || csvMetadata.website || '';

    const allText = description + ' ' + specialties.join(' ') + ' ' + industry.toLowerCase();

    const signals = [];
    const bonuses = [];

    // Security specialty detection
    const securityMatches = SECURITY_SPECIALTIES.filter(s => allText.includes(s));
    if (securityMatches.length > 0) {
        signals.push('security-specialty');
        bonuses.push({ reason: `security specialty: ${securityMatches.join(', ')}`, points: BONUSES.securitySpecialty });
    }

    // Compliance mentions
    const complianceMatches = COMPLIANCE_KEYWORDS.filter(c => allText.includes(c));
    if (complianceMatches.length > 0) {
        signals.push('compliance-cert-announcement');
        bonuses.push({ reason: `compliance: ${complianceMatches.join(', ')}`, points: BONUSES.complianceMentioned });
    }

    // Target industry
    const industryMatch = TARGET_INDUSTRIES.find(ind => industry.toLowerCase().includes(ind));
    if (industryMatch) {
        bonuses.push({ reason: `target industry: ${industryMatch}`, points: BONUSES.targetIndustry });
    }

    // Employee count signals
    if (employeeCount >= 1000) {
        signals.push('large-enterprise');
    }

    // Determine primary signal and score
    let primarySignal = signals[0] || 'large-enterprise';
    const rule = SIGNAL_SCORES[primarySignal] || SIGNAL_SCORES['large-enterprise'];
    let baseScore = rule.base;
    let totalScore = baseScore + bonuses.reduce((sum, b) => sum + b.points, 0);
    if (totalScore > 50) totalScore = 50;

    // Determine outreach
    let outreachKey = 'default';
    if (signals.includes('compliance-cert-announcement')) outreachKey = 'compliance-cert';
    else if (signals.includes('security-specialty')) outreachKey = 'security-focus';
    else if (signals.includes('employee-growth-20pct') || signals.includes('employee-growth-50pct')) outreachKey = 'employee-growth';
    const template = OUTREACH_TEMPLATES[outreachKey];

    return {
        name,
        industry,
        employeeCount,
        segment: segmentCompany(employeeCount),
        headquarters,
        founded,
        website,
        description: (companyData.description || companyData.about || '').slice(0, 500),
        specialties: companyData.specialties || [],
        securityMatches,
        complianceMatches,
        signals,
        baseScore,
        bonuses,
        totalScore,
        urgency: rule.urgency,
        urgencyWindow: rule.window,
        outreachAngle: template.angle,
        suggestedMessage: template.opener + ' ' + template.cta
    };
}

function mergeCSVMetadata(apifyData, csvRow) {
    // CSV metadata takes priority for fields the user already has
    const merged = { ...apifyData };
    const meta = csvRow.csvMetadata;

    if (meta.industry && !merged.industry) merged.industry = meta.industry;
    if (meta.employee_count && !merged.employeeCount) merged.employeeCount = parseInt(meta.employee_count);
    if (meta.segment) merged.csvSegment = meta.segment;
    if (meta.company_name || meta.name) merged.name = meta.company_name || meta.name || merged.name;

    return merged;
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
function buildOutputJSON(companies, meta) {
    const bySegment = { A: 0, B: 0, C: 0, Unknown: 0 };
    for (const c of companies) {
        bySegment[c.enriched.segment] = (bySegment[c.enriched.segment] || 0) + 1;
    }

    return {
        meta: {
            ...meta,
            companiesEnriched: companies.length,
            bySegment
        },
        companies: companies.sort((a, b) => b.enriched.totalScore - a.enriched.totalScore)
    };
}

function generateMarkdownReport(companies, meta) {
    const lines = [];
    const date = new Date().toISOString().split('T')[0];

    lines.push(`# LinkedIn Companies — Enrichment Report (${date})`);
    lines.push('');
    lines.push(`**Topic:** ${meta.topic} | **CSV:** ${meta.csvFile} | **Companies enriched:** ${companies.length}`);
    lines.push('');

    // Segment summary
    const segCounts = { A: 0, B: 0, C: 0, Unknown: 0 };
    for (const c of companies) segCounts[c.enriched.segment] = (segCounts[c.enriched.segment] || 0) + 1;

    lines.push('## Segment Summary');
    lines.push('');
    lines.push('| Segment | Count | Description |');
    lines.push('|---------|-------|-------------|');
    lines.push(`| **A** (Enterprise) | ${segCounts.A} | 1,000+ employees |`);
    lines.push(`| **B** (Mid-Market) | ${segCounts.B} | 100-999 employees |`);
    lines.push(`| **C** (SMB) | ${segCounts.C} | Under 100 employees |`);
    if (segCounts.Unknown > 0) lines.push(`| **Unknown** | ${segCounts.Unknown} | Employee count unavailable |`);
    lines.push('');

    lines.push('## Companies');
    lines.push('');

    for (const c of companies) {
        const e = c.enriched;
        lines.push(`### ${e.name || 'Unknown'} — Segment ${e.segment}`);
        lines.push(`**Score:** ${e.totalScore}/50 | **Urgency:** ${e.urgency} | **Window:** ${e.urgencyWindow}`);
        if (c.companyUrl) lines.push(`**LinkedIn:** ${c.companyUrl}`);
        if (e.website) lines.push(`**Website:** ${e.website}`);
        if (e.industry) lines.push(`**Industry:** ${e.industry}`);
        if (e.employeeCount) lines.push(`**Employees:** ${e.employeeCount.toLocaleString()}`);
        if (e.headquarters) lines.push(`**HQ:** ${e.headquarters}`);
        if (e.founded) lines.push(`**Founded:** ${e.founded}`);
        lines.push('');

        if (e.securityMatches.length > 0) {
            lines.push(`**Security specialties:** ${e.securityMatches.join(', ')}`);
        }
        if (e.complianceMatches.length > 0) {
            lines.push(`**Compliance frameworks:** ${e.complianceMatches.join(', ')}`);
        }
        if (e.specialties.length > 0) {
            lines.push(`**Company specialties:** ${e.specialties.join(', ')}`);
        }

        if (e.bonuses.length > 0) {
            lines.push(`**Score bonuses:** ${e.bonuses.map(b => `+${b.points} (${b.reason})`).join(', ')}`);
        }

        if (Object.keys(c.csvMetadata).length > 0) {
            lines.push(`**CSV metadata:** ${Object.entries(c.csvMetadata).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }

        lines.push('');
        lines.push(`**Outreach angle:** ${e.outreachAngle}`);
        lines.push(`> ${e.suggestedMessage}`);
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

function appendAuditLog(entry) {
    const logPath = path.join(__dirname, '..', 'linkedin-history.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ── Main ──
async function scanLinkedInCompanies(options) {
    const { csvFile, topic, maxCompanies, skipScraped, dryRun, inlineCompanies } = options;
    const startTime = Date.now();

    console.log(`\nLinkedIn Company Enrichment Scanner`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Input: ${csvFile}`);

    let csvCompanies, hasMetadata;
    if (inlineCompanies) {
        csvCompanies = inlineCompanies;
        hasMetadata = inlineCompanies.some(c => Object.keys(c.csvMetadata).length > 0);
    } else {
        ({ companies: csvCompanies, hasMetadata } = parseCSV(csvFile));
    }

    console.log(`Companies found: ${csvCompanies.length}`);
    console.log(`Format: ${inlineCompanies ? (csvFile.endsWith('.json') ? 'jobs JSON' : 'direct URL') : (hasMetadata ? 'CSV with metadata' : 'CSV URL-only')}`);
    console.log(`Topic: ${topic || 'auto'}`);
    console.log(`Actor: ${ACTOR_ID}`);
    console.log(`${'─'.repeat(40)}\n`);

    // Dedup and skip-scraped filtering
    let toScrape = csvCompanies;

    if (skipScraped) {
        const { seen } = loadSeenUrls(topic);
        const before = toScrape.length;
        toScrape = toScrape.filter(c => !seen.has(c.companyUrl));
        if (toScrape.length < before) {
            console.log(`Skipped ${before - toScrape.length} previously scraped companies`);
        }
    }

    if (maxCompanies && maxCompanies < toScrape.length) {
        console.log(`Capping at ${maxCompanies} companies (${toScrape.length} available)`);
        toScrape = toScrape.slice(0, maxCompanies);
    }

    if (toScrape.length === 0) {
        console.log('No companies to scrape. Exiting.');
        return;
    }

    console.log(`Will scrape ${toScrape.length} company page(s)`);
    console.log(`Estimated Apify cost: ~$${(toScrape.length * 0.01).toFixed(2)}-$${(toScrape.length * 0.05).toFixed(2)}\n`);

    if (dryRun) {
        console.log('DRY RUN — no Apify calls will be made.\n');
        console.log(`Actor page: ${ACTOR_URL}`);
        console.log(`\nCompanies that would be scraped:\n`);
        for (let i = 0; i < toScrape.length; i++) {
            const c = toScrape[i];
            const name = c.csvMetadata.company_name || c.csvMetadata.name || '';
            console.log(`  [${i + 1}] ${c.companyUrl}${name ? ` (${name})` : ''}`);
        }
        console.log(`\nTo run for real, remove --dry-run`);
        return;
    }

    if (!APIFY_TOKEN) {
        console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
        process.exit(1);
    }

    // Batch scrape — send all URLs in one actor run for efficiency
    const BATCH_SIZE = 10;
    const enrichedCompanies = [];
    const { seen: seenUrls, file: seenFile } = loadSeenUrls(topic);

    for (let batchStart = 0; batchStart < toScrape.length; batchStart += BATCH_SIZE) {
        const batch = toScrape.slice(batchStart, batchStart + BATCH_SIZE);
        const batchLabel = `[Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(toScrape.length / BATCH_SIZE)}]`;

        console.log(`${batchLabel} Scraping ${batch.length} companies...`);
        const batchUrls = batch.map(c => c.companyUrl);

        try {
            const runData = await startActorRun(batchUrls);
            const runId = runData.data.id;
            console.log(`${batchLabel}   Run ID: ${runId}`);

            const completedRun = await waitForCompletion(runId, batchLabel);
            const datasetId = completedRun.defaultDatasetId;

            const results = await getResults(datasetId);
            console.log(`${batchLabel}   Fetched ${results.length} company records`);

            // Match results back to CSV rows by URL
            for (const csvRow of batch) {
                const normalizedCsvUrl = csvRow.companyUrl.toLowerCase();

                // Find matching Apify result
                let apifyData = results.find(r => {
                    const rUrl = normalizeCompanyUrl(r.url || r.linkedinUrl || r.companyUrl || '').toLowerCase();
                    return rUrl === normalizedCsvUrl;
                }) || {};

                // Merge CSV metadata
                apifyData = mergeCSVMetadata(apifyData, csvRow);

                // Extract signals
                const enriched = extractCompanySignals(apifyData, csvRow.csvMetadata);

                enrichedCompanies.push({
                    companyUrl: csvRow.companyUrl,
                    csvMetadata: csvRow.csvMetadata,
                    enriched
                });

                seenUrls.add(csvRow.companyUrl);
            }

        } catch (err) {
            console.error(`${batchLabel}   Error: ${err.message}`);
            // Still add CSV-only data for failed batch
            for (const csvRow of batch) {
                enrichedCompanies.push({
                    companyUrl: csvRow.companyUrl,
                    csvMetadata: csvRow.csvMetadata,
                    enriched: extractCompanySignals({}, csvRow.csvMetadata)
                });
            }
        }

        // Delay between batches
        if (batchStart + BATCH_SIZE < toScrape.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    saveSeenUrls(seenUrls, seenFile);

    // Output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const outputTopic = topic || 'LinkedIn';
    const dir = path.join(outputTopic, 'LinkedIn');
    fs.mkdirSync(dir, { recursive: true });

    const jsonFile = path.join(dir, `companies-${timestamp}.json`);
    const mdFile = path.join(dir, `companies-${timestamp}.md`);

    const meta = {
        topic: outputTopic,
        source: 'linkedin-companies',
        csvFile: path.basename(csvFile),
        inputType: inlineCompanies ? (csvFile.endsWith('.json') ? 'jobs-json' : 'direct-url') : 'csv',
        hasMetadata,
        scannedAt: new Date().toISOString().split('T')[0],
        totalInCSV: csvCompanies.length,
        scraped: toScrape.length,
        durationMs: Date.now() - startTime
    };

    const outputJSON = buildOutputJSON(enrichedCompanies, meta);
    fs.writeFileSync(jsonFile, JSON.stringify(outputJSON, null, 2));

    const mdContent = generateMarkdownReport(enrichedCompanies, meta);
    fs.writeFileSync(mdFile, mdContent);

    appendAuditLog({
        timestamp: new Date().toISOString(),
        script: 'linkedin-companies',
        topic: outputTopic,
        csvFile: path.basename(csvFile),
        companiesInCSV: csvCompanies.length,
        companiesScraped: toScrape.length,
        companiesEnriched: enrichedCompanies.length,
        outputFile: jsonFile,
        durationMs: Date.now() - startTime
    });

    // Summary
    const segCounts = { A: 0, B: 0, C: 0, Unknown: 0 };
    for (const c of enrichedCompanies) segCounts[c.enriched.segment] = (segCounts[c.enriched.segment] || 0) + 1;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Companies in CSV:      ${csvCompanies.length}`);
    console.log(`Companies scraped:     ${toScrape.length}`);
    console.log(`Companies enriched:    ${enrichedCompanies.length}`);
    console.log(`\nSegments:  A: ${segCounts.A}  B: ${segCounts.B}  C: ${segCounts.C}  Unknown: ${segCounts.Unknown}`);
    console.log(`\nSaved to:`);
    console.log(`  ${jsonFile}`);
    console.log(`  ${mdFile}`);
    console.log(`${'='.repeat(50)}\n`);

    return outputJSON;
}

// ── CLI ──
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`
LinkedIn Company Enrichment Scanner

Scrapes LinkedIn company pages from a CSV of target accounts.
Extracts employee count, growth signals, compliance certifications.
Merges scraped data with any metadata from the CSV.

Usage:
  node scripts/linkedin-companies.js <csv-file> [options]

CSV Format:
  URL-only (no header):
    https://linkedin.com/company/acme-corp
    https://linkedin.com/company/globex

  With metadata (any columns, LinkedIn URL is the key):
    company_name,linkedin_url,industry,employee_count,segment
    Acme Corp,https://linkedin.com/company/acme-corp,SaaS,1500,A

Options:
  --topic <Name>          Topic directory for output (default: auto)
  --max-companies <N>     Cap how many companies to scrape (default: all)
  --skip-scraped          Skip companies already in LinkedIn/ output folder
  --dry-run               Print companies to scrape without calling Apify

Examples:
  node scripts/linkedin-companies.js target-accounts.csv --topic IdentityManagement
  node scripts/linkedin-companies.js accounts.csv --max-companies 10 --dry-run
  node scripts/linkedin-companies.js urls-only.csv --topic GRC --skip-scraped
    `);
    process.exit(0);
}

let inputArg = null;
let topic = null;
let maxCompanies = null;
let skipScraped = false;
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--max-companies') {
        maxCompanies = parseInt(rawArgs[++i]) || null;
    } else if (arg === '--skip-scraped') {
        skipScraped = true;
    } else if (arg === '--dry-run') {
        dryRun = true;
    } else if (!arg.startsWith('--') && !inputArg) {
        inputArg = arg;
    }
}

if (!inputArg) {
    console.error('Error: Input is required as the first argument (CSV file, jobs JSON, or LinkedIn company URL).');
    console.error('  Usage: node scripts/linkedin-companies.js <csv-file|jobs.json|linkedin-url> [options]');
    process.exit(1);
}

// Detect input type: direct URL, jobs JSON, or CSV
const isDirectUrl = /^https?:\/\/.*linkedin\.com\/company\//i.test(inputArg);
const isJsonFile = !isDirectUrl && inputArg.endsWith('.json');
const csvFile = isDirectUrl ? null : isJsonFile ? null : inputArg;

if (isDirectUrl) {
    // Wrap single URL as an inline companies list
    const url = normalizeCompanyUrl(inputArg);
    const inlineCompanies = [{ companyUrl: url, csvMetadata: {} }];
    scanLinkedInCompanies({ csvFile: inputArg, topic, maxCompanies, skipScraped, dryRun, inlineCompanies });
} else if (isJsonFile) {
    if (!fs.existsSync(inputArg)) {
        console.error(`Error: Jobs JSON file not found: ${inputArg}`);
        process.exit(1);
    }
    const { companies: inlineCompanies, hasMetadata } = parseJobsJSON(inputArg);
    if (inlineCompanies.length === 0) {
        console.error('Error: No company URLs found in jobs JSON.');
        process.exit(1);
    }
    scanLinkedInCompanies({ csvFile: inputArg, topic, maxCompanies, skipScraped, dryRun, inlineCompanies });
} else {
    if (!fs.existsSync(csvFile)) {
        console.error(`Error: CSV file not found: ${csvFile}`);
        process.exit(1);
    }
    scanLinkedInCompanies({ csvFile, topic, maxCompanies, skipScraped, dryRun });
}

export { scanLinkedInCompanies };
