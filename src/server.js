import { createServer as createHttpServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, serialize } from '@incremental-code/last-act';
import { buildRoute, matchPath, parseQuery } from './common.js';

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

export function createServer({ port = 3000, base = 'src', imports = {} } = {}) {
    const baseDir = resolve(process.cwd(), base);
    const importMap = { ...defaultImports(baseDir), ...imports };

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const path = url.pathname;

            if (path === '/__router/client.js') return sendFile(join(HERE, 'client.js'), res);
            if (path === '/__router/common.js') return sendFile(join(HERE, 'common.js'), res);
            if (path.startsWith('/__module/')) return serveModule(baseDir, decodeURIComponent(path.slice('/__module/'.length)), res);
            if (path.startsWith('/__src/')) return sendFile(join(baseDir, decodeURIComponent(path.slice('/__src/'.length))), res);
            if (path.startsWith('/__data')) return streamData(baseDir, path.slice('/__data'.length) || '/', url, res);

            return renderPage(baseDir, importMap, path, url, res);
        } catch (err) {
            console.error(err);
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(`Internal Server Error: ${err.message}`);
        }
    };

    const server = createHttpServer(handler);

    return {
        connect() {
            return new Promise((res, rej) => {
                server.once('error', rej);
                server.listen(port, () => res({ url: `http://localhost:${port}` }));
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
        if (entries.some(e => e.isFile() && e.name === 'page.js')) {
            const route = buildRoute(segments);
            route.hasApi = entries.some(e => e.isFile() && e.name === 'api.js');
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

async function runApi(apiFn, context) {
    const body = {};
    if (!apiFn) return body;

    const result = apiFn(context);
    if (isAsyncIterable(result)) {
        for await (const chunk of result) Object.assign(body, chunk);
    } else {
        Object.assign(body, await result);
    }
    return body;
}

async function renderPage(baseDir, importMap, path, url, res) {
    const routes = await scanRoutes(baseDir);
    const match = matchPath(routes, path);
    if (!match) return notFound(res);

    const { route, params } = match;
    const query = parseQuery(url.search);
    const router = serverRouter(path);

    let body = {};
    try {
        const apiFn = await loadApi(baseDir, route);
        body = await runApi(apiFn, { router, params, query });
    } catch (err) {
        if (err instanceof Redirect) {
            res.writeHead(err.permanent ? 301 : 302, { location: err.path });
            return res.end();
        }
        throw err;
    }

    const Page = await loadPage(baseDir, route);
    const appHtml = serialize(createElement(Page, { router, params, body }));

    const manifest = routes.map(r => ({ pattern: r.pattern, params: r.params, dir: r.dir, hasApi: r.hasApi }));
    const data = { path, params, body, manifest };

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(renderShell({ appHtml, importMap, data }));
}

async function streamData(baseDir, path, url, res) {
    const routes = await scanRoutes(baseDir);
    const match = matchPath(routes, path);
    if (!match) {
        res.writeHead(404, { 'content-type': 'application/x-ndjson' });
        return res.end();
    }

    const { route, params } = match;
    const query = parseQuery(url.search);
    const router = serverRouter(path);
    const apiFn = await loadApi(baseDir, route);

    res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
    });

    if (!apiFn) {
        res.write(JSON.stringify({}) + '\n');
        return res.end();
    }

    try {
        const result = apiFn({ router, params, query });
        if (isAsyncIterable(result)) {
            for await (const chunk of result) res.write(JSON.stringify(chunk) + '\n');
        } else {
            res.write(JSON.stringify(await result) + '\n');
        }
        res.end();
    } catch (err) {
        if (err instanceof Redirect) {
            res.write(JSON.stringify({ __redirect: err.path }) + '\n');
            return res.end();
        }
        throw err;
    }
}

function serverRouter(path) {
    return {
        path,
        push: target => { throw new Redirect(target); },
        replace: target => { throw new Redirect(target, true); },
    };
}

function renderShell({ appHtml, importMap, data }) {
    const json = JSON.stringify(data).replaceAll('<', '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>last-router</title>
<script type="importmap">${JSON.stringify({ imports: importMap })}</script>
</head>
<body>
<div id="app">${appHtml}</div>
<script type="application/json" id="__last_router_data">${json}</script>
<script type="module" src="/__router/client.js"></script>
</body>
</html>`;
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

async function serveModule(baseDir, sub, res) {
    const nm = findNodeModules(baseDir);
    if (!nm) return notFound(res);
    return sendFile(join(nm, sub), res);
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
