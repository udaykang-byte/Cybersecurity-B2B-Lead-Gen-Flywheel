import test from 'node:test';
import assert from 'node:assert/strict';
import db, { buildCompanyRow, buildCompanyPatch } from '../scripts/lib/supabase.js';

test('buildCompanyRow shapes a domain-keyed row', () => {
    const row = buildCompanyRow({ name: 'Acme', domain: 'acme.com',
        linkedin_url: 'https://linkedin.com/company/acme', website: 'https://acme.com' });
    assert.equal(row.domain, 'acme.com');
    assert.equal(row.name, 'Acme');
    assert.ok(row.updated_at && row.last_seen_at);
});

test('buildCompanyPatch omits unknown fields so writes never null out existing data', () => {
    const patch = buildCompanyPatch({ name: 'Acme', domain: 'acme.com' });
    assert.equal(patch.domain, 'acme.com');
    assert.ok(!('linkedin_url' in patch), 'absent linkedin_url must not be sent as null');
    assert.ok(!('industry' in patch), 'absent industry must not be sent as null');
    assert.ok(patch.updated_at && patch.last_seen_at);
});

test('findOrCreateCompanyByDomain rejects when unconfigured', async () => {
    if (db.isConfigured()) return; // skip on machines with live keys
    await assert.rejects(db.findOrCreateCompanyByDomain({ name: 'A', domain: 'a.com' }), /Supabase not configured/);
});
