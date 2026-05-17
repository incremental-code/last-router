export default async function* stream() {
    yield { a: 'one' };
    await new Promise(r => setTimeout(r, 30));
    yield { b: 'two' };
    await new Promise(r => setTimeout(r, 30));
    yield { c: 'three' };
}
