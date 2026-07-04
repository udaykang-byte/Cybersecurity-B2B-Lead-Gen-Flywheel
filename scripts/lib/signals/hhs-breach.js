/** HHS OCR breach portal adapter — authoritative healthcare breach registry. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV } from './csv.js';
import { makeSignal } from './signal.js';
import { mentionsCompany } from './classify-news.js';

export const name = 'hhs-breach';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', '.cache');
// The portal has no anonymous single-GET CSV URL: the "Export as CSV" button is
// a PrimeFaces/JSF mojarra.jsfcljs POST to breach_report_hip.jsf carrying the
// session's javax.faces.ViewState and the auto-generated id of the CSV link
// (ids like ocrForm:j_idt389 change between deployments, so the id is discovered
// from the page on every fetch). Verified live 2026-07-04: GET breach_report_hip.jsf
// sets JSESSIONID and returns the page; the POST returns text/csv with
// Content-Disposition: attachment; filename="breach_report.csv" (715 rows).
const PORTAL_URL = 'https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf';
const PORTAL_HIP_URL = 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf';
const UA = 'reddit-scrape-signals/1.0 (uday.kang@martechs.io)';
const CACHE_TTL_MS = 24 * 3600 * 1000;

export function parsePortalPage(html) {
    const vs = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    let csvParam = null;
    const linkRe = /jsfcljs\(document\.getElementById\('ocrForm'\),\s*\{'([^']+)':'[^']+'\}/g;
    for (let m; (m = linkRe.exec(html)) !== null;) {
        // the link's own <img title="Export as CSV"> follows its onclick attribute
        if (html.slice(linkRe.lastIndex, linkRe.lastIndex + 400).includes('Export as CSV')) {
            csvParam = m[1];
            break;
        }
    }
    if (!vs || !csvParam) throw new Error('HHS portal page missing ViewState or CSV export control');
    return { viewState: vs[1], csvParam };
}

function sessionCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    return raw.map(c => c.split(';')[0]).join('; ');
}

async function fetchCsvViaPortal(fetchImpl) {
    let res = await fetchImpl(PORTAL_HIP_URL, { headers: { 'user-agent': UA }, redirect: 'manual' });
    let cookie = sessionCookies(res);
    for (let hops = 0; [301, 302, 303, 307, 308].includes(res.status) && hops < 3; hops++) {
        const loc = new URL(res.headers.get('location'), PORTAL_HIP_URL).href;
        res = await fetchImpl(loc, { headers: { 'user-agent': UA, cookie }, redirect: 'manual' });
        const more = sessionCookies(res);
        if (more) cookie = cookie ? `${cookie}; ${more}` : more;
    }
    if (res.status !== 200) throw new Error(`HHS portal page returned HTTP ${res.status}`);
    const { viewState, csvParam } = parsePortalPage(await res.text());
    const body = new URLSearchParams({ ocrForm: 'ocrForm', 'javax.faces.ViewState': viewState, [csvParam]: csvParam });
    const post = await fetchImpl(PORTAL_HIP_URL, {
        method: 'POST',
        headers: { 'user-agent': UA, cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    const ctype = post.headers.get('content-type') || '';
    if (post.status !== 200 || !ctype.includes('csv')) {
        throw new Error(`HHS CSV export failed: HTTP ${post.status} (${ctype || 'no content-type'})`);
    }
    return post.text();
}

async function loadCsv(deps, cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'hhs-breaches.csv');
    if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < CACHE_TTL_MS) {
        return fs.readFileSync(cacheFile, 'utf8');
    }
    const text = deps.fetchText
        ? await deps.fetchText(PORTAL_URL, { timeoutMs: 30000 })
        : await fetchCsvViaPortal(deps.fetch || globalThis.fetch);
    fs.writeFileSync(cacheFile, text);
    return text;
}

function parseUsDate(mdY) {
    const m = (mdY || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export async function fetchSignals(company, config, deps = {}) {
    const rows = parseCSV(await loadCsv(deps, deps.cacheDir || DEFAULT_CACHE_DIR));
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.toLowerCase());
    const col = label => header.findIndex(h => h.includes(label));
    // the live export mangles the name header into a JSF artifact
    // ("javax.faces.component.UIPanel@..."); the entity name is always column 0
    let iName = col('name of covered entity');
    if (iName === -1) iName = 0;
    const iState = col('state'), iCount = col('individuals'),
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
