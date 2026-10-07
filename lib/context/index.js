/**
 * Node-RED context storage backed by Sequelize.
 *
 * Named *context store*, it holds `global`, `flow` and `node` context
 * (`global.set()`, `flow.set()`, `node.set()`) — the counterpart of the storage
 * module, which holds the flows themselves.
 *
 * ## How Node-RED drives a context store
 *
 * The runtime calls `require(module)(config)` and expects back an object with:
 *
 *   open() / close()
 *   get(scope, key, callback)          key is a string OR an array of strings
 *   set(scope, key, value, callback)   key is a string OR an array of strings
 *   keys(scope, callback)              must yield an ARRAY
 *   delete(scope)
 *   clean(activeNodes)
 *
 * Two details matter and are easy to get wrong:
 *
 *  1. **A callback is always supplied.** `@node-red/runtime/lib/nodes/context`
 *     calls `context.get(scope, key, callback)`; returning a bare value instead
 *     of invoking the callback leaves the flow waiting forever. Values are
 *     therefore only ever delivered through the callback.
 *
 *  2. **The scope string is opaque.** Node-RED composes it (a flow id, or
 *     `"<nodeId>:<flowId>"`, or the literal `"global"`). It is stored verbatim
 *     rather than parsed, so `set` and `keys` can never disagree.
 *
 * ## Why there is no write-behind cache
 *
 * Writing through an in-memory cache made reads return stale data: a value could
 * be read from memory while the database held something else, and changes made
 * outside Node-RED were never picked up. This implementation always reads from
 * and writes to the database, so the database is the single source of truth and
 * a value is immediately visible to every node, every instance and any external
 * tool.
 *
 * For workloads that cannot afford a query per access, `cache` is deliberately
 * not offered: use Node-RED's built-in `memory` store for those values and keep
 * the database store for what must be durable.
 */

var connection = require('../connection');
var modelsFactory = require('./models');
var logger = require('../logger');

/**
 * Creates a context store instance.
 *
 * @param {object} [config] Configuration from the `contextStorage` block.
 * @returns {object} The context store instance.
 */
function ContextSequelize(config) {
    this.config = config || {};

    this.sequelize = null;
    this.models = null;

    // Node-RED looks for these two to decide whether the store is ready.
    this.opened = false;
    this.closed = false;

    // Serialises writes so two concurrent `set`s cannot interleave their
    // upserts, and so `keys` never observes a half-applied batch.
    this.writePromise = Promise.resolve();

    this._log = logger;
}

/**
 * Ensures `open()` ran before the store is used.
 * @returns {object} The registered models.
 * @throws {Error} When the store is not open yet.
 */
ContextSequelize.prototype._requireModels = function () {
    if (!this.models) {
        throw new Error('[node-red-storage-sequelize] Context store used before open() was called');
    }
    return this.models;
};

/**
 * Opens the store: connects and creates the table.
 * @returns {Promise<void>}
 */
ContextSequelize.prototype.open = function () {
    var self = this;

    // `open()` may be called with a callback by some Node-RED versions; the
    // return value is a Promise either way, which the runtime also accepts.
    return Promise.resolve().then(function () {
        self.sequelize = connection.createSequelize(self.config);
        self.models = modelsFactory.defineModels(self.sequelize);

        return self.sequelize.authenticate();
    }).then(function () {
        return self.sequelize.sync({ alter: self.config.alterSync === true });
    }).then(function () {
        self.opened = true;
        self._log.info('Context store ready (' + self.sequelize.getDialect() + ')');
    });
};

/**
 * Closes the store and releases the connection.
 * @returns {Promise<void>}
 */
ContextSequelize.prototype.close = function () {
    var self = this;

    if (this.closed || !this.sequelize) {
        this.closed = true;
        return Promise.resolve();
    }

    // Let any in-flight write finish before dropping the connection.
    return this.writePromise.then(function () {
        self.closed = true;
        return self.sequelize.close();
    }, function () {
        self.closed = true;
        return self.sequelize.close();
    });
};

