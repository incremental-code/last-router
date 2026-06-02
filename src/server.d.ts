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

/** @deprecated Pages now receive plain body values, not signals. */
export interface BodySignal<T> {
    get(): T;
    set(value: T): void;
}

/**
 * The body shape pages receive. Top-level fields are plain values while
 * remaining reactive under the hood when streamed chunks update them.
 */
export type ReactiveBody<B extends Body> = {
    [K in keyof B]: B[K];
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

/**
 * A one-shot message persisted across a single response→request hop via cookie.
 * Read on the next request via `req.flash`; the underlying cookie is cleared
 * automatically once observed, so a refresh will not replay it.
 */
export interface FlashMessage {
    kind: string;
    message: string;
}

export interface ApiRequest<P extends Params = Params, Q extends Query = Query, B = unknown> {
    method: string;
    path: string;
    params: P;
    query: Q;
    body: B;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string>;
    /** Populated when the prior response called `res.flash(...)`. Null otherwise. */
    flash: FlashMessage | null;
}

export interface ApiResponse {
    setStatus(code: number): void;
    setHeader(name: string, value: string): void;
    setCookie(name: string, value: string, opts?: CookieOptions): void;
    /**
     * Queue a flash message for the next request. The browser receives a Set-Cookie
     * carrying `{ kind, message }`; the next render reads it as `req.flash` and the
     * router auto-clears the cookie so a refresh does not replay it.
     */
    flash(kind: string, message: string): void;
    /** Throws an internal Redirect; control does not return. */
    redirect(to: string, opts?: { permanent?: boolean }): never;
}

export type Api<B extends Body = Body, P extends Params = Params, Q extends Query = Query, In = unknown> =
    (req: ApiRequest<P, Q, In>, res: ApiResponse) =>
        B | Promise<B> | AsyncIterable<Partial<B>>;
