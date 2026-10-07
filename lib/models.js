/**
 * Sequelize model definitions.
 *
 * The schema is intentionally simple: a handful of small tables that mirror the
 * pieces of state Node-RED keeps on disk. Every table is prefixed with
 * `nodered_` so the plugin can safely share a database with other applications.
 *
 * ## Index sizing on MySQL
 *
 * InnoDB rejects any index whose total byte length exceeds 3072. With the usual
 * utf8mb4 collation a VARCHAR(n) costs 4n bytes, so a composite index over two
 * strings can blow the budget easily — `VARCHAR(64) + VARCHAR(768)` is already
 * 3328 bytes.
 *
 * Two rules follow from that, and both have bitten this package:
 *
 *  1. **Keep indexed columns narrow.** All indexed strings here are <= 191
 *     characters, which is the classic "safe" width for utf8mb4.
 *
 *  2. **Never index a column whose width may change.** `sync()` does not resize
 *     existing columns, so a table created by an older version with a wider
 *     column keeps that width, and re-adding the index then fails with
 *     "Specified key was too long". Where a wide natural key is needed
 *     (`LibraryEntry.path`) the unique index therefore uses a fixed-width hash
 *     instead of the column itself. The hash length does not depend on the
 *     column, so the index is safe on any table, old or new.
 *
 * Design notes:
 *  - `Flows`, `Credentials` and `Sessions` are singleton rows (id = 1) because
 *    Node-RED exposes a single global document for each of them.
 *  - `Settings` is a key/value table because the runtime reads and writes
 *    individual keys (`_credentialSecret`, `credentialSecret`, ...).
 *  - `Context` is one row per `(scope, key)`.
 */

var crypto = require('crypto');

var TABLE_PREFIX = 'nodered_';

/**
 * Builds the index key for a library entry.
 *
 * A SHA-256 digest is 64 hex characters = 256 bytes with utf8mb4, comfortably
 * inside the 3072 byte limit and independent of how wide `type` and `path`
 * happen to be in an existing table.
 *
 * @param {string} type Library type.
 * @param {string} path Entry path.
 * @returns {string} A stable 64 character hex digest.
 */
function libraryKeyHash(type, path) {
    return crypto.createHash('sha256')
        .update(String(type) + '\u0000' + String(path))
        .digest('hex');
}

/**
 * Registers every model on the given Sequelize instance.
 * @param {Sequelize} sequelize An initialised Sequelize instance.
 * @returns {object} A map of model name to model class.
 */
