import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromJD } from '../scripts/lib/jd-extract.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const cfg = loadClientConfig();

test('extracts tools, frameworks, pain from JD text', () => {
    const r = extractFromJD('Manage CyberArk and Okta. Drive SOC 2 and ISO 27001. Clean up orphaned accounts.', cfg);
    assert.deepEqual(r.tools.sort(), ['cyberark', 'okta']);
    assert.ok(r.frameworks.includes('soc 2') && r.frameworks.includes('iso 27001'));
    assert.deepEqual(r.painLanguage, ['orphaned accounts']);
});

test('empty text → empty lists', () => {
    assert.deepEqual(extractFromJD('', cfg), { tools: [], frameworks: [], painLanguage: [] });
});
