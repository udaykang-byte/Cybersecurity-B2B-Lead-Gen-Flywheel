import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSignals } from '../scripts/lib/signals/sec-edgar.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const f8k = JSON.parse(fs.readFileSync(new URL('./fixtures/edgar-8k.json', import.meta.url), 'utf8'));
const fD = JSON.parse(fs.readFileSync(new URL('./fixtures/edgar-formd.json', import.meta.url), 'utf8'));
const cfg = loadClientConfig();
const acme = { name: 'Acme Corp', domain: 'acme.test' };

test('8-K Item 1.05 → breach; Form D → funding; UA header sent', async () => {
    const calls = [];
    const signals = await fetchSignals(acme, cfg, {
        fetchJson: async (url, opts) => {
            calls.push({ url, opts });
            return url.includes('forms=8-K') ? f8k : fD;
        }
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].opts.headers['User-Agent'], /martechs\.io/);
    const breach = signals.find(s => s.type === 'breach_announced');
    assert.equal(breach.observedAt, '2026-06-10');
    assert.equal(breach.confidence, 1.0);
    assert.match(breach.evidence, /8-K Item 1\.05/);
    const funding = signals.find(s => s.type === 'funding_a_only');
    assert.equal(funding.observedAt, '2026-03-22');
    assert.equal(funding.confidence, 0.8);
    // Globex hit must not leak in
    assert.ok(!signals.some(s => s.evidence.includes('Globex')));
});
