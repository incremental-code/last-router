import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, serialize } from '@incremental-code/last-act';
import {
    buildRoute,
    makeBodySignals,
    matchPath,
} from './common.js';

/**
 * AWS Lambda handler for last-router filesystem-based routing.
 * 
 * Usage:
 *   import { createLambdaHandler } from '@incremental-code/last-router/lambda';
 *   
 *   const handler = createLambdaHandler({ base: '../src', importMap: {} });
 *   export { handler };
 */

export interface LambdaEvent {
    path: string;
    httpMethod: string;
    headers: Record<string, string>;
    queryStringParameters?: Record<string, string> | null;
    body?: string | null;
    isBase64Encoded?: boolean;
    requestContext?: {
        requestId?: string;
        [key: string]: any;
    };
}

export interface LambdaResponse {
    statusCode: number;
    headers: Record<string, string | string[]>;
    body: string;
    isBase64Encoded?: boolean;
}

export interface ApiRequest {
    method: string;
    path: string;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    body: any;
    files: Record<string, any>;
    headers: Record<string, string | string[]>;
    cookies: Record<string, string>;
    flash: { kind: string; message: string } | null;
}

interface ApiResponse {
    setStatus(code: number): void;
    setHeader(name: string, value: string | string[]): void;
    setCookie(name: string, value: string, opts?: any): void;
    flash(kind: string, message: string): void;
    status(): number | null;
    takeHeaders(): Record<string, string | string[]>;
    takeCookies(): string[];
    markSent(): void;
}

interface Route {
    pattern: string;
    params: string[];
    dir: string;
    hasApi?: boolean;
    hasPage?: boolean;
}

class Redirect extends Error {
    constructor(public path: string, public permanent: boolean = false) {
        super('Redirect');
    }
}

const SSR_DRAIN_MS = 1000;
const FLASH_COOKIE = '_flash';

async function scanRoutes(baseDir: string): Promise<Route[]> {
    const routes: Route[] = [];
    async function walk(dir: string, segments: string[]) {
        const entries = await readdir(dir, { withFileTypes: true });
        const hasPage = entries.some(e => e.isFile() && e.name === 'page.js');
        const hasApi = entries.some(e => e.isFile() && e.name === 'api.js');
        if (hasPage || hasApi) {
            const route = buildRoute(segments) as Route;
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

async function loadApi(baseDir: string, route: Route): Promise<any> {
    if (!route.hasApi) return null;
    const apiPath = join(baseDir, route.dir, 'api.js');
    const mod = await import(pathToFileURL(apiPath).href);
    return mod.default;
}

async function loadPage(baseDir: string, route: Route): Promise<any> {
    const pagePath = join(baseDir, route.dir, 'page.js');
    const mod = await import(pathToFileURL(pagePath).href);
    return mod.default;
}

function createApiResponse(): ApiResponse {
    let status: number | null = null;
    const headers: Record<string, string | string[]> = {};
    const cookies: string[] = [];
    let sent = false;

    return {
        setStatus(code: number) {
            if (sent) return;
            status = code;
        },
        setHeader(name: string, value: string | string[]) {
            if (sent) return;
            headers[String(name).toLowerCase()] = value;
        },
        setCookie(name: string, value: string, opts: any = {}) {
            if (sent) return;
            cookies.push(serializeCookie(name, value, opts));
        },
        flash(kind: string, message: string) {
            if (sent) return;
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
        status() {
            return status;
        },
        takeHeaders() {
            return { ...headers };
        },
        takeCookies() {
            return cookies.slice();
        },
        markSent() {
            sent = true;
        },
    };
}

function serializeCookie(name: string, value: string, opts: any = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.domain) parts.push(`Domain=${opts.domain}`);
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.expires instanceof Date) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) {
        const v = opts.sameSite.toLowerCase();
        const map: Record<string, string> = { strict: 'Strict', lax: 'Lax', none: 'None' };
        if (map[v]) parts.push(`SameSite=${map[v]}`);
    }
    return parts.join('; ');
}

function parseCookies(header?: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (!name) continue;
        try {
            out[name] = decodeURIComponent(raw);
        } catch {
            out[name] = raw;
        }
    }
    return out;
}

