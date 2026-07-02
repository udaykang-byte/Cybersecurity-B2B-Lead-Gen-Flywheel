/** HHS OCR breach portal adapter — authoritative healthcare breach registry. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText as defaultFetchText } from './http.js';
import { parseCSV } from './csv.js';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'hhs-breach';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', '.cache');
// Verified in Task 7 Step 1 (2026-07-02) — the anonymous CSV URL 404s, and the
// portal's real "Export as CSV" button is NOT a static URL: it's a PrimeFaces/JSF
// mojarra.jsfcljs POST to breach_report_hip.jsf carrying a per-session ViewState
// token (captured live via CDP network trace: POST breach_report_hip.jsf ->
// 200 text/csv, Content-Disposition: attachment; filename="breach_report.csv").
// A bare GET to breach_report_hip.jsf returns Content-Length: 0 (no session).
// There is no anonymous single-GET URL that returns the CSV, so this constant is
// kept as the brief specified and this adapter is marked REVERIFY: to fix for
// real, loadCsv() needs a two-step flow (GET the portal page to capture
// JSESSIONID + javax.faces.ViewState, then POST the export form fields with that
// state) which is out of scope for the current deps.fetchText(url) contract.
// REVERIFY.
const HHS_CSV_URL = 'https://ocrportal.hhs.gov/ocr/breach/breach_report.csv';
const PORTAL_URL = 'https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf';
const CACHE_TTL_MS = 24 * 3600 * 1000;

async function loadCsv(fetchText, cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'hhs-breaches.csv');
    if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < CACHE_TTL_MS) {
        return fs.readFileSync(cacheFile, 'utf8');
    }
    const text = await fetchText(HHS_CSV_URL, { timeoutMs: 30000 });
    fs.writeFileSync(cacheFile, text);
    return text;
}

function parseUsDate(mdY) {
    const m = (mdY || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export async function fetchSignals(company, config, deps = {}) {
    const rows = parseCSV(await loadCsv(deps.fetchText || defaultFetchText, deps.cacheDir || DEFAULT_CACHE_DIR));
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.toLowerCase());
    const col = label => header.findIndex(h => h.includes(label));
    const iName = col('covered entity'), iState = col('state'), iCount = col('individuals'),
          iDate = col('submission date'), iType = col('type of breach');

    const signals = [];
    for (const row of rows.slice(1)) {
        const entity = row[iName] || '';
        if (!mentionsCompany(entity, company.name)) continue;
        signals.push(makeSignal({
            company: company.name, domain: company.domain,
            type: 'breach_announced',
            evidence: `HHS OCR: ${entity} — ${row[iType] || 'breach'}, ${row[iCount] || '?'} individuals (${row[iState] || '?'})`,
            url: PORTAL_URL,
            observedAt: parseUsDate(row[iDate]),
            confidence: 1.0,
            source: name
        }));
    }
    return signals;
}
