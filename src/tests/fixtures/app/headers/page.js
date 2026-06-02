import { createElement } from '@incremental-code/last-act';

export default function Headers({ body }) {
    return createElement('p', undefined, body.echoed);
}
