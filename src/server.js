import { createServer as createHttpServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, serialize } from '@incremental-code/last-act';
import {
    buildRoute,
    makeBodySignals,
    matchPath,
    normalizeBasePath,
    parseQuery,
    prefixInternalAssetPath,
} from './common.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
};

class Redirect {
    constructor(path, permanent = false) {
        this.path = path;
        this.permanent = permanent;
    }
}

/**
 * Parse pagination, sorting, and search params from a query object.
 *
 * @param {Record<string, any>} query - The request query object (req.query).
 * @param {{ defaults?: object, allowedSorts?: string[] }} opts
 * @returns {{ page: number, perPage: number, sort: string, dir: 'asc'|'desc', q: string }}
 */
export function parseListParams(query, { defaults = {}, allowedSorts = [] } = {}) {
    const page = Math.max(1, parseInt(String(query?.page || ''), 10) || defaults.page || 1);
    const perPage = Math.max(1, Math.min(100, parseInt(String(query?.perPage || ''), 10) || defaults.perPage || 20));
    const rawSort = String(query?.sort || defaults.sort || '');
    const sort = allowedSorts.includes(rawSort) ? rawSort : (defaults.sort || '');
    const dir = String(query?.dir || defaults.dir || '') === 'asc' ? 'asc' : 'desc';
    const q = String(query?.q || '').trim();
    return { page, perPage, sort, dir, q };
}

export function createServer({ port = 3000, base = 'src', imports = {}, staticDirs = [] } = {}) {
    const baseDir = resolve(process.cwd(), base);
    const importMap = { ...defaultImports(baseDir), ...imports };
    const resolvedStaticDirs = staticDirs.map(({ path: urlPath, dir }) => ({
        urlPath: urlPath.endsWith('/') ? urlPath : `${urlPath}/`,
        dir: resolve(process.cwd(), dir),
    }));

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const path = url.pathname;

            if (path === '/health') return sendHealth(res);
            if (path === '/__router/client.js') return sendFile(join(HERE, 'client.js'), res);
            if (path === '/__router/common.js') return sendFile(join(HERE, 'common.js'), res);
            if (path.startsWith('/__module/')) return serveUnder(findNodeModules(baseDir), path.slice('/__module/'.length), res);
            if (path.startsWith('/__src/')) return serveUnder(baseDir, path.slice('/__src/'.length), res);

            for (const { urlPath, dir } of resolvedStaticDirs) {
                if (path === urlPath.slice(0, -1) || path.startsWith(urlPath)) {
                    return serveUnder(dir, path.slice(urlPath.length), res);
                }
            }

            if (path.startsWith('/__data')) return await streamData(baseDir, path.slice('/__data'.length) || '/', url, req, res);

            return await renderPage(baseDir, importMap, path, url, req, res);
        } catch (err) {
            logRouterError('request failed', err, { method: req?.method, url: req?.url });
            if (res.writableEnded) return;
            if (res.headersSent) {
                res.end();
                return;
            }
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(`Internal Server Error: ${err.message}`);
        }
    };

    const server = createHttpServer(handler);

    return {
        connect() {
            return new Promise((res, rej) => {
                server.once('error', rej);
                server.listen(port, () => res({ url: `http://localhost:${server.address().port}` }));
            });
        },
        close() {
            return new Promise(res => server.close(res));
        },
    };
}

async function scanRoutes(baseDir) {
    const routes = [];
    async function walk(dir, segments) {
        const entries = await readdir(dir, { withFileTypes: true });
        const hasPage = entries.some(e => e.isFile() && e.name === 'page.js');
        const hasApi = entries.some(e => e.isFile() && e.name === 'api.js');
        if (hasPage || hasApi) {
            const route = buildRoute(segments);
            route.hasApi = hasApi;
            route.hasPage = hasPage;
            routes.push(route);
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await walk(join(dir, entry.name), [...segments, entry.name]);
            }
        }
    }
    await walk(baseDir, []);
    return routes;
}

async function loadApi(baseDir, route) {
    if (!route.hasApi) return null;
    const apiPath = join(baseDir, route.dir, 'api.js');
    const mod = await import(pathToFileURL(apiPath).href);
    return mod.default;
}

async function loadPage(baseDir, route) {
    const pagePath = join(baseDir, route.dir, 'page.js');
    const mod = await import(pathToFileURL(pagePath).href);
    return mod.default;
}

