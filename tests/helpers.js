// Shared setup for the test suite.
//
// These tests deliberately run WITHOUT a database. Every check here is about
// request handling — auth, CSRF, validation, rate limits, what leaves in a
// response body — and none of it needs Mongo. That keeps `npm test` a
// two-second command anyone can run before pushing, which is the difference
// between a suite that gets run and one that does not.
//
// The trade-off is explicit: persistence and query behaviour are NOT covered.
// Those need a real database and belong in a separate integration suite.

const crypto = require('crypto');
const assert = require('assert');

/** Stub the DB connector so the app boots with no Mongo running. */
const stubDatabase = () => {
    const path = require.resolve('../src/config/database');
    require.cache[path] = { id: path, filename: path, loaded: true, exports: async () => {} };

    // Without this, every model call sits in Mongoose's buffer for ten seconds
    // before giving up — so a suite that touches the database a handful of times
    // takes a minute and buries its own output in timeout errors. With buffering
    // off, an unconnected call fails instantly, which is what these tests want:
    // they assert on how the app RESPONDS, and a fast failure exercises the same
    // error path a real outage would.
    require('mongoose').set('bufferCommands', false);
};

/**
 * Stop `require('dotenv').config()` reading the developer's real .env.
 *
 * index.js calls it at import time, so without this the suite inherits whatever
 * happens to be on the machine running it — a different FRONTEND_URL fails the
 * CORS assertion, a real MONGO_URI makes it reach for a live database, and the
 * result is a suite that passes for one person and fails for another. Tests
 * should depend on their own fixtures and nothing else.
 */
const stubDotenv = () => {
    const path = require.resolve('dotenv');
    require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports: { config: () => ({ parsed: {} }) },
    };
};

/**
 * Silence the noise the app logs on purpose while being tested — refused CSRF,
 * rejected OAuth state, failed sign-ins. Those are the assertions passing, not
 * problems. Run with TEST_VERBOSE=1 to see everything.
 */
const quietLogs = () => {
    if (process.env.TEST_VERBOSE === '1') return () => {};
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const keep = (...args) => {
        // Anything the suite itself prints still gets through.
        if (typeof args[0] === 'string' && /^\s*[✓✗]|passed|FAILED/.test(args[0])) saved.log(...args);
    };
    console.log = keep;
    console.warn = () => {};
    console.error = () => {};
    return () => Object.assign(console, saved);
};

/** The environment the app needs to start. */
const testEnv = (overrides = {}) => {
    Object.assign(process.env, {
        NODE_ENV: 'test',
        JWT_SECRET: 'test-secret',
        DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        FRONTEND_URL: 'https://rentreview.in',
        BACKEND_URL: 'http://localhost:5990',
        CLOUDINARY_CLOUD_NAME: 'demo',
        CLOUDINARY_API_KEY: '1',
        CLOUDINARY_API_SECRET: 'a',
        // Present so the Passport strategies actually register — without them
        // config/passport.js skips registration and every OAuth route 500s,
        // which looks like a product bug but is only a missing fixture.
        // No network call is ever made: the tests stop at the redirect.
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
        ...overrides,
    });
};

/** Boot the real app on a port and return its base URL. */
const startApp = async (port) => {
    stubDotenv();
    stubDatabase();
    testEnv({ PORT: String(port), BACKEND_URL: `http://localhost:${port}` });
    require('../src/index.js');
    // The listener is bound synchronously inside index.js; give it a tick.
    await new Promise((r) => setTimeout(r, 700));
    return `http://localhost:${port}`;
};

const jwt = () => require('jsonwebtoken');

/** A session cookie for an arbitrary user id (that user won't exist in the DB). */
const sessionCookie = (id = '507f1f77bcf86cd799439011') =>
    `rr_session=${jwt().sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Tiny test runner: collects failures instead of dying on the first one. */
const suite = (name) => {
    const results = [];
    return {
        check(label, fn) {
            try {
                fn();
                results.push({ label, ok: true });
            } catch (err) {
                results.push({ label, ok: false, err: err.message });
            }
        },
        async checkAsync(label, fn) {
            try {
                await fn();
                results.push({ label, ok: true });
            } catch (err) {
                results.push({ label, ok: false, err: err.message });
            }
        },
        report() {
            const failed = results.filter((r) => !r.ok);
            for (const r of results) {
                console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}${r.ok ? '' : `\n      ${r.err}`}`);
            }
            console.log(
                `\n${name}: ${results.length - failed.length}/${results.length} passed` +
                (failed.length ? ` — ${failed.length} FAILED` : '')
            );
            return failed.length;
        },
    };
};

module.exports = {
    stubDatabase, stubDotenv, quietLogs, testEnv, startApp,
    sessionCookie, JSON_HEADERS, suite, assert,
};
