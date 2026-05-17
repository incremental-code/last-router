import type { Renderable } from '@incremental-code/last-act';

export interface ServerOptions {
    port?: number;
    base?: string;
    imports?: Record<string, string>;
}

export interface Server {
    connect(): Promise<{ url: string }>;
    close(): Promise<void>;
}

export function createServer(options?: ServerOptions): Server;

/**
 * The router instance passed to every page and api. On the server, `push`
 * and `replace` throw a redirect that becomes a 302/301.
 */
export interface Router {
    readonly path: string;
    push(target: string): void;
    replace(target: string): void;
}

export type Params = Record<string, string>;
export type Query = Record<string, string>;
export type Body = Record<string, any>;

/**
 * Props passed to a page component.
 *
 * Note: at runtime, `body` values are plain on the server (SSR) and
 * `Signal.State<T>` on the client (hydration). last-act's createElement
 * accepts both, so passing them through as children works in both contexts.
 */
export interface PageProps<P extends Params = Params, B extends Body = Body> {
    router: Router;
    params: P;
    body: B;
}

export type Page<P extends Params = Params, B extends Body = Body> =
    (props: PageProps<P, B>) => Renderable;

export interface ApiContext<P extends Params = Params, Q extends Query = Query> {
    router: Router;
    params: P;
    query: Q;
}

export type Api<B extends Body = Body, P extends Params = Params, Q extends Query = Query> =
    (ctx: ApiContext<P, Q>) => B | Promise<B> | AsyncIterable<Partial<B>>;
