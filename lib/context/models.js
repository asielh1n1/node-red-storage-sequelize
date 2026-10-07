/**
 * Sequelize model for the context store.
 *
 * Context values are addressed by `(scope, key)`. Node-RED composes the scope
 * itself and its format is **not** a plain id (verified in
 * `@node-red/runtime/lib/nodes/context/index.js`):
 *
 *   getContext(nodeId, flowId) -> contextId = nodeId + ":" + flowId
 *   global scope               -> the literal string "global"
 *   flow scope                 -> the flow (tab) id, e.g. "a1b2c3d4"
 *   node scope                 -> "<nodeId>:<flowId>"
 *
 * Because the format is an internal detail that has changed across Node-RED
 * versions, the scope string is stored **verbatim** — no parsing, no
 * normalisation. Guessing produces mismatches between `set` and `keys`, which is
 * a documented source of "the value is written but never read back" bugs.
 */

var TABLE_PREFIX = 'nodered_';

/**
 * Registers the Context model on a Sequelize instance.
 * @param {Sequelize} sequelize An initialised Sequelize instance.
 * @returns {object} A map of model name to model class.
 */
function defineModels(sequelize) {
    var ContextEntry = sequelize.define('ContextEntry', {
        id: {
            type: sequelize.Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        scope: {
            // Stored verbatim. 191 characters keep the composite index safely
            // inside MySQL's 3072 byte limit with utf8mb4.
            type: sequelize.Sequelize.STRING(191),
            allowNull: false
        },
        key: {
            type: sequelize.Sequelize.STRING(191),
            allowNull: false
        },
        value: {
            type: sequelize.Sequelize.JSON,
            allowNull: true
        }
    }, {
        tableName: TABLE_PREFIX + 'context',
        timestamps: true,
        indexes: [
            {
                name: TABLE_PREFIX + 'context_scope_key',
                unique: true,
                fields: ['scope', 'key']
            },
            {
                name: TABLE_PREFIX + 'context_scope',
                fields: ['scope']
            }
        ]
    });

    return {
        ContextEntry: ContextEntry
    };
}

module.exports = {
    defineModels: defineModels,
    TABLE_PREFIX: TABLE_PREFIX
};