const SSR_DRAIN_MS = 1000;
const MAX_BODY_BYTES = 1024 * 1024; // ~1MB cap on parsed request body
const FORM_URLENCODED = 'application/x-www-form-urlencoded';
const JSON_CONTENT_TYPE = 'application/json';
const MULTIPART_CONTENT_TYPE = 'multipart/form-data';
const MAX_MULTIPART_BYTES = 20 * 1024 * 1024; // 20MB cap for multipart uploads

async function runApi(apiFn, req, res) {
    const body = {};
    if (!apiFn) return body;

    const result = apiFn(req, res);
    if (isAsyncIterable(result)) {
        await drainForSsr(result, body, SSR_DRAIN_MS);
    } else {
        Object.assign(body, await result);
    }
    return body;
}

/**
 * Drain chunks from an async iterable into `body`, but stop after `timeoutMs`
 * and close the iterator. This lets infinite "live" apis return their initial
 * chunks for SSR without hanging the request. The client picks up subsequent
 * chunks via /__data.
 */
async function drainForSsr(iterable, body, timeoutMs) {
    const iter = iterable[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;
    try {
        while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const next = iter.next();
            const timer = new Promise(resolve => setTimeout(() => resolve('__ssr_timeout'), remaining));
            const winner = await Promise.race([next, timer]);
            if (winner === '__ssr_timeout') break;
            if (winner.done) break;
            if (winner.value) Object.assign(body, winner.value);
        }
    } finally {
        if (typeof iter.return === 'function') {
            await iter.return().catch(() => {});
        }
    }
}

async function renderPage(baseDir, importMap, path, url, req, res) {
    const routes = await scanRoutes(baseDir);
    const match = matchPath(routes, path);
    if (!match) return notFound(res);

    const { route, params } = match;
    const query = parseQuery(url.search);
    const basePath = getBasePath(req);
    const router = serverRouter(path, basePath);

    let reqBody;
    try {
        reqBody = await readRequestBody(req, path);
    } catch (err) {
        if (err && err.code === 'PAYLOAD_TOO_LARGE') {
            logRouterWarning('payload too large', { method: req?.method, path });
            res.writeHead(413, { 'content-type': 'text/plain' });
            return res.end('Payload Too Large');
        }
        throw err;
    }

    const apiReq = buildApiRequest(req, path, params, query, reqBody);
    const apiRes = createApiResponse(basePath);

    // API-only routes (no page.js) return JSON directly
    if (!route.hasPage) {
        try {
            const apiFn = await loadApi(baseDir, route);
            const jsonBody = apiFn ? await runApi(apiFn, apiReq, apiRes) : {};
            const headers = { 'content-type': 'application/json', ...apiRes.takeHeaders() };
            const cookies = withFlashClear(apiReq, apiRes.takeCookies());
            if (cookies.length) headers['set-cookie'] = cookies;
            apiRes.markSent();
            res.writeHead(apiRes.status() ?? 200, headers);
            return res.end(JSON.stringify(jsonBody ?? null));
        } catch (err) {
            if (err instanceof Redirect) {
                const headers = { location: err.path };
                const cookies = withFlashClear(apiReq, apiRes.takeCookies());
                if (cookies.length) headers['set-cookie'] = cookies;
                res.writeHead(err.permanent ? 301 : 302, headers);
                return res.end();
            }
            throw err;
        }
    }

    let body = {};
    try {
        const apiFn = await loadApi(baseDir, route);
        body = await runApi(apiFn, apiReq, apiRes);
    } catch (err) {
        if (err instanceof Redirect) {
            const headers = { location: err.path };
            const cookies = withFlashClear(apiReq, apiRes.takeCookies());
            if (cookies.length) headers['set-cookie'] = cookies;
            res.writeHead(err.permanent ? 301 : 302, headers);
            return res.end();
        }
        throw err;
    }

    const Page = await loadPage(baseDir, route);
    const reactiveBody = makeBodySignals(body);
    const appHtml = serialize(createElement(Page, { router, params, body: reactiveBody }));

    const manifest = routes.map(r => ({ pattern: r.pattern, params: r.params, dir: r.dir, hasApi: r.hasApi }));
    const data = { path, params, body, manifest, basePath };

    const headers = { 'content-type': 'text/html', ...apiRes.takeHeaders() };
    const cookies = withFlashClear(apiReq, apiRes.takeCookies());
    if (cookies.length) headers['set-cookie'] = cookies;
    apiRes.markSent();
    res.writeHead(apiRes.status() ?? 200, headers);
    res.end(renderShell({ appHtml, importMap, data, head: body.head, basePath }));
}

