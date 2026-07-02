/** Maine AG breach notification list — broad US coverage via ME notification law. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText as defaultFetchText } from './http.js';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'maine-ag-breach';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', '.cache');
// Verified in Task 7 Step 1 (2026-07-02) — this URL now 302s to
// https://www.maine.gov/ag/consumer-protection/data-security-breaches, a static
// Drupal page stating: "We were recently made aware of an apparent abuse of our
// data breach reporting system... The public-facing database will remain
// offline until then." The old agviewer list app (and the nav's "Data Breach
// Notices" link, which meta-refreshes right back to this same URL) both dead-end
// at that notice. There is currently no live, anonymous, parseable breach list
// at Maine AG to verify the anchor-row markup against, so the URL/regex below
// are kept exactly as specified in the brief. REVERIFY once the database is
// restored — the anchorRe pattern is unverified against real markup.
const LIST_URL = 'https://www.maine.gov/agviewer/content/ag/985235c7-cb95-4be2-8792-a1252b4f8318/list.html';
const CACHE_TTL_MS = 24 * 3600 * 1000;

async function loadHtml(fetchText, cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'maine-ag-list.html');
    if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < CACHE_TTL_MS) {
        return fs.readFileSync(cacheFile, 'utf8');
    }
    const text = await fetchText(LIST_URL, { timeoutMs: 30000 });
    fs.writeFileSync(cacheFile, text);
    return text;
}

export async function fetchSignals(company, config, deps = {}) {
    const html = await loadHtml(deps.fetchText || defaultFetchText, deps.cacheDir || DEFAULT_CACHE_DIR);
    const signals = [];
    // Each entry: <a href="...">Org Name</a> ... optional "Date received: MM/DD/YYYY" nearby
    const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]{3,120})<\/a>([^<]{0,120})/g;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
        const [, href, orgName, trailing] = m;
        if (!mentionsCompany(orgName, company.name)) continue;
        const dateMatch = trailing.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const observedAt = dateMatch
            ? `${dateMatch[3]}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`
            : null;
        signals.push(makeSignal({
            company: company.name, domain: company.domain,
            type: 'breach_announced',
            evidence: `Maine AG breach notification: ${orgName.trim()}`,
            url: href.startsWith('http') ? href : `https://www.maine.gov${href}`,
            observedAt, confidence: 0.9, source: name
        }));
    }
    return signals;
}
