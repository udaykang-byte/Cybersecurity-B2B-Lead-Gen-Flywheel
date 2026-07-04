import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAdapters, processAccount, parseAccountsCSV } from '../scripts/account-signals.js';
import { makeSignal } from '../scripts/lib/signals/signal.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const cfg = loadClientConfig();
const acme = { name: 'Acme Corp', domain: 'acme.com', linkedinUrl: 'https://linkedin.com/company/acme-corp' };

const okAdapter = {
    name: 'fake-ok',
    fetchSignals: async c => [makeSignal({ company: c.name, type: 'breach_announced',
        source: 'fake-ok', url: 'https://x.test/b', confidence: 1.0 })]
};
const failAdapter = { name: 'fake-fail', fetchSignals: async () => { throw new Error('HTTP 503'); } };

// Anchor "now" to today's UTC midnight so it lines up with makeSignal's default
// observedAt (today, truncated to a date-only string and re-parsed as UTC
// midnight) — otherwise the elapsed wall-clock time since midnight UTC decays
// the "fresh" signal by a few percent and the exact-score assertion flakes
// depending on what time of day the suite runs (see tests/scoring.test.js,
// which pins NOW for the same reason).
const TODAY_UTC_MIDNIGHT = new Date(new Date().toISOString().slice(0, 10));

test('processAccount isolates adapter failures and still scores', async () => {
    const { signals, adapterStatus, result } = await processAccount(acme, cfg, [okAdapter, failAdapter], { now: TODAY_UTC_MIDNIGHT });
    assert.equal(signals.length, 1);
    assert.equal(adapterStatus['fake-ok'].ok, 1);
    assert.match(adapterStatus['fake-fail'].error, /503/);
    assert.equal(result.score, 45);
    assert.equal(result.tier, 'CRITICAL');
});

test('duplicate signals across adapters dedupe on type+url', async () => {
    const twin = { name: 'fake-twin', fetchSignals: okAdapter.fetchSignals };
    const { signals } = await processAccount(acme, cfg, [okAdapter, twin], {});
    assert.equal(signals.length, 1);
});

test('buildAdapters honors news provider and enrich flag', () => {
    const both = buildAdapters({ ...cfg, news: { ...cfg.news, provider: 'both' } }, { enrich: true });
    const names = both.map(a => a.name);
    assert.ok(names.includes('parallel-news') && names.includes('exa-news'));
    assert.ok(names.includes('sec-edgar') && names.includes('job-boards') && names.includes('local-scans'));
    const lean = buildAdapters(cfg, { enrich: false });
    assert.deepEqual(lean.map(a => a.name), ['local-scans']);
});

test('competitor companies are disqualified before adapters run', async () => {
    const r = await processAccount({ name: 'CyberArk', domain: 'cyberark.com',
        linkedinUrl: 'https://linkedin.com/company/cyberark' }, cfg, [okAdapter], {});
    assert.equal(r.disqualified, 'cyberark');
    assert.equal(r.signals.length, 0);
});

test('a non-array adapter result is guarded, other adapters still score', async () => {
    const undefinedAdapter = { name: 'fake-undefined', fetchSignals: async () => undefined };
    const { adapterStatus, result } = await processAccount(acme, cfg, [okAdapter, undefinedAdapter], { now: TODAY_UTC_MIDNIGHT });
    assert.deepEqual(adapterStatus['fake-undefined'], { error: 'adapter returned non-array result' });
    assert.equal(adapterStatus['fake-ok'].ok, 1);
    assert.equal(result.score, 45);
});

function writeTmpCsv(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-signals-csv-'));
    const file = path.join(dir, 'accounts.csv');
    fs.writeFileSync(file, contents);
    return file;
}

test('parseAccountsCSV handles a domain-only CSV (no linkedin_url column)', () => {
    const file = writeTmpCsv('company_name,domain\nAcme,acme.com\n');
    const accounts = parseAccountsCSV(file);
    assert.deepEqual(accounts, [{ name: 'Acme', linkedinUrl: null, domain: 'acme.com' }]);
});

test('parseAccountsCSV returns [] for an empty/whitespace-only file', () => {
    const file = writeTmpCsv('   \n\n  ');
    assert.deepEqual(parseAccountsCSV(file), []);
});
