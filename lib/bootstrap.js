/**
 * Storage backend bootstrap.
 *
 * A Node-RED storage backend is a plain object, and the runtime decides whether
 * it may persist settings by testing `hasOwnProperty('getSettings')` **once**,
 * during `storage.init()`. That single check is why the object handed to
 * `settings.storageModule` must expose `getSettings` from the very beginning,
 * even when the filesystem backend is the one that ends up being used.
 *
 * This module solves that by always exporting the full method set and forwarding
 * each call to whichever backend was registered at startup.
 */

var registry = {
    active: null
};

/**
 * Registers the backend that should serve the requests.
 * @param {object} backend A Node-RED storage module implementation.
 * @returns {void}
 */
function register(backend) {
    if (!backend || typeof backend.init !== 'function') {
        throw new Error('[node-red-storage-sequelize] register() needs a storage module with init()');
    }
    registry.active = backend;
}

/**
 * @returns {object} The registered backend.
 * @throws {Error} When nothing was registered yet.
 */
function backend() {
    if (!registry.active) {
        throw new Error('[node-red-storage-sequelize] No storage backend registered. ' +
            'Call buildStorageModule() before RED.init(), or register() manually.');
    }
    return registry.active;
}

/**
 * Reports whether the active backend implements a method.
 * @param {string} name Method name.
 * @returns {boolean} True when supported.
 */
function supports(name) {
    return !!registry.active && typeof registry.active[name] === 'function';
}

/**
 * Builds a method that forwards to the active backend.
 * @param {string} name Method name.
 * @returns {Function} The forwarding method.
 */
function delegate(name) {
    return function () {
        var active = backend();
        if (typeof active[name] !== 'function') {
            throw new Error('[node-red-storage-sequelize] Backend does not implement ' + name + '()');
        }
        return active[name].apply(active, arguments);
    };
}

/**
 * Resolves Node-RED's built-in filesystem storage module.
 *
 * `node-red` itself only ships `lib/red.js`; the implementation lives in
 * `@node-red/runtime`. Required lazily so the failure mode is obvious if the
 * internal layout ever changes.
 *
 * @returns {object} The localfilesystem storage module.
 */
function filesystemBackend() {
    return require('@node-red/runtime/lib/storage/localfilesystem');
}

var bootstrap = {
    // Required by @node-red/runtime/lib/storage.
    init: delegate('init'),
    getFlows: delegate('getFlows'),
    saveFlows: delegate('saveFlows'),
    getCredentials: delegate('getCredentials'),
    saveCredentials: delegate('saveCredentials'),

    // Optional, but always declared so the runtime enables the features tied to
    // them (`settingsAvailable` / `sessionsAvailable` are computed only once).
    getSettings: function () {
        return supports('getSettings') ? backend().getSettings() : Promise.resolve({});
    },
    saveSettings: function (settings) {
        return supports('saveSettings') ? backend().saveSettings(settings) : Promise.resolve();
    },
    getSessions: function () {
        return supports('getSessions') ? backend().getSessions() : Promise.resolve({});
    },
    saveSessions: function (sessions) {
        return supports('saveSessions') ? backend().saveSessions(sessions) : Promise.resolve();
    },

    // Library access.
    getLibraryEntry: delegate('getLibraryEntry'),
    saveLibraryEntry: delegate('saveLibraryEntry'),

    // Deprecated but still consulted by the runtime.
    getAllFlows: function () {
        return supports('getAllFlows') ? backend().getAllFlows() : Promise.resolve([]);
    },

    // Public helpers.
    register: register,
    filesystemBackend: filesystemBackend,
    activeBackend: function () { return registry.active; }
};

module.exports = bootstrap;
