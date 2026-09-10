# better-sqlite3-compat

The [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) API on Node's built-in `node:sqlite`. No native module, no `node-gyp`, no prebuilds, no `NODE_MODULE_VERSION` mismatches after a Node or Electron upgrade.

```sh
npm install better-sqlite3-compat
```

```js
import Database from 'better-sqlite3-compat';

const db = new Database('app.db');
db.exec('CREATE TABLE IF NOT EXISTS cats (name TEXT NOT NULL, age INTEGER)');
const insert = db.prepare('INSERT INTO cats (name, age) VALUES (@name, @age)');
const insertMany = db.transaction(cats => { for (const cat of cats) insert.run(cat); });
insertMany([{name: 'Joey', age: 2}, {name: 'Sally', age: 4}]);

db.prepare('SELECT name FROM cats WHERE age > ?').pluck().all(3); // ['Sally']
```

Same `Database`, `Statement`, `SqliteError`, transactions, pragma, user functions, aggregates, backup, serialize, verbose and safe-integer contract. Zero runtime dependencies. Node 24.16+ (also runs on Deno's `node:sqlite`; Bun ships `bun:sqlite` with this API already).

## Drop-in use

- **Direct**: change the import. Kysely's `SqliteDialect` and Drizzle's better-sqlite3 driver accept the `Database` instance unchanged.
- **Alias** for libraries that `require('better-sqlite3')` internally (Knex, session stores, plugins):

```sh
npm install better-sqlite3@npm:better-sqlite3-compat
```

Verified with Kysely 0.29, Drizzle ORM 0.45, Knex 3.3 and Prisma 7.10 through `@prisma/adapter-better-sqlite3` (see [docs/compatibility.md](docs/compatibility.md)). Electron 41 and later ship Node 24.18+, so Electron apps get the same API with no `electron-rebuild` step.

## How compatible

better-sqlite3's own test suite runs unchanged in this repository's CI. On Node 24 and 26, **274 of the 321 tests that run** pass. Of the 47 that do not, 37 need virtual tables (`db.table()`, including the virtual-table cases in the BigInt and integrity files), 4 need per-step control of the backup transfer rate, 2 need `DELETE … LIMIT`/`UPDATE … LIMIT`, 1 checks the `nativeBinding` build path, and 3 are aggregate edge cases listed in [docs/compatibility.md](docs/compatibility.md). Eleven further tests in three blocks (native entrypoints and extension loading) run in neither configuration because their setup hooks need the native build directory or a compiled test extension. The only other compatibility package on npm passes 29.

## What is different

- `db.table()` (virtual tables) throws `TypeError`: node:sqlite has no virtual-table API.
- `backup()` reports progress and completion, but the progress callback cannot change the transfer rate or pause the backup.
- `DELETE … ORDER BY … LIMIT` and `UPDATE … LIMIT` are unavailable because Node's SQLite is built without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`.
- Zero-length blobs bind as `NULL` on current node:sqlite.
- Integers beyond 2^53 are returned lossily by `get()`/`all()` like better-sqlite3, but `iterate()` throws `RangeError` for them unless `safeIntegers()` is on.
- `Statement.readonly` is inferred from the leading SQL keyword rather than `sqlite3_stmt_readonly()`.
- `options.nativeBinding` is accepted and ignored.
- `serialize()` and `new Database(buffer)` need Node 24.16 / 26.1 or later.
- Node 24 prints its own `ExperimentalWarning` for `node:sqlite` once per process; Node 26 does not. This package does not suppress warnings.

## Performance

In-memory, Node 24.21, median of 3 (200k-row table): inserting 200k rows in one transaction 132 ms (better-sqlite3 166 ms); `all()` over 200k rows 125 ms (45 ms); 100k point `get()` calls 128 ms (69 ms); iterating 200k rows 125 ms (69 ms); 50k named-parameter `get()` calls 79 ms (49 ms). Reads cost roughly 1.6–2.8× the native addon, about 60% of which is node:sqlite itself. Measure your own workload before switching a read-heavy hot path.

## API

Everything documented in better-sqlite3's [API reference](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) except the differences above: `new Database(path | buffer, {readonly, fileMustExist, timeout, verbose})`, `db.prepare()`, `db.transaction()` (with `.deferred`, `.immediate`, `.exclusive`), `db.pragma()`, `db.explain()`, `db.checkpoint()`, `db.backup()`, `db.serialize()`, `db.function()`, `db.aggregate()`, `db.loadExtension()`, `db.exec()`, `db.close()`, `db.defaultSafeIntegers()`, `db.unsafeMode()`, and on statements `run()`, `get()`, `all()`, `iterate()`, `pluck()`, `expand()`, `raw()`, `columns()`, `bind()`, `safeIntegers()`, `toString()` plus the `database`, `source`, `reader`, `readonly` and `busy` properties. Errors carry the same `SqliteError.code` names, and argument validation throws the same `TypeError`/`RangeError` classes.

## License

MIT. The parity suite under `test/parity/better-sqlite3` is better-sqlite3's test suite, MIT, Joshua Wise and contributors; it is not part of the npm package.
