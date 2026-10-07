/**
 * Tests for the context store.
 *
 * The store is exercised against an in-memory SQLite database, so no external
 * service is needed. The contract covered here is the one
 * `@node-red/runtime/lib/nodes/context` depends on:
 *
 *  - `get`/`set` deliver results through the callback;
 *  - `get`/`set` accept an array of keys, and multi-get uses `(err, v1, ... vN)`;
 *  - `keys` always yields an array (the runtime calls `.map()` on it);
 *  - `undefined` deletes a key while `null` is a stored value;
 *  - writes are visible immediately, because the database is the source of truth.
 */

var test = require('node:test');
var assert = require('node:assert');

var createStore = require('../lib/context');
var logger = require('../lib/logger');

// Keep the output readable.
logger.info = function () {};
logger.debug = function () {};

/**
 * Opens a store backed by in-memory SQLite.
 *
 * SQLite is not a "production" dialect for this plugin, but it is a full
 * Sequelize dialect and needs no server, which makes it ideal for tests.
 *
 * @param {object} [overrides] Config overrides.
 * @returns {Promise<object>} The opened store.
 */
async function openStore(overrides) {
    var config = Object.assign({
        dialect: 'sqlite',
        storage: ':memory:',
        flushInterval: 0
    }, overrides || {});

    var store = createStore(config);
    await store.open();
    return store;
}

/**
 * Promisified single-key `get`.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @param {string} key Key.
 * @returns {Promise<*>} The value.
 */
function get(store, scope, key) {
    return new Promise(function (resolve, reject) {
        store.get(scope, key, function (err, value) {
            if (err) { return reject(err); }
            resolve(value);
        });
    });
}

/**
 * Promisified multi-key `get`, returning the values as an array.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @param {string[]} keys Keys.
 * @returns {Promise<Array>} The values.
 */
function getMany(store, scope, keys) {
    return new Promise(function (resolve, reject) {
        store.get(scope, keys, function (err) {
            if (err) { return reject(err); }
            resolve(Array.prototype.slice.call(arguments, 1));
        });
    });
}

/**
 * Promisified `set`.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @param {string|string[]} key Key or keys.
 * @param {*|*[]} value Value or values.
 * @returns {Promise<void>}
 */
function set(store, scope, key, value) {
    return new Promise(function (resolve, reject) {
        store.set(scope, key, value, function (err) {
            if (err) { return reject(err); }
            resolve();
        });
    });
}

/**
 * Promisified `keys`.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @returns {Promise<string[]>} The keys.
 */
function keys(store, scope) {
    return new Promise(function (resolve, reject) {
        store.keys(scope, function (err, value) {
            if (err) { return reject(err); }
            resolve(value);
        });
    });
}

test('a fresh store has no keys', async function () {
    var store = await openStore();
    assert.deepStrictEqual(await keys(store, 'global'), []);
    assert.strictEqual(await get(store, 'global', 'missing'), undefined);
    await store.close();
});

test('set then get round-trips a scalar', async function () {
    var store = await openStore();

    await set(store, 'global', 'answer', 42);
    assert.strictEqual(await get(store, 'global', 'answer'), 42);

    await store.close();
});

test('nested objects and arrays survive the round trip', async function () {
    var store = await openStore();
    var payload = { a: 1, b: [1, 2, { c: 'deep' }], d: { e: true } };

    await set(store, 'global', 'obj', payload);
    assert.deepStrictEqual(await get(store, 'global', 'obj'), payload);

    await store.close();
});

test('values are visible immediately, without waiting for a flush', async function () {
    var store = await openStore();

    await set(store, 'global', 'now', 'visible');
    assert.strictEqual(await get(store, 'global', 'now'), 'visible');

    await store.close();
});

test('a second store sees writes from the first, immediately', async function () {
    var Sequelize = require('sequelize');
    var os = require('os');
    var fs = require('fs');
    var path = require('path');

    // A file-backed database is shared by both connections, standing in for two
    // Node-RED instances (or a manual UPDATE from a DBA).
    var dbFile = path.join(os.tmpdir(), 'nodered-ctx-shared-' + process.pid + '.sqlite');
    var connectionA = new Sequelize({ dialect: 'sqlite', storage: dbFile, logging: false });
    var connectionB = new Sequelize({ dialect: 'sqlite', storage: dbFile, logging: false });

    var storeA = createStore({ dialect: 'sqlite', storage: dbFile });
    var storeB = createStore({ dialect: 'sqlite', storage: dbFile });

    // Point both stores at the same open connections by replacing the factory.
    var connection = require('../lib/connection');
    var original = connection.createSequelize;

    connection.createSequelize = function () { return connectionA; };
    await storeA.open();

    connection.createSequelize = function () { return connectionB; };
    await storeB.open();

    await set(storeA, 'global', 'shared', 'from-A');
    assert.strictEqual(await get(storeB, 'global', 'shared'), 'from-A',
        'store B did not see the value written by store A');

    // And the reverse direction.
    await set(storeB, 'global', 'shared', 'from-B');
    assert.strictEqual(await get(storeA, 'global', 'shared'), 'from-B',
        'store A kept serving a stale value');

    await storeA.close();
    await storeB.close();
    connection.createSequelize = original;
    fs.unlinkSync(dbFile);
});

test('get and set accept an array of keys', async function () {
    var store = await openStore();

    await set(store, 'global', ['a', 'b', 'c'], [1, 2, 3]);

    assert.deepStrictEqual(await getMany(store, 'global', ['a', 'b']), [1, 2]);
    assert.deepStrictEqual(await getMany(store, 'global', ['a', 'missing']), [1, undefined]);

    await store.close();
});

