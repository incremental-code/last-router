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
