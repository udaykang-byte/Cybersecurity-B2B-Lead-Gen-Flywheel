/**
 * Playbook scoring engine — decay + confidence + signal stacks.
 * Pure functions; all client-specific numbers come from config (Task 1).
 */
export function effectivePoints(signal, def, now = new Date()) {
    const ageDays = Math.max(0, (now - new Date(signal.observedAt)) / 86400000);
    const decayFactor = Math.pow(0.5, ageDays / def.halfLifeDays);
    return { effective: def.base * decayFactor * signal.confidence, decayFactor };
}

export function getTier(score, tiers) {
    for (const t of tiers) if (score >= t.min) return t;
    return { min: 0, tier: 'SKIP', action: 'No action', emoji: '⚪' };
}

export function scoreAccount(signals, config, now = new Date()) {
    const defs = config.signalDefs;
    const floor = config.detectionFloor ?? 8;

    // Strongest signal per type
    const best = new Map();
    for (const s of signals) {
        const def = defs[s.type];
        if (!def) continue;
        const { effective, decayFactor } = effectivePoints(s, def, now);
        const prev = best.get(s.type);
        if (!prev || effective > prev.effective) best.set(s.type, { signal: s, effective, decayFactor });
    }

    const breakdown = [];
    let sum = 0;
    for (const [type, v] of best) {
        if (v.effective < floor) continue;
        const def = defs[type];
        breakdown.push({
            type, label: def.label, base: def.base,
            decayFactor: +v.decayFactor.toFixed(3),
            confidence: v.signal.confidence,
            effective: Math.round(v.effective),
            observedAt: v.signal.observedAt,
            url: v.signal.url, source: v.signal.source, evidence: v.signal.evidence
        });
        sum += v.effective;
    }
    const detectedTypes = new Set(breakdown.map(b => b.type));

    // Calculate base score first
    const baseScore = Math.min(50, Math.round(sum));

    // Find firing stacks and their scores
    // A stack is used only if ALL detected signals are part of that stack
    let bestStack = null;
    for (const stack of config.signalStacks || []) {
        // All members of the stack must be detected
        if (!stack.signals.every(t => detectedTypes.has(t))) continue;
        // All detected signals must be in this stack (or no non-stack signals)
        const allDetectedInStack = [...detectedTypes].every(t => stack.signals.includes(t));
        if (!allDetectedInStack) continue;

        const weakest = Math.min(...stack.signals.map(t => {
            const v = best.get(t);
            return v.decayFactor * v.signal.confidence;
        }));
        const stackScore = Math.min(50, Math.round(stack.combined * weakest));

        // Use the best stack (highest score)
        if (!bestStack || stackScore > bestStack.score) {
            bestStack = { score: stackScore, label: stack.label, meaning: stack.meaning };
        }
    }

    let score = baseScore;
    let isStack = false, stackLabel = null, stackMeaning = null;
    if (bestStack) {
        score = bestStack.score;
        isStack = true;
        stackLabel = bestStack.label;
        stackMeaning = bestStack.meaning;
    }

    const tier = getTier(score, config.tiers);
    return {
        score, tier: tier.tier, action: tier.action, emoji: tier.emoji,
        isStack, stackLabel, stackMeaning,
        detected: [...detectedTypes], breakdown,
        flagged: breakdown.filter(b => b.confidence < 0.7)
    };
}
