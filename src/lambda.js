var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement, serialize } from "@incremental-code/last-act";
import {
  buildRoute,
  makeBodySignals,
  matchPath
} from "./common.js";
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
function createLambdaHandler(options = {}) {
  const baseDir = resolve(process.cwd(), options.base || "src");
  return async (event) => {
    try {
      const path = event.path || "/";
      const method = event.httpMethod || "GET";
      if (path === "/health") {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "ok" })
        };
      }
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
      let reqBody = null;
      if (method !== "GET" && method !== "HEAD" && event.body) {
        try {
          const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
          const contentType = (event.headers["content-type"] || "").toLowerCase();
          if (contentType.includes("application/json")) {
            reqBody = JSON.parse(bodyStr);
          } else if (contentType.includes("application/x-www-form-urlencoded")) {
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
      if (!route.hasPage) {
        try {
          const apiFn = await loadApi(baseDir, route);
          const jsonBody = apiFn ? await runApi(apiFn, apiReq, apiRes) : {};
          const headers2 = formatHeaders({
            "content-type": "application/json",
            ...apiRes.takeHeaders()
          });
          const cookies2 = withFlashClear(apiReq, apiRes.takeCookies());
          if (cookies2.length) {
            headers2["set-cookie"] = cookies2;
          }
          apiRes.markSent();
          return {
            statusCode: apiRes.status() ?? 200,
            headers: headers2,
            body: JSON.stringify(jsonBody ?? null)
          };
        } catch (err) {
          if (err instanceof Redirect) {
            const headers2 = formatHeaders({ location: err.path });
            const cookies2 = withFlashClear(apiReq, apiRes.takeCookies());
            if (cookies2.length) {
              headers2["set-cookie"] = cookies2;
            }
            return {
              statusCode: err.permanent ? 301 : 302,
              headers: headers2,
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
          if (cookies2.length) {
            headers2["set-cookie"] = cookies2;
          }
          return {
            statusCode: err.permanent ? 301 : 302,
            headers: headers2,
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
      const data = { path, params, body, manifest };
      const headers = formatHeaders({
        "content-type": "text/html",
        ...apiRes.takeHeaders()
      });
      const cookies = withFlashClear(apiReq, apiRes.takeCookies());
      if (cookies.length) {
        headers["set-cookie"] = cookies;
      }
      apiRes.markSent();
      const html = renderShell({ appHtml, data });
      return {
        statusCode: apiRes.status() ?? 200,
        headers,
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
function renderShell({ appHtml, data }) {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${data.body?.head?.title || "App"}</title>
    ${data.body?.head?.styles || ""}
</head>
<body>
    <div id="app">${appHtml}</div>
    <script>
        window.__ROUTE_DATA__ = ${json};
    <\/script>
    ${data.body?.head?.scripts || ""}
</body>
</html>`;
}
export {
  createLambdaHandler
};
