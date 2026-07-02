import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSignals, slugCandidates } from '../scripts/lib/signals/job-boards.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const gh = JSON.parse(fs.readFileSync(new URL('./fixtures/greenhouse-jobs.json', import.meta.url), 'utf8'));
const cfg = loadClientConfig();
const acme = { name: 'Acme Corp', domain: 'acme.com', linkedinUrl: 'https://linkedin.com/company/acme-corp' };

function memStore(initial = {}) {
    let data = initial;
    return { load: () => data, save: d => { data = d; }, peek: () => data };
}

test('slugCandidates covers domain, name, linkedin slug', () => {
    const slugs = slugCandidates(acme);
    assert.ok(slugs.includes('acme'));        // from domain
    assert.ok(slugs.includes('acmecorp'));    // from name
    assert.ok(slugs.includes('acme-corp'));   // from linkedin
});

test('greenhouse postings → signals with delta dates; non-security filtered', async () => {
    const store = memStore();
    const fj = async url => {
        if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) return gh;
        throw new Error('404');
    };
    const signals = await fetchSignals(acme, cfg, { fetchJson: fj, seenStore: store });
    const types = new Set(signals.map(s => s.type));
    assert.ok(types.has('hiring_security_grc'));
    assert.ok(types.has('competitor_in_jd'));      // CyberArk in JD 111
    assert.ok(types.has('soc2_and_compliance'));   // SOC 2 in JD 111
    assert.ok(types.has('hiring_ciso_and_iam'));   // CISO (222) + IAM (111) live together
    assert.ok(!signals.some(s => (s.url || '').includes('/333'))); // Backend Engineer filtered
    // first-seen recorded with posting dates
    assert.equal(store.peek()['acme.com']['gh:111'], '2026-06-20');
});

test('no board found → empty array, no throw', async () => {
    const signals = await fetchSignals(acme, cfg, {
        fetchJson: async () => { throw new Error('404'); }, seenStore: memStore()
    });
    assert.deepEqual(signals, []);
});

test('"Brand Designer, Identity" is not a security posting (no false-positive signals)', async () => {
    const fixture = { jobs: [
        { id: 501, title: 'Brand Designer, Identity',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/501',
          updated_at: '2026-06-20T12:00:00-04:00',
          content: 'Own our brand identity system and visual design language.' }
    ] };
    const fj = async url => {
        if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) return fixture;
        throw new Error('404');
    };
    const signals = await fetchSignals(acme, cfg, { fetchJson: fj, seenStore: memStore() });
    assert.deepEqual(signals, []);
});

test('"Director of Identity and Access Management" is treated as a security posting', async () => {
    const fixture = { jobs: [
        { id: 502, title: 'Director of Identity and Access Management',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/502',
          updated_at: '2026-06-20T12:00:00-04:00',
          content: 'Lead our IAM program across the enterprise.' }
    ] };
    const fj = async url => {
        if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) return fixture;
        throw new Error('404');
    };
    const signals = await fetchSignals(acme, cfg, { fetchJson: fj, seenStore: memStore() });
    assert.ok(signals.some(s => s.type === 'hiring_security_grc'));
});
