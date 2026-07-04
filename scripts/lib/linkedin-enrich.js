/**
 * LinkedIn Company Enrichment (Apify)
 *
 * Extracted from the pre-rewrite scripts/account-signals.js monolith: the
 * .env loader, the raw HTTP helper, and the three-stage Apify actor
 * run/poll/fetch flow (curious_coder~linkedin-company-scraper). Logic is
 * unchanged from the original — only relocated here and wrapped in a single
 * enrichCompanies() entry point so the orchestrator doesn't need to know
 * about Apify's run/dataset lifecycle.
 *
 * Usage:
 *   import { enrichCompanies } from './lib/linkedin-enrich.js';
 *   const byUrl = await enrichCompanies(['https://www.linkedin.com/company/okta']);
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env (two levels up from scripts/lib/) ──
try {
    const envPath = path.join(__dirname, '..', '..', '.env');
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
        if (response.status === 201) return response.data.data.id;
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
        if (status === 'SUCCEEDED') { process.stdout.write('\n'); return response.data.data.defaultDatasetId; }
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
    if (!url) return null;
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'company' && parts[1]) {
            return `https://www.linkedin.com/company/${parts[1]}`;
        }
    } catch { /* as-is */ }
    return url;
}

export { normalizeCompanyUrl };

/** Enrich LinkedIn company URLs via Apify. Returns Map<normalizedUrl, companyData>. */
export async function enrichCompanies(companyUrls) {
    if (!process.env.APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN not set in .env');
    if (!companyUrls.length) return new Map();
    const runId = await startLinkedInActorRun(companyUrls);
    const datasetId = await waitForActorRun(runId);
    const results = await getActorResults(datasetId);
    const byUrl = new Map();
    for (const r of results) {
        const key = normalizeCompanyUrl(r.url || r.companyUrl || r.linkedinUrl || '');
        if (key) byUrl.set(key, r);
    }
    return byUrl;
}
