// Shared HTML shell, import-map, and static-asset helpers.
//
// Both the dev server (server.js) and the AWS Lambda adapter (lambda.js) render
// pages through the SAME shell so a server-rendered page hydrates identically in
// either environment: same import map, same `__last_router_data` boot payload,
// same portal root, same `/__router/client.js` module entry. Keeping this in one
// place is what prevents the two adapters from drifting apart.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBasePath, prefixInternalAssetPath } from './common.js';

export const HERE = dirname(fileURLToPath(import.meta.url));

export const MIME = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

/**
 * Render the full HTML document that boots and hydrates a page. The `client.js`
 * module reads `#__last_router_data`, resolves bare specifiers through the inline
 * import map, and hydrates `#app`, so all three must ship together.
 */
export function renderShell({ appHtml, importMap, data, head, basePath }) {
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

function buildAnalyticsScript() {
    const src = process.env.UMAMI_SCRIPT_URL;
    const websiteId = process.env.UMAMI_WEBSITE_ID;
    if (!src || !websiteId) return '';
    return `<script defer src="${escapeHtml(src)}" data-website-id="${escapeHtml(websiteId)}"></script>`;
}

export function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * Base import map every page needs in the browser: last-act and its
 * signal-polyfill peer, resolved to `/__module/` URLs the router serves.
 */
export function defaultImports(baseDir) {
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

export function findNodeModules(start) {
    let dir = start;
    while (true) {
        const candidate = join(dir, 'node_modules');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Resolve `sub` under `base`, returning `null` if the result escapes `base`
 * (path-traversal guard). Shared by both adapters' `/__src/`, `/__module/`, and
 * `/__router/` handlers.
 */
export function resolveSafe(base, sub) {
    if (!base) return null;
    const resolved = resolve(base, decodeURIComponent(sub));
    if (resolved !== base && !resolved.startsWith(base + sep)) return null;
    return resolved;
}
