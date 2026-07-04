/** Classify a news item into a canonical signal type. */
const PATTERNS = [
    { type: 'breach_announced', confidence: 0.9,
      keywords: ['breach', 'ransomware', 'cyberattack', 'data breach', 'hacked', 'leaked',
                 'exposed records', 'security incident', 'compromised'] },
    { type: 'new_ciso_hired', confidence: 0.8,
      keywords: ['named ciso', 'names ciso', 'new ciso', 'appoints', 'joins as',
                 'chief information security officer', 'vp of security', 'head of security'] },
    { type: 'funding_a_only', confidence: 0.85,
      keywords: ['series a', 'seed round'] },
    { type: 'funding_bc_soc2', confidence: 0.85,
      keywords: ['series b', 'series c', 'series d', 'raised $', 'funding round',
                 'growth equity', 'venture capital', 'ipo'] },
    { type: 'ma_activity', confidence: 0.85,
      keywords: ['acquisition', 'acquired', 'merger', 'merges with', 'private equity',
                 'pe-backed', 'buyout', 'taken private'] },
    { type: 'cloud_migration', confidence: 0.75,
      keywords: ['cloud migration', 'cloud transformation', 'moving to cloud',
                 'aws migration', 'azure migration', 'cloud-first'] },
    { type: 'soc2_and_compliance', confidence: 0.75,
      keywords: ['soc 2 audit', 'soc2 audit', 'iso 27001 certification', 'compliance audit',
                 'audit findings', 'achieves fedramp', 'hipaa audit'] }
];

export function classifyNewsItem({ title = '', snippet = '' }) {
    const text = `${title} ${snippet}`.toLowerCase();
    // Series A / seed headlines often also contain generic B/C-round keywords
    // ("raised $", "funding round"), which would otherwise outvote the single
    // Series A keyword in the generic pattern loop below. Short-circuit here
    // so a real Series A/seed round is never misclassified as funding_bc_soc2.
    if (/\bseries a\b|\bseed round\b/.test(text) && !/\bseries [b-d]\b/.test(text)) {
        return { type: 'funding_a_only', confidence: 0.85 };
    }
    let bestMatch = null;
    for (const p of PATTERNS) {
        const matches = p.keywords.filter(kw => text.includes(kw)).length;
        if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
            bestMatch = { type: p.type, confidence: p.confidence, matches };
        }
    }
    return bestMatch ? { type: bestMatch.type, confidence: bestMatch.confidence } : null;
}

export function mentionsCompany(text, companyName) {
    const t = (text || '').toLowerCase();
    const n = (companyName || '').toLowerCase().trim();
    if (!n) return false;
    if (t.includes(n)) return true;
    const words = n.split(/\s+/).filter(w => w.length > 3);
    return words.length > 0 && words.every(w => t.includes(w));
}
