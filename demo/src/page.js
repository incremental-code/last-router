import { createElement } from '@incremental-code/last-act';
import { Signal } from 'signal-polyfill';

export default function Home({ router, body }) {
    const input = new Signal.State('alice');
    const go = () => {
        const name = input.get().trim();
        if (name) router.push('/' + encodeURIComponent(name));
    };

    return createElement('div', undefined,
        createElement('h1', undefined, body.title),
        createElement('p', undefined, body.intro),
        createElement('input', {
            value: input.get(),
            placeholder: 'username',
            oninput: e => input.set(e.target.value),
            onkeydown: e => { if (e.key === 'Enter') go(); },
        }),
        createElement('button', { onclick: go }, 'View profile'),
    );
}
