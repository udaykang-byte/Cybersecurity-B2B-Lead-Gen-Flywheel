import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSignals } from '../scripts/lib/signals/ransomware-watch.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';
import { HttpError } from '../scripts/lib/signals/http.js';

const victims = JSON.parse(fs.readFileSync(new URL('./fixtures/ransomware-victims.json', import.meta.url), 'utf8'));
const cfg = loadClientConfig();

test('leak-site claim → breach_announced at 0.85', async () => {
    const signals = await fetchSignals({ name: 'Acme Corp', domain: 'acme.test' }, cfg,
        { fetchJson: async () => victims });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'breach_announced');
    assert.equal(signals[0].confidence, 0.85);
    assert.equal(signals[0].observedAt, '2026-06-25');
    assert.match(signals[0].evidence, /lockbit4/);
});

test('non-matching victims are ignored', async () => {
    const signals = await fetchSignals({ name: 'Initech', domain: null }, cfg,
        { fetchJson: async () => victims });
    assert.equal(signals.length, 0);
});

// Live-verified 2026-07-02: api.ransomware.live returns HTTP 404 with a JSON
// error body (not 200 + empty array/`{victims:[]}`) when a keyword matches no
// victims — which is the common case for most companies queried. fetchJson
// (scripts/lib/signals/http.js) throws HttpError for any >=400 status, so the
// adapter must swallow a 404 specifically and treat it as "no signals" rather
// than letting the exception propagate and abort the pipeline.
test('404 "no victims found" response → empty signals, not a thrown error', async () => {
    const signals = await fetchSignals({ name: 'Nobody Corp', domain: null }, cfg, {
        fetchJson: async (url) => {
            throw new HttpError(404, url, '{"error": "No victims found for keyword \'nobody corp\'."}');
        }
    });
    assert.deepEqual(signals, []);
});
