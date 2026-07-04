// Live CLI output shape verified 2026-07-04 (see fixtures/parallel-search-live.json)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSignals, parseResults } from '../scripts/lib/signals/parallel-news.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const fixture = fs.readFileSync(new URL('./fixtures/parallel-search.json', import.meta.url), 'utf8');
const liveFixture = fs.readFileSync(new URL('./fixtures/parallel-search-live.json', import.meta.url), 'utf8');
const cfg = loadClientConfig();
const okta = { name: 'Okta', domain: 'okta.com', linkedinUrl: 'https://linkedin.com/company/okta' };

test('classifies fixture items into signals, skipping non-mentions', async () => {
    const calls = [];
    const signals = await fetchSignals(okta, cfg, { exec: async args => { calls.push(args); return fixture; } });
    assert.equal(calls.length, cfg.news.queries.length);      // one CLI call per query
    assert.ok(calls[0].includes('search') && calls[0].includes('--json'));
    const types = signals.map(s => s.type).sort();
    assert.deepEqual([...new Set(types)].sort(), ['breach_announced', 'new_ciso_hired']);
    const breach = signals.find(s => s.type === 'breach_announced');
    assert.equal(breach.observedAt, '2026-05-14');
    assert.equal(breach.source, 'parallel-news');
    assert.ok(!signals.some(s => s.url.includes('globex'))); // Globex item filtered by mentionsCompany
});

test('parses live CLI shape: excerpts[] and publish_date', async () => {
    const rows = parseResults(liveFixture);
    assert.equal(rows[0].publishedAt, '2026-05-14');           // live field is publish_date
    assert.match(rows[0].snippet, /support case management/);  // live field is excerpts[]
    assert.match(rows[0].snippet, /notifying affected/);       // all excerpts joined

    const signals = await fetchSignals(okta, cfg, { exec: async () => liveFixture });
    const breach = signals.find(s => s.type === 'breach_announced');
    assert.equal(breach.observedAt, '2026-05-14');             // must NOT default to today
    assert.ok(!signals.some(s => s.url.includes('globex')));
});

test('parseResults absorbs alternate shapes', () => {
    assert.equal(parseResults('[{"title":"t","link":"https://x.test"}]')[0].url, 'https://x.test');
    assert.equal(parseResults('{"items":[{"title":"t","url":"https://y.test","text":"s"}]}')[0].snippet, 's');
});

test('CLI failure propagates as error', async () => {
    await assert.rejects(
        fetchSignals(okta, cfg, { exec: async () => { throw new Error('exit 3'); } }),
        /parallel-cli failed/
    );
});
