import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSignals } from '../scripts/lib/signals/maine-ag-breach.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const html = fs.readFileSync(new URL('./fixtures/maine-ag-list.html', import.meta.url), 'utf8');
const cfg = loadClientConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meag-'));

test('matches org name in the AG list', async () => {
    const signals = await fetchSignals({ name: 'Acme Widgets', domain: 'acmewidgets.test' }, cfg,
        { fetchText: async () => html, cacheDir: tmp });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'breach_announced');
    assert.equal(signals[0].confidence, 0.9);
    assert.equal(signals[0].observedAt, '2026-06-20');
    assert.ok(signals[0].url.startsWith('https://www.maine.gov'));
});
