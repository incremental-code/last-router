import { createElement } from '@incremental-code/last-act';

export default function Profile({ router, params: { username }, body }) {
    return createElement('div', undefined,
        createElement('h1', undefined, `Profile for ${username}`),
        createElement('p', undefined, body.greeting),
        createElement('p', undefined, body.status),
        createElement('button', { onclick: () => router.push('/') }, 'Home'),
    );
}
