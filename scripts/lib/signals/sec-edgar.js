/** SEC EDGAR full-text search — 8-K Item 1.05 cyber incidents + Form D funding. */
import { fetchJson as defaultFetchJson } from './http.js';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'sec-edgar';
const FTS_URL = 'https://efts.sec.gov/LATEST/search-index';
const UA_HEADERS = { 'User-Agent': 'martechs.io signal-engine uday.kang@martechs.io' };

function searchUiUrl(q, forms) {
    return `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(q)}&forms=${forms}`;
}

async function fts(fj, q, forms) {
    const url = `${FTS_URL}?q=${encodeURIComponent(q)}&forms=${forms}`;
    const data = await fj(url, { headers: UA_HEADERS, timeoutMs: 20000 });
    return data?.hits?.hits || [];
}

export async function fetchSignals(company, config, deps = {}) {
    const fj = deps.fetchJson || defaultFetchJson;
    const signals = [];

    // 8-K Item 1.05 — material cybersecurity incident disclosures
    for (const hit of await fts(fj, `"${company.name}" "Item 1.05"`, '8-K')) {
        const src = hit._source || {};
        const names = src.display_names || [];
        if (!names.some(n => mentionsCompany(n, company.name))) continue;
        signals.push(makeSignal({
            company: company.name, domain: company.domain,
            type: 'breach_announced',
            evidence: `SEC 8-K Item 1.05 (material cyber incident) filed ${src.file_date} by ${names[0]}`,
            url: searchUiUrl(`"${company.name}" "Item 1.05"`, '8-K'),
            observedAt: src.file_date || null, confidence: 1.0, source: name
        }));
    }

    // Form D — exempt offering (funding); series unknown from the form
    for (const hit of await fts(fj, `"${company.name}"`, 'D')) {
        const src = hit._source || {};
        const names = src.display_names || [];
        if (!names.some(n => mentionsCompany(n, company.name))) continue;
        signals.push(makeSignal({
            company: company.name, domain: company.domain,
            type: 'funding_a_only',
            evidence: `SEC Form D (exempt offering) filed ${src.file_date} by ${names[0]}`,
            url: searchUiUrl(`"${company.name}"`, 'D'),
            observedAt: src.file_date || null, confidence: 0.8, source: name
        }));
    }
    return signals;
}
