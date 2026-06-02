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

export function normalizeBasePath(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed === '/') return '';
    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '';
    if (/[\r\n?#]/.test(trimmed)) return '';
    const normalized = trimmed.replace(/\/+$/u, '');
    if (!normalized) return '';
    const segments = normalized.split('/');
    if (segments.some(segment => segment === '.' || segment === '..')) return '';
    return normalized;
}

export function stripBasePath(path, basePath) {
    const normalizedBasePath = normalizeBasePath(basePath);
    const targetPath = String(path || '');
    if (!normalizedBasePath) {
        return targetPath || '/';
    }
    if (targetPath === normalizedBasePath) {
        return '/';
    }
    if (targetPath.startsWith(normalizedBasePath + '/')) {
        return targetPath.slice(normalizedBasePath.length) || '/';
    }
    return targetPath || '/';
}

export function isPathWithinBasePath(path, basePath) {
    const normalizedBasePath = normalizeBasePath(basePath);
    const targetPath = String(path || '');
    if (!normalizedBasePath) {
        return targetPath.startsWith('/');
    }
    return targetPath === normalizedBasePath || targetPath.startsWith(normalizedBasePath + '/');
}

export function prefixInternalAssetPath(path, basePath) {
    const normalizedBasePath = normalizeBasePath(basePath);
    const targetPath = String(path || '');
    if (!normalizedBasePath || !targetPath.startsWith('/__')) {
        return targetPath;
    }
    return normalizedBasePath + targetPath;
}

/**
 * Parse pagination, sort, and search params from a query object with sane
 * defaults, integer clamping, and a sort allowlist. Returns the parsed values
 * plus offset/limit ready to pass to a database driver.
 *
 * Sort convention: `field` ascending, `-field` descending. The helper does no
 * splitting — pass `sort` through to your driver and let it interpret.
 */
export function parseListParams(query, options = {}) {
    const {
        defaultPage = 1,
        defaultPageSize = 20,
        maxPageSize = 100,
        allowedSorts = null,
        defaultSort = null,
        searchKey = 'q',
        pageKey = 'page',
        pageSizeKey = 'pageSize',
        sortKey = 'sort',
    } = options;

    const page = clampInt(query?.[pageKey], defaultPage, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = clampInt(query?.[pageSizeKey], defaultPageSize, 1, maxPageSize);

    let sort = defaultSort;
    if (query && typeof query[sortKey] === 'string') {
        const candidate = query[sortKey].trim();
        if (candidate && (!Array.isArray(allowedSorts) || allowedSorts.includes(candidate))) {
            sort = candidate;
        }
    }

    const rawSearch = query?.[searchKey];
    const q = typeof rawSearch === 'string' ? rawSearch.trim() : '';

    return {
        page,
        pageSize,
        offset: (page - 1) * pageSize,
        limit: pageSize,
        sort,
        q,
    };
}

function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Keep top-level body fields as internal Signal.State values but expose a plain
 * value view to pages. This lets page components read `body.someField` while
 * still getting reactive updates from streamed chunks.
 */
export function makeBodySignals(body) {
    const signals = {};
    for (const [key, value] of Object.entries(body || {})) {
        signals[key] = new Signal.State(value);
    }

    const ensureSignal = (property) => {
        if (!(property in signals)) {
            signals[property] = new Signal.State(undefined);
        }
        return signals[property];
    };

    return new Proxy({}, {
        get(target, property, receiver) {
            if (typeof property !== 'string') {
                return Reflect.get(target, property, receiver);
            }
            return ensureSignal(property).get();
        },
        set(_target, property, value) {
            if (typeof property !== 'string') {
                return false;
            }
            ensureSignal(property).set(value);
            return true;
        },
    });
}
