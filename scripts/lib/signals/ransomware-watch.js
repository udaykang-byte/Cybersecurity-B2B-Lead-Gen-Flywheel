/** ransomware.live — leak-site victim claims (often precede official disclosure). */
import { fetchJson as defaultFetchJson, HttpError } from './http.js';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'ransomware-watch';
const API_URL = 'https://api.ransomware.live/v2/searchvictims/';

export async function fetchSignals(company, config, deps = {}) {
    const fj = deps.fetchJson || defaultFetchJson;
    let data;
    try {
        data = await fj(API_URL + encodeURIComponent(company.name), { timeoutMs: 20000 });
    } catch (err) {
        // Live-verified 2026-07-02: the API returns HTTP 404 with a JSON error
        // body (not 200 + empty array) when the keyword matches no victims —
        // the common case. Treat "not found" as "no signals", not a failure.
        if (err instanceof HttpError && err.status === 404) return [];
        throw err;
    }
    const victims = Array.isArray(data) ? data : data.victims || [];
    const signals = [];
    for (const v of victims) {
        const victimName = v.victim || v.post_title || '';
        const domainHit = company.domain && (v.website || v.domain || '').includes(company.domain);
        if (!mentionsCompany(victimName, company.name) && !domainHit) continue;
        const date = (v.discovered || v.published || '').slice(0, 10) || null;
        signals.push(makeSignal({
            company: company.name, domain: company.domain,
            type: 'breach_announced',
            evidence: `Ransomware leak-site claim: "${victimName}" listed by ${v.group || 'unknown group'}`,
            url: v.url || 'https://www.ransomware.live',
            observedAt: date, confidence: 0.85, source: name
        }));
    }
    return signals;
}
