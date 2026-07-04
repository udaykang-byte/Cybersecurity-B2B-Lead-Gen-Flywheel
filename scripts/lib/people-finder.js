/** Decision-maker discovery — Parallel search over LinkedIn profile pages. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseResults } from './signals/parallel-news.js';

const pExecFile = promisify(execFile);

async function runCli(args) {
    const { stdout } = await pExecFile('parallel-cli', args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
}

export async function findDecisionMakers(company, config, deps = {}) {
    const exec = deps.exec || runCli;
    const roles = config.people?.roles || ['CISO'];
    const max = config.people?.max ?? 5;
    const query = `site:linkedin.com/in ("${roles.join('" OR "')}") "${company.name}"`;

    let stdout;
    try {
        stdout = await exec(['search', query, '--json']);
    } catch (err) {
        throw new Error(`parallel-cli failed: ${err.message}`);
    }

    const people = [];
    const seen = new Set();
    for (const item of parseResults(stdout)) {
        if (!item.url || !/linkedin\.com\/in\//.test(item.url)) continue;
        const profileUrl = item.url.split('?')[0];
        if (seen.has(profileUrl)) continue;
        seen.add(profileUrl);
        // LinkedIn result titles look like "Name - Title - Company | LinkedIn"
        const parts = (item.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').split(/\s[-–]\s/);
        people.push({
            name: (parts[0] || '').trim() || item.title,
            title: (parts[1] || '').trim(),
            profileUrl,
            evidence: (item.snippet || '').slice(0, 200),
            source: 'parallel-people'
        });
        if (people.length >= max) break;
    }
    return people;
}
