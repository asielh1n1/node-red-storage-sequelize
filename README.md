# node-red-storage-sequelize

Persist **everything** Node-RED would otherwise write to disk — plus its runtime
variables — in any database Sequelize supports, using a single npm package and a
single configuration variable.

It provides two things that work together:

| Concern | What it stores | Node-RED setting |
| --- | --- | --- |
| **Storage module** | Flows, credentials, settings, sessions, library | `storageModule` |
| **Context store** | `global` / `flow` / `node` variables (`global.set()`, `flow.set()`, `node.set()`) | `contextStorage` |

One environment variable, `NODE_RED_STORAGE_DIALECT`, drives both. Without it,
flows stay on the filesystem and context stays in memory, exactly like a stock
Node-RED installation.

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [As a standalone Node-RED plugin](#as-a-standalone-node-red-plugin)
  - [Inside an embedded Node-RED application](#inside-an-embedded-node-red-application)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [settings.js](#settingsjs)
  - [Configuration reference](#configuration-reference)
- [The context store explained](#the-context-store-explained)
  - [Why two stores are registered](#why-two-stores-are-registered)
  - [Why default is an alias](#why-default-is-an-alias)
  - [Choosing a store per value](#choosing-a-store-per-value)
- [Consistency: no stale reads](#consistency-no-stale-reads)
- [Database schema](#database-schema)
- [How credentials are handled](#how-credentials-are-handled)
- [Public API](#public-api)
- [Running tests](#running-tests)
- [Publishing](#publishing)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [License](#license)

---

## Why

Node-RED ships with a local-filesystem storage backend and an in-memory context
store. That is fine for a single instance on a single machine, but it breaks down
when you want to:

- run Node-RED in Docker/Kubernetes with ephemeral containers;
- replace a container without losing every `global.set()`;
- run more than one instance that needs to agree on state;
- back everything up with the database tools you already use.

This package replaces both defaults with a thin Sequelize layer, so a single set
of credentials keeps the whole runtime durable.

## Features

- **Any Sequelize dialect**: PostgreSQL, MySQL, MariaDB, SQL Server, SQLite.
- **Full state persistence**: flows, credentials, settings, sessions, library.
- **Context persistence**: `global`, `flow` and `node` scopes.
- **One variable drives both**, with fallbacks to the built-in backends.
- **No stale reads**: the database is the single source of truth; a value is
  visible to every node, every instance and external tools the moment it is set.
- **Prefixed tables** (`nodered_*`), safe to share a database.
- **No crypto of its own**: credentials are stored exactly as Node-RED produces
  them, preserving the built-in `aes-256-ctr` encryption.
- **Fails fast** with actionable errors when a driver is missing.

## Requirements

| Component | Version |
| --- | --- |
| Node.js | `>= 18` |
| Node-RED | `>= 2.0` (verified against 5.x) |
| Sequelize | `^6.37` |

### Conformance with the official APIs

The package implements both documented interfaces exactly:

- [Storage Module API](https://nodered.org/docs/api/storage/) — `init`,
  `getFlows`, `saveFlows`, `getCredentials`, `saveCredentials`, `getSettings`,
  `saveSettings`, `getSessions`, `saveSessions`, `getLibraryEntry`,
  `saveLibraryEntry`
- [Context Storage API](https://nodered.org/docs/api/context/) and
  [ContextStore methods](https://nodered.org/docs/api/context/methods/) —
  `open`, `close`, `get`, `set`, `keys`, `delete`, `clean`

## Installation

```bash
npm install node-red-storage-sequelize
```

Then install the driver for the database you use:

```bash
npm install pg        # PostgreSQL
npm install mysql2    # MySQL
npm install mariadb   # MariaDB
npm install tedious   # SQL Server
npm install sqlite3   # SQLite
```

Drivers are declared as *optional* dependencies so npm installs them when
possible; installing yours explicitly guarantees it is present.

### As a standalone Node-RED plugin

If you run Node-RED normally (the `node-red` command or your own entry point),
configure it through `settings.js`:

```js
// settings.js
module.exports = {
    storageModule: require("node-red-storage-sequelize"),

    contextStorage: {
        memory: { module: "memory" },
        postgres: {
            module: require("node-red-storage-sequelize").ContextStore,
            config: {}
        },
        default: "postgres"
    }
};
```

Connection details come from the environment (`NODE_RED_STORAGE_*`), so nothing
sensitive has to live in `settings.js`.

### Inside an embedded Node-RED application

When you embed Node-RED in your own Express app, two helper functions do the
wiring for you:

```js
require("dotenv").config();

const RED = require("node-red");
const backend = require("node-red-storage-sequelize");

const settings = {
    // Flows, credentials, settings, sessions, library.
    storageModule: backend.buildStorageModule(),

    // Global/flow/node variables.
    contextStorage: backend.buildContextStorage()
};

RED.init(server, settings);
```

`buildStorageModule()` and `buildContextStorage()` read `NODE_RED_STORAGE_DIALECT`
and return the right configuration for it — including falling back to the
filesystem and memory when no dialect is set.

## Quick start

```bash
# 1. Install
npm install node-red-storage-sequelize pg

# 2. Configure
cat >> .env <<'EOF'
NODE_RED_STORAGE_DIALECT=postgres
NODE_RED_STORAGE_HOST=localhost
NODE_RED_STORAGE_PORT=5432
NODE_RED_STORAGE_DATABASE=nodered
NODE_RED_STORAGE_USERNAME=nodered
NODE_RED_STORAGE_PASSWORD=secret
EOF

# 3. Run
node index.js
```

You should see:

```
[node-red-storage-sequelize] Flows/credentials: postgres via sequelize
[node-red-storage-sequelize] Context (global/flow/node): postgres via sequelize (stores: memory, postgres; default -> postgres)
[node-red-storage-sequelize] Storage initialised (postgres)
[node-red-storage-sequelize] Context store ready (postgres)
```

Deploy a flow, set a value with a Change node, and check the database:

```sql
SELECT scope, key, value FROM nodered_context;
```

## Configuration

Every option can be provided as an environment variable or through the `config`
block Node-RED passes to the plugin. `config` wins over the environment.

### Environment variables

All of them share the `NODE_RED_STORAGE_` prefix:

```dotenv
# Which database to use. Omit it entirely to keep the built-in backends.
NODE_RED_STORAGE_DIALECT=postgres

# Connection, either field by field...
NODE_RED_STORAGE_HOST=localhost
NODE_RED_STORAGE_PORT=5432
NODE_RED_STORAGE_DATABASE=nodered
NODE_RED_STORAGE_USERNAME=nodered
NODE_RED_STORAGE_PASSWORD=secret

# ...or as a single URL.
# NODE_RED_STORAGE_URL=postgres://nodered:secret@localhost:5432/nodered

# Optional tuning
NODE_RED_STORAGE_SCHEMA=
NODE_RED_STORAGE_SSL=false
NODE_RED_STORAGE_POOL_MAX=5
NODE_RED_STORAGE_LOGGING=false
```

For SQLite, point at a file instead of a host:

```dotenv
NODE_RED_STORAGE_DIALECT=sqlite
NODE_RED_STORAGE_STORAGE=/var/lib/nodered/flows.sqlite
```

### settings.js

```js
const backend = require("node-red-storage-sequelize");

module.exports = {
    storageModule: backend.buildStorageModule(),
    contextStorage: backend.buildContextStorage(),

    uiPort: process.env.PORT || 1880
};
```

Or configure each side by hand:

```js
module.exports = {
    storageModule: require("node-red-storage-sequelize"),

    // Options read by the storage module. Any value not set here is taken from
    // the NODE_RED_STORAGE_* environment variables.
    storagePlugin: {
        dialect: "mysql",
        host: "db.internal",
        port: 3306,
        database: "nodered",
        username: "nodered",
        password: process.env.DB_PASSWORD,
        poolMax: 10
    },

    contextStorage: {
        memory: { module: "memory" },
        mysql: {
            module: require("node-red-storage-sequelize").ContextStore,
            config: { poolMax: 10 }
        },
        default: "mysql"
    }
};
```

### Configuration reference

| Option (`config` / `storagePlugin`) | Env var | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `dialect` | `NODE_RED_STORAGE_DIALECT` | see below | `postgres` | Database engine. `postgresql`/`pg` normalise to `postgres`. |
| `url` | `NODE_RED_STORAGE_URL` | string | – | Full connection URL. Takes precedence over individual fields. |
| `host` | `NODE_RED_STORAGE_HOST` | string | `localhost` | Database host. |
| `port` | `NODE_RED_STORAGE_PORT` | number | `5432` / `3306` / `1433` | Database port, depending on dialect. |
| `database` | `NODE_RED_STORAGE_DATABASE` | string | – | **Required** unless `url` or `storage` is used. |
| `username` | `NODE_RED_STORAGE_USERNAME` | string | – | Database user. |
| `password` | `NODE_RED_STORAGE_PASSWORD` | string | – | Database password. |
| `storage` | `NODE_RED_STORAGE_STORAGE` | string | – | File path, for file-based dialects (SQLite). |
| `schema` | `NODE_RED_STORAGE_SCHEMA` | string | – | PostgreSQL schema / search path. |
| `ssl` | `NODE_RED_STORAGE_SSL` | boolean | `false` | Enable TLS. |
| `sslRejectUnauthorized` | `NODE_RED_STORAGE_SSL_REJECT_UNAUTHORIZED` | boolean | `true` | Verify the server certificate. |
| `poolMax` | `NODE_RED_STORAGE_POOL_MAX` | number | `5` | Maximum pool connections. |
| `logging` | `NODE_RED_STORAGE_LOGGING` | boolean | `false` | Log every SQL statement. |
| `forceSync` | – | boolean | `false` | **Destructive.** Drops and recreates tables on startup. |
| `flushInterval` | `NODE_RED_STORAGE_FLUSH_INTERVAL` | seconds | `0` | Context write batching. `0` writes immediately. |
| `cacheTTL` | `NODE_RED_STORAGE_CACHE_TTL` | seconds | `0` | How long a context read may be served from memory. `0` always reads the database. |
| `NODE_RED_STORAGE_DEBUG` | | boolean | – | Verbose plugin logging. |

Supported dialects and their drivers:

| Dialect | Driver | Notes |
| --- | --- | --- |
| `postgres` | `pg` | `pg-hstore` recommended |
| `mysql` | `mysql2` | |
| `mariadb` | `mariadb` | |
| `mssql` | `tedious` | |
| `sqlite` | `sqlite3` | Uses `storage` (file path) instead of host/port |

`availableDialects()` reports which of them are usable right now, based on the
drivers actually installed.

## The context store explained

### Why two stores are registered

The editor only renders the store picker when **more than one** store is
configured. From `editor-client/public/red/red.js`:

```js
if (contextStoreOptions.length < 2) {
    allOptions.flow.options = [];   // the selector is hidden
}
```

With a single store the dropdown disappears and every node silently uses the
default, so users cannot tell where their data goes. `buildContextStorage()`
therefore always registers `memory` alongside the database store.

### Why default is an alias

This is the single most important detail in the configuration:

```js
// ❌ WRONG - two independent stores over the same database
contextStorage: {
    memory: { module: "memory" },
    postgres: { module: backend.ContextStore, config: {} },
    default:  { module: backend.ContextStore, config: {} }   // a SECOND instance
}
```

That version makes Node-RED instantiate **two separate stores**, each with its own
state, so a value written through one is invisible to the other. The fix is to
make `default` a **string alias** of the named store:

```js
// ✅ CORRECT - one instance, two names
contextStorage: {
    memory: { module: "memory" },
    postgres: { module: backend.ContextStore, config: {} },
    default: "postgres"
}
```

The runtime supports this form explicitly
(`@node-red/runtime/lib/nodes/context/index.js`):

```js
if (pluginName === "default" && typeof plugins[pluginName] === "string") {
    defaultIsAlias = true;
    ...
    stores["_"] = stores[plugins["default"]];
}
```

`buildContextStorage()` does this for you.

### Choosing a store per value

In a **Change** node, pick the scope (`Global` / `Flow` / `Node`) and the store:
`postgres` (or `default`) to persist, `memory` for values you can afford to lose.

In a **Function** node:

```js
flow.set("scratch", tmp, "memory");     // volatile, fast
flow.set("report", data, "postgres");   // persisted
flow.set("report", data, "default");    // same store as "postgres"
```

In **JSONata**: `$flowContext("report", "postgres")`.

Nodes that do not name a store resolve to `default`, so existing flows keep
working unchanged.

## Consistency: no stale reads

The context store reads from and writes to the database directly. There is no
write-behind cache, so:

- a value is visible to the node that set it, to every other node, and to any
  external tool **immediately**;
- editing a row by hand is picked up on the very next read;
- two stores pointed at the same database always agree;
- nothing is lost if the process is killed abruptly.

The trade-off is one query per access. For values read on every message, use the
`memory` store and keep the database store for what must survive a restart.

If you need batching for a write-heavy flow, raise
`NODE_RED_STORAGE_FLUSH_INTERVAL` — at the cost of losing up to that many seconds
of context on a hard crash.

## Database schema

Tables are created automatically on first start. All are prefixed with `nodered_`
to avoid collisions.

| Table | Purpose | Cardinality |
| --- | --- | --- |
| `nodered_flows` | Deployed flows, plus `rev` and `deployedBy` | one row |
| `nodered_credentials` | Credentials document, verbatim | one row |
| `nodered_settings` | Key/value store (`_credentialSecret`, editor prefs…) | one row per key |
| `nodered_sessions` | Editor login sessions | one row |
| `nodered_library_entries` | Library files and folders | one row per entry |
| `nodered_context` | Every context value | one row per `(scope, key)` |

### Index sizing on MySQL

InnoDB rejects any index whose total byte length exceeds **3072**. With utf8mb4 a
`VARCHAR(n)` costs `4n` bytes, so a composite index over two strings blows the
budget quickly — `VARCHAR(64) + VARCHAR(768)` is already 3328.

Two rules keep this package safe:

1. **Indexed strings stay narrow** (≤ 191 characters). A test asserts this.
2. **No index over a column whose width may change.** `LibraryEntry` needs a
   unique key on `(type, path)`, but `path` is wide and could be re-sized, so the
   index is on `keyHash` — a fixed-width SHA-256 digest (64 chars = 256 bytes)
   whose size never depends on another column.

### Upgrading from an older version

`sequelize.sync()` only *adds* what it considers missing; it never resizes
existing columns. A database created by an older version can therefore fail at
startup with:

```
Specified key was too long; max key length is 3072 bytes
```

That is not a configuration problem. The package repairs it automatically on the
next start:

```
[node-red-storage-sequelize] Existing schema does not match the models
  (Key column 'keyHash' doesn't exist in table). Reconciling - existing data is preserved.
[node-red-storage-sequelize] Backfilled 1 row(s) required by the new index.
[node-red-storage-sequelize] Schema reconciled successfully.
```

The repair runs in three phases — reconcile columns, backfill the data a new
index depends on, then create the indexes — and **never drops data**. Nothing is
required from the operator.

<details>
<summary>If you prefer to repair by hand</summary>

```sql
-- MySQL: resize the column first, then let the plugin create the new index
ALTER TABLE nodered_library_entries MODIFY path VARCHAR(512) NOT NULL;
```

Or simply drop the affected table if it holds nothing you need:

```sql
DROP TABLE nodered_library_entries;
```

</details>

### Understanding the scope column

All three context scopes share `nodered_context`; the `scope` column tells them
apart. Node-RED composes that string itself and it is stored **verbatim**:

| Where you set it | `scope` column | Example row |
| --- | --- | --- |
| Change → `Global`, `global.set()` | `global` | `global \| appName \| "miApp"` |
| Change → `Flow`, `flow.set()` | the flow (tab) id | `a1b2c3d4 \| counter \| 42` |
| Change → `Node`, `node.set()` | `<nodeId>:<flowId>` | `n1:a1b2c3d4 \| lastSeen \| "ayer"` |

```sql
-- Everything, by scope
SELECT scope, key, value FROM nodered_context ORDER BY scope, key;

-- Only the global variables
SELECT key, value FROM nodered_context WHERE scope = 'global';
```

> If a value seems to be missing, query the `scope` column first: `global` is
> always literally `'global'`, so an absent row means the write never reached the
> store — check whether the node was pointed at the `memory` store instead.

## How credentials are handled

Node-RED encrypts credentials **before** they reach any storage backend, using
`aes-256-ctr` with a key derived from `sha256(credentialSecret)`. The encrypted
document looks like:

```json
{ "$": "<32 hex chars IV><base64 ciphertext>" }
```

This package stores that object exactly as received and never encrypts or
decrypts anything itself. Two consequences:

- Deleting the row makes the credentials unrecoverable, exactly like deleting the
  file would.
- The `_credentialSecret` must survive in `nodered_settings`. That is why
  `getSettings`/`saveSettings` are implemented — if the settings store were
  unavailable, the runtime would generate a fresh secret on every restart and old
  credentials would become undecryptable.

Pin your own secret to avoid depending on the generated one:

```js
module.exports = {
    credentialSecret: process.env.CREDENTIAL_SECRET
};
```

## Public API

Besides being a Node-RED storage module, the package can be driven
programmatically:

```js
const backend = require("node-red-storage-sequelize");

// --- helpers for embedding ---
backend.buildStorageModule(options);   // -> settings.storageModule
backend.buildContextStorage(options);  // -> settings.contextStorage
backend.configuredDialect();           // -> the NODE_RED_STORAGE_DIALECT value
backend.availableDialects();           // -> dialects whose driver is installed
backend.driverByDialect;               // -> { postgres: "pg", ... }

// --- storage module ---
const storage = require("node-red-storage-sequelize");
await storage.init(settings, runtime);
await storage.saveFlows(flows, user);
await storage.close();

// --- context store ---
const store = backend.ContextStore({ dialect: "postgres", database: "nodered" });
await store.open();
await new Promise((resolve, reject) =>
    store.set("global", "key", "value", (err) => (err ? reject(err) : resolve()))
);
await store.close();
```

### Storage module interface

| Method | Notes |
| --- | --- |
| `init(settings, runtime)` | Connects and creates tables. |
| `getFlows()` / `saveFlows(flows, user)` | `user` is `req.user` (an object) and is normalised. |
| `getCredentials()` / `saveCredentials(credentials)` | Stored verbatim. |
| `getSettings()` / `saveSettings(settings)` | Never returns `null`, so the runtime persists its secret. |
| `getSessions()` / `saveSessions(sessions)` | |
| `getLibraryEntry(type, path)` / `saveLibraryEntry(type, path, meta, body)` | Mirrors the filesystem semantics. |
| `close()` | Releases the connection. |

### Context store interface

| Method | Notes |
| --- | --- |
| `open()` / `close()` | |
| `get(scope, key, callback)` | `key` may be a string or an array. Multi-key uses `(err, v1, ... vN)`. |
| `set(scope, key, value, callback)` | `key` may be a string or an array. `undefined` deletes. |
| `keys(scope, callback)` | Always yields an array. |
| `delete(scope)` | Removes a whole scope. |
| `clean(activeNodes)` | Drops scopes whose flow/node no longer exists. Never removes `global`. |

## Running tests

```bash
npm test
```

The suite uses Node's built-in test runner and an in-memory SQLite database, so no
external service is required. Tests that need a specific driver are skipped when
that driver is absent.

## Publishing

```bash
cd packages/node-red-storage-sequelize
npm login
npm publish --access public
```

Checklist before publishing:

1. Bump `version` in `package.json`.
2. `npm pack --dry-run` lists only the intended files.
3. Add a `LICENSE` file to accompany the `license` field.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No database configured` | Missing connection settings | Set `NODE_RED_STORAGE_DATABASE` and friends, or use `NODE_RED_STORAGE_URL`. |
| `Unknown dialect "x"` | Typo | Run `availableDialects()` to see the valid names. |
| `Dialect "x" requires the "y" package` | Driver not installed | `npm install y`. |
| Still on filesystem / `[module=memory]` | `NODE_RED_STORAGE_DIALECT` not set | Set it; both features follow it. |
| **No store selector in Change/Inject** | Fewer than two stores configured | Use `buildContextStorage()`, which always registers `memory` too. |
| **A value written in one store is invisible in another** | `default` declared as a second object instead of an alias | Make it a string: `default: "postgres"`. |
| **A value set externally is not picked up** | Reading a cached scope | Not applicable by default (`cacheTTL` is `0`). If you raised it, lower it or restart. |
| **Global values seem to vanish** | Wrong scope, or the node wrote to `memory` | They live in `nodered_context` with `scope = 'global'`. |
| `Failed to decrypt credentials` | `_credentialSecret` changed | Restore the original secret via `credentialSecret`, or re-enter the credentials. |
| `Specified key was too long` (MySQL) | A table from an older version has wider indexed columns | Handled automatically — see [Upgrading from an older version](#upgrading-from-an-older-version). |
| `Key column 'keyHash' doesn't exist` | Same as above, mid-repair | Handled automatically; this line may appear in the log during the first start after upgrading. |
| `Connection timed out` | Host/port unreachable | Check connectivity, host, port, firewall and `ssl`. |

## Compatibility

| Node-RED | Storage module | Context store |
| --- | --- | --- |
| 2.x | ✅ | ✅ |
| 3.x | ✅ | ✅ |
| 4.x | ✅ | ✅ |
| 5.x | ✅ (verified) | ✅ (verified) |

Two runtime behaviours the implementation relies on, both verified against
Node-RED 5.0.7 sources:

1. **A callback is always supplied** to `ContextStore.get` / `set`
   (`@node-red/runtime/lib/nodes/context/index.js`). Results are therefore
   delivered through the callback; a Promise is returned only when used
   programmatically.
2. **`hasOwnProperty('getSettings')` is checked once**, during
   `storage.init()`. The delegating bootstrap object always exposes it, so
   settings persistence is enabled even when the filesystem backend is active.

## License

MIT
