import { createElement } from '@incremental-code/last-act';

export default function FlashRead({ body }) {
    return createElement('p', undefined, `${body.kind}:${body.message}`);
}
