import { Signal } from 'signal-polyfill';
import { createElement, mount, hydrate, onUnmount, effect } from '@incremental-code/last-act';
import {
    isPathWithinBasePath,
    makeBodySignals,
    matchPath,
    normalizeBasePath,
    prefixInternalAssetPath,
    stripBasePath,
} from './common.js';

const data = JSON.parse(document.getElementById('__last_router_data').textContent);
const manifest = data.manifest;
const appEl = document.getElementById('app');
const basePath = normalizeBasePath(data.basePath);

const path = new Signal.State(data.path);
const router = {
    get path() { return path.get(); },
    push(target) {
        const resolved = resolveTarget(target);
        history.pushState(null, '', resolved.browserTarget);
        navigate(resolved);
    },
    replace(target) {
        const resolved = resolveTarget(target);
        history.replaceState(null, '', resolved.browserTarget);
        navigate(resolved);
    },
};

let currentBody = null;

window.addEventListener('popstate', () => navigate(resolveTarget(location.pathname + location.search + location.hash)));
window.addEventListener('click', interceptLinks);

await hydrateInitial();

async function hydrateInitial() {
    const match = matchPath(manifest, data.path);
    if (!match) return;
    currentBody = makeBodySignals(data.body);
    const Page = await loadPage(match.route);
    const vnode = createElement(Page, { router, params: match.params, body: currentBody });
    hydrate(vnode, appEl.firstElementChild);
    attachTitleEffect(currentBody, appEl.firstElementChild);
    streamInto(data.path, appEl.firstElementChild, { skipFirstChunk: true });
}

async function navigate(target) {
    const resolved = typeof target === 'string' ? resolveTarget(target) : target;
    if (!resolved.withinBasePath) {
        window.location.assign(resolved.browserTarget);
        return;
    }

    path.set(resolved.appPath);
    const match = matchPath(manifest, resolved.appPath);
    if (!match) {
        window.location.assign(resolved.browserTarget);
        return;
    }

    currentBody = null;

    const controller = new AbortController();
    const ownBody = {};
    let response;
    try {
        response = await fetch(assetPath('/__data' + resolved.dataTarget), { signal: controller.signal });
    } catch (err) {
        if (err.name !== 'AbortError') console.error(err);
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let mountedNode = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line) continue;
                const chunk = JSON.parse(line);

                if (chunk.__redirect) {
                    controller.abort();
                    router.replace(chunk.__redirect);
                    return;
                }

                if (!mountedNode) {
                    Object.assign(ownBody, chunk);
                    currentBody = makeBodySignals(ownBody);
                    const Page = await loadPage(match.route);
                    const vnode = createElement(Page, { router, params: match.params, body: currentBody });
                    mountedNode = mount(vnode);
                    onUnmount(mountedNode, () => controller.abort());
                    appEl.replaceChildren(mountedNode);
                    attachTitleEffect(currentBody, mountedNode);
                } else if (currentBody) {
                    mergeIntoSignals(currentBody, chunk);
                }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error(err);
    }
}

/**
 * Open a /__data stream and merge chunks into the existing currentBody until
 * the given DOM node is unmounted (next navigation replaces appEl's child).
 */
function streamInto(target, node, { skipFirstChunk } = {}) {
    const controller = new AbortController();
    onUnmount(node, () => controller.abort());

    (async () => {
        let response;
        try {
            response = await fetch(assetPath('/__data' + target), { signal: controller.signal });
        } catch (err) {
            if (err.name !== 'AbortError') console.error(err);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstSkipped = !skipFirstChunk;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line) continue;
                    const chunk = JSON.parse(line);

                    if (chunk.__redirect) {
                        controller.abort();
                        router.replace(chunk.__redirect);
                        return;
                    }

                    if (!firstSkipped) {
                        firstSkipped = true;
                        continue;
                    }

                    if (currentBody) mergeIntoSignals(currentBody, chunk);
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError') console.error(err);
        }
    })();
}

async function loadPage(route) {
    const dir = route.dir ? route.dir + '/' : '';
    const mod = await import(assetPath(`/__src/${dir}page.js`));
    return mod.default;
}

function mergeIntoSignals(signals, chunk) {
    for (const [k, v] of Object.entries(chunk)) {
        if (signals[k]) signals[k].set(v);
        else signals[k] = new Signal.State(v);
    }
}

/**
 * If body has a `head` signal carrying { title, ... }, mirror its title into
 * document.title. Cleans up when the mounted node unmounts.
 */
function attachTitleEffect(body, node) {
    if (!Object.hasOwn(body, 'head')) return;
    const stop = effect(() => {
        const head = body.head.get();
        const title = head && typeof head.title === 'string' ? head.title : null;
        if (title) document.title = title;
    });
    onUnmount(node, stop);
}

function interceptLinks(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('//') || anchor.target === '_blank') return;
    const resolved = resolveTarget(anchor.href);
    if (!resolved.withinBasePath) return;
    event.preventDefault();
    router.push(resolved.browserTarget);
}

function assetPath(path) {
    return prefixInternalAssetPath(path, basePath);
}

function resolveTarget(target) {
    const stringTarget = String(target || '');
    const url = new URL(stringTarget, window.location.href);
    if (url.origin !== window.location.origin) {
        return {
            browserTarget: url.href,
            appPath: stripBasePath(url.pathname, basePath),
            dataTarget: stripBasePath(url.pathname, basePath) + url.search,
            withinBasePath: false,
        };
    }
    const browserTarget = stringTarget.startsWith('/') && !isPathWithinBasePath(url.pathname, basePath)
        ? `${basePath}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`
        : url.pathname + url.search + url.hash;
    return resolveBrowserPath(browserTarget);
}

function resolveBrowserPath(browserTarget) {
    const url = new URL(browserTarget, window.location.origin);
    const withinBasePath = isPathWithinBasePath(url.pathname, basePath);
    return {
        browserTarget: url.pathname + url.search + url.hash,
        appPath: stripBasePath(url.pathname, basePath),
        dataTarget: stripBasePath(url.pathname, basePath) + url.search,
        withinBasePath,
    };
}
