export interface Route {
    pattern: string;
    params: string[];
    dir: string;
}

export interface RouteMatch {
    route: Route;
    params: Record<string, string>;
}

export function buildRoute(segments: string[]): Route;
export function matchPath(routes: Route[], path: string): RouteMatch | null;
export function parseQuery(search: string): Record<string, string>;

export interface ListParamsOptions {
    defaultPage?: number;
    defaultPageSize?: number;
    maxPageSize?: number;
    /** When set, only these sort tokens are accepted; any other value falls back to defaultSort. */
    allowedSorts?: string[] | null;
    defaultSort?: string | null;
    searchKey?: string;
    pageKey?: string;
    pageSizeKey?: string;
    sortKey?: string;
}

export interface ListParams {
    page: number;
    pageSize: number;
    /** (page - 1) * pageSize — ready to pass as a SQL OFFSET. */
    offset: number;
    /** Alias for pageSize — ready to pass as a SQL LIMIT. */
    limit: number;
    /** The accepted sort token, or null if absent / not in allowlist. */
    sort: string | null;
    /** The trimmed search query, or '' if absent. */
    q: string;
}

export function parseListParams(query: Record<string, any>, options?: ListParamsOptions): ListParams;
