/**
 * Smoke test for the storage module.
 *
 * Runs the whole storage interface against an in-memory SQLite database, so it
 * needs no external service. Node-RED's storage contract is exercised in the
 * same order the runtime uses it during startup and deploy.
 *
 * Run with:  npm test
 */

var test = require('node:test');
var assert = require('node:assert');

var storage = require('../index.js');

/**
 * Builds a settings-like object pointing at an in-memory SQLite database.
 * @returns {object} A minimal settings object.
 */
function makeSettings() {
    return {
        storagePlugin: {
            dialect: 'sqlite',
            storage: ':memory:',
            logging: false
        }
    };
}

/**
 * Wraps the storage module so the SQLite dialect is accepted.
 *
 * The production plugin deliberately rejects anything other than postgres and
 * mysql, so the smoke test installs the models on top of a SQLite Sequelize
 * instance directly. This keeps the public behaviour untouched while still
 * validating every query.
 *
 * @returns {Promise<void>}
 */
async function initForTest() {
    var Sequelize = require('sequelize');
    var modelsFactory = require('../lib/models');

    var sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: ':memory:',
        logging: false
    });

    var models = modelsFactory.defineModels(sequelize);
    await sequelize.sync({ force: true });

    // Swap the internal state of the module for the test instance.
    var internals = require('../lib/test-hooks');
    internals.inject(sequelize, models);

    return sequelize;
}

test.before(async function () {
    await initForTest();
});

test.after(async function () {
    await storage.close();
});

test('getFlows returns an empty array before anything is saved', async function () {
    var flows = await storage.getFlows();
    assert.deepStrictEqual(flows, []);
});

test('saveFlows persists and getFlows reads the same document', async function () {
    var flows = [
        { id: 'tab1', type: 'tab', label: 'Flow 1' },
        { id: 'n1', type: 'inject', z: 'tab1' }
    ];

    await storage.saveFlows(flows, 'tester');
    var loaded = await storage.getFlows();

    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0].label, 'Flow 1');
    assert.strictEqual(loaded[1].type, 'inject');
});

test('saveFlows overwrites the previous document (singleton row)', async function () {
    await storage.saveFlows([{ id: 'only', type: 'tab' }], 'tester');
    var loaded = await storage.getFlows();
    assert.strictEqual(loaded.length, 1);
});

test('saveFlows accepts the user object the runtime actually passes', async function () {
    // Node-RED forwards `req.user`, which is an object like
    // `{ username, permissions }`. Passing it straight to a STRING column used
    // to raise "deployedBy cannot be an array or an object".
    var fakeUser = {
        username: 'admin',
        permissions: '*',
        req: { some: 'internal' }
    };

    await storage.saveFlows([{ id: 'tab-user', type: 'tab' }], fakeUser);

    var Models = require('../lib/state').getModels();
    var row = await Models.Flows.findByPk(1);
    assert.strictEqual(row.deployedBy, 'admin');
});

test('saveFlows falls back to other user fields', async function () {
    await storage.saveFlows([{ id: 'tab-user2', type: 'tab' }], { name: 'operator' });

    var Models = require('../lib/state').getModels();
    var row = await Models.Flows.findByPk(1);
    assert.strictEqual(row.deployedBy, 'operator');
});

test('saveFlows tolerates a null or anonymous user', async function () {
    var Models = require('../lib/state').getModels();

    await storage.saveFlows([{ id: 'tab-a', type: 'tab' }], null);
    var rowNull = await Models.Flows.findByPk(1);
    assert.strictEqual(rowNull.deployedBy, null);

    await storage.saveFlows([{ id: 'tab-b', type: 'tab' }], { permissions: '*' });
    var rowAnon = await Models.Flows.findByPk(1);
    assert.strictEqual(rowAnon.deployedBy, null);
});

test('credentials are stored verbatim, including encrypted blobs', async function () {
    var encrypted = { $: 'a'.repeat(32) + 'ZW5jcnlwdGVk' };

    await storage.saveCredentials(encrypted);
    var loaded = await storage.getCredentials();

    assert.deepStrictEqual(loaded, encrypted);
});

test('credentials default to an empty object when never saved', async function () {
    // Clean slate in a fresh table is covered by the very first read below.
    await storage.saveCredentials({});
    var loaded = await storage.getCredentials();
    assert.deepStrictEqual(loaded, {});
});

test('getSettings never returns null', async function () {
    var settings = await storage.getSettings();
    assert.notStrictEqual(settings, null);
    assert.strictEqual(typeof settings, 'object');
});

