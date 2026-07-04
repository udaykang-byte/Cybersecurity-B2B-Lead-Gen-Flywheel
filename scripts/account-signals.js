#!/usr/bin/env node
/**
 * Account Signal Orchestrator (v2)
 *
 * On-demand account intelligence: CSV of target companies in → per-account
 * signal fan-out → decay/confidence scoring → Supabase persistence → briefs.
 *
 * Usage:
 *   node scripts/account-signals.js <csv-file> [options]
 *
 * Options:
 *   --client <name>     Client config from clients/<name>.json (default: default)
 *   --min-score <N>     Only include accounts scoring >= N (default: 15)
 *   --no-enrich         Skip news/registry/job-board adapters (local data only)
 *   --no-linkedin       Skip Apify LinkedIn company enrichment
 *   --no-people         Skip decision-maker discovery
 *   --no-notify         Skip Slack/macOS notifications
 *   --dry-run           Show the plan without any API calls
 *
 * Output: data/AccountSignals/<timestamp>/ranked-accounts.{md,json} + accounts/<slug>.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadClientConfig } from './lib/client-config.js';
import { scoreAccount } from './lib/scoring.js';
import { findDecisionMakers } from './lib/people-finder.js';
import { enrichCompanies, normalizeCompanyUrl } from './lib/linkedin-enrich.js';
import db from './lib/supabase.js';
import * as parallelNews from './lib/signals/parallel-news.js';
import * as exaNews from './lib/signals/exa-news.js';
import * as hhsBreach from './lib/signals/hhs-breach.js';
import * as maineAg from './lib/signals/maine-ag-breach.js';
import * as secEdgar from './lib/signals/sec-edgar.js';
import * as ransomwareWatch from './lib/signals/ransomware-watch.js';
import * as jobBoards from './lib/signals/job-boards.js';
import * as localScans from './lib/signals/local-scans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── .env loader (same pattern as every script in this repo) ──
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length) process.env[key.trim()] = valueParts.join('=').trim();
        }
    }
} catch { /* ok */ }

// ── CSV parsing (kept from v1) ──
function parseCSVLine(line) {
    const fields = [];
    let field = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(field); field = ''; }
        else field += ch;
    }
    fields.push(field);
    return fields;
}

export function parseAccountsCSV(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const accounts = [];
    let urlCol = -1, nameCol = -1, domainCol = -1, headerSkipped = false;
    const first = parseCSVLine(lines[0]);
    // Only treat the first line as a header if it looks like one (has a
    // recognizable column name) and doesn't already contain a LinkedIn URL
    // (which would mean it's the first data row of a header-less file).
    const isHeader = !first.some(f => f.includes('linkedin.com')) &&
        first.some(f => /name|url|domain|website|company/i.test(f));
    if (isHeader) {
        urlCol = first.findIndex(f => /linkedin/i.test(f));
        nameCol = first.findIndex(f => /name/i.test(f));
        domainCol = first.findIndex(f => /domain|website/i.test(f));
        headerSkipped = true;
    }
    for (const line of lines.slice(headerSkipped ? 1 : 0)) {
        const fields = parseCSVLine(line);
        const urlField = urlCol >= 0 ? fields[urlCol] : fields.find(f => f.includes('linkedin.com'));
        const url = (urlField || '').trim();
        let domain = domainCol >= 0 ? (fields[domainCol] || '').trim() : null;
        if (domain) domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() || null;
        const name = nameCol >= 0 ? (fields[nameCol] || '').trim() : '';
        if (!url && !domain && !name) continue; // fully blank/unusable row
        accounts.push({
            name,
            linkedinUrl: url ? normalizeCompanyUrl(url) : null,
            domain
        });
    }
    return accounts;
}

// ── Competitor disqualification (config-driven) ──
function isCompetitorCompany(name, linkedinUrl, config) {
    const nameLower = (name || '').toLowerCase().trim();
    const urlSlug = ((linkedinUrl || '').match(/\/company\/([^/?]+)/)?.[1] || '').toLowerCase();
    for (const comp of config.competitorCompanies || []) {
        if (nameLower && (nameLower === comp.name || nameLower.includes(comp.name))) return comp.name;
        if (urlSlug && comp.slugs.some(s => urlSlug === s)) return comp.name;
    }
    return null;
}

// ── Adapter registry ──
export function buildAdapters(config, opts) {
    const list = [];
    if (opts.enrich) {
        const provider = config.news?.provider || 'parallel';
        if (provider === 'parallel' || provider === 'both') list.push(parallelNews);
        if (provider === 'exa' || provider === 'both') list.push(exaNews);
        list.push(hhsBreach, maineAg, secEdgar, ransomwareWatch, jobBoards);
    }
    list.push(localScans);
    return list;
}