/**
 * Reads one or more values, delivering the result through the callback.
 *
 * Node-RED always passes a callback. When one is absent (direct programmatic
 * use) a Promise is returned instead, which keeps the store usable in tests and
 * scripts.
 *
 * @param {string} scope The scope string as provided by the runtime.
 * @param {string|string[]} key A key or an array of keys.
 * @param {Function} [callback] Node-style callback: `(err, value)` for a single
 *   key, `(err, v1, ..., vN)` for an array of keys.
 * @returns {Promise<*|Array>|undefined} A Promise when no callback is given.
 */
ContextSequelize.prototype.get = function (scope, key, callback) {
    var Models = this._requireModels();
    var isMulti = Array.isArray(key);
    var keys = isMulti ? key : [key];

    var work = Models.ContextEntry.findAll({
        where: { scope: scope, key: keys }
    }).then(function (rows) {
        var byKey = Object.create(null);
        rows.forEach(function (row) { byKey[row.key] = row.value; });
        return keys.map(function (k) { return byKey[k]; });
    });

    if (typeof callback !== 'function') {
        return work.then(function (values) { return isMulti ? values : values[0]; });
    }

    work.then(function (values) {
        if (isMulti) {
            // Node-RED expects (err, v1, ... vN) for multi-key reads.
            callback.apply(null, [null].concat(values));
        } else {
            callback(null, values[0]);
        }
    }, function (err) {
        callback(err);
    });

    return undefined;
};

/**
 * Writes one or more values.
 *
 * `undefined` deletes the key, matching the behaviour of the built-in stores;
 * `null` is a legitimate value and is stored as such.
 *
 * @param {string} scope The scope string.
 * @param {string|string[]} key A key or an array of keys.
 * @param {*|*[]} value The value, or an array of values matching `key`.
 * @param {Function} [callback] Optional node-style callback.
 * @returns {Promise<void>|undefined} A Promise when no callback is given.
 */
ContextSequelize.prototype.set = function (scope, key, value, callback) {
    var self = this;
    var Models = this._requireModels();
    var isMulti = Array.isArray(key);
    var keys = isMulti ? key : [key];
    var values = isMulti
        ? (Array.isArray(value) ? value : keys.map(function () { return value; }))
        : [value];

    // Serialise writes: two concurrent transactions touching the same rows would
    // otherwise deadlock or produce a last-writer-wins surprise.
    var work = this.writePromise.then(function () {
        return self.sequelize.transaction(function (transaction) {
            var chain = Promise.resolve();

            keys.forEach(function (k, index) {
                var v = values[index];
                chain = chain.then(function () {
                    if (v === undefined) {
                        return Models.ContextEntry.destroy({
                            where: { scope: scope, key: k },
                            transaction: transaction
                        });
                    }
                    return Models.ContextEntry.upsert({
                        scope: scope,
                        key: k,
                        value: v
                    }, {
                        transaction: transaction,
                        conflictFields: ['scope', 'key']
                    });
                });
            });

            return chain;
        });
    });

    // Keep the chain alive even after a failure so later writes still run.
    this.writePromise = work.catch(function () { return undefined; });

    if (typeof callback !== 'function') {
        return isMulti ? work.then(function () { return keys.map(function () { return null; }); })
            : work.then(function () { return null; });
    }

    work.then(function () {
        if (isMulti) {
            callback.apply(null, [null].concat(keys.map(function () { return null; })));
        } else {
            callback(null);
        }
    }, function (err) {
        callback(err);
    });

    return undefined;
};

/**
 * Lists the keys of a scope.
 *
 * The callback always receives an array: Node-RED calls `.map()` on the result
 * in `node-red/lib/api/context.js`, and `undefined` there crashes the process.
 *
 * @param {string} scope The scope string.
 * @param {Function} [callback] Optional node-style callback.
 * @returns {Promise<string[]>|undefined} A Promise when no callback is given.
 */
ContextSequelize.prototype.keys = function (scope, callback) {
    var Models = this._requireModels();

    var work = Models.ContextEntry.findAll({
        where: { scope: scope },
        attributes: ['key']
    }).then(function (rows) {
        return rows.map(function (row) { return row.key; });
    });

    if (typeof callback !== 'function') {
        return work;
    }

    work.then(function (keys) {
        callback(null, keys);
    }, function (err) {
        callback(err);
    });

    return undefined;
};

