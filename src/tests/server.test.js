import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(HERE, 'fixtures', 'app');

let server;
let baseUrl;

before(async () => {
    server = createServer({ port: 0, base: fixtureDir });
    ({ url: baseUrl } = await server.connect());
});

after(async () => {
    await server.close();
});

function readData(html) {
    const m = html.match(/id="__last_router_data">(.+?)<\/script>/s);
    return JSON.parse(m[1].replaceAll('\\u003c', '<'));
}

describe('SSR', () => {
    it('renders the root page with api body', async () => {
        const html = await (await fetch(baseUrl + '/')).text();
        assert.match(html, /<h1>home<\/h1>/);
    });

    it('passes dynamic params to the api and the page', async () => {
        const html = await (await fetch(baseUrl + '/alice')).text();
        assert.match(html, /<p>Hello, alice<\/p>/);
    });

    it('drains a streaming api and merges all chunks', async () => {
        const html = await (await fetch(baseUrl + '/stream')).text();
        assert.match(html, /<p>one two three<\/p>/);
    });

    it('renders a page that has no colocated api', async () => {
        const html = await (await fetch(baseUrl + '/static')).text();
        assert.match(html, /<p>no api here<\/p>/);
        const data = readData(html);
        assert.deepEqual(data.body, {});
    });

    it('returns 404 for an unmatched route', async () => {
        const res = await fetch(baseUrl + '/no/such/route');
        assert.equal(res.status, 404);
    });

    it('serves a built-in health route', async () => {
        const res = await fetch(baseUrl + '/health');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/plain/);
        assert.equal(await res.text(), 'ok');
    });

    it('returns 302 when the api calls router.push', async () => {
        const res = await fetch(baseUrl + '/redirect', { redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/');
    });

    it('embeds a route manifest in the shell', async () => {
        const html = await (await fetch(baseUrl + '/')).text();
        const data = readData(html);
        const patterns = data.manifest.map(r => r.pattern).sort();
        assert.deepEqual(patterns, ['/', '/:slug', '/danger', '/redirect', '/static', '/stream']);
    });

    it('escapes < inside the embedded JSON to prevent script breakout', async () => {
        const html = await (await fetch(baseUrl + '/danger')).text();
        const block = html.match(/id="__last_router_data">(.+?)<\/script>/s)[1];
        assert.doesNotMatch(block, /<\/script>/);
        assert.match(block, /\\u003c\/script>/);
    });

    it('escapes < in serialized page output', async () => {
        const html = await (await fetch(baseUrl + '/danger')).text();
        const app = html.match(/<div id="app">(.+?)<\/div>\s*<script/s)[1];
        assert.match(app, /&lt;script&gt;alert/);
        assert.doesNotMatch(app, /<script>alert/);
    });
});

describe('/__data streaming', () => {
    it('streams one NDJSON line per yield, in order', async () => {
        const text = await (await fetch(baseUrl + '/__data/stream')).text();
        const lines = text.trim().split('\n').map(JSON.parse);
        assert.deepEqual(lines, [{ a: 'one' }, { b: 'two' }, { c: 'three' }]);
    });

    it('writes a single line for non-streaming apis', async () => {
        const text = await (await fetch(baseUrl + '/__data/alice')).text();
        const lines = text.trim().split('\n');
        assert.equal(lines.length, 1);
        assert.deepEqual(JSON.parse(lines[0]), { greeting: 'Hello,', slug: 'alice' });
    });

    it('emits an empty object for routes without an api', async () => {
        const text = await (await fetch(baseUrl + '/__data/static')).text();
        assert.equal(text.trim(), '{}');
    });

    it('emits a __redirect marker when api pushes', async () => {
        const text = await (await fetch(baseUrl + '/__data/redirect')).text();
        assert.match(text, /"__redirect":"\/"/);
    });

    it('flushes chunks incrementally rather than buffering', async () => {
        const start = Date.now();
        const reader = (await fetch(baseUrl + '/__data/stream')).body.getReader();
        const reads = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reads.push({ at: Date.now() - start, bytes: value.byteLength });
        }
        const last = reads[reads.length - 1];
        assert.ok(last.at >= 50, `expected last read at ≥50ms (yields sleep 30ms between them), got ${last.at}ms`);
    });

    it('returns 404 for unknown data paths', async () => {
        const res = await fetch(baseUrl + '/__data/no/such/route');
        assert.equal(res.status, 404);
    });
});

describe('module serving', () => {
    it('serves the client runtime', async () => {
        const res = await fetch(baseUrl + '/__router/client.js');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /javascript/);
        assert.match(await res.text(), /matchPath/);
    });

    it('serves the common runtime', async () => {
        const res = await fetch(baseUrl + '/__router/common.js');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /export function matchPath/);
    });

    it('serves a user page under /__src/', async () => {
        const res = await fetch(baseUrl + '/__src/page.js');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /export default/);
    });

    it('decodes bracket folders in /__src/ URLs', async () => {
        const res = await fetch(baseUrl + '/__src/%5Bslug%5D/page.js');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /export default function Slug/);
    });

    it('serves transitive package files under /__module/', async () => {
        const res = await fetch(baseUrl + '/__module/@incremental-code/last-act/src/element.js');
        assert.equal(res.status, 200);
    });

    it('rejects /__src/ path traversal that survives URL normalization', async () => {
        // %2f preserves an encoded slash, so ".." is not collapsed by URL parsing
        // and reaches our handler intact. safeJoin must reject it.
        const res = await fetch(baseUrl + '/__src/..%2fpackage.json');
        assert.equal(res.status, 404);
    });

    it('rejects /__module/ path traversal that survives URL normalization', async () => {
        const res = await fetch(baseUrl + '/__module/..%2fpackage.json');
        assert.equal(res.status, 404);
    });
});

describe('import map', () => {
    it('includes last-act and signal-polyfill by default', async () => {
        const html = await (await fetch(baseUrl + '/')).text();
        const imap = JSON.parse(html.match(/<script type="importmap">(.+?)<\/script>/)[1]);
        assert.ok(imap.imports['@incremental-code/last-act']);
        assert.ok(imap.imports['signal-polyfill']);
    });

    it('merges user-supplied imports over the defaults', async () => {
        const s = createServer({ port: 0, base: fixtureDir, imports: { 'my-lib': '/cdn/my-lib.js' } });
        try {
            const { url } = await s.connect();
            const html = await (await fetch(url + '/')).text();
            const imap = JSON.parse(html.match(/<script type="importmap">(.+?)<\/script>/)[1]);
            assert.equal(imap.imports['my-lib'], '/cdn/my-lib.js');
            assert.ok(imap.imports['signal-polyfill'], 'defaults should still be present');
        } finally {
            await s.close();
        }
    });
});
