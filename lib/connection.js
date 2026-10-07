/**
 * Sequelize connection factory, shared by the storage module and the context
 * store.
 *
 * Resolution order for every option:
 *   1. The `config` object passed by Node-RED.
 *   2. The `NODE_RED_STORAGE_*` environment variable.
 *
 * Both features read the same variables on purpose: one set of credentials
 * drives everything, so enabling `NODE_RED_STORAGE_DIALECT` moves flows *and*
 * context to the database without further configuration.
 *
 * Any dialect Sequelize supports can be used, provided the matching driver is
 * installed (`pg`, `mysql2`, `mariadb`, `tedious`, `sqlite3`, ...).
 */

var Sequelize = require('sequelize');
var logger = require('./logger');

var PREFIX = 'NODE_RED_STORAGE_';

/**
 * Dialect name -> npm driver package.
 *
 * Sequelize resolves drivers itself, but it requires them lazily and produces an
 * unhelpful error when one is missing. Knowing the mapping lets us fail with an
 * actionable message before Sequelize even tries.
 */
var DRIVER_BY_DIALECT = {
    postgres: 'pg',
    mysql: 'mysql2',
    mariadb: 'mariadb',
    mssql: 'tedious',
    sqlite: 'sqlite3',
    db2: 'ibm_db',
    snowflake: 'snowflake-sdk',
    oracle: 'oracledb'
};

/**
 * Normalises a dialect name to the value Sequelize expects.
 * @param {string} dialect Raw dialect name.
 * @returns {string} A Sequelize dialect name.
 */
function normaliseDialect(dialect) {
    var value = String(dialect || '').toLowerCase().trim();
    if (value === 'postgresql' || value === 'pg') {
        return 'postgres';
    }
    return value;
}

/**
 * Checks whether a module can be resolved from this package.
 * @param {string} name Module name.
 * @returns {boolean} True when resolvable.
 */
