/**
 * Test-only hooks.
 *
 * Lets the test suite replace the live database connection with an in-memory
 * one. This file exists purely for testing and is not part of the public API;
 * it is excluded from the published package.
 *
 * @internal
 */

var state = require('./state');

module.exports = {
    /**
     * Injects a prepared Sequelize instance and its models.
     * @param {Sequelize} sequelize The test connection.
     * @param {object} models The registered models.
     */
    inject: function (sequelize, models) {
        state.set(sequelize, models);
    }
};
