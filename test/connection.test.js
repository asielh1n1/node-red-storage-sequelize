/**
 * Configuration resolution tests.
 *
 * Validates dialect normalisation, default ports, URL handling, driver detection
 * and the validation errors — all without touching a real database.
 *
 * Tests that need a specific driver are skipped when it is not installed, so the
 * suite passes on a clean checkout where only SQLite (a devDependency) exists.
 */

var test = require('node:test');
var assert = require('node:assert');

var connection = require('../lib/connection');
var logger = require('../lib/logger');

// Silence the plugin logger during the test run.
logger.setLogger({ info: function () {}, warn: function () {}, error: function () {}, debug: function () {} });

/**
 * Reports whether a driver package is installed.
 * @param {string} name Package name.
 * @returns {boolean} True when resolvable.
 */
function driverInstalled(name) {
    try {
        require.resolve(name);
        return true;
    } catch (err) {
        return false;
    }
}

var HAS_PG = driverInstalled('pg');
var HAS_MYSQL = driverInstalled('mysql2');

test('postgres is the default dialect with port 5432', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({ database: 'nodered' });
    assert.strictEqual(resolved.dialect, 'postgres');
    assert.strictEqual(resolved.connection.port, 5432);
    assert.strictEqual(resolved.connection.host, 'localhost');
});

test('mysql defaults to port 3306', { skip: !HAS_MYSQL }, function () {
    var resolved = connection.resolveConfig({ dialect: 'mysql', database: 'nodered' });
    assert.strictEqual(resolved.dialect, 'mysql');
    assert.strictEqual(resolved.connection.port, 3306);
});

test('dialect aliases are normalised', function () {
    assert.strictEqual(connection.normaliseDialect('postgresql'), 'postgres');
    assert.strictEqual(connection.normaliseDialect('pg'), 'postgres');
    assert.strictEqual(connection.normaliseDialect('MySQL '), 'mysql');
    assert.strictEqual(connection.normaliseDialect('mariadb'), 'mariadb');
});

test('sqlite uses a file path instead of host and port', function () {
    var resolved = connection.resolveConfig({ dialect: 'sqlite', storage: ':memory:' });
    assert.strictEqual(resolved.dialect, 'sqlite');
    assert.strictEqual(resolved.connection, null, 'file dialects have no connection object');
    assert.strictEqual(resolved.sequelizeOptions.storage, ':memory:');
});

test('config wins over environment variables', function () {
    process.env.NODE_RED_STORAGE_DIALECT = 'sqlite';
    process.env.NODE_RED_STORAGE_STORAGE = 'from-env.sqlite';

    var resolved = connection.resolveConfig({ dialect: 'sqlite', storage: 'from-config.sqlite' });

    assert.strictEqual(resolved.sequelizeOptions.storage, 'from-config.sqlite');

    delete process.env.NODE_RED_STORAGE_DIALECT;
    delete process.env.NODE_RED_STORAGE_STORAGE;
});

test('environment variables are used when config is empty', function () {
    process.env.NODE_RED_STORAGE_DIALECT = 'sqlite';
    process.env.NODE_RED_STORAGE_STORAGE = 'from-env.sqlite';

    var resolved = connection.resolveConfig({});

    assert.strictEqual(resolved.dialect, 'sqlite');
    assert.strictEqual(resolved.sequelizeOptions.storage, 'from-env.sqlite');

    delete process.env.NODE_RED_STORAGE_DIALECT;
    delete process.env.NODE_RED_STORAGE_STORAGE;
});

test('a connection URL is passed through untouched', { skip: !HAS_PG }, function () {
    var url = 'postgres://user:pass@db:5432/nodered';
    var resolved = connection.resolveConfig({ url: url });
    assert.strictEqual(resolved.connection, url);
});

test('an unknown dialect is rejected with the known list', function () {
    assert.throws(function () {
        connection.resolveConfig({ dialect: 'oracle-nope', database: 'x' });
    }, /Unknown dialect/);
});

test('a dialect whose driver is missing names the package to install', function () {
    var missing = Object.keys(connection.DRIVER_BY_DIALECT).filter(function (dialect) {
        return !driverInstalled(connection.DRIVER_BY_DIALECT[dialect]);
    });

    if (missing.length === 0) {
        // Every driver happens to be installed; nothing to assert.
        return;
    }

    var dialect = missing[0];
    var driver = connection.DRIVER_BY_DIALECT[dialect];

    assert.throws(function () {
        connection.resolveConfig({ dialect: dialect, database: 'x' });
    }, new RegExp('npm install ' + driver));
});

test('a missing database is rejected with a helpful message', { skip: !HAS_PG }, function () {
    assert.throws(function () {
        connection.resolveConfig({ dialect: 'postgres' });
    }, /No database configured/);
});

test('SSL options are built into dialectOptions', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({
        dialect: 'postgres',
        database: 'nodered',
        ssl: true,
        sslRejectUnauthorized: false
    });

    assert.strictEqual(resolved.sequelizeOptions.dialectOptions.ssl.require, true);
    assert.strictEqual(resolved.sequelizeOptions.dialectOptions.ssl.rejectUnauthorized, false);
});

test('the connection pool size is configurable', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({ database: 'nodered', poolMax: 12 });
    assert.strictEqual(resolved.sequelizeOptions.pool.max, 12);
});

test('a custom schema is forwarded to Sequelize', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({ database: 'nodered', schema: 'nr' });
    assert.strictEqual(resolved.sequelizeOptions.schema, 'nr');
    assert.strictEqual(resolved.sequelizeOptions.searchPath, 'nr');
});

test('availableDialects only reports installed drivers', function () {
    var available = connection.availableDialects();

    available.forEach(function (dialect) {
        assert.ok(
            driverInstalled(connection.DRIVER_BY_DIALECT[dialect]),
            dialect + ' was reported as available but its driver is missing'
        );
    });

    assert.ok(available.indexOf('sqlite') !== -1, 'sqlite is a devDependency and must be available');
});

test('behaviour options default sensibly', function () {
    var defaults = connection.resolveBehaviour({});

    assert.strictEqual(defaults.cache, true);
    assert.strictEqual(defaults.flushInterval, 0, 'writes go straight to the database');
    assert.strictEqual(defaults.cacheTTL, 0, 'reads always hit the database');
});

test('behaviour options can be overridden', function () {
    var behaviour = connection.resolveBehaviour({ flushInterval: 10, cacheTTL: 5, cache: false });

    assert.strictEqual(behaviour.flushInterval, 10);
    assert.strictEqual(behaviour.cacheTTL, 5);
    assert.strictEqual(behaviour.cache, false);
});
