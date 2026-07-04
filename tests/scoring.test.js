import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAccount, effectivePoints, getTier } from '../scripts/lib/scoring.js';
import { makeSignal } from '../scripts/lib/signals/signal.js';
import { loadClientConfig } from '../scripts/lib/client-config.js';

const cfg = loadClientConfig();
const NOW = new Date('2026-07-01T00:00:00Z');
const d = daysAgo => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10);
const sig = (type, daysOld, confidence = 1.0) => makeSignal({
    company: 'Acme', type, source: 'test', confidence, observedAt: d(daysOld), url: `https://x.test/${type}/${daysOld}`
});

test('fresh breach scores full base and CRITICAL', () => {
    const r = scoreAccount([sig('breach_announced', 0)], cfg, NOW);
    assert.equal(r.score, 45);
    assert.equal(r.tier, 'CRITICAL');
    assert.equal(r.isStack, false);
});

test('60-day-old breach decays below LOW threshold (45 × 0.25 ≈ 11)', () => {
    const r = scoreAccount([sig('breach_announced', 60)], cfg, NOW);
    assert.equal(r.score, 11);
    assert.equal(r.tier, 'SKIP'); // 11 < 15
});

test('stale social post falls below detection floor', () => {
    // half-life 21d: 22 × 0.5^(90/21) ≈ 1.1 < floor 8 → not detected
    const r = scoreAccount([sig('social_pain_post', 90)], cfg, NOW);
    assert.equal(r.detected.length, 0);
    assert.equal(r.score, 0);
});

test('fresh stack beats the sum', () => {
    const r = scoreAccount([sig('new_ciso_hired', 5), sig('competitor_in_jd', 3)], cfg, NOW);
    assert.equal(r.isStack, true);
    assert.equal(r.stackLabel, 'New CISO hired + CyberArk/SailPoint job posting');
    // weakest member: ciso decay 0.5^(5/90)=0.9622 → round(47×0.9622)=45
    assert.equal(r.score, 45);
    assert.equal(r.tier, 'CRITICAL');
});

test('confidence multiplies and low-confidence rows are flagged', () => {
    const r = scoreAccount([sig('breach_announced', 0, 0.5)], cfg, NOW);
    assert.equal(r.score, 23); // 45 × 0.5 = 22.5 → 23
    assert.equal(r.flagged.length, 1);
    assert.equal(r.flagged[0].type, 'breach_announced');
});

test('duplicate types keep the strongest only, capped at 50', () => {
    const r = scoreAccount([
        sig('breach_announced', 0), sig('breach_announced', 40),
        sig('hiring_security_grc', 0), sig('soc2_and_compliance', 0)
    ], cfg, NOW);
    assert.equal(r.breakdown.filter(b => b.type === 'breach_announced').length, 1);
    assert.equal(r.score, 50); // 45+25+40=110 → cap 50
});

test('extra unrelated signal does not disable a stack', () => {
    const r = scoreAccount([sig('new_ciso_hired', 5), sig('competitor_in_jd', 3), sig('cloud_migration', 0)], cfg, NOW);
    assert.equal(r.isStack, true);
    assert.equal(r.stackLabel, 'New CISO hired + CyberArk/SailPoint job posting');
    // stack 47 × 0.9549 = 44.88 + residual 28 (fresh cloud_migration) = 72.88 → cap 50
    assert.equal(r.score, 50);
});

test('calibrated stack value governs even when naive sum is higher', () => {
    const r = scoreAccount([sig('hiring_security_grc', 0), sig('social_pain_post', 0)], cfg, NOW);
    // naive sum 25+22=47, but the Playbook calibrates this pair at 38
    assert.equal(r.isStack, true);
    assert.equal(r.score, 38);
    assert.equal(r.stackLabel, 'Hiring access management + LinkedIn pain post');
});

test('getTier boundaries', () => {
    assert.equal(getTier(35, cfg.tiers).tier, 'CRITICAL');
    assert.equal(getTier(34, cfg.tiers).tier, 'HIGH');
    assert.equal(getTier(14, cfg.tiers).tier, 'SKIP');
});
