import test from 'node:test';
import assert from 'node:assert/strict';
import db, { buildCompanyRow } from '../scripts/lib/supabase.js';

test('buildCompanyRow shapes a domain-keyed row', () => {
    const row = buildCompanyRow({ name: 'Acme', domain: 'acme.com',
        linkedin_url: 'https://linkedin.com/company/acme', website: 'https://acme.com' });
    assert.equal(row.domain, 'acme.com');
    assert.equal(row.name, 'Acme');
    assert.ok(row.updated_at && row.last_seen_at);
});

test('findOrCreateCompanyByDomain rejects when unconfigured', async () => {
    if (db.isConfigured()) return; // skip on machines with live keys
    await assert.rejects(db.findOrCreateCompanyByDomain({ name: 'A', domain: 'a.com' }), /Supabase not configured/);
});
