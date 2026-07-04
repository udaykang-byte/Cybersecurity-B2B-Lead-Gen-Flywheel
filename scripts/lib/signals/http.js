/** Minimal HTTP helper — retry + timeout, zero dependencies (global fetch). */
export class HttpError extends Error {
    constructor(status, url, body) {
        super(`HTTP ${status} for ${url}`);
        this.status = status;
        this.body = body;
    }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(url, { method = 'GET', headers = {}, body = null,
                              timeoutMs = 15000, retries = 2, retryDelayMs = 500 } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(url, {
                method, headers, body,
                redirect: 'follow',
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (RETRYABLE.has(res.status) && attempt < retries) {
                await sleep(retryDelayMs * 2 ** attempt);
                continue;
            }
            const text = await res.text();
            if (res.status >= 400) throw new HttpError(res.status, url, text.slice(0, 300));
            return text;
        } catch (err) {
            if (err instanceof HttpError) throw err;
            if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
            throw err;
        }
    }
}

export async function fetchText(url, opts) { return request(url, opts); }

export async function fetchJson(url, opts = {}) {
    const text = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    try { return JSON.parse(text); }
    catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 120)}`); }
}
