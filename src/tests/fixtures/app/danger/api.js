export default async function danger(req) {
    if (req.query.boom === '1') {
        throw new Error('danger route failed');
    }
    return { payload: '</script><script>alert(1)</script>' };
}
