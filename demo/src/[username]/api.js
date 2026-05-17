export default async function* profile({ router, params: { username } }) {
    if (!username) return router.push('/');

    yield { greeting: `Hello, ${username}!`, status: 'Loading recent activity...' };

    await new Promise(r => setTimeout(r, 800));
    yield { status: 'Fetching profile from upstream...' };

    await new Promise(r => setTimeout(r, 800));
    yield { status: `Last seen ${new Date().toLocaleTimeString()}` };
}
