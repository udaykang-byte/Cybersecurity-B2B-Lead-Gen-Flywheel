import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findDecisionMakers } from '../scripts/lib/people-finder.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const fixture = fs.readFileSync(new URL('./fixtures/parallel-people.json', import.meta.url), 'utf8');
const cfg = loadClientConfig();

test('extracts people with cleaned names/titles, filters company pages, strips URL params', async () => {
    const people = await findDecisionMakers({ name: 'Acme Corp', domain: 'acme.com' }, cfg,
        { exec: async () => fixture });
    assert.equal(people.length, 2);
    assert.equal(people[0].name, 'Jane Doe');
    assert.equal(people[0].title, 'Chief Information Security Officer');
    assert.equal(people[0].profileUrl, 'https://www.linkedin.com/in/janedoe');
    assert.equal(people[0].source, 'parallel-people');
});

test('caps at config.people.max', async () => {
    const many = JSON.stringify({ results: Array.from({ length: 10 }, (_, i) => ({
        title: `P${i} - CISO - Acme | LinkedIn`, url: `https://linkedin.com/in/p${i}`, excerpt: '' })) });
    const people = await findDecisionMakers({ name: 'Acme', domain: null }, cfg, { exec: async () => many });
    assert.equal(people.length, cfg.people.max);
});