// ── Per-account processing: fan out → dedupe → score ──
export async function processAccount(account, config, adapters, deps = {}) {
    const dq = isCompetitorCompany(account.name, account.linkedinUrl, config);
    if (dq) return { company: account, signals: [], adapterStatus: {}, disqualified: dq, result: null };

    const settled = await Promise.allSettled(adapters.map(a => a.fetchSignals(account, config, deps)));
    const adapterStatus = {};
    const signals = [];
    const seen = new Set();
    settled.forEach((s, i) => {
        const adapterName = adapters[i].name;
        if (s.status === 'fulfilled') {
            if (!Array.isArray(s.value)) {
                adapterStatus[adapterName] = { error: 'adapter returned non-array result' };
                return;
            }
            let kept = 0;
            for (const sig of s.value) {
                const key = `${sig.type}|${sig.url || sig.evidence}`;
                if (seen.has(key)) continue;
                seen.add(key);
                signals.push(sig);
                kept++;
            }
            adapterStatus[adapterName] = { ok: kept };
        } else {
            adapterStatus[adapterName] = { error: String(s.reason?.message || s.reason).slice(0, 200) };
        }
    });

    const result = scoreAccount(signals, config, deps.now || new Date());
    return { company: account, signals, adapterStatus, disqualified: null, result };
}

// ── Persistence (Supabase optional) ──
// Filter out signals already stored for this company AND duplicates within the
// batch itself, keyed the same way as the signal_events_dedup index.
export function dedupeSignalEvents(signals, existingRows) {
    const seen = new Set(existingRows.map(r => `${r.type}|${r.url || ''}`));
    return signals.filter(s => {
        const key = `${s.type}|${s.url || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function persist(processed, people, config, runId) {
    if (!db.isConfigured()) return null;
    const companyId = await db.findOrCreateCompanyByDomain({
        name: processed.company.name, domain: processed.company.domain,
        linkedin_url: processed.company.linkedinUrl,
        website: processed.company.domain ? `https://${processed.company.domain}` : null,
        employee_count: processed.company.employeeCount || null,
        industry: processed.company.industry || null
    });
    if (processed.signals.length) {
        // signal_events_dedup is an expression index (coalesce(url,'')) that
        // PostgREST ignore-duplicates can't target, so dedupe client-side.
        const existing = await db.select('signal_events', {
            company_id: `eq.${companyId}`, select: 'type,url'
        });
        const fresh = dedupeSignalEvents(processed.signals, existing);
        if (fresh.length) {
            await db.insert('signal_events', fresh.map(s => ({
                company_id: companyId, client: config.client, type: s.type,
                evidence: s.evidence, url: s.url, source: s.source, confidence: s.confidence,
                base_points: config.signalDefs[s.type].base,
                half_life_days: config.signalDefs[s.type].halfLifeDays,
                observed_at: s.observedAt
            })));
        }
    }
    await db.insert('account_signal_scores', {
        run_id: runId, company_id: companyId, client: config.client,
        score: processed.result.score, tier: processed.result.tier,
        is_stack: processed.result.isStack, stack_label: processed.result.stackLabel,
        breakdown: processed.result.breakdown, flagged: processed.result.flagged
    });
    if (people?.length) {
        await db.upsert('people_signals', people.map(p => ({
            company_id: companyId, source: 'parallel-people', type: 'decision-maker',
            name: p.name, title: p.title, profile_url: p.profileUrl
        })), 'profile_url');
    }
    return companyId;
}

// ── Brief + report rendering ──
function slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function renderBrief(p, people, config) {
    const r = p.result;
    const lines = [
        `# ${p.company.name} — ${r.emoji} ${r.tier} (${r.score}/50)`,
        '',
        `**Action:** ${r.action}${p.company.domain ? `  |  **Domain:** ${p.company.domain}` : ''}`,
        ''
    ];
    if (r.isStack) lines.push(`**Signal stack:** ${r.stackLabel} — *${r.stackMeaning}*`, '');
    if (r.breakdown.length) {
        lines.push('## Why now', '', '| Signal | Effective | Age/Decay | Confidence | Evidence |', '|---|---|---|---|---|');
        for (const b of [...r.breakdown].sort((a, z) => z.effective - a.effective)) {
            const link = b.url ? `[source](${b.url})` : b.source;
            lines.push(`| ${b.label} | ${b.effective} | ${b.observedAt} (×${b.decayFactor}) | ${b.confidence} | ${b.evidence.slice(0, 120)} ${link} |`);
        }
        lines.push('');
    }
    if (r.flagged.length) {
        lines.push('## ⚠️ Low-confidence signals (verify before outreach)', '');
        for (const f of r.flagged) lines.push(`- ${f.label}: ${f.evidence.slice(0, 150)} (confidence ${f.confidence})`);
        lines.push('');
    }
    if (people?.length) {
        lines.push('## Decision-makers', '');
        for (const person of people) lines.push(`- **${person.name}** — ${person.title || 'title unknown'} — ${person.profileUrl}`);
        lines.push('');
    }
    const failed = Object.entries(p.adapterStatus).filter(([, v]) => v.error);
    if (failed.length) {
        lines.push('## Sources unavailable this run', '');
        for (const [nameKey, v] of failed) lines.push(`- ${nameKey}: ${v.error}`);
        lines.push('');
    }
    return lines.join('\n');
}

