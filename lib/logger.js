/**
 * Minimal logger, shared by the storage module and the context store.
 *
 * The storage module receives the Node-RED runtime logger through
 * `init(settings, runtime)`, so we use it when available. The context store is a
 * factory that gets no runtime, so it falls back to the console and honours
 * `NODE_RED_STORAGE_DEBUG`.
 */

var runtimeLog = null;

/**
 * @returns {boolean} True when verbose logging is enabled.
 */
function isDebugEnabled() {
    var value = process.env.NODE_RED_STORAGE_DEBUG;
    if (value === undefined || value === '') {
        return false;
    }
    return String(value).toLowerCase() === 'true' || String(value) === '1';
}

var PREFIX = '[node-red-storage-sequelize]';

module.exports = {
    /**
     * Binds the Node-RED runtime logger, when one is available.
     * @param {object|null} log A `@node-red/util` log instance.
     * @returns {void}
     */
    setLogger: function (log) {
        runtimeLog = log || null;
    },

    /**
     * @returns {boolean} True when debug output is enabled.
     */
    isDebugEnabled: isDebugEnabled,

    info: function () {
        if (runtimeLog && typeof runtimeLog.info === 'function') {
            return runtimeLog.info.apply(runtimeLog, arguments);
        }
        return console.log.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },

    warn: function () {
        if (runtimeLog && typeof runtimeLog.warn === 'function') {
            return runtimeLog.warn.apply(runtimeLog, arguments);
        }
        return console.warn.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },

    error: function () {
        if (runtimeLog && typeof runtimeLog.error === 'function') {
            return runtimeLog.error.apply(runtimeLog, arguments);
        }
        return console.error.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
    },

    debug: function () {
        if (runtimeLog && typeof runtimeLog.debug === 'function') {
            return runtimeLog.debug.apply(runtimeLog, arguments);
        }
        if (isDebugEnabled()) {
            return console.log.apply(console, [PREFIX].concat(Array.prototype.slice.call(arguments)));
        }
        return undefined;
    }
};
