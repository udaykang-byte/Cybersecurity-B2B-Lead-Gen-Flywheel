/**
 * Discogen API Client (Discolike.com)
 *
 * Replaces Exa.ai in account-signals.js. Searches web and news for company
 * intelligence signals (breaches, funding, CISO changes, M&A, cloud migration).
 *
 * ── Setup ──
 * Add to .env:
 *   DISCOGEN_API_KEY=your_discogen_key_here
 *
 * ── Interface ──
 * searchCompanyNews(companyName, domain, options) → Promise<NewsSignal[]>
 *
 * Returns the same shape that account-signals.js expects:
 *   [{ title, url, summary, type, published_at, points, confidence, source }]
 *
 * ── Status ──
 * API endpoint and request format are stubbed — fill in once Discogen credentials
 * are available. The signal extraction and scoring logic is fully implemented.
 *
 * To test with live credentials:
 *   1. Set DISCOGEN_API_KEY in .env
 *   2. Update DISCOGEN_HOSTNAME and buildRequestBody() below
 *   3. Run: node Skills/lib/discogen.js "Acme Corp" "acmecorp.com"
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env ──
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

const DISCOGEN_KEY = process.env.DISCOGEN_API_KEY;

// ── API Configuration ──
// TODO: Update these with the actual Discogen API endpoint once credentials are available.
// Current placeholder matches Exa.ai's pattern for reference.
const DISCOGEN_HOSTNAME = 'api.discolike.com';         // ← update when confirmed
const DISCOGEN_PATH     = '/v1/discogen/search';        // ← update when confirmed

// ── Signal Type Classification ──
// Maps keywords found in article titles/summaries to signal types + base point values
const SIGNAL_PATTERNS = [
    {
        type: 'breach',
        keywords: ['breach', 'ransomware', 'cyberattack', 'data breach', 'hack', 'leaked', 'exposed records', 'security incident', 'compromised'],
        points: 45,
        confidence: 0.9
    },
    {
        type: 'funding',
        keywords: ['series b', 'series c', 'series d', 'raised $', 'funding round', 'investment round', 'venture capital', 'growth equity', 'ipo'],
        points: 33,
        confidence: 0.85
    },
    {
        type: 'ciso_change',
        keywords: ['ciso', 'chief information security', 'vp of security', 'head of security', 'director of security', 'appoints', 'hires', 'joins as', 'named ciso'],
        points: 35,
        confidence: 0.8
    },
    {
        type: 'm&a',
        keywords: ['acquisition', 'acquired', 'merger', 'merges with', 'private equity', 'pe-backed', 'buyout', 'taken private'],
        points: 28,
        confidence: 0.85
    },
    {
        type: 'cloud_migration',
        keywords: ['cloud migration', 'cloud transformation', 'moving to cloud', 'aws migration', 'azure migration', 'digital transformation', 'cloud-first'],
        points: 28,
        confidence: 0.75
    },
    {
        type: 'compliance',
        keywords: ['soc 2', 'soc2', 'hipaa', 'iso 27001', 'cmmc', 'fedramp', 'pci dss', 'gdpr', 'compliance audit', 'regulatory', 'audit findings'],
        points: 25,
        confidence: 0.8
    }
];

// ── HTTP helper ──
function makeRequest(options, body = null) {
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
        if (body) req.write(body);
        req.end();
    });
}

// ── Build request body for Discogen API ──
// TODO: Update this function to match actual Discogen API request format.
// The current structure mirrors Exa.ai's format as a starting point.
function buildRequestBody(companyName, domain, options = {}) {
    const queries = buildSearchQueries(companyName, domain);
    return {
        queries,
        numResults: options.numResults || 5,
        startPublishedDate: options.startPublishedDate || getDateMonthsAgo(6),
        // TODO: add any Discogen-specific fields here
    };
}

// ── Generate targeted search queries ──
function buildSearchQueries(companyName, domain) {
    const queries = [`"${companyName}" cybersecurity OR breach OR CISO OR compliance`];
    if (domain) {
        queries.push(`site:${domain} OR "${companyName}" security funding acquisition`);
    }
    return queries;
}

function getDateMonthsAgo(months) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString().split('T')[0];
}

// ── Classify a result into a signal type ──
function classifyResult(result) {
    const text = `${result.title || ''} ${result.summary || result.text || ''}`.toLowerCase();

    for (const pattern of SIGNAL_PATTERNS) {
        const matchCount = pattern.keywords.filter(kw => text.includes(kw)).length;
        if (matchCount > 0) {
            return {
                type: pattern.type,
                points: pattern.points + Math.min(matchCount - 1, 3) * 2, // +2 pts per extra keyword match, cap +6
                confidence: pattern.confidence
            };
        }
    }
    return { type: 'general', points: 5, confidence: 0.5 };
}

// ── Normalize a Discogen result into a NewsSignal ──
// TODO: Update field mappings to match actual Discogen API response shape.
function normalizeResult(raw) {
    const classified = classifyResult(raw);
    return {
        source:       'discogen',
        title:        raw.title || raw.headline || '',
        url:          raw.url || raw.link || '',
        summary:      raw.text || raw.summary || raw.snippet || '',
        type:         classified.type,
        published_at: raw.publishedDate || raw.published_at || raw.date || null,
        points:       classified.points,
        confidence:   classified.confidence
    };
}

// ── Main export: searchCompanyNews ──
/**
 * Search for company news and intelligence signals.
 *
 * @param {string} companyName  - Company name (e.g. "Acme Corp")
 * @param {string} domain       - Company website domain (e.g. "acmecorp.com") — optional
 * @param {object} options      - { numResults: 5, startPublishedDate: '2024-01-01' }
 * @returns {Promise<NewsSignal[]>}
 */
