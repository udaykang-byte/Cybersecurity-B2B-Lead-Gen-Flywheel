/** Exa.ai news adapter — fallback/secondary news source. */
import { fetchJson as defaultFetchJson } from './http.js';
import { makeSignal } from './signal.js';
import { classifyNewsItem, mentionsCompany } from './classify-news.js';

export const name = 'exa-news';
const EXA_URL = 'https://api.exa.ai/search';
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

export async function fetchSignals(company, config, deps = {}) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) throw new Error('EXA_API_KEY not set in .env — required for the exa-news adapter');
    const fj = deps.fetchJson || defaultFetchJson;
    const lookback = config.news?.lookbackDays ?? 180;
    const queries = (config.news?.queries || []).map(q => q.replaceAll('{company}', company.name));
    const signals = [];
    const seen = new Set();

    for (const query of queries) {
        const data = await fj(EXA_URL, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query, numResults: 10, type: 'auto',
                startPublishedDate: daysAgo(lookback),
                contents: { text: { maxCharacters: 400 } }
            })
        });
        for (const r of data.results || []) {
            const item = { title: r.title || '', snippet: r.text || '', url: r.url || null,
                           publishedAt: r.publishedDate || null };
            if (!item.url || seen.has(item.url)) continue;
            if (!mentionsCompany(`${item.title} ${item.snippet}`, company.name)) continue;
            const match = classifyNewsItem(item);
            if (!match) continue;
            seen.add(item.url);
            signals.push(makeSignal({
                company: company.name, domain: company.domain, type: match.type,
                evidence: (item.title || item.snippet).slice(0, 300),
                url: item.url, observedAt: item.publishedAt || null,
                confidence: match.confidence, source: name
            }));
        }
    }
    return signals;
}
