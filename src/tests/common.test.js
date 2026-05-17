import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, matchPath, parseQuery } from '../common.js';

describe('buildRoute', () => {
    it('builds the root route from no segments', () => {
        const r = buildRoute([]);
        assert.equal(r.pattern, '/');
        assert.deepEqual(r.params, []);
        assert.equal(r.dir, '');
    });

    it('builds a static route', () => {
        const r = buildRoute(['about']);
        assert.equal(r.pattern, '/about');
        assert.deepEqual(r.params, []);
        assert.equal(r.dir, 'about');
    });

    it('extracts params from [name] syntax', () => {
        const r = buildRoute(['[username]']);
        assert.equal(r.pattern, '/:username');
        assert.deepEqual(r.params, ['username']);
        assert.equal(r.dir, '[username]');
    });

    it('mixes static and dynamic segments', () => {
        const r = buildRoute(['users', '[id]', 'posts']);
        assert.equal(r.pattern, '/users/:id/posts');
        assert.deepEqual(r.params, ['id']);
        assert.equal(r.dir, 'users/[id]/posts');
    });
});

describe('matchPath', () => {
    const routes = [
        buildRoute([]),
        buildRoute(['about']),
        buildRoute(['[username]']),
        buildRoute(['users', '[id]']),
        buildRoute(['users', 'me']),
    ];

    it('matches the root route', () => {
        const m = matchPath(routes, '/');
        assert.equal(m.route.pattern, '/');
        assert.deepEqual(m.params, {});
    });

    it('matches a static route', () => {
        const m = matchPath(routes, '/about');
        assert.equal(m.route.pattern, '/about');
    });

    it('matches a dynamic route and extracts params', () => {
        const m = matchPath(routes, '/alice');
        assert.equal(m.route.pattern, '/:username');
        assert.deepEqual(m.params, { username: 'alice' });
    });

    it('prefers a fully-static route over a dynamic one', () => {
        const m = matchPath(routes, '/users/me');
        assert.equal(m.route.pattern, '/users/me');
    });

    it('falls back to a dynamic route when no static one matches', () => {
        const m = matchPath(routes, '/users/42');
        assert.equal(m.route.pattern, '/users/:id');
        assert.deepEqual(m.params, { id: '42' });
    });

    it('returns null when nothing matches', () => {
        assert.equal(matchPath(routes, '/a/b/c/d'), null);
    });

    it('strips query and hash before matching', () => {
        const m = matchPath(routes, '/alice?ref=x#frag');
        assert.equal(m.route.pattern, '/:username');
        assert.deepEqual(m.params, { username: 'alice' });
    });

    it('decodes URI-encoded segments', () => {
        const m = matchPath(routes, '/hello%20world');
        assert.deepEqual(m.params, { username: 'hello world' });
    });
});

describe('parseQuery', () => {
    it('parses key=value pairs', () => {
        assert.deepEqual(parseQuery('?a=1&b=2'), { a: '1', b: '2' });
    });

    it('returns an empty object for an empty string', () => {
        assert.deepEqual(parseQuery(''), {});
    });

    it('decodes percent-encoded values', () => {
        assert.deepEqual(parseQuery('?q=hello%20world'), { q: 'hello world' });
    });
});
