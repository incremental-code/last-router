export default async function headers(req) {
    return {
        echoed: req.headers['x-test-header'] || 'missing',
    };
}
