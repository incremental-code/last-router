export default async function readFlash(req) {
    return {
        kind: req.flash?.kind || 'none',
        message: req.flash?.message || '',
    };
}