async function streamData(baseDir, path, url, req, res) {
    const routes = await scanRoutes(baseDir);
    const match = matchPath(routes, path);
    if (!match) {
        res.writeHead(404, { 'content-type': 'application/x-ndjson' });
        return res.end();
    }

    const { route, params } = match;
    const query = parseQuery(url.search);
    const apiFn = await loadApi(baseDir, route);
    const basePath = getBasePath(req);

    let reqBody;
    try {
        reqBody = await readRequestBody(req, path);
    } catch (err) {
        if (err && err.code === 'PAYLOAD_TOO_LARGE') {
            logRouterWarning('payload too large', { method: req?.method, path });
            res.writeHead(413, { 'content-type': 'text/plain' });
            return res.end('Payload Too Large');
        }
        throw err;
    }

    const apiReq = buildApiRequest(req, path, params, query, reqBody);
    const apiRes = createApiResponse(basePath);

    if (!apiFn) {
        res.writeHead(200, {
            'content-type': 'application/x-ndjson',
            'cache-control': 'no-store',
        });
        res.write(JSON.stringify({}) + '\n');
        return res.end();
    }

    const flushHeaders = () => {
        const headers = {
            'content-type': 'application/x-ndjson',
            'cache-control': 'no-store',
            ...apiRes.takeHeaders(),
        };
        const cookies = withFlashClear(apiReq, apiRes.takeCookies());
        if (cookies.length) headers['set-cookie'] = cookies;
        apiRes.markSent();
        res.writeHead(apiRes.status() ?? 200, headers);
    };

    try {
        const result = apiFn(apiReq, apiRes);
        if (isAsyncIterable(result)) {
            let headersFlushed = false;
            for await (const chunk of result) {
                if (!headersFlushed) { flushHeaders(); headersFlushed = true; }
                res.write(JSON.stringify(chunk) + '\n');
            }
            if (!headersFlushed) flushHeaders();
        } else {
            const value = await result;
            flushHeaders();
            res.write(JSON.stringify(value) + '\n');
        }
        res.end();
    } catch (err) {
        if (err instanceof Redirect) {
            if (!res.headersSent) {
                const headers = {
                    'content-type': 'application/x-ndjson',
                    'cache-control': 'no-store',
                };
                const cookies = withFlashClear(apiReq, apiRes.takeCookies());
                if (cookies.length) headers['set-cookie'] = cookies;
                res.writeHead(200, headers);
            }
            res.write(JSON.stringify({ __redirect: err.path }) + '\n');
            return res.end();
        }
        throw err;
    }
}

const FLASH_COOKIE = '_flash';

function buildApiRequest(req, path, params, query, body) {
    const cookies = parseCookies(req.headers.cookie);
    let files = {};
    let cleanBody = body;
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, '__files')) {
        files = body.__files || {};
        const { __files: _ignored, ...rest } = body;
        cleanBody = rest;
    }
    return {
        method: req.method,
        path,
        params,
        query,
        body: cleanBody,
        files,
        headers: copyHeaders(req.headers),
        cookies,
        flash: readFlash(cookies),
    };
}

function readFlash(cookies) {
    const raw = cookies && cookies[FLASH_COOKIE];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
            return { kind: parsed.kind, message: String(parsed.message ?? '') };
        }
    } catch {}
    return null;
}

function clearFlashCookie() {
    return serializeCookie(FLASH_COOKIE, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax' });
}

// Prepend a flash-clear cookie when the inbound request had one. Browsers honour
// the latest Set-Cookie header per name in a response, so a clear at the front
// stays out of the way of a fresh res.flash() set later in the same response.
function withFlashClear(apiReq, cookies) {
    if (!apiReq || !apiReq.flash) return cookies;
    return [clearFlashCookie(), ...cookies];
}

function copyHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (Array.isArray(value)) {
            out[name] = value.slice();
            continue;
        }
        if (typeof value === 'string' || value == null) {
            out[name] = value;
        }
    }
    return out;
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (!name) continue;
        try { out[name] = decodeURIComponent(raw); }
        catch { out[name] = raw; }
    }
    return out;
}

function extractBoundary(contentType) {
    const match = /;\s*boundary=("?)([^";\s]+)\1/i.exec(contentType);
    return match ? match[2] : null;
}

