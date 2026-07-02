import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClientConfig } from '../scripts/lib/client-config.js';

test('loads default config with playbook keys', () => {
    const cfg = loadClientConfig();
    assert.equal(cfg.client, 'default');
    assert.equal(cfg.signalDefs.breach_announced.base, 45);
    assert.equal(cfg.signalDefs.breach_announced.halfLifeDays, 30);
    assert.equal(cfg.signalStacks.length, 8);
    assert.equal(cfg.tiers[0].tier, 'CRITICAL');
    assert.ok(cfg.jd.competitorTools.includes('cyberark'));
});

test('unknown client throws', () => {
    assert.throws(() => loadClientConfig('no-such-client'), /Unknown client/);
});

test('client overrides deep-merge over defaults', () => {
    // acme fixture only overrides detectionFloor and one signal base
    const cfg = loadClientConfig('_test_acme');
    assert.equal(cfg.detectionFloor, 10);
    assert.equal(cfg.signalDefs.breach_announced.base, 40);
    assert.equal(cfg.signalDefs.breach_announced.halfLifeDays, 30); // inherited
    assert.equal(cfg.signalDefs.new_ciso_hired.base, 35);           // inherited
});
