import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSignal, SIGNAL_TYPES } from '../scripts/lib/signals/signal.js';

test('makeSignal validates and normalizes', () => {
    const s = makeSignal({ company: 'Acme', type: 'breach_announced', source: 'hhs-breach',
        evidence: 'x'.repeat(600), confidence: 1.4, observedAt: '2026-06-01T10:00:00Z' });
    assert.equal(s.observedAt, '2026-06-01');
    assert.equal(s.confidence, 1);           // clamped
    assert.equal(s.evidence.length, 500);    // truncated
    assert.equal(s.domain, null);
    assert.ok(Object.isFrozen(s));
});

test('makeSignal defaults observedAt to today', () => {
    const s = makeSignal({ company: 'Acme', type: 'ma_activity', source: 'exa-news' });
    assert.equal(s.observedAt, new Date().toISOString().slice(0, 10));
});

test('makeSignal rejects bad input', () => {
    assert.throws(() => makeSignal({ type: 'breach_announced', source: 'x' }), /company/);
    assert.throws(() => makeSignal({ company: 'A', type: 'nope', source: 'x' }), /Unknown signal type/);
    assert.throws(() => makeSignal({ company: 'A', type: 'breach_announced' }), /source/);
    assert.equal(SIGNAL_TYPES.length, 13);
});
