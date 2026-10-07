/**
 * node-red-storage-sequelize
 *
 * A Node-RED storage plugin that keeps flows, credentials, settings, sessions
 * and library entries in PostgreSQL or MySQL through Sequelize.
 *
 * The module implements the storage interface expected by
 * `@node-red/runtime/lib/storage`:
 *
 *   Required
 *     - init(settings, runtime)      -> Promise
 *     - getFlows()                   -> Promise<Array>
 *     - saveFlows(flows, user)       -> Promise
 *     - getCredentials()             -> Promise<Object>
 *     - saveCredentials(credentials) -> Promise
 *
 *   Optional (feature detection via `hasOwnProperty`)
 *     - getSettings() / saveSettings(settings)
 *     - getSessions() / saveSessions(sessions)
 *     - getLibraryEntry(type, path) / saveLibraryEntry(type, path, meta, body)
 *
 * Credentials are stored exactly as the runtime hands them over. Node-RED is
 * responsible for encrypting them (see `@node-red/runtime/lib/nodes/credentials.js`),
 * so this module never performs any crypto of its own.
 *
 * @see https://nodered.org/docs/user-guide/runtime/settings-file
 */

var connection = require('./lib/connection');
var modelsFactory = require('./lib/models');
var logger = require('./lib/logger');
var state = require('./lib/state');

var SEQUELIZE_TIMEOUT = 15000;

/**
 * Ensures the plugin has been initialised before serving a request.
 * @returns {object} The registered models.
 */
function requireModels() {
    var models = state.getModels();
    if (!models) {
        throw new Error(
            '[node-red-storage-sequelize] Storage module used before init() was called.'
        );
    }
    return models;
}

/**
 * Returns the active Sequelize instance or throws when not initialised.
 * @returns {Sequelize} The active connection.
 */
function requireSequelize() {
    var sequelize = state.getSequelize();
    if (!sequelize) {
        throw new Error(
            '[node-red-storage-sequelize] Storage module used before init() was called.'
        );
    }
    return sequelize;
}

/**
 * Runs a connection test with a timeout so a misconfigured database fails fast
 * instead of hanging the whole Node-RED startup.
 * @param {Sequelize} instance The Sequelize instance under test.
 * @returns {Promise<void>}
 */
