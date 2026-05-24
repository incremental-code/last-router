import { createElement } from '@incremental-code/last-act';

export default function Slug({ params: { slug }, body }) {
    return createElement('p', undefined, body.greeting.get(), ' ', slug);
}
