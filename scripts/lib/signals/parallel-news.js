/**
 * Parallel.ai news adapter (primary news source).
 * Shells out to `parallel-cli search --json`; auth via `parallel-cli login`
 * or PARALLEL_API_KEY in the environment (.env is loaded by the orchestrator).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeSignal } from './signal.js';
import { classifyNewsItem, mentionsCompany } from './classify-news.js';

const pExecFile = promisify(execFile);
export const name = 'parallel-news';

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export function parseResults(stdout) {
    const data = JSON.parse(stdout);
    const list = Array.isArray(data) ? data : data.results || data.items || data.data || [];
    return list.map(r => ({
        title: r.title || '',
        snippet: r.excerpt || r.snippet || r.text || r.summary || '',
        url: r.url || r.link || null,
        publishedAt: r.publishedDate || r.published_date || r.date || null
    }));
}

async function runCli(args) {
    const { stdout } = await pExecFile('parallel-cli', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
}

export async function fetchSignals(company, config, deps = {}) {
    const exec = deps.exec || runCli;
    const lookback = config.news?.lookbackDays ?? 180;
    const queries = (config.news?.queries || []).map(q => q.replaceAll('{company}', company.name));
    const signals = [];
    const seen = new Set();

    for (const query of queries) {
        let stdout;
        try {
            stdout = await exec(['search', query, '--after-date', daysAgo(lookback), '--json']);
        } catch (err) {
            throw new Error(`parallel-cli failed: ${err.message}`);
        }
        for (const item of parseResults(stdout)) {
            if (!item.url || seen.has(item.url)) continue;
            if (!mentionsCompany(`${item.title} ${item.snippet}`, company.name)) continue;
            const match = classifyNewsItem(item);
            if (!match) continue;
            seen.add(item.url);
            signals.push(makeSignal({
                company: company.name, domain: company.domain,
                type: match.type,
                evidence: (item.title || item.snippet).slice(0, 300),
                url: item.url,
                observedAt: item.publishedAt || null,
                confidence: match.confidence,
                source: name
            }));
        }
    }
    return signals;
}
