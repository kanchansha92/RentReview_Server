// Pure-logic checks: crypto, policy, detection, and the shape of the models.
// No server, no network.
const { suite, assert, testEnv, stubDotenv, quietLogs } = require('./helpers');
stubDotenv();
testEnv();
// The tamper test deliberately corrupts a ciphertext, and fieldCrypto logs that
// — correctly. It is the assertion working, not a failure.
const restoreLogs = quietLogs();

const t = suite('unit');

// ── Field encryption ─────────────────────────────────────────────────────────
const fc = require('../src/utils/fieldCrypto');
t.check('encrypt → decrypt round-trips', () => {
    const c = fc.encrypt('ABCDE1234F');
    assert(c.startsWith('enc:v1:'), 'ciphertext is tagged');
    assert.equal(fc.decrypt(c), 'ABCDE1234F');
});
t.check('never double-encrypts', () => {
    const c = fc.encrypt('ABCDE1234F');
    assert.equal(fc.encrypt(c), c);
});
t.check('legacy plaintext passes through', () => assert.equal(fc.decrypt('plain'), 'plain'));
t.check('tampered ciphertext fails closed', () => {
    const c = fc.encrypt('ABCDE1234F');
    assert.equal(fc.decryptOrBlank(c.slice(0, -3) + 'AAA'), '');
});
t.check('masking keeps only the last four', () => assert.equal(fc.maskIdentifier('ABCDE1234F'), '••••234F'));

// ── Password policy ──────────────────────────────────────────────────────────
const { validatePassword } = require('../src/utils/passwordPolicy');
t.check('rejects short, common, repeated and identity passwords', () => {
    assert(validatePassword('short'), 'too short');
    assert(validatePassword('password'), 'common');
    assert(validatePassword('aaaaaaaa'), 'single repeated char');
    assert(validatePassword('kane@x.com', { email: 'kane@x.com' }), 'same as email');
});
t.check('accepts a reasonable passphrase', () =>
    assert.equal(validatePassword('correct horse battery', { email: 'k@x.com' }), null));

// ── Mongo operator rejection ─────────────────────────────────────────────────
const { offendingKey } = require('../src/middleware/rejectMongoOperators');
t.check('rejects $-prefixed and dotted keys at any depth', () => {
    assert.equal(offendingKey({ email: { $gt: '' } }), '$gt');
    assert.equal(offendingKey({ a: [{ 'x.y': 1 }] }), 'x.y');
    assert.equal(offendingKey({ email: 'a', nested: { ok: [1, 2] } }), null);
});

// ── CSRF comparison ──────────────────────────────────────────────────────────
const { verifyCsrf } = require('../src/middleware/csrf');
const v = (method, headers) => verifyCsrf({ method, headers });
t.check('CSRF: safe methods pass, matching pairs pass, everything else fails', () => {
    assert.equal(v('GET', {}), true);
    assert.equal(v('POST', { cookie: 'rr_csrf=abc', 'x-csrf-token': 'abc' }), true);
    assert.equal(v('POST', { cookie: 'rr_csrf=abc', 'x-csrf-token': 'abd' }), false);
    assert.equal(v('POST', { cookie: 'rr_csrf=abc' }), false, 'header missing');
    assert.equal(v('POST', { 'x-csrf-token': 'abc' }), false, 'cookie missing');
    assert.equal(v('POST', { cookie: 'rr_csrf=abc', 'x-csrf-token': 'abcdef' }), false, 'length mismatch must not throw');
});
t.check('CSRF: a Bearer header buys no exemption', () =>
    assert.equal(v('POST', { cookie: 'rr_csrf=abc', authorization: 'Bearer x' }), false));

