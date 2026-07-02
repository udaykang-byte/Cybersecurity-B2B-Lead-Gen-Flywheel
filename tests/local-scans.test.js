import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSignals } from '../scripts/lib/signals/local-scans.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const cfg = loadClientConfig();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localscan-'));
const liDir = path.join(dataDir, 'IdentityManagement', 'LinkedIn');
fs.mkdirSync(liDir, { recursive: true });

fs.writeFileSync(path.join(liDir, 'jobs-2026-06-20T10-00.json'), JSON.stringify({
    signals: [
        { company: 'Acme Corp', companyUrl: 'https://linkedin.com/company/acme-corp',
          type: 'hiring-iam-engineer', title: 'IAM Engineer', url: 'https://linkedin.com/jobs/1',
          currentTools: ['cyberark'], frameworks: ['soc 2'], painLanguage: [],
          detectedAt: '2026-06-19' },
        { company: 'Globex', companyUrl: 'https://linkedin.com/company/globex',
          type: 'hiring-other', title: 'Chef', url: 'https://linkedin.com/jobs/2',
          currentTools: [], frameworks: [], painLanguage: [], detectedAt: '2026-06-19' }
    ]
}));
fs.writeFileSync(path.join(liDir, 'feed-2026-06-21T10-00.json'), JSON.stringify({
    posts: [
        { authorName: 'Jane', url: 'https://linkedin.com/posts/1',
          postText: 'Our access reviews at Acme Corp are a nightmare of spreadsheets',
          postedAt: '2026-06-18' }
    ]
}));

test('extracts job + feed signals for the matching company only', async () => {
    const signals = await fetchSignals({ name: 'Acme Corp', domain: 'acme.com' }, cfg, { dataDir });
    const types = new Set(signals.map(s => s.type));
    assert.ok(types.has('hiring_security_grc'));
    assert.ok(types.has('competitor_in_jd'));
    assert.ok(types.has('social_pain_post'));
    assert.ok(signals.every(s => s.source === 'local-scans'));
    const job = signals.find(s => s.type === 'hiring_security_grc');
    assert.equal(job.observedAt, '2026-06-19');
    assert.ok(!signals.some(s => s.evidence.includes('Chef')));
});

test('missing data dir → empty array', async () => {
    const signals = await fetchSignals({ name: 'Acme Corp', domain: null }, cfg,
        { dataDir: path.join(dataDir, 'nope') });
    assert.deepEqual(signals, []);
});