export async function searchCompanyNews(companyName, domain = null, options = {}) {
    if (!DISCOGEN_KEY) {
        // Graceful degradation: return empty array if not configured (same as Exa.ai fallback)
        return [];
    }

    const requestBody = buildRequestBody(companyName, domain, options);
    const postData = JSON.stringify(requestBody);

    const reqOptions = {
        hostname: DISCOGEN_HOSTNAME,
        port: 443,
        path: DISCOGEN_PATH,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${DISCOGEN_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
            // TODO: add any Discogen-specific auth headers here (e.g. 'x-api-key')
        }
    };

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await makeRequest(reqOptions, postData);

            if (response.status === 200) {
                // TODO: update result extraction to match actual Discogen API response structure.
                // Current: expects { results: [...] } — update if different.
                const rawResults = response.data?.results || response.data?.articles || response.data || [];
                const results = Array.isArray(rawResults) ? rawResults : [];
                return results
                    .map(normalizeResult)
                    .filter(r => r.url && r.title);  // drop empty results
            }

            if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
                await new Promise(r => setTimeout(r, [2000, 5000][attempt]));
                continue;
            }

            // Non-retryable error
            console.error(`  Discogen API error (${response.status}) for "${companyName}"`);
            return [];

        } catch (err) {
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            console.error(`  Discogen network error for "${companyName}": ${err.message}`);
            return [];
        }
    }
    return [];
}

// ── isConfigured — safe check ──
export function isConfigured() {
    return !!DISCOGEN_KEY;
}

// ── CLI test (run directly to verify integration) ──
// Usage: node Skills/lib/discogen.js "Acme Corp" "acmecorp.com"
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const companyName = process.argv[2] || 'Acme Corp';
    const domain = process.argv[3] || null;

    if (!DISCOGEN_KEY) {
        console.error('DISCOGEN_API_KEY not set in .env');
        process.exit(1);
    }

    console.log(`Testing Discogen for: ${companyName}${domain ? ` (${domain})` : ''}`);
    const results = await searchCompanyNews(companyName, domain);
    console.log(`\nReturned ${results.length} signal(s):\n`);
    results.forEach((r, i) => {
        console.log(`[${i + 1}] ${r.type.toUpperCase()} — ${r.points} pts — ${r.confidence * 100}% confidence`);
        console.log(`    ${r.title}`);
        console.log(`    ${r.url}`);
        if (r.summary) console.log(`    ${r.summary.slice(0, 120)}...`);
        console.log();
    });
}