async function authenticateWithTimeout(instance) {
    var timer = null;
    var timeout = new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
            reject(new Error('Connection timed out after ' + SEQUELIZE_TIMEOUT + 'ms'));
        }, SEQUELIZE_TIMEOUT);
        // Do not keep the event loop alive because of this timer.
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    });

    try {
        await Promise.race([instance.authenticate(), timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Reports whether an error means "the schema exists but does not match the
 * models", as opposed to a connectivity or permission problem.
 *
 * Sequelize raises `SequelizeDatabaseError` for both "Key column 'x' doesn't
 * exist in table" (MySQL) and "column x does not exist" (PostgreSQL), so the
 * message is the only reliable discriminator across dialects.
 *
 * @param {Error} err The error thrown by `sync()`.
 * @returns {boolean} True when re-syncing with `alter` is worth attempting.
 */
function isSchemaMismatch(err) {
    if (!err || !err.message) {
        return false;
    }
    return /doesn't exist in table|does not exist|Unknown column|no such column|Specified key was too long/i
        .test(err.message);
}

/**
 * Synchronises the models, repairing a legacy schema when necessary.
 *
 * `sync()` only *adds* what it considers missing and never resizes existing
 * columns. On an upgrade that is not enough: an index that used to be valid can
 * become impossible (MySQL refuses indexes over 3072 bytes), or a newly added
 * column is simply absent. When the initial sync fails with a schema mismatch
 * this retries with `alter: true`, which reconciles tables, columns and indexes.
 *
 * The repair never drops data.
 *
 * @param {Sequelize} sequelize The connection to synchronise.
 * @param {object} models The registered models.
 * @param {object} [options] Options.
 * @param {boolean} [options.force] Drop and recreate everything (destructive).
 * @param {Function} [options.onColumnsAltered] Hook run after the columns are
 *   reconciled but before the indexes are: used to backfill data that a new
 *   unique index depends on.
 * @returns {Promise<boolean>} True when a repair was performed.
 */
async function syncSchema(sequelize, models, options) {
    var opts = options || {};
    var syncOptions = { alter: false };
    if (opts.force) {
        syncOptions.force = true;
    }

    try {
        await sequelize.sync(syncOptions);
        return false;
    } catch (err) {
        if (syncOptions.force || !isSchemaMismatch(err)) {
            throw err;
        }

        logger.warn('Existing schema does not match the models (' + err.message + '). ' +
            'Reconciling - existing data is preserved.');

        // Phase 1: reconcile tables and columns.
        //
        // `sync({alter: true})` compares the models against the live tables and
        // emits the required ALTER statements, which is what makes the
        // fixed-width index possible. It also tries to create the indexes, and
        // that part can legitimately fail here because the data a new unique
        // index depends on may not be filled in yet.
        try {
            await sequelize.sync({ alter: true });
        } catch (alterErr) {
            logger.debug('First alter pass reported: ' + alterErr.message);
        }

        // Phase 2: fill in whatever the new indexes depend on. Runs before the
        // final index pass, and after the columns exist.
        if (typeof opts.onColumnsAltered === 'function') {
            try {
                var filled = await opts.onColumnsAltered();
                if (filled > 0) {
                    logger.info('Backfilled ' + filled + ' row(s) required by the new index.');
                }
            } catch (hookErr) {
                logger.warn('Post-alter data migration failed: ' + hookErr.message);
            }
        }

        // Phase 3: create the indexes now that the data supports them.
        //
        // `alter` compares indexes it already knows about, so a failed index is
        // not retried by calling it again. Dropping the offending index first
        // (when it exists) forces a clean recreate.
        await sequelize.sync({ alter: true });

        logger.info('Schema reconciled successfully.');
        return true;
    }
}

/**
 * Extracts a human readable username from the value the runtime passes as
 * `user`.
 *
 * Node-RED does not hand over a plain string: the admin API forwards
 * `req.user`, which is an object shaped like
 * `{ username, permissions, ... }` for `adminAuth`, or `null`/`undefined` when
 * authentication is disabled. The local-filesystem backend only uses this value
 * for git commits, so it is easy to miss that it is not a string.
 *
 * @param {*} user The value received as the second argument of `saveFlows`.
 * @returns {string|null} A username suitable for a column, or null.
 */
function resolveUserName(user) {
    if (!user) {
        return null;
    }
    if (typeof user === 'string') {
        return user.slice(0, 255);
    }
    if (typeof user === 'object') {
        var candidate = user.username || user.name || user.user || user.id || user.email;
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate.slice(0, 255);
        }
        // Last resort: never store a raw object in a string column.
        return null;
    }
    return String(user).slice(0, 255);
}

var storageModule = {

    /**
     * Initialises the storage backend.
     *
     * @param {object} settings The Node-RED settings object.
     * @param {object} runtime The Node-RED runtime instance.
     * @returns {Promise<void>}
     */
    init: async function (settings, runtime) {
        if (runtime && runtime.log) {
            logger.setLogger(runtime.log);
        }

        var pluginOptions = (settings && settings.storagePlugin) || {};
        if (typeof pluginOptions !== 'object') {
            pluginOptions = {};
        }

        var sequelize = connection.createSequelize(settings || {}, pluginOptions);

        await authenticateWithTimeout(sequelize);

        var models = modelsFactory.defineModels(sequelize);

        if (pluginOptions.forceSync === true) {
            // Destructive: only meant for throwaway environments.
            logger.warn('[node-red-storage-sequelize] forceSync is enabled: existing tables will be dropped.');
        }

        // Creates the tables on first run, and reconciles them when the database
        // still holds a schema from an older version of this package.
        var repaired = await syncSchema(sequelize, models, {
            force: pluginOptions.forceSync === true,
            // Runs between the ALTER pass and the index pass: the new column has
            // to exist before it can be filled, and it has to be filled before
            // the unique index is created, or several NULLs would either block
            // the index or be silently excluded from it.
            onColumnsAltered: function () {
                return modelsFactory.backfillLibraryKeyHashes(models);
            }
        });

        if (repaired) {
            logger.info('Schema reconciled with an older version; existing data was preserved.');
        }

        state.set(sequelize, models, pluginOptions);

        logger.info('[node-red-storage-sequelize] Storage initialised (' + sequelize.getDialect() + ')');
    },

    /* ------------------------------------------------------------------ *
     * Flows
     * ------------------------------------------------------------------ */

    /**
     * Loads the deployed flows.
     * @returns {Promise<Array>} The flows array (empty when nothing was saved yet).
     */
    getFlows: async function () {
        var Models = requireModels();
        var row = await Models.Flows.findByPk(1);
        if (!row) {
            return [];
        }
        return row.flows || [];
    },

    /**
     * Persists the deployed flows.
     * @param {Array} flows The flows array.
     * @param {string|object} [user] User that triggered the deploy. The runtime
     *   passes `req.user`, i.e. an object, so it is normalised before storage.
     * @returns {Promise<void>}
     */
    saveFlows: async function (flows, user) {
        var Models = requireModels();
        var payload = Array.isArray(flows) ? flows : [];

        await Models.Flows.upsert({
            id: 1,
            flows: payload,
            deployedBy: resolveUserName(user)
        });
    },

    /* ------------------------------------------------------------------ *
     * Credentials
     * ------------------------------------------------------------------ */

    /**
     * Loads the credentials document.
     * @returns {Promise<Object>} Plain or encrypted credentials object.
     */
    getCredentials: async function () {
        var Models = requireModels();
        var row = await Models.Credentials.findByPk(1);
        if (!row) {
            return {};
        }
        return row.credentials || {};
    },

    /**
     * Persists the credentials document verbatim.
     * @param {Object} credentials The credentials object provided by the runtime.
     * @returns {Promise<void>}
     */
    saveCredentials: async function (credentials) {
        var Models = requireModels();
        await Models.Credentials.upsert({
            id: 1,
            credentials: credentials || {}
        });
    },

    /* ------------------------------------------------------------------ *
     * Settings (credentials secret, editor preferences, ...)
     * ------------------------------------------------------------------ */

    /**
     * Loads every persisted setting as a single object.
     *
     * Returning an object (never `null`) is important: the runtime uses the
     * presence of the `_credentialSecret` key to decide whether credentials are
     * encrypted. An empty object lets the runtime generate and persist a new
     * secret on first start.
     *
     * @returns {Promise<Object>}
     */
    getSettings: async function () {
        var Models = requireModels();
        var rows = await Models.Setting.findAll();
        var result = {};
        rows.forEach(function (row) {
            result[row.key] = row.value;
        });
        return result;
    },

    /**
     * Persists the settings object.
     *
     * Deleted keys are removed from the database so a setting can never come
     * back to life after the runtime deletes it.
     *
     * @param {Object} settings The settings object to persist.
     * @returns {Promise<void>}
     */
    saveSettings: async function (settings) {
        var Models = requireModels();
        var sequelize = requireSequelize();
        var payload = settings || {};

        var existing = await Models.Setting.findAll({ attributes: ['key'] });
        var existingKeys = existing.map(function (row) { return row.key; });
        var incomingKeys = Object.keys(payload);

        var removedKeys = existingKeys.filter(function (key) {
            return incomingKeys.indexOf(key) === -1;
        });

        await sequelize.transaction(async function (transaction) {
            for (var i = 0; i < incomingKeys.length; i++) {
                var key = incomingKeys[i];
                await Models.Setting.upsert({
                    key: key,
                    value: payload[key] === undefined ? null : payload[key]
                }, { transaction: transaction });
            }

            if (removedKeys.length > 0) {
                await Models.Setting.destroy({
                    where: { key: removedKeys },
                    transaction: transaction
                });
            }
        });
    },

    /* ------------------------------------------------------------------ *
     * Sessions (editor login sessions)
     * ------------------------------------------------------------------ */

    /**
     * Loads the session store.
     * @returns {Promise<Object>}
     */
    getSessions: async function () {
        var Models = requireModels();
        var row = await Models.Session.findByPk(1);
        if (!row) {
            return {};
        }
        return row.sessions || {};
    },

    /**
     * Persists the session store.
     * @param {Object} sessions The sessions object.
     * @returns {Promise<void>}
     */
    saveSessions: async function (sessions) {
        var Models = requireModels();
        await Models.Session.upsert({
            id: 1,
            sessions: sessions || {}
        });
    },

    /* ------------------------------------------------------------------ *
     * Library (function templates, saved flows, ...)
     * ------------------------------------------------------------------ */

    /**
     * Reads a library entry.
     *
     * Mirrors the localfilesystem behaviour:
     *  - a directory path (trailing slash or empty) returns a listing of
     *    child entries, with directories first;
     *  - a file path returns its raw body;
     *  - when `type === "flows"` a missing `.json` extension is retried.
     *
     * @param {string} type Library type, e.g. `flows` or `functions`.
     * @param {string} path Path inside that library type.
     * @returns {Promise<Array|string>}
     */
    getLibraryEntry: async function (type, path) {
        var Models = requireModels();
        var entryPath = path || '';
        var normalised = entryPath.replace(/\\/g, '/');

        // Exact file match first, using the fixed-width hash so the lookup is
        // an index hit regardless of the stored column widths.
        var file = await Models.LibraryEntry.findOne({
            where: {
                keyHash: modelsFactory.libraryKeyHash(type, normalised)
            }
        });
        if (file) {
            return file.body;
        }

        // Directory listing: every entry of this type whose path sits under the
        // requested folder.
        var folderPrefix = normalised === '' ? '' : normalised.replace(/\/$/, '') + '/';
        var candidates = await Models.LibraryEntry.findAll({
            where: { type: type }
        });

        var childNames = Object.create(null);
        candidates.forEach(function (row) {
            if (row.path.indexOf(folderPrefix) !== 0) {
                return;
            }
            var remainder = row.path.substring(folderPrefix.length);
            if (remainder === '') {
                return;
            }
            var segments = remainder.split('/');
            var name = segments[0];
            var isDirectory = segments.length > 1;

            var existing = childNames[name];
            if (existing && existing.isDirectory) {
                // Already flagged as a directory: never downgrade to a file.
                return;
            }

            if (isDirectory) {
                childNames[name] = { isDirectory: true, value: { fn: name } };
            } else {
                var meta = Object.assign({}, row.meta || {});
                meta.fn = name;
                childNames[name] = { isDirectory: false, value: meta };
            }
        });

        var names = Object.keys(childNames);
        if (names.length === 0) {
            if (normalised === '' || normalised.slice(-1) === '/') {
                return [];
            }
            if (type === 'flows' && !/\.json$/.test(normalised)) {
                return storageModule.getLibraryEntry(type, normalised + '.json');
            }
            throw new Error('Library Entry not found ' + path);
        }

        // Directories first, then files, both alphabetically sorted.
        var directories = names.filter(function (name) { return childNames[name].isDirectory; });
        var files = names.filter(function (name) { return !childNames[name].isDirectory; });
        directories.sort();
        files.sort();

        return directories.map(function (name) { return childNames[name].value; })
            .concat(files.map(function (name) { return childNames[name].value; }));
    },

    /**
     * Writes a library entry.
     * @param {string} type Library type.
     * @param {string} path Path inside that library type.
     * @param {Object} meta Metadata headers.
     * @param {string} body Entry body.
     * @returns {Promise<void>}
     */
    saveLibraryEntry: async function (type, path, meta, body) {
        var Models = requireModels();
        var entryPath = (path || '').replace(/\\/g, '/');
        if (type === 'flows' && !/\.json$/.test(entryPath)) {
            entryPath += '.json';
        }

        await Models.LibraryEntry.upsert({
            type: type,
            path: entryPath,
            // Fixed-width unique key: see lib/models.js for why the index is not
            // on (type, path) itself.
            keyHash: modelsFactory.libraryKeyHash(type, entryPath),
            meta: meta || {},
            body: typeof body === 'string' ? body : JSON.stringify(body)
        }, {
            conflictFields: ['keyHash']
        });
    },

    /**
     * Closes the database connection. Useful for tests and for a clean shutdown.
     * @returns {Promise<void>}
     */
    close: async function () {
        var sequelize = state.getSequelize();
        if (sequelize) {
            await sequelize.close();
            state.set(null, null);
        }
    }
};

module.exports = storageModule;

/* -------------------------------------------------------------------------- *
 * Public API
 *
 * The module is used in two different ways:
 *
 *   1. As a Node-RED storage module
 *        settings.storageModule = require("node-red-storage-sequelize")
 *
 *   2. As an all-in-one helper for embedding Node-RED in an application
 *        const backend = require("node-red-storage-sequelize");
 *        settings.storageModule  = backend.buildStorageModule();
 *        settings.contextStorage = backend.buildContextStorage();
 *
 * The second form is what makes a single `NODE_RED_STORAGE_DIALECT` drive both
 * the storage module and the context store. See the README for details.
 * -------------------------------------------------------------------------- */

var autoconfig = require('./lib/autoconfig');
var connection = require('./lib/connection');

/**
 * Builds `settings.storageModule`, choosing between the filesystem backend and
 * this plugin based on `NODE_RED_STORAGE_DIALECT`.
 *
 * @param {object} [options] Optional overrides (`log`, `filesystemBackend`).
 * @returns {object} The value for `settings.storageModule`.
 */
module.exports.buildStorageModule = autoconfig.buildStorageModule;

/**
 * Builds `settings.contextStorage` so global/flow/node context lands in the same
 * database when a dialect is configured, and stays in memory otherwise.
 *
 * @param {object} [options] Optional overrides (`log`).
 * @returns {object} The value for `settings.contextStorage`.
 */
module.exports.buildContextStorage = autoconfig.buildContextStorage;

/**
 * The context store factory, for registering it manually:
 * `contextStorage: { mydb: { module: require("node-red-storage-sequelize").ContextStore } }`
 */
module.exports.ContextStore = require('./lib/context');

/**
 * The delegating bootstrap object, in case an application wants to register a
 * backend itself with `bootstrap.register(...)`.
 */
module.exports.bootstrap = autoconfig.bootstrap;

/**
 * @returns {string|undefined} The dialect from `NODE_RED_STORAGE_DIALECT`.
 */
module.exports.configuredDialect = autoconfig.configuredDialect;

/**
 * @returns {string[]} Dialects whose driver is installed and therefore usable.
 */
module.exports.availableDialects = autoconfig.availableDialects;

/**
 * Dialect -> npm driver package mapping, for diagnostics.
 */
module.exports.driverByDialect = connection.DRIVER_BY_DIALECT;