function indexOfBuffer(haystack, needle, offset = 0) {
    const limit = haystack.length - needle.length;
    outer: for (let i = offset; i <= limit; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function parseMultipartParts(buffer, boundary) {
    const fields = {};
    const files = {};
    const crlfBuf = Buffer.from('\r\n');
    const crlfcrlfBuf = Buffer.from('\r\n\r\n');
    const firstDelimiter = Buffer.from(`--${boundary}`);
    const innerDelimiter = Buffer.concat([crlfBuf, firstDelimiter]);

    let pos = indexOfBuffer(buffer, firstDelimiter, 0);
    if (pos === -1) return { fields, files };
    pos += firstDelimiter.length;

    while (pos < buffer.length) {
        // After boundary: \r\n (part continues) or -- (end marker)
        if (buffer[pos] === 45 && buffer[pos + 1] === 45) break;
        if (buffer[pos] !== 13 || buffer[pos + 1] !== 10) break;
        pos += 2;

        const headerEnd = indexOfBuffer(buffer, crlfcrlfBuf, pos);
        if (headerEnd === -1) break;

        const headerText = buffer.slice(pos, headerEnd).toString('latin1');
        pos = headerEnd + 4;

        const nextBoundary = indexOfBuffer(buffer, innerDelimiter, pos);
        const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary;
        const data = buffer.slice(pos, dataEnd);

        const headers = {};
        for (const line of headerText.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim();
        }

        const disposition = headers['content-disposition'] || '';
        const nameMatch = /\bname="([^"]*)"/.exec(disposition);
        const filenameMatch = /\bfilename="([^"]*)"/.exec(disposition);
        const fieldName = nameMatch ? nameMatch[1] : null;
        const fileName = filenameMatch ? filenameMatch[1] : null;
        const partContentType = headers['content-type'] || '';

        if (fieldName !== null) {
            if (fileName !== null) {
                files[fieldName] = { name: fileName, type: partContentType || 'application/octet-stream', data };
            } else {
                fields[fieldName] = data.toString('utf8');
            }
        }

        if (nextBoundary === -1) break;
        pos = nextBoundary + innerDelimiter.length;
    }

    return { fields, files };
}

async function readRequestBody(req, path = '') {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return null;
    const rawContentType = req.headers['content-type'] || '';
    const contentType = rawContentType.split(';')[0].trim().toLowerCase();

    if (contentType === MULTIPART_CONTENT_TYPE) {
        const boundary = extractBoundary(rawContentType);
        if (!boundary) {
            logRouterWarning('multipart/form-data missing boundary; body ignored', { method, path });
            req.resume();
            return null;
        }
        let total = 0;
        const chunks = [];
        for await (const chunk of req) {
            total += chunk.length;
            if (total > MAX_MULTIPART_BYTES) {
                const err = new Error('Payload Too Large');
                err.code = 'PAYLOAD_TOO_LARGE';
                throw err;
            }
            chunks.push(chunk);
        }
        if (total === 0) return null;
        const buffer = Buffer.concat(chunks);
        const { fields, files } = parseMultipartParts(buffer, boundary);
        return Object.keys(files).length > 0 ? { ...fields, __files: files } : { ...fields };
    }

    if (contentType !== JSON_CONTENT_TYPE && contentType !== FORM_URLENCODED) {
        if (requestMayHaveBody(req)) {
            logRouterWarning('unsupported request content-type; body ignored', { method, path, contentType });
        }
        // Drain so the connection isn't left half-read, but don't expose the bytes.
        req.resume();
        return null;
    }

    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            const err = new Error('Payload Too Large');
            err.code = 'PAYLOAD_TOO_LARGE';
            throw err;
        }
        chunks.push(chunk);
    }
    if (total === 0) return null;
    const text = Buffer.concat(chunks).toString('utf8');

    if (contentType === JSON_CONTENT_TYPE) {
        try {
            return JSON.parse(text);
        } catch {
            logRouterWarning('invalid JSON body; body ignored', { method, path });
            return null;
        }
    }
    return Object.fromEntries(new URLSearchParams(text));
}

function requestMayHaveBody(req) {
    const contentLength = req.headers['content-length'];
    const transferEncoding = req.headers['transfer-encoding'];
    const declaredLength = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
    return declaredLength > 0 || Boolean(transferEncoding);
}

function createApiResponse(basePath) {
    let status = null;
    const headers = {};
    const cookies = [];
    let sent = false;

    return {
        setStatus(code) {
            if (sent) { console.warn('setStatus called after response started; ignoring'); return; }
            status = code;
        },
        setHeader(name, value) {
            if (sent) { console.warn('setHeader called after response started; ignoring'); return; }
            headers[String(name).toLowerCase()] = value;
        },
        setCookie(name, value, opts) {
            if (sent) { console.warn('setCookie called after response started; ignoring'); return; }
            cookies.push(serializeCookie(name, value, opts));
        },
        flash(kind, message) {
            if (sent) { console.warn('flash called after response started; ignoring'); return; }
            const payload = JSON.stringify({
                kind: String(kind || 'info'),
                message: String(message ?? ''),
            });
            cookies.push(serializeCookie(FLASH_COOKIE, payload, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
            }));
        },
        redirect(to, opts) {
            throw new Redirect(toBrowserPath(to, basePath), !!(opts && opts.permanent));
        },
        status() { return status; },
        takeHeaders() { const h = headers; return { ...h }; },
        takeCookies() { return cookies.slice(); },
        markSent() { sent = true; },
    };
}

