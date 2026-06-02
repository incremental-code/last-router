# Last Router

An isomorphic file-system router for the [last-act](../last-act) ecosystem.
Zero build step, one HTTP server, signals over the wire.

## API

```
const server = createServer({ port, base })
const { url } = await server.connect()
```

## File-system routes

```
src/page.js              →  /
src/about/page.js        →  /about
src/[username]/page.js   →  /:username
```

Each folder can colocate an `api.js`. Its default export receives an `ApiRequest` with `method`, `path`, `params`, `query`, `body`, `headers`, and `cookies`, and returns (or yields) the `body` that gets passed to the matching `page.js`.

## page.js

A plain function component. Receives `{ router, params, body }`. Top-level `body` fields are plain values (for example `body.greeting`), while streamed updates stay reactive under the hood. Use `createElement` from last-act:

```js
import { createElement } from '@incremental-code/last-act';

export default function Profile({ params: { username }, body }) {
    return createElement('div', undefined,
        createElement('h1', undefined, `Profile for ${username}`),
        createElement('p', undefined, body.greeting),
    );
}
```

## api.js — plain or streaming

Return a value, or yield partial updates:

```js
// one-shot
export default async function ({ params, headers }) {
    return {
        greeting: `Hello, ${params.username}!`,
        host: headers.host ?? 'unknown-host',
    };
}

// streaming — each yield is a partial body merge
export default async function* ({ params }) {
    yield { greeting: 'Loading...' };
    await fetchSlowly();
    yield { greeting: `Hello, ${params.username}!` };
}
```

On the server, the api is drained and the merged body is rendered to HTML.
On the client, each yielded chunk arrives as an NDJSON line and updates the body reactively.

## router

```
router.path           // current path (signal-backed)
router.push(path)     // history.pushState + navigate
router.replace(path)  // history.replaceState + navigate
```

On the server, `push` and `replace` throw a redirect that becomes a 302.

## Built-in health route

`createServer()` always serves `GET /health` with `200 OK` and a plain-text body of `ok`.
This route is reserved for process health checks and is handled before file-system routing.

## Demo

```
cd demo && node index.js
```

Visit http://localhost:3000.