// Highest-`effective` breakdown entry — same ordering renderBrief's table uses.
// (breakdown[0] is just insertion order, not the strongest signal.)
function topSignal(breakdown) {
    if (!breakdown || !breakdown.length) return null;
    return breakdown.reduce((max, b) => (b.effective > max.effective ? b : max), breakdown[0]);
}

function renderRankedReport(rankedRows, meta) {
    const lines = [
        `# Account Signals — ${meta.timestamp}`, '',
        `**Client:** ${meta.client} | **Accounts:** ${meta.total} | **Disqualified:** ${meta.disqualified} | **Min score:** ${meta.minScore}`, '',
        '| # | Company | Score | Tier | Top Signal | Action |', '|---|---|---|---|---|---|'
    ];
    rankedRows.forEach((p, i) => {
        const top = topSignal(p.result.breakdown);
        lines.push(`| ${i + 1} | ${p.company.name} | ${p.result.score}/50 | ${p.result.emoji} ${p.result.tier} | ${p.result.isStack ? p.result.stackLabel : (top?.label || '—')} | ${p.result.action} |`);
    });
    return lines.join('\n');
}

// ── Notifications (kept from v1, simplified) ──
function notifyHot(rankedRows, config) {
    const hot = rankedRows.filter(p => p.result.tier === 'CRITICAL' || p.result.tier === 'HIGH');
    if (!hot.length) return;
    const text = hot.map(p => `${p.result.emoji} ${p.company.name}: ${p.result.score}/50 (${p.result.tier}) — ${p.result.isStack ? p.result.stackLabel : topSignal(p.result.breakdown)?.label || ''}`).join('\n');
    if (config.notify?.slack && process.env.SLACK_WEBHOOK_URL) {
        fetch(process.env.SLACK_WEBHOOK_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `*Account signals — ${hot.length} hot account(s)*\n${text}` })
        }).catch(err => console.error(`Slack notify failed: ${err.message}`));
    }
    if (config.notify?.macos && process.platform === 'darwin') {
        try {
            execSync(`osascript -e 'display notification ${JSON.stringify(`${hot.length} hot account(s)`)} with title "Account Signals"'`);
        } catch { /* non-fatal */ }
    }
}