function defineModels(sequelize) {
    var Flows = sequelize.define('Flows', {
        id: {
            type: sequelize.Sequelize.INTEGER,
            primaryKey: true,
            defaultValue: 1
        },
        flows: {
            type: sequelize.Sequelize.JSON,
            allowNull: false
        },
        rev: {
            type: sequelize.Sequelize.STRING(64),
            allowNull: true
        },
        deployedBy: {
            type: sequelize.Sequelize.STRING(255),
            allowNull: true
        }
    }, {
        tableName: TABLE_PREFIX + 'flows',
        timestamps: true
    });

    var Credentials = sequelize.define('Credentials', {
        id: {
            type: sequelize.Sequelize.INTEGER,
            primaryKey: true,
            defaultValue: 1
        },
        // Node-RED stores either plain credentials or an encrypted blob shaped
        // like `{ "$": "<iv><ciphertext>" }`. We persist whichever we receive.
        credentials: {
            type: sequelize.Sequelize.JSON,
            allowNull: false
        }
    }, {
        tableName: TABLE_PREFIX + 'credentials',
        timestamps: true
    });

    var Setting = sequelize.define('Setting', {
        key: {
            type: sequelize.Sequelize.STRING(191),
            primaryKey: true
        },
        value: {
            type: sequelize.Sequelize.JSON,
            allowNull: true
        }
    }, {
        tableName: TABLE_PREFIX + 'settings',
        timestamps: true
    });

    var Session = sequelize.define('Session', {
        id: {
            type: sequelize.Sequelize.INTEGER,
            primaryKey: true,
            defaultValue: 1
        },
        sessions: {
            type: sequelize.Sequelize.JSON,
            allowNull: false
        }
    }, {
        tableName: TABLE_PREFIX + 'sessions',
        timestamps: true
    });

    var LibraryEntry = sequelize.define('LibraryEntry', {
        id: {
            type: sequelize.Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        type: {
            type: sequelize.Sequelize.STRING(32),
            allowNull: false
        },
        path: {
            // Not indexed directly: see the note about MySQL above. 512 is
            // enough for realistic library paths while staying well inside the
            // utf8mb4 row limits.
            type: sequelize.Sequelize.STRING(512),
            allowNull: false
        },
        // Fixed-width surrogate key for the unique constraint on (type, path).
        keyHash: {
            type: sequelize.Sequelize.STRING(64),
            allowNull: false
        },
        meta: {
            type: sequelize.Sequelize.JSON,
            allowNull: true
        },
        body: {
            type: sequelize.Sequelize.TEXT('long'),
            allowNull: true
        }
    }, {
        tableName: TABLE_PREFIX + 'library_entries',
        timestamps: true,
        indexes: [
            {
                // 64 characters x 4 bytes = 256 bytes: safe on MySQL, and safe
                // on a table whose `type`/`path` columns are wider than the
                // current model declares.
                name: TABLE_PREFIX + 'library_entries_key_hash',
                unique: true,
                fields: ['keyHash']
            },
            {
                name: TABLE_PREFIX + 'library_entries_type',
                fields: ['type']
            }
        ]
    });

    return {
        Flows: Flows,
        Credentials: Credentials,
        Setting: Setting,
        Session: Session,
        LibraryEntry: LibraryEntry
    };
}

/**
 * Backfills `keyHash` for library rows written before the column existed.
 *
 * On an upgrade the repair adds the column but leaves existing rows without a
 * usable hash, and the unique index does not cover them. Without a backfill those
 * entries become unreachable: every lookup goes through the hash, so a row whose
 * hash is missing can never be found.
 *
 * Note on the "missing" value: when `alter` adds a `NOT NULL` column, MySQL fills
 * existing rows with the empty string rather than NULL. Rows with an empty hash
 * must therefore be treated as missing too, which is why the predicate checks for
 * both.
 *
 * Idempotent: rows that already carry a 64 character hash are skipped.
 *
 * @param {object} models The registered models.
 * @returns {Promise<number>} How many rows were backfilled.
 */
async function backfillLibraryKeyHashes(models) {
    var Model = models.LibraryEntry;

    // Every row is examined in JavaScript rather than filtered in SQL, because
    // the "missing" value differs by dialect and by how the column was added
    // (MySQL fills new NOT NULL columns with '', PostgreSQL uses NULL). Reading
    // the three narrow columns is cheap; library tables are tiny.
    var rows = await Model.findAll({
        attributes: ['id', 'type', 'path', 'keyHash']
    });

    var pending = rows.filter(function (row) {
        // A valid hash is exactly 64 hex characters.
        return !row.keyHash || String(row.keyHash).length !== 64;
    });

    for (var i = 0; i < pending.length; i++) {
        var row = pending[i];
        // `type`/`path` may be null on very old schemas.
        var type = row.type === null || row.type === undefined ? '' : row.type;
        var entryPath = row.path === null || row.path === undefined ? '' : row.path;

        await Model.update(
            { keyHash: libraryKeyHash(type, entryPath) },
            { where: { id: row.id } }
        );
    }

    return pending.length;
}

module.exports = {
    defineModels: defineModels,
    libraryKeyHash: libraryKeyHash,
    backfillLibraryKeyHashes: backfillLibraryKeyHashes,
    TABLE_PREFIX: TABLE_PREFIX
};
