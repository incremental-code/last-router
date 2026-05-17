import { Signal } from 'signal-polyfill';
import { createElement, mount, hydrate } from '@incremental-code/last-act';
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

window.addEventListener('popstate', () => navigate(location.pathname + location.search));
window.addEventListener('click', interceptLinks);

await hydrateInitial();

async function hydrateInitial() {
    const match = matchPath(manifest, data.path);
    if (!match) return;
    const body = makeBodySignals(data.body);
    const Page = await loadPage(match.route);
    const vnode = createElement(Page, { router, params: match.params, body });
    hydrate(vnode, appEl.firstElementChild);
}

async function navigate(target) {
    path.set(target);
    const match = matchPath(manifest, target);
    if (!match) return;

    const response = await fetch('/__data' + target);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let body = null;

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
                router.replace(chunk.__redirect);
                return;
            }

            if (!body) {
                body = makeBodySignals(chunk);
                const Page = await loadPage(match.route);
                const vnode = createElement(Page, { router, params: match.params, body });
                appEl.replaceChildren(mount(vnode));
            } else {
                mergeIntoSignals(body, chunk);
            }
        }
    }
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
