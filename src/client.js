import { Signal } from 'signal-polyfill';
import { createElement, mount, hydrate, onUnmount } from '@incremental-code/last-act';
import { matchPath } from '/__router/common.js';

const data = JSON.parse(document.getElementById('__last_router_data').textContent);
const manifest = data.manifest;
const appEl = document.getElementById('app');

const path = new Signal.State(data.path);
const router = {
    get path() { return path.get(); },
    push(target) { history.pushState(null, '', target); navigate(target); },
    replace(target) { history.replaceState(null, '', target); navigate(target); },
};

let currentBody = null;

window.addEventListener('popstate', () => navigate(location.pathname + location.search));
window.addEventListener('click', interceptLinks);

await hydrateInitial();

async function hydrateInitial() {
    const match = matchPath(manifest, data.path);
    if (!match) return;
    currentBody = makeBodySignals(data.body);
    const Page = await loadPage(match.route);
    const vnode = createElement(Page, { router, params: match.params, body: currentBody });
    hydrate(vnode, appEl.firstElementChild);
    streamInto(data.path, appEl.firstElementChild, { skipFirstChunk: true });
}

async function navigate(target) {
    path.set(target);
    const match = matchPath(manifest, target);
    if (!match) return;

    currentBody = null;

    const controller = new AbortController();
    const ownBody = {};
    let response;
    try {
        response = await fetch('/__data' + target, { signal: controller.signal });
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
            response = await fetch('/__data' + target, { signal: controller.signal });
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
    const mod = await import(`/__src/${dir}page.js`);
    return mod.default;
}

function makeBodySignals(obj) {
    const signals = {};
    for (const [k, v] of Object.entries(obj || {})) signals[k] = new Signal.State(v);
    return signals;
}

function mergeIntoSignals(signals, chunk) {
    for (const [k, v] of Object.entries(chunk)) {
        if (signals[k]) signals[k].set(v);
        else signals[k] = new Signal.State(v);
    }
}

function interceptLinks(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//') || anchor.target === '_blank') return;
    event.preventDefault();
    router.push(href);
}
