/** Normalized signal event — the unit every adapter emits. */
export const SIGNAL_TYPES = [
    'breach_announced', 'hiring_ciso_and_iam', 'soc2_and_compliance',
    'cyber_insurance_funding', 'new_ciso_hired', 'funding_bc_soc2',
    'competitor_in_jd', 'cloud_migration', 'ma_activity',
    'hiring_security_grc', 'social_pain_post', 'funding_a_only',
    'content_consumption'
];

export function makeSignal({ company, domain = null, type, evidence = '', url = null,
                             observedAt = null, confidence = 1.0, source }) {
    if (!company) throw new Error('Signal requires company');
    if (!SIGNAL_TYPES.includes(type)) throw new Error(`Unknown signal type: ${type}`);
    if (!source) throw new Error('Signal requires source');
    const date = observedAt ? new Date(observedAt) : new Date();
    if (isNaN(date.getTime())) throw new Error(`Invalid observedAt: ${observedAt}`);
    return Object.freeze({
        company, domain, type,
        evidence: String(evidence).slice(0, 500),
        url,
        observedAt: date.toISOString().slice(0, 10),
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        source
    });
}
