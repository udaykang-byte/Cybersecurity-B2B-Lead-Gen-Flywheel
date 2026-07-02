/** Greenhouse/Lever/Ashby public job-board APIs — free structured job signals. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson as defaultFetchJson } from './http.js';
import { makeSignal } from './signal.js';
import { extractFromJD } from '../jd-extract.js';

export const name = 'job-boards';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = path.join(__dirname, '..', '..', '..', 'data', '.cache', 'job-boards-seen.json');
const SECURITY_TITLE = /security|\biam\b|identity|privileged|\bpam\b|grc|compliance|ciso|infosec/i;
const CISO_TITLE = /ciso|chief information security/i;
const IAM_TITLE = /\biam\b|identity|privileged|\bpam\b/i;
const NON_SECURITY_TITLE = /\b(brand|design|designer|visual|creative|graphic|copywriter|marketing)\b/i;

const defaultSeenStore = {
    load() {
        try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('job-boards: seen-store unreadable, resetting first-seen history: ' + SEEN_FILE);
            }
            return {};
        }
    },
    save(data) {
        fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
        fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2));
    }
};

function stripHtml(s) {
    return (s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

export function slugCandidates(company) {
    const out = new Set();
    if (company.domain) out.add(company.domain.split('.')[0].toLowerCase());
    const rawName = (company.name || '').toLowerCase().trim();
    if (rawName) out.add(rawName.replace(/[^a-z0-9]/g, ''));
    const n = rawName.replace(/,?\s+(inc|llc|ltd|corp|corporation|co)\.?$/i, '').trim();
    if (n) { out.add(n.replace(/[^a-z0-9]/g, '')); out.add(n.replace(/\s+/g, '-')); }
    const liSlug = (company.linkedinUrl || '').match(/\/company\/([^/?]+)/)?.[1];
    if (liSlug) out.add(liSlug.toLowerCase());
    return [...out].filter(Boolean);
}

async function probeGreenhouse(slug, fj) {
    try {
        const d = await fj(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
        if (!d?.jobs?.length) return null;
        return d.jobs.map(j => ({ id: `gh:${j.id}`, title: j.title, text: stripHtml(j.content),
            url: j.absolute_url, postedAt: (j.updated_at || '').slice(0, 10) || null }));
    } catch { return null; }
}

async function probeLever(slug, fj) {
    try {
        const d = await fj(`https://api.lever.co/v0/postings/${slug}?mode=json`);
        if (!Array.isArray(d) || !d.length) return null;
        return d.map(j => ({ id: `lv:${j.id}`, title: j.text, text: j.descriptionPlain || stripHtml(j.description),
            url: j.hostedUrl, postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null }));
    } catch { return null; }
}

async function probeAshby(slug, fj) {
    try {
        const d = await fj(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`);
        if (!d?.jobs?.length) return null;
        return d.jobs.map(j => ({ id: `ab:${j.id}`, title: j.title,
            text: j.descriptionPlain || stripHtml(j.descriptionHtml), url: j.jobUrl || j.applyUrl,
            postedAt: (j.publishedAt || '').slice(0, 10) || null }));
    } catch { return null; }
}

export async function fetchSignals(company, config, deps = {}) {
    const fj = deps.fetchJson || defaultFetchJson;
    const seenStore = deps.seenStore || defaultSeenStore;

    let postings = null;
    outer: for (const slug of slugCandidates(company)) {
        for (const probe of [probeGreenhouse, probeLever, probeAshby]) {
            postings = await probe(slug, fj);
            if (postings) break outer;
        }
    }
    if (!postings) return [];

    const secPostings = postings.filter(p => SECURITY_TITLE.test(p.title || '') && !NON_SECURITY_TITLE.test(p.title || ''));
    if (!secPostings.length) return [];

    // First-seen dates → new postings become dated signal events
    const seen = seenStore.load();
    const key = company.domain || company.name;
    const firstSeen = seen[key] || {};
    const today = new Date().toISOString().slice(0, 10);
    for (const p of secPostings) if (!firstSeen[p.id]) firstSeen[p.id] = p.postedAt || today;
    seen[key] = firstSeen;
    seenStore.save(seen);

    const base = { company: company.name, domain: company.domain, source: name };
    const signals = [];
    for (const p of secPostings) {
        const observedAt = firstSeen[p.id];
        const { tools, frameworks } = extractFromJD(`${p.title} ${p.text}`, config);
        signals.push(makeSignal({ ...base, type: 'hiring_security_grc', url: p.url, observedAt,
            confidence: 0.95,
            evidence: `Job posting: ${p.title}${frameworks.length ? ` [${frameworks.join(', ')}]` : ''}` }));
        if (tools.length) {
            signals.push(makeSignal({ ...base, type: 'competitor_in_jd', url: p.url, observedAt,
                confidence: 0.95, evidence: `"${p.title}" JD mentions ${tools.join(', ')}` }));
        }
        if (frameworks.some(f => f.startsWith('soc'))) {
            signals.push(makeSignal({ ...base, type: 'soc2_and_compliance', url: p.url, observedAt,
                confidence: 0.85, evidence: `SOC 2 named in "${p.title}" JD` }));
        }
    }
    if (secPostings.some(p => CISO_TITLE.test(p.title)) && secPostings.some(p => IAM_TITLE.test(p.title))) {
        signals.push(makeSignal({ ...base, type: 'hiring_ciso_and_iam', url: null, observedAt: today,
            confidence: 0.95,
            evidence: `CISO + IAM postings live simultaneously (${secPostings.length} security postings)` }));
    }
    return signals;
}
