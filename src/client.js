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

// Slim top-of-viewport bar that gives immediate feedback an in-app navigation
// has started. Opt-in: renders nothing unless the page defines the CSS variable
// `--last-router-progress`, so sites that don't want it are wholly unaffected.
const progress = createProgress();

window.addEventListener('popstate', () => navigate(resolveTarget(location.pathname + location.search + location.hash)));
window.addEventListener('click', interceptLinks);

await hydrateInitial();

async function hydrateInitial() {
    const match = matchPath(manifest, data.path);
    if (!match) return;
    currentBody = makeBodySignals(data.body);
    const Page = await loadPage(match.route);
    const vnode = createElement(Page, { router, params: match.params, body: currentBody });
    try {
        hydrate(vnode, appEl.firstElementChild);
        attachTitleEffect(currentBody, appEl.firstElementChild);
        streamInto(data.path, appEl.firstElementChild, { skipFirstChunk: true });
    } catch {
        const mountedNode = mount(vnode);
        appEl.replaceChildren(mountedNode);
        attachTitleEffect(currentBody, mountedNode);
        streamInto(data.path, mountedNode, { skipFirstChunk: true });
    }
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

    const gen = progress.start();
    const controller = new AbortController();
    const ownBody = {};
    let response;
    try {
        response = await fetch(assetPath('/__data' + resolved.dataTarget), { signal: controller.signal });
    } catch (err) {
        progress.done(gen);
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
                    // The new page is on screen — the streamed chunks that
                    // follow are progressive enhancement, so finish the bar now.
                    progress.done(gen);
                } else if (currentBody) {
                    mergeIntoSignals(currentBody, chunk);
                }
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            if (!mountedNode) {
                console.error(
                    `[last-router] navigate(): failed to render and mount route "${resolved.appPath}" before DOM swap. ` +
                    'Effect: previous route content remains visible because appEl.replaceChildren() was not reached.',
                );
            } else {
                console.error(
                    `[last-router] navigate(): failed while processing streamed data for route "${resolved.appPath}" after mount. ` +
                    'Effect: page may be partially updated until the next navigation.',
                );
            }
            console.error(err);
        }
    } finally {
        // Safety net: complete the bar on any exit the mount path missed
        // (empty stream, read error, abort). No-op once already finished, or
        // once a newer navigation has taken over the bar.
        progress.done(gen);
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
    // Encode segments: API Gateway rejects raw `[`/`]` from `[param]` folders with a 400.
    const dir = route.dir ? route.dir.split('/').map(encodeURIComponent).join('/') + '/' : '';
    const mod = await import(assetPath(`/__src/${dir}page.js`));
    return mod.default;
}

function mergeIntoSignals(signals, chunk) {
    for (const [k, v] of Object.entries(chunk)) {
        signals[k] = v;
    }
}

/**
 * Mirror `body.head.title` into document.title and keep it in sync as streamed
 * body chunks update `head`.
 */
function attachTitleEffect(body, node) {
    const stop = effect(() => {
        const head = body.head;
        const title = head && typeof head.title === 'string' ? head.title : null;
        if (title) document.title = title;
    });
    onUnmount(node, stop);
}

/**
 * Navigation progress bar. An NProgress-style sliver pinned to the top of the
 * viewport: it appears the instant a navigation's /__data fetch begins, trickles
 * toward 90% while the round-trip is in flight (real progress is unknowable — the
 * response is a stream of unknown length), then jumps to 100% and fades once the
 * new page has mounted.
 *
 * The bar lives on <body>, OUTSIDE #app, so it survives the appEl.replaceChildren
 * swap that every navigation performs. Opt-in and themeable via CSS custom
 * properties read off :root:
 *   --last-router-progress          the bar colour (its presence is the opt-in)
 *   --last-router-progress-height   bar thickness (default 3px)
 * When the colour variable is unset, every method is a no-op and nothing renders.
 *
 * `start()` returns a generation id; pass it back to `done(id)`. Only the current
 * generation can finish the bar, so a stale completion from a navigation that has
 * already been superseded (e.g. a redirect chaining into a fresh navigate()) is
 * ignored and the bar flows straight through instead of flickering.
 */
function createProgress() {
    let optedIn = false;   // sticks true once the CSS variable is seen set
    let el = null;
    let gen = 0;
    let finishedGen = -1;
    let trickle = null;
    let value = 0;

    function isOptedIn() {
        if (optedIn) return true;
        try {
            const v = getComputedStyle(document.documentElement)
                .getPropertyValue('--last-router-progress').trim();
            if (v) optedIn = true;
            return Boolean(v);
        } catch {
            return false;
        }
    }

    function ensureEl() {
        if (el) return el;
        el = document.createElement('div');
        el.className = 'last-router-progress';
        el.setAttribute('aria-hidden', 'true');
        // Colour and height flow from the CSS variables, so the browser resolves
        // any var() chain (e.g. a site pointing the bar at its own --cta token).
        Object.assign(el.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100%',
            height: 'var(--last-router-progress-height, 3px)',
            background: 'var(--last-router-progress)',
            transformOrigin: '0 50%',
            transform: 'scaleX(0)',
            opacity: '0',
            zIndex: '2147483647',
            pointerEvents: 'none',
            transition: 'transform .2s ease, opacity .3s ease',
            willChange: 'transform, opacity',
        });
        document.body.appendChild(el);
        return el;
    }

    function paint(v) {
        value = Math.max(0, Math.min(1, v));
        const node = ensureEl();
        node.style.opacity = '1';
        node.style.transform = `scaleX(${value})`;
    }

    function stopTrickle() {
        if (trickle) { clearInterval(trickle); trickle = null; }
    }

    function start() {
        const id = ++gen;
        if (!isOptedIn()) return id;
        stopTrickle();
        paint(0.08);
        trickle = setInterval(() => {
            const room = 0.9 - value;
            if (room <= 0.01) { stopTrickle(); return; }
            paint(value + Math.random() * room * 0.25);
        }, 300);
        return id;
    }

    function done(id) {
        if (id !== gen || id === finishedGen || !el) return;
        finishedGen = id;
        stopTrickle();
        paint(1);
        const node = el;
        setTimeout(() => {
            if (id !== gen) return;   // a newer navigation owns the bar now
            node.style.opacity = '0';
            setTimeout(() => {
                if (id !== gen) return;
                node.style.transition = 'none';
                node.style.transform = 'scaleX(0)';
                void node.offsetWidth;   // reflow so the reset isn't animated
                node.style.transition = 'transform .2s ease, opacity .3s ease';
            }, 300);
        }, 200);
    }

    return { start, done };
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
