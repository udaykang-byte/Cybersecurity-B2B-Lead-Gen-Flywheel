/** JD text → technographic/compliance/pain extraction, driven by client config. */
export function extractFromJD(text, config) {
    const t = (text || '').toLowerCase();
    const find = list => [...new Set(list.filter(k => t.includes(k)))];
    return {
        tools: find(config.jd.competitorTools),
        frameworks: find(config.jd.frameworks),
        painLanguage: find(config.jd.painKeywords)
    };
}
