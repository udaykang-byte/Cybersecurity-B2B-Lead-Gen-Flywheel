/**
 * Supabase REST Client (native https — no npm required)
 *
 * Wraps Supabase's PostgREST API. All scripts import this module
 * instead of managing their own HTTP headers.
 *
 * Setup: add to .env
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY=your-service-role-key   ← used for writes
 *   SUPABASE_ANON_KEY=your-anon-key              ← optional, for read-only queries
 *
 * Usage:
 *   import db from '../lib/supabase.js';
 *
 *   // Upsert (insert or update on conflict)
 *   await db.upsert('companies', rows, 'linkedin_url');
 *
 *   // Insert (skip duplicates silently)
 *   await db.insert('job_signals', rows);
 *
 *   // Select
 *   const rows = await db.select('job_signals', { company_id: 'eq.uuid', limit: 100 });
 *
 *   // Update rows matching a filter
 *   await db.update('reddit_leads', { url: 'eq.https://...' }, { lead_score: 8 });
 *
 *   // Check if URL already exists (fast dedup check)
 *   const existing = await db.exists('job_signals', 'url', urls);
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// ── Internal HTTP helper ──
function makeRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, data: parsed, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ── Build PostgREST-compatible query string ──
// Supports: column=eq.value, column=in.(a,b,c), limit=N, order=col.desc, select=col1,col2
function buildQuery(params = {}) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
        if (key === 'limit' || key === 'order' || key === 'select') {
            parts.push(`${key}=${encodeURIComponent(value)}`);
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
    }
    return parts.length ? '?' + parts.join('&') : '';
}

// ── Base headers ──
function headers(extra = {}) {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

// ── Parse Supabase URL ──
function parseUrl(urlStr) {
    const u = new URL(urlStr);
    return { hostname: u.hostname, port: u.port || 443, basePath: u.pathname };
}

// ── Validate client is configured ──
function assertConfigured() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error(
            'Supabase not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to .env\n' +
            'Get your keys at: https://supabase.com/dashboard/project/_/settings/api'
        );
    }
}

const { hostname, port, basePath } = (() => {
    if (!SUPABASE_URL) return { hostname: '', port: 443, basePath: '' };
    try { return parseUrl(SUPABASE_URL); } catch { return { hostname: '', port: 443, basePath: '' }; }
})();

// ── SELECT ──
// params: { column: 'eq.value', limit: 100, order: 'created_at.desc', select: 'col1,col2' }
async function select(table, params = {}) {
    assertConfigured();
    const qs = buildQuery(params);
    const opts = {
        hostname, port,
        path: `${basePath}/rest/v1/${table}${qs}`,
        method: 'GET',
        headers: headers({ 'Accept': 'application/json' })
    };
    const res = await makeRequest(opts);
    if (res.status >= 400) throw new Error(`Supabase select ${table} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return Array.isArray(res.data) ? res.data : [];
}

// ── INSERT (skip on conflict — idempotent) ──
// rows: object or array of objects
async function insert(table, rows) {
    assertConfigured();
    const data = Array.isArray(rows) ? rows : [rows];
    if (data.length === 0) return [];
    const body = JSON.stringify(data);
    const opts = {
        hostname, port,
        path: `${basePath}/rest/v1/${table}`,
        method: 'POST',
        headers: headers({
            'Content-Length': Buffer.byteLength(body),
            'Prefer': 'resolution=ignore-duplicates,return=representation'
        })
    };
    const res = await makeRequest(opts, body);
    if (res.status >= 400) throw new Error(`Supabase insert ${table} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return Array.isArray(res.data) ? res.data : [];
}

// ── UPSERT (insert or update on conflict column) ──
// onConflict: the UNIQUE column name (e.g. 'linkedin_url', 'url', 'profile_url')
async function upsert(table, rows, onConflict) {
    assertConfigured();
    const data = Array.isArray(rows) ? rows : [rows];
    if (data.length === 0) return [];
    const body = JSON.stringify(data);
    const conflictParam = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    const opts = {
        hostname, port,
        path: `${basePath}/rest/v1/${table}${conflictParam}`,
        method: 'POST',
        headers: headers({
            'Content-Length': Buffer.byteLength(body),
            'Prefer': 'resolution=merge-duplicates,return=representation'
        })
    };
    const res = await makeRequest(opts, body);
    if (res.status >= 400) throw new Error(`Supabase upsert ${table} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return Array.isArray(res.data) ? res.data : [];
}

// ── UPDATE rows matching a filter ──
// filter: { column: 'eq.value' }   (PostgREST filter syntax)
// patch:  { field: newValue }
async function update(table, filter, patch) {
    assertConfigured();
    const qs = buildQuery(filter);
    const body = JSON.stringify(patch);
    const opts = {
        hostname, port,
        path: `${basePath}/rest/v1/${table}${qs}`,
        method: 'PATCH',
        headers: headers({
            'Content-Length': Buffer.byteLength(body),
            'Prefer': 'return=representation'
        })
    };
    const res = await makeRequest(opts, body);
    if (res.status >= 400) throw new Error(`Supabase update ${table} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return Array.isArray(res.data) ? res.data : [];
}

// ── EXISTS — returns Set of values already in the table for a given column ──
// Efficient dedup: pass an array of candidate values, get back a Set of the ones already stored.
// Handles batching for large arrays (Supabase URL limit ~8 KB).
//
// Example:
//   const seen = await db.exists('job_signals', 'url', candidateUrls);
//   const newUrls = candidateUrls.filter(u => !seen.has(u));
async function exists(table, column, values) {
    assertConfigured();
    if (!values || values.length === 0) return new Set();

    const BATCH = 200;
    const seen = new Set();

    for (let i = 0; i < values.length; i += BATCH) {
        const batch = values.slice(i, i + BATCH);
        const inValue = `(${batch.map(v => `"${v.replace(/"/g, '\\"')}"`).join(',')})`;
        const qs = `?select=${encodeURIComponent(column)}&${encodeURIComponent(column)}=in.${encodeURIComponent(inValue)}`;
        const opts = {
            hostname, port,
            path: `${basePath}/rest/v1/${table}${qs}`,
            method: 'GET',
            headers: headers({ 'Accept': 'application/json' })
        };
        const res = await makeRequest(opts);
        if (res.status >= 400) throw new Error(`Supabase exists check on ${table}.${column} failed (${res.status}): ${JSON.stringify(res.data)}`);
        if (Array.isArray(res.data)) {
            res.data.forEach(row => seen.add(row[column]));
        }
    }
    return seen;
}

// ── FIND OR CREATE a company row ──
// Returns the company id. Upserts on linkedin_url.
async function findOrCreateCompany(companyData) {
    assertConfigured();
    if (!companyData.linkedin_url) {
        throw new Error('findOrCreateCompany requires a linkedin_url');
    }
    const rows = await upsert('companies',
        { ...buildCompanyPatch(companyData), linkedin_url: companyData.linkedin_url },
        'linkedin_url');

    if (rows.length > 0) return rows[0].id;

    // Fallback: fetch the id if upsert didn't return it
    const existing = await select('companies', { linkedin_url: `eq.${companyData.linkedin_url}`, select: 'id', limit: 1 });
    if (existing.length > 0) return existing[0].id;
    throw new Error(`Failed to find or create company: ${companyData.linkedin_url}`);
}

// ── isConfigured — safe check without throwing ──
function isConfigured() {
    return !!(SUPABASE_URL && SUPABASE_KEY);
}

// ── Shape a companies row (shared by both findOrCreate paths) ──
export function buildCompanyRow(companyData) {
    const now = new Date().toISOString();
    return {
        name:           companyData.name || null,
        domain:         companyData.domain || null,
        linkedin_url:   companyData.linkedin_url || null,
        website:        companyData.website || null,
        industry:       companyData.industry || null,
        employee_count: companyData.employee_count || null,
        segment:        companyData.segment || null,
        location:       companyData.location || null,
        updated_at:     now,
        last_seen_at:   now
    };
}

// ── Sparse variant for writes onto possibly-existing rows: absent fields are
// omitted (not sent as null), so a lean caller (e.g. account-signals with just
// name+domain) never wipes enrichment data written by earlier runs ──
export function buildCompanyPatch(companyData) {
    return Object.fromEntries(
        Object.entries(buildCompanyRow(companyData)).filter(([, v]) => v !== null)
    );
}

// ── FIND OR CREATE by domain (canonical key), fallback to linkedin_url ──
// Companies created by other scripts (e.g. linkedin-companies.js) are keyed on
// linkedin_url with domain NULL. Upserting straight onto 'domain' would insert
// a second row sharing that same linkedin_url and 409 on its unique constraint.
// So: look up by domain first, then by linkedin_url (reconciling that row by
// setting its domain), and only insert fresh when neither key matches.
async function findOrCreateCompanyByDomain(companyData) {
    assertConfigured();
    if (!companyData.domain) return findOrCreateCompany(companyData);

    const byDomain = await select('companies', { domain: `eq.${companyData.domain}`, select: 'id', limit: 1 });
    if (byDomain.length > 0) {
        const id = byDomain[0].id;
        await update('companies', { id: `eq.${id}` }, buildCompanyPatch(companyData));
        return id;
    }

    if (companyData.linkedin_url) {
        const byLinkedin = await select('companies', { linkedin_url: `eq.${companyData.linkedin_url}`, select: 'id', limit: 1 });
        if (byLinkedin.length > 0) {
            const id = byLinkedin[0].id;
            await update('companies', { id: `eq.${id}` }, buildCompanyPatch(companyData));
            return id;
        }
    }

    const rows = await upsert('companies', buildCompanyPatch(companyData), 'domain');
    if (rows.length > 0) return rows[0].id;
    const existing = await select('companies', { domain: `eq.${companyData.domain}`, select: 'id', limit: 1 });
    if (existing.length > 0) return existing[0].id;
    throw new Error(`Failed to find or create company by domain: ${companyData.domain}`);
}

export default { select, insert, upsert, update, exists, findOrCreateCompany, findOrCreateCompanyByDomain, isConfigured };
