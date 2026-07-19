import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLambdaHandler } from '../lambda.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(HERE, 'fixtures', 'app');
const handler = createLambdaHandler({ base: fixtureDir });

function event(overrides = {}) {
    return {
        path: '/',
        httpMethod: 'GET',
        headers: {},
        queryStringParameters: null,
        body: null,
        isBase64Encoded: false,
        ...overrides,
    };
}

function readData(html) {
    const m = html.match(/id="__last_router_data">(.+?)<\/script>/s);
    return JSON.parse(m[1].replaceAll('\\u003c', '<'));
}

describe('lambda SSR shell', () => {
    it('renders a hydration-ready shell for the root page', async () => {
        const res = await handler(event({ path: '/' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/html/);
        assert.match(res.body, /<h1>home<\/h1>/);
        // The three things the client bundle needs to boot:
        assert.match(res.body, /<script type="importmap">/);
        assert.match(res.body, /id="__last_router_data"/);
        assert.match(res.body, /<script type="module" src="\/__router\/client\.js">/);
        // Portal root parity with the dev server shell.
        assert.match(res.body, /id="__portal_root"/);
        // No leftover of the old non-hydrating shell.
        assert.doesNotMatch(res.body, /__ROUTE_DATA__/);
    });

    it('embeds the route manifest and basePath in the boot data', async () => {
        const res = await handler(event({ path: '/' }));
        const data = readData(res.body);
        assert.equal(data.path, '/');
        assert.equal(data.basePath, '');
        assert.ok(Array.isArray(data.manifest));
        assert.ok(data.manifest.some(r => r.pattern === '/'));
    });

    it('includes last-act and signal-polyfill in the import map', async () => {
        const res = await handler(event({ path: '/' }));
        const imap = JSON.parse(res.body.match(/<script type="importmap">(.+?)<\/script>/)[1]);
        assert.match(imap.imports['@incremental-code/last-act'], /^\/__module\/@incremental-code\/last-act\//);
        assert.ok(imap.imports['signal-polyfill']);
    });

    it('prefixes shell assets + boot data when a forwarded prefix is present', async () => {
        const res = await handler(event({ path: '/', headers: { 'x-forwarded-prefix': '/blog' } }));
        assert.match(res.body, /<script type="module" src="\/blog\/__router\/client\.js">/);
        const imap = JSON.parse(res.body.match(/<script type="importmap">(.+?)<\/script>/)[1]);
        assert.match(imap.imports['@incremental-code/last-act'], /^\/blog\/__module\//);
        assert.equal(readData(res.body).basePath, '/blog');
    });
});

describe('lambda asset serving', () => {
    it('serves the client runtime', async () => {
        const res = await handler(event({ path: '/__router/client.js' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /javascript/);
        assert.match(res.body, /hydrate/);
    });

    it('serves the common runtime', async () => {
        const res = await handler(event({ path: '/__router/common.js' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /javascript/);
    });

    it('serves a package file under /__module/', async () => {
        const res = await handler(event({ path: '/__module/@incremental-code/last-act/src/index.js' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /javascript/);
    });

    it('serves a compiled user page under /__src/', async () => {
        const res = await handler(event({ path: '/__src/page.js' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /javascript/);
    });

    it('rejects /__module/ path traversal', async () => {
        const res = await handler(event({ path: '/__module/..%2fpackage.json' }));
        assert.equal(res.statusCode, 404);
    });

    it('rejects /__src/ path traversal', async () => {
        const res = await handler(event({ path: '/__src/..%2f..%2fpackage.json' }));
        assert.equal(res.statusCode, 404);
    });
});

describe('lambda header casing', () => {
    it('parses cookies from an original-case Cookie header (payload 1.0)', async () => {
        // API Gateway proxy events can deliver `Cookie` (not `cookie`). An inbound
        // flash cookie that is actually parsed triggers a flash-CLEAR on the way
        // out, so its presence proves the capital-case header was read.
        const flash = encodeURIComponent(JSON.stringify({ kind: 'info', message: 'hi' }));
        const res = await handler(event({ path: '/', headers: { Cookie: `_flash=${flash}` } }));
        const setCookies = res.multiValueHeaders?.['set-cookie'] || [];
        assert.ok(
            setCookies.some(c => c.startsWith('_flash=;')),
            'expected a _flash clear cookie, proving the Cookie header was parsed',
        );
    });
});

describe('lambda res.redirect()', () => {
    it('turns res.redirect() into a 302 with a Location header', async () => {
        const res = await handler(event({ path: '/redirect' }));
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, '/');
    });
});

describe('lambda Set-Cookie (payload 1.0)', () => {
    it('emits cookies via multiValueHeaders, never as a headers array', async () => {
        // API Gateway (payload 1.0) 500s on an array-valued `headers` entry, so
        // repeated Set-Cookie must live in multiValueHeaders.
        const res = await handler(event({ path: '/flash/set' }));
        assert.equal(res.statusCode, 200);
        assert.ok(res.multiValueHeaders && Array.isArray(res.multiValueHeaders['set-cookie']));
        assert.ok(res.multiValueHeaders['set-cookie'].some(c => c.startsWith('_flash=')));
        assert.equal(res.headers['set-cookie'], undefined);
    });

    it('omits multiValueHeaders when the response sets no cookies', async () => {
        const res = await handler(event({ path: '/' }));
        assert.equal(res.multiValueHeaders, undefined);
    });
});

describe('lambda /__data', () => {
    it('returns one NDJSON line for a non-streaming api', async () => {
        const res = await handler(event({ path: '/__data/' }));
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /x-ndjson/);
        const lines = res.body.trim().split('\n').map(JSON.parse);
        assert.deepEqual(lines, [{ title: 'home' }]);
    });

    it('drains a streaming api into one line per yield', async () => {
        const res = await handler(event({ path: '/__data/stream' }));
        assert.equal(res.statusCode, 200);
        const lines = res.body.trim().split('\n').map(JSON.parse);
        assert.deepEqual(lines, [{ a: 'one' }, { b: 'two' }, { c: 'three' }]);
    });

    it('returns 404 for an unknown data path', async () => {
        const res = await handler(event({ path: '/__data/no/such/route' }));
        assert.equal(res.statusCode, 404);
    });
});