test('saveSettings round-trips the credential secret', async function () {
    await storage.saveSettings({ _credentialSecret: 'super-secret-key' });
    var settings = await storage.getSettings();

    assert.strictEqual(settings._credentialSecret, 'super-secret-key');
});

test('saveSettings removes keys the runtime deleted', async function () {
    await storage.saveSettings({ _credentialSecret: 'a', credentialSecret: 'b' });
    await storage.saveSettings({ credentialSecret: 'b' });

    var settings = await storage.getSettings();
    assert.strictEqual(settings._credentialSecret, undefined);
    assert.strictEqual(settings.credentialSecret, 'b');
});

test('sessions round-trip', async function () {
    await storage.saveSessions({ token1: { user: 'admin' } });
    var sessions = await storage.getSessions();

    assert.strictEqual(sessions.token1.user, 'admin');
});

test('library entries round-trip and listing puts directories first', async function () {
    await storage.saveLibraryEntry('functions', 'utils/format.js', { name: 'format' }, 'return 1;');
    await storage.saveLibraryEntry('functions', 'root.js', {}, 'return 2;');

    var body = await storage.getLibraryEntry('functions', 'utils/format.js');
    assert.strictEqual(body, 'return 1;');

    var listing = await storage.getLibraryEntry('functions', '');
    assert.strictEqual(listing.length, 2);
    // `utils` is a directory, so it comes before the `root.js` file entry.
    assert.deepStrictEqual(listing[0], { fn: 'utils' });
    assert.strictEqual(listing[1].fn, 'root.js');
});

test('missing library entry throws', async function () {
    await assert.rejects(
        function () { return storage.getLibraryEntry('functions', 'does/not/exist.js'); },
        /Library Entry not found/
    );
});

test('library entries with the same path are updated, not duplicated', async function () {
    await storage.saveLibraryEntry('flows', 'reusable', {}, 'first');
    await storage.saveLibraryEntry('flows', 'reusable', {}, 'second');

    var body = await storage.getLibraryEntry('flows', 'reusable.json');
    assert.strictEqual(body, 'second');
});

test('the library key hash is stable and fixed width', function () {
    var modelsFactory = require('../lib/models');

    var first = modelsFactory.libraryKeyHash('functions', 'utils/format.js');
    var second = modelsFactory.libraryKeyHash('functions', 'utils/format.js');

    assert.strictEqual(first, second, 'the hash must be deterministic');
    assert.strictEqual(first.length, 64, 'a sha256 hex digest is 64 characters');
    assert.match(first, /^[0-9a-f]{64}$/);
});

test('the library key hash separates adjacent type/path pairs', function () {
    var modelsFactory = require('../lib/models');

    // Without a separator, ("ab", "c") and ("a", "bc") would collide.
    assert.notStrictEqual(
        modelsFactory.libraryKeyHash('ab', 'c'),
        modelsFactory.libraryKeyHash('a', 'bc')
    );

    // Same path, different library type: distinct entries.
    assert.notStrictEqual(
        modelsFactory.libraryKeyHash('flows', 'x'),
        modelsFactory.libraryKeyHash('functions', 'x')
    );
});

test('every indexed column is narrow enough for MySQL', function () {
    // InnoDB refuses indexes over 3072 bytes with utf8mb4 (4 bytes per char).
    // This guards the schema against a future widening of an indexed column.
    var BYTES_PER_CHAR = 4;
    var MAX_INDEX_BYTES = 3072;

    var models = require('../lib/state').getModels();

    Object.keys(models).forEach(function (name) {
        var model = models[name];
        (model.options.indexes || []).forEach(function (index) {
            var total = index.fields.reduce(function (sum, field) {
                var attribute = model.rawAttributes[field];
                var length = attribute && attribute.type.options && attribute.type.options.length;
                return sum + (length ? length * BYTES_PER_CHAR : 0);
            }, 0);

            assert.ok(total <= MAX_INDEX_BYTES,
                name + ': index "' + index.name + '" is ' + total + ' bytes, over the ' +
                MAX_INDEX_BYTES + ' byte MySQL limit');
        });
    });
});

test('the library unique index does not depend on column widths', async function () {
    // The regression: an index over (type, path) with the legacy widths
    // (64 + 768 characters = 3328 bytes) is impossible on MySQL. Indexing the
    // fixed-width hash instead keeps it valid on any existing table.
    var models = require('../lib/state').getModels();
    var libraryIndexes = models.LibraryEntry.options.indexes || [];

    var unique = libraryIndexes.filter(function (index) { return index.unique; });
    assert.strictEqual(unique.length, 1, 'exactly one unique index is expected');
    assert.deepStrictEqual(unique[0].fields, ['keyHash']);
});
