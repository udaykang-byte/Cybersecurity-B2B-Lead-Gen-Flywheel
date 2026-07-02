import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNewsItem, mentionsCompany } from '../scripts/lib/signals/classify-news.js';

test('classifies breach, funding, ciso, m&a', () => {
    assert.equal(classifyNewsItem({ title: 'Acme hit by ransomware attack' }).type, 'breach_announced');
    assert.equal(classifyNewsItem({ title: 'Acme raised $40M Series B funding round' }).type, 'funding_bc_soc2');
    assert.equal(classifyNewsItem({ title: 'Acme closes Series A' }).type, 'funding_a_only');
    assert.equal(classifyNewsItem({ title: 'Acme names new CISO', snippet: 'joins as chief information security officer' }).type, 'new_ciso_hired');
    assert.equal(classifyNewsItem({ title: 'Acme acquired by PE firm in buyout' }).type, 'ma_activity');
    assert.equal(classifyNewsItem({ title: 'Acme launches new coffee line' }), null);
});

test('mentionsCompany requires the significant words', () => {
    assert.ok(mentionsCompany('Acme Widgets discloses breach', 'Acme Widgets'));
    assert.ok(mentionsCompany('breach at acme widgets inc', 'Acme Widgets'));
    assert.ok(!mentionsCompany('Globex discloses breach', 'Acme Widgets'));
});
