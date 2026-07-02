import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSignals } from '../scripts/lib/signals/exa-news.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/exa-search.json', import.meta.url), 'utf8'));
const cfg = loadClientConfig();
const okta = { name: 'Okta', domain: 'okta.com' };

test('maps Exa results to signals with API key and POST body', async () => {
    process.env.EXA_API_KEY = 'test-key';
    const calls = [];
    const signals = await fetchSignals(okta, cfg, {
        fetchJson: async (url, opts) => { calls.push({ url, opts }); return fixture; }
    });
    assert.equal(calls.length, cfg.news.queries.length);
    assert.equal(calls[0].url, 'https://api.exa.ai/search');
    assert.equal(calls[0].opts.headers['x-api-key'], 'test-key');
    assert.ok(JSON.parse(calls[0].opts.body).startPublishedDate);
    const breach = signals.find(s => s.type === 'breach_announced');
    assert.equal(breach.observedAt, '2026-04-20');
    assert.equal(breach.source, 'exa-news');
});

test('throws clearly without EXA_API_KEY', async () => {
    delete process.env.EXA_API_KEY;
    await assert.rejects(fetchSignals(okta, cfg, {}), /EXA_API_KEY/);
});
