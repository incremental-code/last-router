var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement, serialize } from "@incremental-code/last-act";
import {
  buildRoute,
  makeBodySignals,
  matchPath,
  normalizeBasePath
} from "./common.js";
import {
  HERE,
  MIME,
  defaultImports,
  findNodeModules,
  renderShell,
  resolveSafe
} from "./shell.js";
class Redirect extends Error {
  constructor(path, permanent = false) {
    super("Redirect");
    __publicField(this, "path", path);
    __publicField(this, "permanent", permanent);
  }
}
const SSR_DRAIN_MS = 1e3;
const FLASH_COOKIE = "_flash";
async function scanRoutes(baseDir) {
  const routes = [];
  async function walk(dir, segments) {
    const entries = await readdir(dir, { withFileTypes: true });
    const hasPage = entries.some((e) => e.isFile() && e.name === "page.js");
    const hasApi = entries.some((e) => e.isFile() && e.name === "api.js");
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
  const apiPath = join(baseDir, route.dir, "api.js");
  const mod = await import(pathToFileURL(apiPath).href);
  return mod.default;
}
async function loadPage(baseDir, route) {
  const pagePath = join(baseDir, route.dir, "page.js");
  const mod = await import(pathToFileURL(pagePath).href);
  return mod.default;
}
function createApiResponse() {
  let status = null;
  const headers = {};
  const cookies = [];
  let sent = false;
  return {
    setStatus(code) {
      if (sent) return;
      status = code;
    },
    setHeader(name, value) {
      if (sent) return;
      headers[String(name).toLowerCase()] = value;
    },
    setCookie(name, value, opts = {}) {
      if (sent) return;
      cookies.push(serializeCookie(name, value, opts));
    },
    flash(kind, message) {
      if (sent) return;
      const payload = JSON.stringify({
        kind: String(kind || "info"),
        message: String(message ?? "")
      });
      cookies.push(serializeCookie(FLASH_COOKIE, payload, {
        path: "/",
        httpOnly: true,
        sameSite: "lax"
      }));
    },
    redirect(to, opts) {
      // Mirrors the dev server's res.redirect: throw a Redirect so the handler
      // stops the api and emits a 301/302 (with any cookies set so far). Apis
      // rely on this aborting — e.g. `if (!session) res.redirect('/signin')`.
      throw new Redirect(to, !!(opts && opts.permanent));
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
    }
  };
}
function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires instanceof Date) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) {
    const v = opts.sameSite.toLowerCase();
    const map = { strict: "Strict", lax: "Lax", none: "None" };
    if (map[v]) parts.push(`SameSite=${map[v]}`);
  }
  return parts.join("; ");
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
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
function buildApiRequest(event, path, params, query, body) {
  const cookies = parseCookies(event.headers.cookie);
  let files = {};
  let cleanBody = body;
  if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "__files")) {
    files = body.__files || {};
    const { __files: _ignored, ...rest } = body;
    cleanBody = rest;
  }
  return {
    method: event.httpMethod || "GET",
    path,
    params,
    query,
    body: cleanBody,
    files,
    headers: copyHeaders(event.headers),
    cookies,
    flash: readFlash(cookies)
  };
}
function copyHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      out[name] = value.slice();
      continue;
    }
    if (typeof value === "string" || value == null) {
      out[name] = value || "";
    }
  }
  return out;
}
function readFlash(cookies) {
  const raw = cookies && cookies[FLASH_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
      return { kind: parsed.kind, message: String(parsed.message ?? "") };
    }
  } catch {
  }
  return null;
}
async function runApi(apiFn, req, res) {
  if (!apiFn) return {};
  const result = apiFn(req, res);
  if (isAsyncIterable(result)) {
    const body = {};
    await drainForSsr(result, body, SSR_DRAIN_MS);
    return body;
  } else {
    return await result;
  }
}
async function drainForSsr(iterable, body, timeoutMs) {
  const iter = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = iter.next();
      const timer = new Promise((resolve2) => setTimeout(() => resolve2("__ssr_timeout"), remaining));
      const winner = await Promise.race([next, timer]);
      if (winner === "__ssr_timeout") break;
      if (winner.done) break;
      if (winner.value) Object.assign(body, winner.value);
    }
  } finally {
    if (typeof iter.return === "function") {
      await iter.return().catch(() => {
      });
    }
  }
}
function isAsyncIterable(obj) {
  return obj && typeof obj[Symbol.asyncIterator] === "function";
}
function withFlashClear(apiReq, cookies) {
  if (!apiReq || !apiReq.flash) return cookies;
  const clearCookie = serializeCookie(FLASH_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax"
  });
  return [clearCookie, ...cookies];
}
function formatHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}
function lowerHeaderKeys(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}
// API Gateway proxy (payload format 1.0) requires every `headers` value to be a
// string, so repeated Set-Cookie headers must travel in `multiValueHeaders`.
// Putting an array under `headers['set-cookie']` makes API Gateway reject the
// whole response with a 500 — silently breaking every cookie-setting flow
// (sessions, sign-in/out, flash). Spread the result into the response object.
function cookieHeaders(cookies) {
  return cookies && cookies.length ? { multiValueHeaders: { "set-cookie": cookies } } : {};
}
function createLambdaHandler(options = {}) {
  const baseDir = resolve(process.cwd(), options.base || "src");
  const importMap = { ...defaultImports(baseDir), ...(options.imports || {}) };
  return async (event) => {
    try {
      // Normalize header keys to lowercase once. API Gateway proxy events (REST
      // v1 and HTTP API payload format 1.0) deliver headers with their original
      // case (e.g. `Cookie`, `Content-Type`), but the adapter and app read them
      // lowercase (`event.headers.cookie`). Without this, cookies never parse and
      // sessions silently fail (every members-area route bounces to sign-in).
      if (event.headers) event.headers = lowerHeaderKeys(event.headers);
      const path = event.path || "/";
      const basePath = getBasePath(event);
      if (path === "/health") {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "ok" })
        };
      }
      // Hydration runtime + assets. These mirror the prefixes last-router's dev
      // server exposes (server.js), so a page rendered here boots the client
      // bundle, resolves bare specifiers via the inline import map, and hydrates
      // #app exactly as it does under `last-server`.
      if (path === "/__router/client.js") return serveAsset(join(HERE, "client.js"));
      if (path === "/__router/common.js") return serveAsset(join(HERE, "common.js"));
      if (path.startsWith("/__module/")) return serveUnder(findNodeModules(baseDir), path.slice("/__module/".length));
      if (path.startsWith("/__src/")) return serveUnder(baseDir, path.slice("/__src/".length));
      if (path.startsWith("/__data")) return handleData(baseDir, path.slice("/__data".length) || "/", event, basePath);

      const routes = await scanRoutes(baseDir);
      const match = matchPath(routes, path);
      if (!match) {
        return {
          statusCode: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "Not Found" })
        };
      }
      const { route, params } = match;
      const query = formatQuery(event.queryStringParameters);
      const reqBody = parseEventBody(event);
      const apiReq = buildApiRequest(event, path, params, query, reqBody);
      const apiRes = createApiResponse();
      if (!route.hasPage) {
        try {
          const apiFn = await loadApi(baseDir, route);
          const jsonBody = apiFn ? await runApi(apiFn, apiReq, apiRes) : {};
          const headers2 = formatHeaders({
            "content-type": "application/json",
            ...apiRes.takeHeaders()
          });
          const cookies2 = withFlashClear(apiReq, apiRes.takeCookies());
          apiRes.markSent();
          return {
            statusCode: apiRes.status() ?? 200,
            headers: headers2,
            ...cookieHeaders(cookies2),
            body: JSON.stringify(jsonBody ?? null)
          };
        } catch (err) {
          if (err instanceof Redirect) {
            const headers2 = formatHeaders({ location: err.path });
            const cookies2 = withFlashClear(apiReq, apiRes.takeCookies());
            return {
              statusCode: err.permanent ? 301 : 302,
              headers: headers2,
              ...cookieHeaders(cookies2),
              body: ""
            };
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
          const headers2 = formatHeaders({ location: err.path });
          const cookies2 = withFlashClear(apiReq, apiRes.takeCookies());
          return {
            statusCode: err.permanent ? 301 : 302,
            headers: headers2,
            ...cookieHeaders(cookies2),
            body: ""
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
      const manifest = routes.map((r) => ({
        pattern: r.pattern,
        params: r.params,
        dir: r.dir,
        hasApi: r.hasApi
      }));
      const data = { path, params, body, manifest, basePath };
      const headers = formatHeaders({
        "content-type": "text/html",
        ...apiRes.takeHeaders()
      });
      const cookies = withFlashClear(apiReq, apiRes.takeCookies());
      apiRes.markSent();
      const html = renderShell({ appHtml, importMap, data, head: body.head, basePath });
      return {
        statusCode: apiRes.status() ?? 200,
        headers,
        ...cookieHeaders(cookies),
        body: html
      };
    } catch (err) {
      console.error("Lambda handler error:", err);
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err)
        })
      };
    }
  };
}
function formatQuery(params) {
  const out = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    out[key] = value;
  }
  return out;
}
function lambdaRouter(path) {
  return {
    path,
    push(target) {
      throw new Redirect(target, false);
    },
    replace(target) {
      throw new Redirect(target, true);
    }
  };
}
function getBasePath(event) {
  const headers = event.headers || {};
  let value = headers["x-forwarded-prefix"];
  if (value === void 0) {
    for (const [name, headerValue] of Object.entries(headers)) {
      if (name.toLowerCase() === "x-forwarded-prefix") {
        value = headerValue;
        break;
      }
    }
  }
  if (Array.isArray(value)) value = value[0];
  return normalizeBasePath(value);
}
function parseEventBody(event) {
  const method = event.httpMethod || "GET";
  if (method === "GET" || method === "HEAD" || !event.body) return null;
  try {
    const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
    const headers = event.headers || {};
    const contentType = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
    if (contentType.includes("application/json")) {
      return JSON.parse(bodyStr);
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(bodyStr));
    }
    return bodyStr;
  } catch {
    return event.body;
  }
}
function isTextType(type) {
  return type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";
}
async function serveAsset(absPath) {
  try {
    const data = await readFile(absPath);
    const type = MIME[extname(absPath)] || "application/octet-stream";
    const isText = isTextType(type);
    return {
      statusCode: 200,
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=3600"
      },
      body: isText ? data.toString("utf8") : data.toString("base64"),
      isBase64Encoded: !isText
    };
  } catch {
    return {
      statusCode: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found"
    };
  }
}
async function serveUnder(base, sub) {
  const resolved = resolveSafe(base, sub);
  if (!resolved) {
    return {
      statusCode: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found"
    };
  }
  return serveAsset(resolved);
}
// Buffered equivalent of server.js's `/__data` NDJSON stream. Lambda can't hold a
// long-lived stream open, so we drain the api (async iterables up to SSR_DRAIN_MS,
// same budget the page render uses) and return every chunk as one NDJSON line. The
// client merges them exactly as it would from the live dev-server stream.
async function handleData(baseDir, dataPath, event, basePath) {
  const ndjson = { "content-type": "application/x-ndjson", "cache-control": "no-store" };
  const routes = await scanRoutes(baseDir);
  const match = matchPath(routes, dataPath);
  if (!match) {
    return { statusCode: 404, headers: ndjson, body: "" };
  }
  const { route, params } = match;
  const query = formatQuery(event.queryStringParameters);
  const reqBody = parseEventBody(event);
  const apiReq = buildApiRequest(event, dataPath, params, query, reqBody);
  const apiRes = createApiResponse();
  const apiFn = await loadApi(baseDir, route);

  if (!apiFn) {
    return { statusCode: 200, headers: ndjson, body: JSON.stringify({}) + "\n" };
  }

  const finish = (chunks) => {
    const headers = formatHeaders({ ...ndjson, ...apiRes.takeHeaders() });
    const cookies = withFlashClear(apiReq, apiRes.takeCookies());
    apiRes.markSent();
    return {
      statusCode: apiRes.status() ?? 200,
      headers,
      ...cookieHeaders(cookies),
      body: chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n"
    };
  };

  try {
    const result = apiFn(apiReq, apiRes);
    if (isAsyncIterable(result)) {
      const chunks = await drainChunks(result, SSR_DRAIN_MS);
      return finish(chunks.length ? chunks : [{}]);
    }
    const value = await result;
    return finish([value ?? {}]);
  } catch (err) {
    if (err instanceof Redirect) {
      return { statusCode: 200, headers: ndjson, body: JSON.stringify({ __redirect: err.path }) + "\n" };
    }
    throw err;
  }
}
// Like drainForSsr, but keeps each yielded chunk as its own NDJSON line instead of
// merging them, so streamed apis reach the client as discrete updates.
async function drainChunks(iterable, timeoutMs) {
  const iter = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  const chunks = [];
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = iter.next();
      const timer = new Promise((resolve2) => setTimeout(() => resolve2("__ssr_timeout"), remaining));
      const winner = await Promise.race([next, timer]);
      if (winner === "__ssr_timeout") break;
      if (winner.done) break;
      if (winner.value) chunks.push(winner.value);
    }
  } finally {
    if (typeof iter.return === "function") {
      await iter.return().catch(() => {
      });
    }
  }
  return chunks;
}
export {
  createLambdaHandler
};
