import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJson, fetchText, HttpError } from '../scripts/lib/signals/http.js';

function serve(handler) {
    return new Promise(resolve => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
}

test('fetchJson retries 500 then succeeds', async () => {
    let calls = 0;
    const { srv, url } = await serve((req, res) => {
        calls++;
        if (calls < 3) { res.writeHead(500); res.end('boom'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    const data = await fetchJson(url, { retries: 3, retryDelayMs: 1 });
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 3);
    srv.close();
});

test('fetchText throws HttpError with status on 404', async () => {
    const { srv, url } = await serve((req, res) => { res.writeHead(404); res.end('nope'); });
    await assert.rejects(fetchText(url, { retries: 0 }), err => err instanceof HttpError && err.status === 404);
    srv.close();
});
