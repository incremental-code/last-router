export default async function setFlash(req, res) {
    res.flash('success', 'Saved!');
    return { ok: true };
}
