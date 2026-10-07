/**
 * Shared mutable state for the storage module.
 *
 * Kept in its own module so the public entry point (`index.js`) and the
 * test-only hooks (`test-hooks.js`) operate on the exact same references.
 */

var sequelize = null;
var models = null;
var pluginOptions = {};

module.exports = {
    /**
     * @returns {Sequelize|null} The active Sequelize instance.
     */
    getSequelize: function () {
        return sequelize;
    },

    /**
     * @returns {object|null} The registered models.
     */
    getModels: function () {
        return models;
    },

    /**
     * @returns {object} The plugin options taken from `settings.storagePlugin`.
     */
    getOptions: function () {
        return pluginOptions;
    },

    /**
     * Replaces the connection, models and options.
     * @param {Sequelize|null} newSequelize The Sequelize instance.
     * @param {object|null} newModels The registered models.
     * @param {object} [newOptions] The plugin options.
     * @returns {void}
     */
    set: function (newSequelize, newModels, newOptions) {
        sequelize = newSequelize;
        models = newModels;
        if (newOptions) {
            pluginOptions = newOptions;
        }
    }
};