function buildApiRequest(
    event: LambdaEvent,
    path: string,
    params: Record<string, string>,
    query: Record<string, string | string[]>,
    body: any
): ApiRequest {
    const cookies = parseCookies(event.headers.cookie);
    let files: Record<string, any> = {};
    let cleanBody = body;
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, '__files')) {
        files = body.__files || {};
        const { __files: _ignored, ...rest } = body;
        cleanBody = rest;
    }
    return {
        method: event.httpMethod || 'GET',
        path,
        params,
        query,
        body: cleanBody,
        files,
        headers: copyHeaders(event.headers),
        cookies,
        flash: readFlash(cookies),
    };
}

function copyHeaders(headers: Record<string, string | undefined>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (Array.isArray(value)) {
            out[name] = value.slice();
            continue;
        }
        if (typeof value === 'string' || value == null) {
            out[name] = value || '';
        }
    }
    return out;
}

function readFlash(cookies: Record<string, string>): { kind: string; message: string } | null {
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

async function runApi(apiFn: any, req: ApiRequest, res: ApiResponse): Promise<any> {
    if (!apiFn) return {};

    const result = apiFn(req, res);
    if (isAsyncIterable(result)) {
        const body: Record<string, any> = {};
        await drainForSsr(result, body, SSR_DRAIN_MS);
        return body;
    } else {
        return await result;
    }
}

async function drainForSsr(
    iterable: AsyncIterable<any>,
    body: Record<string, any>,
    timeoutMs: number
): Promise<void> {
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
            if ((winner as any).done) break;
            if ((winner as any).value) Object.assign(body, (winner as any).value);
        }
    } finally {
        if (typeof iter.return === 'function') {
            await iter.return().catch(() => {});
        }
    }
}

function isAsyncIterable(obj: any): obj is AsyncIterable<any> {
    return obj && typeof obj[Symbol.asyncIterator] === 'function';
}

function withFlashClear(apiReq: ApiRequest, cookies: string[]): string[] {
    if (!apiReq || !apiReq.flash) return cookies;
    const clearCookie = serializeCookie(FLASH_COOKIE, '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        sameSite: 'lax',
    });
    return [clearCookie, ...cookies];
}

function formatHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        out[name.toLowerCase()] = value;
    }
    return out;
}