function serializeCookie(name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.domain) parts.push(`Domain=${opts.domain}`);
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.expires instanceof Date) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) {
        const v = opts.sameSite.toLowerCase();
        const map = { strict: 'Strict', lax: 'Lax', none: 'None' };
        if (map[v]) parts.push(`SameSite=${map[v]}`);
    }
    return parts.join('; ');
}

function serverRouter(path, basePath) {
    return {
        path,
        push: target => { throw new Redirect(toBrowserPath(target, basePath)); },
        replace: target => { throw new Redirect(toBrowserPath(target, basePath), true); },
    };
}

function buildAnalyticsScript() {
    const src = process.env.UMAMI_SCRIPT_URL;
    const websiteId = process.env.UMAMI_WEBSITE_ID;
    if (!src || !websiteId) return '';
    return `<script defer src="${escapeHtml(src)}" data-website-id="${escapeHtml(websiteId)}"></script>`;
}

function renderShell({ appHtml, importMap, data, head, basePath }) {
    const json = JSON.stringify(data).replaceAll('<', '\\u003c');
    const title = (head && typeof head.title === 'string' && head.title) || 'last-router';
    const browserImportMap = prefixImportMap(importMap, basePath);
    const analyticsScript = buildAnalyticsScript();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script type="importmap">${JSON.stringify({ imports: browserImportMap })}</script>
${analyticsScript ? analyticsScript + '\n' : ''}</head>
<body>
<div id="app">${appHtml}</div>
<div id="__portal_root"></div>
<script type="application/json" id="__last_router_data">${json}</script>
<script type="module" src="${escapeHtml(prefixInternalAssetPath('/__router/client.js', basePath))}"></script>
</body>
</html>`;
}

function prefixImportMap(importMap, basePath) {
    return Object.fromEntries(
        Object.entries(importMap).map(([key, value]) => [key, prefixInternalAssetPath(value, basePath)]),
    );
}

function getBasePath(req) {
    const header = req.headers['x-forwarded-prefix'];
    if (Array.isArray(header)) {
        return normalizeBasePath(header[0]);
    }
    return normalizeBasePath(header);
}

function toBrowserPath(target, basePath) {
    const normalizedBasePath = normalizeBasePath(basePath);
    const value = String(target || '');
    if (!normalizedBasePath || !value.startsWith('/')) {
        return value || '/';
    }
    if (value === normalizedBasePath || value.startsWith(normalizedBasePath + '/')) {
        return value;
    }
    return `${normalizedBasePath}${value === '/' ? '' : value}`;
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function sendHealth(res) {
    res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end('ok');
}

function defaultImports(baseDir) {
    const nm = findNodeModules(baseDir);
    if (!nm) return {};
    const imports = {};
    for (const pkg of ['@incremental-code/last-act', 'signal-polyfill']) {
        const pkgJsonPath = join(nm, pkg, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;
        const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const entry = meta.module || meta.main || 'index.js';
        imports[pkg] = '/__module/' + pkg + '/' + entry;
    }
    return imports;
}

function findNodeModules(start) {
    let dir = start;
    while (true) {
        const candidate = join(dir, 'node_modules');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

async function serveUnder(base, sub, res) {
    if (!base) return notFound(res);
    const resolved = resolve(base, decodeURIComponent(sub));
    if (resolved !== base && !resolved.startsWith(base + sep)) return notFound(res);
    return sendFile(resolved, res);
}

async function sendFile(absPath, res) {
    try {
        const data = await readFile(absPath);
        res.writeHead(200, { 'content-type': MIME[extname(absPath)] || 'application/octet-stream' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
}

function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>404</h1>');
}

function isAsyncIterable(x) {
    return !!x && typeof x[Symbol.asyncIterator] === 'function';
}

function logRouterWarning(event, context = {}) {
    console.warn(`[last-router] ${event}`, context);
}

function logRouterError(event, err, context = {}) {
    console.error(`[last-router] ${event}`, {
        ...context,
        error: serializeError(err),
    });
}

function serializeError(err) {
    if (!err || typeof err !== 'object') {
        return { message: String(err || '') };
    }
    return {
        name: err.name || 'Error',
        message: err.message || '',
        stack: err.stack || '',
    };
}