// ── Session cookie attributes ────────────────────────────────────────────────
t.check('production cookies are HttpOnly + Secure + SameSite=None', () => {
    delete require.cache[require.resolve('../src/utils/sessionCookie')];
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const sc = require('../src/utils/sessionCookie');
    const cap = { cookies: [], cookie(n, val, o) { this.cookies.push({ n, o }); } };
    sc.issueSession(cap, 'tok');
    const session = cap.cookies.find((c) => c.n === 'rr_session');
    const csrf = cap.cookies.find((c) => c.n === 'rr_csrf');
    assert.equal(session.o.httpOnly, true, 'session cookie unreadable by script');
    assert.equal(session.o.secure, true);
    assert.equal(session.o.sameSite, 'none', 'required for a split-host frontend');
    assert.equal(csrf.o.httpOnly, false, 'CSRF cookie must be readable');
    process.env.NODE_ENV = saved;
    delete require.cache[require.resolve('../src/utils/sessionCookie')];
});

// ── Personal-information detection ───────────────────────────────────────────
const { detectPersonalInfo } = require('../src/utils/detectPersonalInfo');
t.check('catches doxxing attempts', () => {
    for (const s of [
        'Call the owner on 9876543210',
        'his number is 98765 43210',
        'contact +91 9876543210',
        'number: 9 8 7 6 5 4 3 2 1 0',
        'mail him at landlord@example.com',
        'write to landlord [at] example.com',
        'his aadhaar is 2345 6789 0123',
        'account 123456789012345',
    ]) assert(detectPersonalInfo(s), `missed: ${s}`);
});
t.check('does not flag legitimate reviews', () => {
    for (const s of [
        'Rent is 15000 per month',
        'They wanted 25,000 a month plus deposit',
        'We lived in flat 301 on the 3rd floor',
        'The area is Indiranagar 560038',
        'Lease 2023-06-01 2024-06-01 renewed once',
        'Rents were 15000 25000 35000 45000 across floors',
        '2BHK, about 1100 sq ft, water 24x7',
    ]) assert(!detectPersonalInfo(s), `false positive: ${s}`);
});
t.check('names what to remove', () => {
    assert.match(detectPersonalInfo('call 9876543210').message, /phone number/i);
    assert.match(detectPersonalInfo('a@b.com').message, /email/i);
    assert.match(detectPersonalInfo('123456789012345').message, /ID, account or card/i);
});

// ── Model contracts ──────────────────────────────────────────────────────────
const User = require('../src/models/User');
const Review = require('../src/models/Review');
const Report = require('../src/models/Report');
const AuditLog = require('../src/models/AuditLog');

t.check('secrets on User are select:false', () => {
    for (const f of ['password', 'resetPasswordToken', 'emailVerifyToken', 'pendingEmail', 'failedLoginAttempts', 'lockUntil']) {
        assert.equal(User.schema.path(f).options.select, false, `${f} must not be selected by default`);
    }
});
t.check('lockout releases once it expires', () => {
    const u = new User({ name: 'A', email: 'a@b.co' });
    assert.equal(u.isLocked(), false);
    u.lockUntil = new Date(Date.now() + 60000);
    assert.equal(u.isLocked(), true);
    u.lockUntil = new Date(Date.now() - 60000);
    assert.equal(u.isLocked(), false);
});
t.check('ID verification data is select:false on Review', () =>
    assert.equal(Review.schema.path('verification').options.select, false));
t.check('reviews default to visible and can only be visible or hidden', () => {
    assert.equal(Review.schema.path('moderation.status').options.default, 'visible');
    assert.deepEqual(Review.schema.path('moderation.status').enumValues, ['visible', 'hidden']);
});
t.check('audit log holds ids, not personal data, and expires', () => {
    const fields = Object.keys(AuditLog.schema.paths);
    for (const forbidden of ['email', 'idNumber', 'password', 'name']) {
        assert(!fields.includes(forbidden), `AuditLog must not carry ${forbidden}`);
    }
    const ttl = AuditLog.schema.indexes().find(([k]) => k.createdAt === 1);
    assert(ttl && ttl[1].expireAfterSeconds > 0, 'entries must expire');
});
t.check('reports start pending', () =>
    assert.equal(Report.schema.path('status').options.default, 'pending'));

restoreLogs();
process.exit(t.report() > 0 ? 1 : 0);
