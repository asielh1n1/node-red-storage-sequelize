/**
 * Auto-configuration helpers.
 *
 * These build the two settings blocks Node-RED needs, from the environment, so
 * an embedding application only has to call them:
 *
 *   - `buildStorageModule()`  -> value for `settings.storageModule`
 *   - `buildContextStorage()` -> value for `settings.contextStorage`
 *
 * Design goal: **one variable drives both**. If `NODE_RED_STORAGE_DIALECT` is
 * set, flows *and* context move to that database. If it is not set, flows use
 * Node-RED's own filesystem storage and context stays in memory, so an
 * unconfigured checkout behaves exactly like a stock Node-RED install.
 */

var connection = require('./connection');
var storageBootstrap = require('./bootstrap');

/**
 * Reads an environment variable, treating blanks as "not configured".
 * @param {string} name Variable name.
 * @returns {string|undefined} The value, or undefined when unset/blank.
 */
function env(name) {
    var value = process.env[name];
    return value === undefined || value === null || String(value).trim() === ''
        ? undefined
        : String(value).trim();
}

/**
 * @returns {string|undefined} The configured dialect, if any.
 */
function configuredDialect() {
    return env('NODE_RED_STORAGE_DIALECT');
}

/**
 * Builds the storage module for `settings.storageModule`.
 *
 * Always returns the delegating bootstrap object rather than the plugin itself:
 * Node-RED decides whether it may persist settings by testing
 * `hasOwnProperty('getSettings')` **once** during startup, so the object must
 * expose that method even when the filesystem backend ends up being used.
 *
 * @param {object} [options] Optional overrides.
 * @param {Function} [options.log] Sink for the startup banner (default console.log).
 * @param {Function} [options.filesystemBackend] Override for the filesystem backend.
 * @returns {object} The value for `settings.storageModule`.
 */
function buildStorageModule(options) {
    var opts = options || {};
    var log = typeof opts.log === 'function' ? opts.log : console.log;
    var dialect = configuredDialect();

    if (!dialect) {
        log('[node-red-storage-sequelize] Flows/credentials: filesystem ' +
            '(set NODE_RED_STORAGE_DIALECT to use a database)');
        storageBootstrap.register(
            opts.filesystemBackend ? opts.filesystemBackend() : storageBootstrap.filesystemBackend()
        );
        return storageBootstrap;
    }

    log('[node-red-storage-sequelize] Flows/credentials: ' + dialect + ' via sequelize');
    storageBootstrap.register(require('../index.js'));
    return storageBootstrap;
}

/**
 * Builds the context storage for `settings.contextStorage`.
 *
 * Default (no dialect): a single memory store, which is Node-RED's own default.
 * With a dialect: the database store, registered under the dialect name, plus a
 * `memory` store, plus `default` as an **alias** of the database store.
 *
 * Why the alias matters: declaring `default` as another object would make
 * Node-RED instantiate a second, independent store over the same database, each
 * with its own cache. The alias form makes both names resolve to one instance.
 *
 * Why two stores at all: the editor only renders the store picker when more than
 * one store is configured (`editor-client/public/red/red.js` hides it when
 * `contextStoreOptions.length < 2`), so a single store leaves users unable to
 * choose where their data goes.
 *
 * @param {object} [options] Optional overrides.
 * @param {Function} [options.log] Sink for the startup banner (default console.log).
 * @returns {object} The value for `settings.contextStorage`.
 */
function buildContextStorage(options) {
    var opts = options || {};
    var log = typeof opts.log === 'function' ? opts.log : console.log;
    var dialect = configuredDialect();

    if (!dialect) {
        log('[node-red-storage-sequelize] Context (global/flow/node): memory ' +
            '(set NODE_RED_STORAGE_DIALECT to persist it)');
        return {
            default: { module: 'memory' }
        };
    }

    log('[node-red-storage-sequelize] Context (global/flow/node): ' + dialect +
        ' via sequelize (stores: memory, ' + dialect + '; default -> ' + dialect + ')');

    var contextStorage = {
        // Volatile values: keeps them out of the database.
        memory: {
            module: 'memory'
        },
        // Named after the driver so the editor's picker is self-explanatory.
        //
        // `flushInterval` is intentionally left at its default of 0: writes go
        // straight to the database, so nothing is lost on an abrupt exit and
        // every reader sees the same value immediately.
        [dialect]: {
            module: require('./context'),
            config: {}
        },
        // Alias, NOT a second instance.
        default: dialect
    };

    return contextStorage;
}

/**
 * Reports which dialects can be used, based on the installed drivers.
 * @returns {string[]} Usable dialect names.
 */
function availableDialects() {
    return connection.availableDialects();
}

module.exports = {
    buildStorageModule: buildStorageModule,
    buildContextStorage: buildContextStorage,
    configuredDialect: configuredDialect,
    availableDialects: availableDialects,
    bootstrap: storageBootstrap
};
