// Request-level checks against the real app: authentication, CSRF, access
// control, and what does (and does not) leave in a response body.
const { startApp, sessionCookie, JSON_HEADERS, suite, assert, quietLogs } = require('./helpers');

const t = suite('http');
const PORT = 5990;

(async () => {
    const B = await startApp(PORT);
    // Refused CSRF, rejected OAuth state and failed sign-ins are all logged by
    // design; during the suite they are the assertions passing.
    const restoreLogs = quietLogs();
    const post = (path, body, headers = {}) =>
        fetch(B + path, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body || {}) });

    // ── Security headers ─────────────────────────────────────────────────────
    await t.checkAsync('every response carries the security headers', async () => {
        const r = await fetch(B + '/');
        for (const [h, v] of [
            ['x-content-type-options', 'nosniff'],
            ['x-frame-options', 'DENY'],
            ['referrer-policy', 'no-referrer'],
            ['cross-origin-opener-policy', 'same-origin'],
            ['cache-control', 'no-store'],
        ]) assert.equal(r.headers.get(h), v, h);
        assert.equal(r.headers.get('x-powered-by'), null, 'stack is not advertised');
    });

    // ── CORS ─────────────────────────────────────────────────────────────────
    await t.checkAsync('CORS admits only the configured origin', async () => {
        const bad = await fetch(B + '/', { headers: { origin: 'https://evil.example' } });
        assert.equal(bad.headers.get('access-control-allow-origin'), null);
        const good = await fetch(B + '/', { headers: { origin: 'https://rentreview.in' } });
        assert.equal(good.headers.get('access-control-allow-origin'), 'https://rentreview.in');
    });

    // ── Injection ────────────────────────────────────────────────────────────
    await t.checkAsync('$-operator bodies are rejected before any handler', async () => {
        const r = await post('/api/auth/login', { email: { $gt: '' }, password: 'x' });
        assert.equal(r.status, 400);
        assert.match((await r.json()).message, /invalid field name/i);
    });

    // ── Password policy at the edge ───────────────────────────────────────────
    await t.checkAsync('registration enforces the password policy', async () => {
        for (const [pw, re] of [['short', /at least 8/], ['password', /too common/]]) {
            const r = await post('/api/auth/register', { name: 'K', email: 'k@x.com', password: pw });
            assert.equal(r.status, 400);
            assert.match((await r.json()).message, re);
        }
    });

    // ── Tokens never leave in a body ─────────────────────────────────────────
    await t.checkAsync('no JWT appears in any response body', async () => {
        for (const [path, body] of [
            ['/api/auth/login', { email: 'nobody@example.com', password: 'whatever123' }],
            ['/api/auth/exchange', { code: 'bad' }],
        ]) {
            const text = await (await post(path, body)).text();
            assert(!/"token"\s*:/.test(text), `${path} leaked a token`);
        }
    });

    // ── OAuth login-CSRF ─────────────────────────────────────────────────────
    await t.checkAsync('OAuth start issues a signed, HttpOnly state cookie', async () => {
        const r = await fetch(B + '/api/auth/google', { redirect: 'manual' });
        assert.equal(r.status, 302);
        const state = new URL(r.headers.get('location')).searchParams.get('state');
        assert(state && state.length > 20, 'state parameter present');
        const cookie = r.headers.get('set-cookie');
        assert.match(cookie, /rr_oauth_state=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
    });
    await t.checkAsync('OAuth callback refuses a missing or forged state', async () => {
        for (const headers of [{}, { cookie: 'rr_oauth_state=forged' }]) {
            const r = await fetch(B + '/api/auth/google/callback?code=abc&state=x', { redirect: 'manual', headers });
            assert.equal(r.status, 302);
            assert.match(r.headers.get('location'), /signin\?error=oauth/);
        }
    });

    // ── Cookie CSRF ──────────────────────────────────────────────────────────
    const authed = (extra = {}) => ({ cookie: `${sessionCookie()}; rr_csrf=tok123`, ...JSON_HEADERS, ...extra });
    await t.checkAsync('authenticated writes require a matching CSRF header', async () => {
        const put = (headers) => fetch(B + '/api/auth/me', { method: 'PUT', headers, body: '{"name":"x"}' });
        assert.equal((await put(authed())).status, 403, 'no header');
        assert.equal((await put(authed({ 'x-csrf-token': 'nope' }))).status, 403, 'wrong header');
        assert.notEqual((await put(authed({ 'x-csrf-token': 'tok123' }))).status, 403, 'right header passes');
    });
    await t.checkAsync('a Bearer header cannot bypass CSRF', async () => {
        const r = await fetch(B + '/api/auth/me', {
            method: 'PUT', headers: authed({ authorization: 'Bearer junk' }), body: '{"name":"x"}',
        });
        assert.equal(r.status, 403);
    });
    await t.checkAsync('a bearer token alone no longer authenticates', async () => {
        const bearer = sessionCookie().replace('rr_session=', '');
        const r = await fetch(B + '/api/auth/me', { headers: { authorization: `Bearer ${bearer}` } });
        assert.equal(r.status, 401);
    });

    // ── The public routes must never be CSRF-gated ───────────────────────────
    await t.checkAsync('public routes work even with a stale session cookie', async () => {
        const wedged = { cookie: sessionCookie(), ...JSON_HEADERS };
        for (const [path, body] of [
            ['/api/auth/login', { email: 'a@b.co', password: 'x' }],
            ['/api/auth/forgot-password', { email: 'a@b.co' }],
            ['/api/auth/logout', {}],
            ['/api/contact', {}],
            ['/api/reports', {}],
        ]) {
            const r = await post(path, body, wedged);
            assert.notEqual(r.status, 403, `${path} must not be CSRF-gated`);
        }
    });
    await t.checkAsync('sign-out always works, and clears both cookies', async () => {
        const r = await post('/api/auth/logout', {}, { cookie: sessionCookie() });
        assert.equal(r.status, 200);
        const cleared = r.headers.getSetCookie?.() || [];
        assert(cleared.some((c) => /rr_session=;/.test(c)), 'session cleared');
        assert(cleared.some((c) => /rr_csrf=;/.test(c)), 'csrf cleared');
    });
    await t.checkAsync('a forged cross-site sign-out is refused', async () => {
        const bad = await post('/api/auth/logout', {}, { origin: 'https://evil.example' });
        assert.equal(bad.status, 403);
        const ours = await post('/api/auth/logout', {}, { origin: 'https://rentreview.in' });
        assert.equal(ours.status, 200);
    });

    // ── CSRF token delivery ──────────────────────────────────────────────────
    await t.checkAsync('GET /auth/csrf hands out a token and sets the cookie', async () => {
        const r = await fetch(B + '/api/auth/csrf');
        assert.equal(r.status, 200);
        assert((await r.json()).csrfToken.length > 20);
        assert((r.headers.getSetCookie?.() || []).some((c) => c.startsWith('rr_csrf=')));
    });
    await t.checkAsync('an existing CSRF token is echoed, not rotated', async () => {
        const r = await fetch(B + '/api/auth/csrf', { headers: { cookie: 'rr_csrf=known' } });
        assert.equal((await r.json()).csrfToken, 'known');
    });

    // ── Access control ───────────────────────────────────────────────────────
    await t.checkAsync('private and admin endpoints require authentication', async () => {
        const cases = [
            ['/api/auth/me', 'DELETE'], ['/api/auth/me/export', 'GET'],
            ['/api/reviews/admin/pending-verifications', 'GET'],
            ['/api/reports/admin', 'GET'],
            ['/api/reports/admin/507f1f77bcf86cd799439011', 'PUT'],
            ['/api/reports/admin/reviews/507f1f77bcf86cd799439011/restore', 'PUT'],
        ];
        for (const [path, method] of cases) {
            const r = await fetch(B + path, {
                method, headers: JSON_HEADERS, body: method === 'GET' ? undefined : '{}',
            });
            assert.equal(r.status, 401, `${method} ${path}`);
        }
    });

    // ── Reporting ────────────────────────────────────────────────────────────
    await t.checkAsync('reporting needs no account and validates its input', async () => {
        const r = await post('/api/reports', {
            reviewId: '507f1f77bcf86cd799439011', reason: 'nonsense',
            details: 'x', reporterName: 'A', reporterEmail: 'bad',
        });
        assert.equal(r.status, 400);
        const d = await r.json();
        assert(d.errors.reason && d.errors.reporterEmail, 'per-field errors returned');
    });
    await t.checkAsync('the report honeypot stores nothing but answers success', async () => {
        const r = await post('/api/reports', {
            website: 'http://spam.example', reviewId: '507f1f77bcf86cd799439011',
            reason: 'spam', details: 'x', reporterName: 'Bot', reporterEmail: 'b@b.co',
        });
        assert.equal(r.status, 200);
        const d = await r.json();
        assert.equal(d.success, true);
        assert(!d.reference, 'no record was actually created');
    });

    restoreLogs();
    process.exit(t.report() > 0 ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
