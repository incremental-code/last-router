export default async function slug(req) {
    return { greeting: `Hello,`, slug: req.params.slug };
}