function tryResolve(name) {
    try {
        require.resolve(name);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Reports whether a dialect can actually be used.
 * @param {string} dialect Normalised dialect name.
 * @returns {{ known: boolean, supported: boolean, driver: (string|null) }} Result.
 */
function resolveDriver(dialect) {
    var driver = DRIVER_BY_DIALECT[dialect];
    if (!driver) {
        return { known: false, supported: false, driver: null };
    }
    return { known: true, supported: tryResolve(driver), driver: driver };
}

/**
 * @returns {string[]} Dialects whose driver is installed.
 */
function availableDialects() {
    return Object.keys(DRIVER_BY_DIALECT).filter(function (dialect) {
        return resolveDriver(dialect).supported;
    });
}

/**
 * Reads the first defined value.
 * @param {...*} values Candidates (empty strings are ignored).
 * @returns {*} The first usable value or undefined.
 */
function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
        var value = arguments[i];
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return undefined;
}

/**
 * Reads a value from config, then from the environment.
 * @param {object} config Node-RED config for this feature.
 * @param {string} key Camel-case key, e.g. `database`.
 * @param {string} envKey Environment suffix, e.g. `DATABASE`.
 * @returns {*} The resolved value or undefined.
 */
function pick(config, key, envKey) {
    return firstDefined(
        config ? config[key] : undefined,
        process.env[PREFIX + envKey]
    );
}

/**
 * Reads a boolean option.
 * @param {object} config Config object.
 * @param {string} key Camel-case key.
 * @param {string} envKey Environment suffix.
 * @param {boolean} defaultValue Fallback.
 * @returns {boolean} The resolved value.
 */
function pickBool(config, key, envKey, defaultValue) {
    var raw = pick(config, key, envKey);
    if (raw === undefined) {
        return defaultValue;
    }
    if (typeof raw === 'boolean') {
        return raw;
    }
    var text = String(raw).toLowerCase();
    return text === 'true' || text === '1' || text === 'yes';
}

/**
 * Reads an integer option.
 * @param {object} config Config object.
 * @param {string} key Camel-case key.
 * @param {string} envKey Environment suffix.
 * @param {number} defaultValue Fallback.
 * @returns {number} The resolved value.
 */
function pickInt(config, key, envKey, defaultValue) {
    var raw = pick(config, key, envKey);
    if (raw === undefined) {
        return defaultValue;
    }
    var parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Default TCP port for a dialect.
 * @param {string} dialect Normalised dialect name.
 * @returns {number} The default port.
 */
function defaultPort(dialect) {
    switch (dialect) {
        case 'mysql':
        case 'mariadb':
            return 3306;
        case 'mssql':
            return 1433;
        case 'db2':
            return 50000;
        case 'oracle':
            return 1521;
        default:
            return 5432;
    }
}

/**
 * Builds the Sequelize options.
 *
 * The dialect is added by the caller: Sequelize v6 expects it inside the options
 * object when a connection URL is passed, and would otherwise try to parse the
 * connection object as a URL and fail.
 *
 * @param {string} dialect Normalised dialect name.
 * @param {object} config Config object.
 * @returns {object} Sequelize constructor options.
 */
function buildSequelizeOptions(dialect, config) {
    var options = {
        logging: pickBool(config, 'logging', 'LOGGING', false)
            ? function (message) { logger.debug(message); }
            : false,
        pool: {
            max: pickInt(config, 'poolMax', 'POOL_MAX', 5),
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    };

    // File-based dialects (sqlite) take a path instead of host/port.
    var storageFile = pick(config, 'storage', 'STORAGE');
    if (storageFile) {
        options.storage = storageFile;
    }

    var schema = pick(config, 'schema', 'SCHEMA');
    if (schema) {
        options.schema = schema;
        options.searchPath = schema;
    }

    var ssl = pickBool(config, 'ssl', 'SSL', false);
    if (ssl) {
        options.dialectOptions = {
            ssl: {
                require: true,
                rejectUnauthorized: pickBool(config, 'sslRejectUnauthorized', 'SSL_REJECT_UNAUTHORIZED', true)
            }
        };
    }

    void dialect;
    return options;
}

/**
 * Resolves the full connection configuration.
 *
 * @param {object} config Node-RED config for this feature.
 * @returns {object} `{ dialect, connection, sequelizeOptions }`.
 * @throws {Error} When the dialect is unknown or its driver is missing.
 */
function resolveConfig(config) {
    var dialect = normaliseDialect(pick(config, 'dialect', 'DIALECT') || 'postgres');

    var availability = resolveDriver(dialect);
    if (!availability.supported) {
        if (!availability.known) {
            throw new Error(
                '[node-red-storage-sequelize] Unknown dialect "' + dialect + '". ' +
                'Known dialects: ' + Object.keys(DRIVER_BY_DIALECT).join(', ') + '.'
            );
        }
        throw new Error(
            '[node-red-storage-sequelize] Dialect "' + dialect + '" requires the "' +
            availability.driver + '" package, which is not installed. ' +
            'Install it with: npm install ' + availability.driver
        );
    }

    var url = pick(config, 'url', 'URL');
    if (url) {
        return {
            dialect: dialect,
            connection: url,
            sequelizeOptions: buildSequelizeOptions(dialect, config)
        };
    }

    var storageFile = pick(config, 'storage', 'STORAGE');
    if (storageFile) {
        // File-backed dialect: only the path matters.
        return {
            dialect: dialect,
            connection: null,
            sequelizeOptions: buildSequelizeOptions(dialect, config)
        };
    }

    var connection = {
        database: pick(config, 'database', 'DATABASE'),
        username: pick(config, 'username', 'USERNAME'),
        password: pick(config, 'password', 'PASSWORD'),
        host: pick(config, 'host', 'HOST') || 'localhost',
        port: pickInt(config, 'port', 'PORT', defaultPort(dialect))
    };

    if (!connection.database) {
        throw new Error(
            '[node-red-storage-sequelize] No database configured. Set ' +
            PREFIX + 'DATABASE (and the related variables), or provide them ' +
            'through the plugin config.'
        );
    }

    return {
        dialect: dialect,
        connection: connection,
        sequelizeOptions: buildSequelizeOptions(dialect, config)
    };
}

/**
 * Creates a Sequelize instance ready to be synchronised.
 * @param {object} config Node-RED config for this feature.
 * @returns {Sequelize} A new Sequelize instance.
 */
function createSequelize(config) {
    var resolved = resolveConfig(config || {});

    logger.debug('Connecting using dialect "' + resolved.dialect + '"');

    var options = Object.assign({}, resolved.sequelizeOptions, {
        dialect: resolved.dialect
    });

    if (typeof resolved.connection === 'string') {
        return new Sequelize(resolved.connection, options);
    }

    if (!resolved.connection) {
        // File-based dialect: the path travels in `options.storage`.
        return new Sequelize(options);
    }

    return new Sequelize(
        resolved.connection.database,
        resolved.connection.username,
        resolved.connection.password,
        Object.assign({}, options, {
            host: resolved.connection.host,
            port: resolved.connection.port
        })
    );
}

/**
 * Resolves the context store behaviour options (caching and flush cadence).
 *
 * @param {object} config The context store config.
 * @returns {{cache: boolean, flushInterval: number, cacheTTL: number}} Options.
 */
function resolveBehaviour(config) {
    var cacheRaw = pick(config, 'cache', 'CACHE');
    var cache = cacheRaw === undefined
        ? true
        : (typeof cacheRaw === 'boolean' ? cacheRaw : String(cacheRaw).toLowerCase() !== 'false');

    var flushInterval = pickInt(config, 'flushInterval', 'FLUSH_INTERVAL', 0);

    // How long a cached scope is served before being refreshed from the
    // database. Defaults to the flush interval so a scope is never staler than
    // the write cadence; with immediate flushing (0) reads always hit the
    // database. Set it explicitly to 0 to disable refreshing while still
    // batching writes.
    var cacheTTL = pickInt(config, 'cacheTTL', 'CACHE_TTL', flushInterval);

    return {
        cache: cache,
        flushInterval: flushInterval,
        cacheTTL: cacheTTL
    };
}

module.exports = {
    createSequelize: createSequelize,
    resolveConfig: resolveConfig,
    resolveBehaviour: resolveBehaviour,
    normaliseDialect: normaliseDialect,
    availableDialects: availableDialects,
    DRIVER_BY_DIALECT: DRIVER_BY_DIALECT,
    PREFIX: PREFIX
};