/**
 * Deletes every key of a scope.
 * @param {string} scope The scope string.
 * @returns {Promise<void>}
 */
ContextSequelize.prototype.delete = function (scope) {
    var self = this;
    var Models = this._requireModels();

    var work = this.writePromise.then(function () {
        return Models.ContextEntry.destroy({ where: { scope: scope } });
    });

    this.writePromise = work.catch(function () { return undefined; });
    return work;
};

/**
 * Removes scopes whose flow or node no longer exists.
 *
 * Node-RED passes the list of live node ids, but the *scope* string it uses for
 * `set`/`get` is a composed value (`"<nodeId>:<flowId>"`, a flow id, or
 * `"global"`). Rather than guessing how to tokenise it — a source of subtle bugs
 * across versions — this implementation keeps every scope that mentions any live
 * id as a substring, and only drops scopes that reference nothing live.
 *
 * `"global"` is never removed.
 *
 * @param {string[]|object} activeNodes Live node ids, in any supported shape.
 * @returns {Promise<void>}
 */
ContextSequelize.prototype.clean = function (activeNodes) {
    var Models = this._requireModels();
    var live = extractLiveIds(activeNodes);

    if (live === null) {
        // Unrecognised shape: deleting nothing is the safe choice. An empty list
        // must not be interpreted as "nothing is live", which would wipe all
        // flow and node context.
        return Promise.resolve();
    }

    return Models.ContextEntry.findAll({ attributes: ['scope'], group: ['scope'] })
        .then(function (rows) {
            var doomed = rows
                .map(function (row) { return row.scope; })
                .filter(function (scope) {
                    if (scope === 'global') {
                        return false;
                    }
                    if (live.length === 0) {
                        // A real, explicit empty list: only global survives.
                        return true;
                    }
                    return !live.some(function (id) { return scope.indexOf(id) !== -1; });
                });

            if (doomed.length === 0) {
                return undefined;
            }
            return Models.ContextEntry.destroy({ where: { scope: doomed } });
        });
};

/**
 * Extracts the live ids from the argument Node-RED passes to `clean()`.
 *
 * Supported shapes:
 *   - `["nodeId1", "nodeId2"]`
 *   - `{ allNodes: { "nodeId1": {...} } }`
 *   - `{ flows: [{id}], nodes: [{id}] }`
 *
 * @param {*} activeNodes The raw argument.
 * @returns {string[]|null} Live ids, or null when the shape is not recognised.
 */
function extractLiveIds(activeNodes) {
    var ids = [];

    if (Array.isArray(activeNodes)) {
        activeNodes.forEach(function (entry) {
            if (typeof entry === 'string' && entry.length > 0) {
                // Entries may be bare ids or "id:flow" / "flow:id" pairs, in
                // which case both halves are useful.
                entry.split(':').forEach(function (part) {
                    if (part.length > 0) { ids.push(part); }
                });
            }
        });
        return ids;
    }

    if (activeNodes && typeof activeNodes === 'object') {
        if (activeNodes.allNodes && typeof activeNodes.allNodes === 'object') {
            Object.keys(activeNodes.allNodes).forEach(function (id) {
                id.split(':').forEach(function (part) {
                    if (part.length > 0) { ids.push(part); }
                });
            });
            return ids;
        }
        if (Array.isArray(activeNodes.flows) || Array.isArray(activeNodes.nodes)) {
            (activeNodes.flows || []).concat(activeNodes.nodes || []).forEach(function (node) {
                if (node && typeof node.id === 'string') { ids.push(node.id); }
            });
            return ids;
        }
    }

    return null;
}

/**
 * Factory expected by Node-RED's context storage loader.
 *
 * Also re-registers the logger, because a factory receives no runtime.
 *
 * @param {object} [config] Configuration from the `contextStorage` block.
 * @returns {ContextSequelize} A new store instance.
 */
module.exports = function (config) {
    return new ContextSequelize(config);
};

// Exported for unit testing.
module.exports.ContextSequelize = ContextSequelize;
module.exports.extractLiveIds = extractLiveIds;