export function createLambdaHandler(options: {
    base?: string;
    importMap?: Record<string, string>;
} = {}) {
    const baseDir = resolve(process.cwd(), options.base || 'src');

    return async (event: LambdaEvent): Promise<LambdaResponse> => {
        try {
            const path = event.path || '/';
            const method = event.httpMethod || 'GET';

            if (path === '/health') {
                return {
                    statusCode: 200,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ status: 'ok' }),
                };
            }

            const routes = await scanRoutes(baseDir);
            const match = matchPath(routes, path);

            if (!match) {
                return {
                    statusCode: 404,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ error: 'Not Found' }),
                };
            }

            const { route, params } = match;
            const query = formatQuery(event.queryStringParameters);
            let reqBody: any = null;

            if (method !== 'GET' && method !== 'HEAD' && event.body) {
                try {
                    const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
                    const contentType = (event.headers['content-type'] || '').toLowerCase();
                    if (contentType.includes('application/json')) {
                        reqBody = JSON.parse(bodyStr);
                    } else if (contentType.includes('application/x-www-form-urlencoded')) {
                        reqBody = Object.fromEntries(new URLSearchParams(bodyStr));
                    } else {
                        reqBody = bodyStr;
                    }
                } catch {
                    reqBody = event.body;
                }
            }

            const apiReq = buildApiRequest(event, path, params, query, reqBody);
            const apiRes = createApiResponse();

            // API-only routes (no page.js) return JSON directly
            if (!route.hasPage) {
                try {
                    const apiFn = await loadApi(baseDir, route);
                    const jsonBody = apiFn ? await runApi(apiFn, apiReq, apiRes) : {};
                    const headers = formatHeaders({
                        'content-type': 'application/json',
                        ...apiRes.takeHeaders(),
                    });
                    const cookies = withFlashClear(apiReq, apiRes.takeCookies());
                    if (cookies.length) {
                        headers['set-cookie'] = cookies;
                    }
                    apiRes.markSent();

                    return {
                        statusCode: apiRes.status() ?? 200,
                        headers,
                        body: JSON.stringify(jsonBody ?? null),
                    };
                } catch (err) {
                    if (err instanceof Redirect) {
                        const headers = formatHeaders({ location: err.path });
                        const cookies = withFlashClear(apiReq, apiRes.takeCookies());
                        if (cookies.length) {
                            headers['set-cookie'] = cookies;
                        }
                        return {
                            statusCode: err.permanent ? 301 : 302,
                            headers,
                            body: '',
                        };
                    }
                    throw err;
                }
            }

            // Routes with page.js - return rendered HTML
            let body: any = {};
            try {
                const apiFn = await loadApi(baseDir, route);
                body = await runApi(apiFn, apiReq, apiRes);
            } catch (err) {
                if (err instanceof Redirect) {
                    const headers = formatHeaders({ location: err.path });
                    const cookies = withFlashClear(apiReq, apiRes.takeCookies());
                    if (cookies.length) {
                        headers['set-cookie'] = cookies;
                    }
                    return {
                        statusCode: err.permanent ? 301 : 302,
                        headers,
                        body: '',
                    };
                }
                throw err;
            }

            const Page = await loadPage(baseDir, route);
            const router = lambdaRouter(path);
            const reactiveBody = makeBodySignals(body);
            const appHtml = serialize(
                createElement(Page, { router, params, body: reactiveBody })
            );

            const manifest = routes.map(r => ({
                pattern: r.pattern,
                params: r.params,
                dir: r.dir,
                hasApi: r.hasApi,
            }));
            const data = { path, params, body, manifest };

            const headers = formatHeaders({
                'content-type': 'text/html',
                ...apiRes.takeHeaders(),
            });
            const cookies = withFlashClear(apiReq, apiRes.takeCookies());
            if (cookies.length) {
                headers['set-cookie'] = cookies;
            }
            apiRes.markSent();

            const html = renderShell({ appHtml, data });
            return {
                statusCode: apiRes.status() ?? 200,
                headers,
                body: html,
            };
        } catch (err) {
            console.error('Lambda handler error:', err);
            return {
                statusCode: 500,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    error: 'Internal Server Error',
                    message: err instanceof Error ? err.message : String(err),
                }),
            };
        }
    };
}

function formatQuery(params?: Record<string, string> | null): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    if (!params) return out;
    for (const [key, value] of Object.entries(params)) {
        out[key] = value;
    }
    return out;
}

function lambdaRouter(path: string) {
    return {
        path,
        push(target: string) {
            throw new Redirect(target, false);
        },
        replace(target: string) {
            throw new Redirect(target, true);
        },
    };
}

function renderShell({ appHtml, data }: { appHtml: string; data: any }): string {
    const json = JSON.stringify(data).replaceAll('<', '\\u003c');
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${data.body?.head?.title || 'App'}</title>
    ${data.body?.head?.styles || ''}
</head>
<body>
    <div id="app">${appHtml}</div>
    <script>
        window.__ROUTE_DATA__ = ${json};
    </script>
    ${data.body?.head?.scripts || ''}
</body>
</html>`;
}

// For use in service index.js:
//   import { createLambdaHandler } from '@incremental-code/last-router/lambda';
//   export const handler = createLambdaHandler({ base: './src' });
