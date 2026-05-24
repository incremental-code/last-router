import { Signal } from 'signal-polyfill';

const DYNAMIC = /^\[(.+)\]$/;

/**
 * Turn an array of folder names into a route entry.
 * `['[username]']` becomes `{ pattern: '/:username', params: ['username'], dir: '[username]' }`.
 */
export function buildRoute(segments) {
    const params = [];
    const patternSegments = segments.map(segment => {
        const m = DYNAMIC.exec(segment);
        if (m) {
            params.push(m[1]);
            return ':' + m[1];
        }
        return segment;
    });

    return {
        pattern: '/' + patternSegments.join('/'),
        params,
        dir: segments.join('/'),
    };
}

/**
 * Pick the most specific route that matches `path` and return the extracted params.
 * Returns `null` if nothing matches.
 */
export function matchPath(routes, path) {
    const clean = path.split('?')[0].split('#')[0];
    const pathSegments = clean.split('/').filter(Boolean);

    let best = null;
    for (const route of routes) {
        const patternSegments = route.pattern.split('/').filter(Boolean);
        if (patternSegments.length !== pathSegments.length) continue;

        const params = {};
        let matches = true;
        let staticCount = 0;

        for (let i = 0; i < patternSegments.length; i++) {
            const pat = patternSegments[i];
            const val = pathSegments[i];
            if (pat.startsWith(':')) {
                params[pat.slice(1)] = decodeURIComponent(val);
            } else if (pat === val) {
                staticCount++;
            } else {
                matches = false;
                break;
            }
        }

        if (matches && (!best || staticCount > best.staticCount)) {
            best = { route, params, staticCount };
        }
    }

    return best ? { route: best.route, params: best.params } : null;
}

export function parseQuery(search) {
    const query = {};
    for (const [key, value] of new URLSearchParams(search)) {
        query[key] = value;
    }
    return query;
}

/**
 * Wrap top-level body fields in Signal.State and lazily create missing keys so
 * pages can safely read `body.someField.get()` before streaming updates arrive.
 */
export function makeBodySignals(body) {
    const signals = {};
    for (const [key, value] of Object.entries(body || {})) {
        signals[key] = new Signal.State(value);
    }

    return new Proxy(signals, {
        get(target, property, receiver) {
            if (typeof property !== 'string') {
                return Reflect.get(target, property, receiver);
            }
            if (!(property in target)) {
                target[property] = new Signal.State(undefined);
            }
            return target[property];
        },
    });
}
