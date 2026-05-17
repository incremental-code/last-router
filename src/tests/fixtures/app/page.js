import { createElement } from '@incremental-code/last-act';

export default function Home({ body }) {
    return createElement('h1', undefined, body.title);
}