// ── Main ──
export async function run(options) {
    const { csvFile, client = 'default', minScore = 15, enrich = true, maxCompanies = null,
            linkedin = true, people = true, notify = true, dryRun = false } = options;
    const config = loadClientConfig(client);
    let accounts = parseAccountsCSV(csvFile);
    if (!accounts.length) {
        console.log(`CSV contains no accounts: ${csvFile}`);
        return { accounts: [] };
    }
    if (maxCompanies) accounts = accounts.slice(0, maxCompanies);
    const adapters = buildAdapters(config, { enrich });

    console.log(`\nAccount Signal Orchestrator — client "${config.client}"`);
    console.log(`Accounts: ${accounts.length} | Adapters: ${adapters.map(a => a.name).join(', ')}`);

    if (dryRun) {
        console.log('\nDRY RUN — no API calls.');
        for (const a of accounts) console.log(`  ${a.name || '(name via enrichment)'} — ${a.linkedinUrl || '(no linkedin url)'} — ${a.domain || 'domain via enrichment'}`);
        return { dryRun: true, accounts };
    }

    // Run audit row
    let runId = null;
    if (db.isConfigured()) {
        try {
            const rows = await db.insert('runs', { client: config.client });
            runId = rows[0]?.id || null;
        } catch (err) { console.error(`  runs insert failed: ${err.message}`); }
    }

    // LinkedIn enrichment fills missing names/domains (and firmographics)
    if (linkedin) {
        try {
            const enriched = await enrichCompanies(accounts.map(a => a.linkedinUrl).filter(Boolean));
            for (const a of accounts) {
                const data = enriched.get(a.linkedinUrl);
                if (!data) continue;
                a.name = a.name || data.name || '';
                a.industry = data.industry || null;
                a.employeeCount = data.employeeCount || data.employee_count || null;
                if (!a.domain && data.website) {
                    a.domain = data.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
                }
            }
        } catch (err) {
            console.error(`  LinkedIn enrichment unavailable: ${err.message}`);
        }
    }

    const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const outDir = path.join(DATA_DIR, 'AccountSignals', timestamp);
    fs.mkdirSync(path.join(outDir, 'accounts'), { recursive: true });

    const processedAll = [];
    const runStatus = {};
    for (const account of accounts) {
        if (!account.name && account.linkedinUrl) account.name = (account.linkedinUrl.match(/\/company\/([^/?]+)/)?.[1] || '').replace(/-/g, ' ');
        console.log(`\n→ ${account.name}`);
        const p = await processAccount(account, config, adapters);
        if (p.disqualified) { console.log(`  DISQUALIFIED (competitor: ${p.disqualified})`); processedAll.push(p); continue; }

        for (const [aName, st] of Object.entries(p.adapterStatus)) {
            runStatus[aName] = runStatus[aName] || { ok: 0, failed: 0 };
            if (st.error) { runStatus[aName].failed++; runStatus[aName].error = st.error; }
            else runStatus[aName].ok += st.ok;
        }
        console.log(`  score ${p.result.score}/50 ${p.result.tier} — ${p.signals.length} signal(s)`);

        let accountPeople = [];
        if (people && (p.result.tier === 'CRITICAL' || p.result.tier === 'HIGH')) {
            try { accountPeople = await findDecisionMakers(account, config); }
            catch (err) { console.error(`  people-finder failed: ${err.message}`); }
        }

        try { await persist(p, accountPeople, config, runId); }
        catch (err) { console.error(`  Supabase persist failed: ${err.message}`); }

        fs.writeFileSync(path.join(outDir, 'accounts', `${slugify(account.name)}.md`), renderBrief(p, accountPeople, config));
        processedAll.push(p);
    }

    const ranked = processedAll
        .filter(p => p.result && p.result.score >= minScore)
        .sort((a, z) => z.result.score - a.result.score);
    const meta = { client: config.client, timestamp, total: accounts.length,
                   disqualified: processedAll.filter(p => p.disqualified).length, minScore };
    fs.writeFileSync(path.join(outDir, 'ranked-accounts.md'), renderRankedReport(ranked, meta));
    fs.writeFileSync(path.join(outDir, 'ranked-accounts.json'), JSON.stringify({ meta, adapterStatus: runStatus,
        accounts: ranked.map(p => ({ ...p.company, ...p.result })) }, null, 2));

    if (runId) {
        try {
            await db.update('runs', { id: `eq.${runId}` }, {
                finished_at: new Date().toISOString(),
                companies_processed: accounts.length, adapter_status: runStatus
            });
        } catch { /* non-fatal */ }
    }

    if (notify) notifyHot(ranked, config);
    console.log(`\nDone. Report: ${path.join(outDir, 'ranked-accounts.md')}`);
    return { outDir, ranked: ranked.length, adapterStatus: runStatus };
}

// ── CLI ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    if (!args.length || args[0].startsWith('--help')) {
        console.log('Usage: node scripts/account-signals.js <csv-file> [--client <name>] [--min-score N] [--max-companies N] [--enrich] [--no-enrich] [--no-linkedin] [--no-people] [--no-notify] [--dry-run]');
        process.exit(0);
    }
    const opts = { csvFile: args[0], client: 'default', minScore: 15, maxCompanies: null,
                   enrich: true, linkedin: true, people: true, notify: true, dryRun: false };
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--client') opts.client = args[++i];
        else if (args[i] === '--min-score') { const n = parseInt(args[++i], 10); opts.minScore = Number.isNaN(n) ? 15 : n; }
        else if (args[i] === '--max-companies') { const n = parseInt(args[++i], 10); opts.maxCompanies = Number.isNaN(n) ? null : n; }
        else if (args[i] === '--enrich') opts.enrich = true;
        else if (args[i] === '--no-enrich') opts.enrich = false;
        else if (args[i] === '--no-linkedin') opts.linkedin = false;
        else if (args[i] === '--no-people') opts.people = false;
        else if (args[i] === '--no-notify') opts.notify = false;
        else if (args[i] === '--dry-run') opts.dryRun = true;
    }
    if (!fs.existsSync(opts.csvFile)) { console.error(`CSV not found: ${opts.csvFile}`); process.exit(1); }
    run(opts).catch(err => { console.error(err); process.exit(1); });
}