test('keys lists the keys of a scope', async function () {
    var store = await openStore();

    await set(store, 'flow-1', 'x', 1);
    await set(store, 'flow-1', 'y', 2);

    assert.deepStrictEqual((await keys(store, 'flow-1')).sort(), ['x', 'y']);
    assert.deepStrictEqual(await keys(store, 'unknown'), []);

    await store.close();
});

test('scopes are isolated from each other', async function () {
    var store = await openStore();

    await set(store, 'global', 'shared', 'g');
    await set(store, 'flow-1', 'shared', 'f');
    await set(store, 'node-1:flow-1', 'shared', 'n');

    assert.strictEqual(await get(store, 'global', 'shared'), 'g');
    assert.strictEqual(await get(store, 'flow-1', 'shared'), 'f');
    assert.strictEqual(await get(store, 'node-1:flow-1', 'shared'), 'n');

    await store.close();
});

test('the scope string is stored verbatim, not parsed', async function () {
    var store = await openStore();

    // Node-RED composes the scope however it likes; the store must not rewrite
    // it, or `set` and `keys` would disagree.
    var oddScopes = ['1:flow', 'flow:1', 'a:b:c', 'weird scope with spaces'];

    for (var i = 0; i < oddScopes.length; i++) {
        await set(store, oddScopes[i], 'k', oddScopes[i]);
    }
    for (var j = 0; j < oddScopes.length; j++) {
        assert.strictEqual(await get(store, oddScopes[j], 'k'), oddScopes[j]);
    }

    await store.close();
});

test('undefined deletes a key, null is stored', async function () {
    var store = await openStore();

    await set(store, 'global', 'nullable', null);
    assert.strictEqual(await get(store, 'global', 'nullable'), null);

    await set(store, 'global', 'temp', 'value');
    assert.strictEqual(await get(store, 'global', 'temp'), 'value');

    await set(store, 'global', 'temp', undefined);
    assert.strictEqual(await get(store, 'global', 'temp'), undefined);
    assert.strictEqual((await keys(store, 'global')).indexOf('temp'), -1,
        'the key should have been removed');

    await store.close();
});

test('delete removes a whole scope', async function () {
    var store = await openStore();

    await set(store, 'flow-9', 'a', 1);
    await store.delete('flow-9');

    assert.deepStrictEqual(await keys(store, 'flow-9'), []);
    assert.strictEqual(await get(store, 'flow-9', 'a'), undefined);

    await store.close();
});

test('clean keeps scopes mentioning a live node and drops orphans', async function () {
    var store = await openStore();

    await set(store, 'global', 'keep', 'yes');
    await set(store, 'flow-1', 'keep', 'yes');
    await set(store, 'node-1:flow-1', 'keep', 'yes');
    await set(store, 'flow-orphan', 'drop', 'yes');

    // Node-RED passes the live node ids (here as composed scopes).
    await store.clean(['flow-1', 'node-1:flow-1']);

    assert.strictEqual(await get(store, 'global', 'keep'), 'yes', 'global must never be cleaned');
    assert.strictEqual(await get(store, 'flow-1', 'keep'), 'yes');
    assert.strictEqual(await get(store, 'node-1:flow-1', 'keep'), 'yes');
    assert.strictEqual(await get(store, 'flow-orphan', 'drop'), undefined);

    await store.close();
});

test('clean accepts the allNodes object shape', async function () {
    var store = await openStore();

    await set(store, 'flow-keep', 'v', 1);
    await set(store, 'flow-gone', 'v', 2);

    await store.clean({ allNodes: { 'flow-keep': { id: 'flow-keep' } } });

    assert.strictEqual(await get(store, 'flow-keep', 'v'), 1);
    assert.strictEqual(await get(store, 'flow-gone', 'v'), undefined);

    await store.close();
});

test('clean ignores unrecognised input instead of wiping everything', async function () {
    var store = await openStore();

    await set(store, 'flow-1', 'v', 1);

    // A shape the store does not understand must be a no-op, never a full wipe.
    await store.clean(null);
    await store.clean(undefined);
    await store.clean({ unexpected: true });

    assert.strictEqual(await get(store, 'flow-1', 'v'), 1, 'data was wiped by an unknown clean() shape');

    await store.close();
});

test('values survive closing and reopening the store', async function () {
    var os = require('os');
    var fs = require('fs');
    var path = require('path');
    var dbFile = path.join(os.tmpdir(), 'nodered-ctx-persist-' + process.pid + '.sqlite');

    var store = createStore({ dialect: 'sqlite', storage: dbFile });
    await store.open();
    await set(store, 'global', 'persisted', 'across-restart');
    await set(store, 'flow-1', 'item', { n: 1 });
    await store.close();

    var reopened = createStore({ dialect: 'sqlite', storage: dbFile });
    await reopened.open();

    assert.strictEqual(await get(reopened, 'global', 'persisted'), 'across-restart');
    assert.deepStrictEqual(await get(reopened, 'flow-1', 'item'), { n: 1 });

    await reopened.close();
    fs.unlinkSync(dbFile);
});

test('close is idempotent', async function () {
    var store = await openStore();
    await store.close();
    await store.close();
});

test('decimal, boolean and null values keep their type', async function () {
    var store = await openStore();

    await set(store, 'global', 'num', 3.14);
    await set(store, 'global', 'bool', false);
    await set(store, 'global', 'nil', null);

    assert.strictEqual(await get(store, 'global', 'num'), 3.14);
    assert.strictEqual(await get(store, 'global', 'bool'), false);
    assert.strictEqual(await get(store, 'global', 'nil'), null);

    await store.close();
});

test('using the store before open() fails loudly', function () {
    var store = createStore({ dialect: 'sqlite', storage: ':memory:' });
    assert.throws(function () {
        store.get('global', 'x', function () {});
    }, /before open\(\)/);
});
