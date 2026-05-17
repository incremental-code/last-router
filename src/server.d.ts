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
 * A read-write signal — the shape of every top-level body field. Compatible
 * with `Signal.State<T>` from signal-polyfill; declared structurally here so
 * consumers don't have to import signal-polyfill just to type pages.
 */
export interface BodySignal<T> {
    get(): T;
    set(value: T): void;
}

/**
 * The body shape pages actually receive. Each top-level field is wrapped in
 * a signal so SSR and client hydration use the same access pattern, and so
 * streamed `yield` chunks can update the page reactively on the client.
 */
export type ReactiveBody<B extends Body> = {
    [K in keyof B]: BodySignal<B[K]>;
};

export interface PageProps<P extends Params = Params, B extends Body = Body> {
    router: Router;
    params: P;
    body: ReactiveBody<B>;
}

export type Page<P extends Params = Params, B extends Body = Body> =
    (props: PageProps<P, B>) => Renderable;

export interface CookieOptions {
    domain?: string;
    path?: string;
    maxAge?: number;
    expires?: Date;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
}

export interface ApiRequest<P extends Params = Params, Q extends Query = Query, B = unknown> {
    method: string;
    path: string;
    params: P;
    query: Q;
    body: B;
    cookies: Record<string, string>;
}

export interface ApiResponse {
    setStatus(code: number): void;
    setHeader(name: string, value: string): void;
    setCookie(name: string, value: string, opts?: CookieOptions): void;
    /** Throws an internal Redirect; control does not return. */
    redirect(to: string, opts?: { permanent?: boolean }): never;
}

export type Api<B extends Body = Body, P extends Params = Params, Q extends Query = Query, In = unknown> =
    (req: ApiRequest<P, Q, In>, res: ApiResponse) =>
        B | Promise<B> | AsyncIterable<Partial<B>>;
