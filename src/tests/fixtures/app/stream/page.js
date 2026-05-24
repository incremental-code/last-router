import { createElement } from '@incremental-code/last-act';

export default function Stream({ body }) {
    return createElement('p', undefined, body.a.get(), ' ', body.b.get(), ' ', body.c.get());
}
