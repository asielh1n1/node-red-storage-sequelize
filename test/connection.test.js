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

test('a connection URL without sslmode is passed through untouched', { skip: !HAS_PG }, function () {
    var url = 'postgres://user:pass@db:5432/nodered';
    var resolved = connection.resolveConfig({ url: url });
    assert.strictEqual(resolved.connection, url);
});

test('sslmode=require gains uselibpqcompat so libpq semantics apply', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({
        dialect: 'postgres',
        url: 'postgresql://u:p@db:5432/nodered?sslmode=require'
    });
    assert.match(resolved.connection, /sslmode=require/);
    assert.match(resolved.connection, /uselibpqcompat=true/);
});

test('sslmode=prefer and no-verify are normalised too', { skip: !HAS_PG }, function () {
    ['prefer', 'no-verify'].forEach(function (mode) {
        var resolved = connection.resolveConfig({
            dialect: 'postgres',
            url: 'postgresql://u:p@db:5432/nodered?sslmode=' + mode
        });
        assert.match(resolved.connection, /uselibpqcompat=true/, 'mode ' + mode);
    });
});

test('strict sslmodes are left alone', { skip: !HAS_PG }, function () {
    ['verify-ca', 'verify-full'].forEach(function (mode) {
        var url = 'postgresql://u:p@db:5432/nodered?sslmode=' + mode;
        var resolved = connection.resolveConfig({ dialect: 'postgres', url: url });
        assert.strictEqual(resolved.connection, url, 'mode ' + mode + ' must not change');
    });
});

test('an explicit uselibpqcompat is respected verbatim', { skip: !HAS_PG }, function () {
    var url = 'postgresql://u:p@db:5432/nodered?uselibpqcompat=false&sslmode=require';
    var resolved = connection.resolveConfig({ dialect: 'postgres', url: url });
    assert.strictEqual(resolved.connection, url, 'the author decision wins');
});

test('normalising the URL twice is a no-op', { skip: !HAS_PG }, function () {
    var once = connection.resolveConfig({
        dialect: 'postgres',
        url: 'postgresql://u:p@db:5432/nodered?sslmode=require'
    }).connection;
    var twice = connection.resolveConfig({ dialect: 'postgres', url: once }).connection;
    assert.strictEqual(twice, once, 'idempotent');
});

test('other parameters survive normalisation', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({
        dialect: 'postgres',
        url: 'postgresql://u:p@db:6543/nodered?pgbouncer=true&sslmode=require&application_name=nr'
    });
    assert.match(resolved.connection, /pgbouncer=true/);
    assert.match(resolved.connection, /application_name=nr/);
    assert.match(resolved.connection, /uselibpqcompat=true/);
});

test('non-libpq dialects keep their URL untouched', { skip: !HAS_MYSQL }, function () {
    var url = 'mysql://u:p@db:3306/nodered?sslmode=require';
    var resolved = connection.resolveConfig({ dialect: 'mysql', url: url });
    assert.strictEqual(resolved.connection, url);
});

test('a URL owns its TLS settings, so ssl options do not override it', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({
        dialect: 'postgres',
        url: 'postgresql://u:p@db:5432/nodered?sslmode=require',
        ssl: true,
        sslRejectUnauthorized: true
    });
    assert.strictEqual(
        resolved.sequelizeOptions.dialectOptions,
        undefined,
        'dialectOptions.ssl would replace what the URL negotiated'
    );
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

test('SSL options still apply to the host and password form', { skip: !HAS_PG }, function () {
    var resolved = connection.resolveConfig({
        dialect: 'postgres',
        database: 'nodered',
        ssl: true
    });
    assert.strictEqual(resolved.sequelizeOptions.dialectOptions.ssl.require, true);
    assert.strictEqual(
        resolved.sequelizeOptions.dialectOptions.ssl.rejectUnauthorized,
        true,
        'defaults to validating the chain'
    );
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

/* -------------------------------------------------------------------------- *
 * Optional integration test
 *
 * The unit tests above only assert the shape of the resolved options. This one
 * proves the whole chain actually connects, which is what catches regressions
 * in the TLS handling. It is skipped unless a database URL is provided:
 *
 *   NODE_RED_TEST_PG_URL='postgresql://user:pass@host:5432/db?sslmode=require' \
 *       npm test
 *
 * Point it at a server whose certificate Node cannot verify on its own (a
 * self-signed one is the quickest way) to exercise the very failure this
 * normalisation exists to prevent.
 * -------------------------------------------------------------------------- */

var TEST_URL = process.env.NODE_RED_TEST_PG_URL;

test('a real database accepts the resolved connection', { skip: !TEST_URL || !HAS_PG }, async function () {
    var resolved = connection.resolveConfig({ dialect: 'postgres', url: TEST_URL });
    var Sequelize = require('sequelize');

    var instance = new Sequelize(resolved.connection, Object.assign({}, resolved.sequelizeOptions, {
        dialect: resolved.dialect
    }));

    try {
        await instance.authenticate();
        assert.ok(true, 'authenticated');
    } finally {
        await instance.close();
    }
});
