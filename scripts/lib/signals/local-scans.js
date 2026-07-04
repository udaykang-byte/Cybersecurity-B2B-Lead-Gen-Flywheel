/** Local-scans adapter — mines existing LinkedIn jobs/feed scan output for company signals. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'local-scans';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const SECURITY_TYPES = /^hiring-(ciso|iam|pam|grc|security)/;

function* scanFiles(dataDir, pattern) {
    if (!fs.existsSync(dataDir)) return;
    for (const topic of fs.readdirSync(dataDir)) {
        const liDir = path.join(dataDir, topic, 'LinkedIn');
        if (!fs.existsSync(liDir) || !fs.statSync(liDir).isDirectory()) continue;
        for (const file of fs.readdirSync(liDir)) {
            if (!pattern.test(file)) continue;
            const full = path.join(liDir, file);
            try {
                yield { data: JSON.parse(fs.readFileSync(full, 'utf8')),
                        mtime: fs.statSync(full).mtime.toISOString().slice(0, 10) };
            } catch { /* skip corrupt file */ }
        }
    }
}

export async function fetchSignals(company, config, deps = {}) {
    const dataDir = deps.dataDir || DEFAULT_DATA_DIR;
    const signals = [];
    const base = { company: company.name, domain: company.domain, source: name };

    for (const { data, mtime } of scanFiles(dataDir, /^jobs-.*\.json$/)) {
        for (const s of data.signals || []) {
            if (!mentionsCompany(s.company || '', company.name)) continue;
            const observedAt = s.detectedAt || s.postedAt || mtime;
            if (SECURITY_TYPES.test(s.type || '')) {
                signals.push(makeSignal({ ...base, type: 'hiring_security_grc', url: s.url || null,
                    observedAt, confidence: 0.9,
                    evidence: `LinkedIn job scan: ${s.title} (${s.type})` }));
            }
            if ((s.currentTools || []).length) {
                signals.push(makeSignal({ ...base, type: 'competitor_in_jd', url: s.url || null,
                    observedAt, confidence: 0.9,
                    evidence: `LinkedIn JD "${s.title}" mentions ${s.currentTools.join(', ')}` }));
            }
        }
    }

    for (const { data, mtime } of scanFiles(dataDir, /^feed-.*\.json$/)) {
        for (const p of data.posts || data.signals || []) {
            const text = p.postText || p.text || '';
            if (!mentionsCompany(text, company.name)) continue;
            signals.push(makeSignal({ ...base, type: 'social_pain_post', url: p.url || null,
                observedAt: p.postedAt || mtime, confidence: 0.75,
                evidence: `LinkedIn post by ${p.authorName || 'unknown'}: ${text.slice(0, 160)}` }));
        }
    }
    return signals;
}
