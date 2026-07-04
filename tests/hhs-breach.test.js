import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSignals } from '../scripts/lib/signals/hhs-breach.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const csv = fs.readFileSync(new URL('./fixtures/hhs-breaches.csv', import.meta.url), 'utf8');
const cfg = loadClientConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hhs-'));

test('matches covered entity and emits authoritative breach signal', async () => {
    const signals = await fetchSignals({ name: 'Acme Health Systems', domain: 'acmehealth.test' }, cfg,
        { fetchText: async () => csv, cacheDir: tmp });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'breach_announced');
    assert.equal(signals[0].confidence, 1.0);
    assert.equal(signals[0].observedAt, '2026-06-15');
    assert.match(signals[0].evidence, /54,?000 individuals|54000 individuals/);
});

test('no match → empty, and second call uses the cache (no refetch)', async () => {
    let fetches = 0;
    const deps = { fetchText: async () => { fetches++; return csv; }, cacheDir: tmp };
    await fetchSignals({ name: 'Initech', domain: null }, cfg, deps);
    const none = await fetchSignals({ name: 'Initech', domain: null }, cfg, deps);
    assert.equal(none.length, 0);
    assert.equal(fetches, 0); // cache file from previous test is < 24h old
});
