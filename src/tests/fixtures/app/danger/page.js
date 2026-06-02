import { createElement } from '@incremental-code/last-act';

export default function Danger({ body }) {
    return createElement('p', undefined, body.payload);
}
