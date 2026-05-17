import { createElement } from '@incremental-code/last-act';

export default function Stream({ body }) {
    return createElement('p', undefined, body.a, ' ', body.b, ' ', body.c);
}
