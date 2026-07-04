import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSignals, parsePortalPage } from '../scripts/lib/signals/hhs-breach.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const csv = fs.readFileSync(new URL('./fixtures/hhs-breaches.csv', import.meta.url), 'utf8');
const liveCsv = fs.readFileSync(new URL('./fixtures/hhs-breaches-live.csv', import.meta.url), 'utf8');
const portalPage = fs.readFileSync(new URL('./fixtures/hhs-portal-page.html', import.meta.url), 'utf8');
const cfg = loadClientConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hhs-'));

// minimal fetch Response stand-in for the portal flow
const fakeRes = ({ status = 200, body = '', headers = {}, setCookies = [] }) => ({
    status, ok: status >= 200 && status < 300,
    headers: {
        get: k => headers[k.toLowerCase()] ?? null,
        getSetCookie: () => setCookies
    },
    text: async () => body
});

test('matches covered entity and emits authoritative breach signal', async () => {
    const signals = await fetchSignals({ name: 'Acme Health Systems', domain: 'acmehealth.test' }, cfg,
        { fetchText: async () => csv, cacheDir: tmp });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'breach_announced');
    assert.equal(signals[0].confidence, 1.0);
    assert.equal(signals[0].observedAt, '2026-06-15');
    assert.match(signals[0].evidence, /54,?000 individuals|54000 individuals/);
});

test('parsePortalPage extracts ViewState and discovers the CSV export control', () => {
    const { viewState, csvParam } = parsePortalPage(portalPage);
    assert.equal(viewState, '6180394723393007973:-5860909394044851848');
    assert.equal(csvParam, 'ocrForm:j_idt389'); // the anchor whose img is titled "Export as CSV"
});

test('portal flow: GET page → POST export with session cookie, live header maps name to column 0', async () => {
    const calls = [];
    const fetchMock = async (url, opts = {}) => {
        calls.push({ url, opts });
        if (!opts.method) return fakeRes({ body: portalPage, setCookies: ['JSESSIONID=ABC123; Path=/ocr; Secure', 'asig_persistence=xyz; path=/'] });
        return fakeRes({ body: liveCsv, headers: { 'content-type': 'text/csv;charset=UTF-8' } });
    };
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hhs-live-'));
    const signals = await fetchSignals({ name: 'Acme Health Systems', domain: 'acmehealth.test' }, cfg,
        { fetch: fetchMock, cacheDir: freshTmp });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].observedAt, '2026-06-15');
    assert.match(signals[0].evidence, /Acme Health Systems/);
    const post = calls.find(c => c.opts.method === 'POST');
    assert.ok(post, 'expected a POST export call');
    assert.match(post.opts.headers.cookie, /JSESSIONID=ABC123/);
    assert.match(post.opts.body, /ocrForm%3Aj_idt389=|ocrForm:j_idt389=/);
    assert.match(post.opts.body, /javax\.faces\.ViewState=/);
});

test('portal flow: non-CSV export response throws (source unavailable)', async () => {
    const fetchMock = async (url, opts = {}) => !opts.method
        ? fakeRes({ body: portalPage })
        : fakeRes({ body: '<html>error</html>', headers: { 'content-type': 'text/html' } });
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hhs-err-'));
    await assert.rejects(
        fetchSignals({ name: 'Acme Health Systems', domain: null }, cfg, { fetch: fetchMock, cacheDir: freshTmp }),
        /CSV export failed/
    );
});

test('no match → empty, and second call uses the cache (no refetch)', async () => {
    let fetches = 0;
    const deps = { fetchText: async () => { fetches++; return csv; }, cacheDir: tmp };
    await fetchSignals({ name: 'Initech', domain: null }, cfg, deps);
    const none = await fetchSignals({ name: 'Initech', domain: null }, cfg, deps);
    assert.equal(none.length, 0);
    assert.equal(fetches, 0); // cache file from previous test is < 24h old
});
