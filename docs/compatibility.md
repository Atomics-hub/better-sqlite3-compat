# Compatibility report

## Method

better-sqlite3 13.0.3's test suite (`test/parity/better-sqlite3`, MIT, unmodified) is run one file at a time against this package by `scripts/parity.mjs`. The expectations in `test/parity/expected.json` list the tests known to fail per Node major line; CI fails on any additional failure or if fewer than 270 tests pass. The same suite passes 320 of 321 on better-sqlite3 itself (the one remaining test needs the native prebuild layout).

## Result (Node 24)

274 of 321 tests pass. The 47 failures group as follows.

| group | tests | reason |
|---|---:|---|
| virtual tables (`34.database.table`, plus vtab cases in `40.bigints` and `42.integrity`) | 36 | node:sqlite has no virtual-table API; `db.table()` throws `TypeError` |
| backup transfer-rate control (`36.database.backup`) | 4 | node:sqlite fixes the page rate when the backup starts; the progress callback cannot change or pause it |
| `DELETE`/`UPDATE … LIMIT` (`50.misc`) | 2 | Node's SQLite is built without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` |
| native prebuild and compiled test extension (`02.entrypoints`, `10.database.open` nativeBinding, `35.database.load-extension`, `42.integrity` loadExtension hook) | 4 | not applicable without a native addon |
| aggregate edge cases (`33.database.aggregate`) | 3 | node:sqlite calls `start()` once more than better-sqlite3 in one window-function case and converts an `undefined` accumulator to `NULL`; one exception-propagation case inside a window frame |

Every other behavior exercised by the suite matches: argument validation classes and messages, named/anonymous binding rules, `SqliteError` codes, `changes`/`lastInsertRowid` semantics, iteration and busy-connection protections, transactions and savepoints, pragma, explain, checkpoint, functions, aggregates and window functions, serialize/deserialize, backup completion and progress reporting, verbose logging including the 32-byte parameter truncation, safe integers, unsafe mode, worker threads and at-exit behavior.

## Integrations

- Kysely 0.29 `SqliteDialect({database: new Database(file)})`: inserts, updates, aggregates, raw SQL, streaming, transactions and rollback.
- Drizzle ORM 0.45 `drizzle({client: new Database(file)})`: inserts with `RETURNING`, updates, transactions and rollback, blobs.
- Knex 3.3 `client: 'better-sqlite3'` with `npm install better-sqlite3@npm:better-sqlite3-compat`: schema builder, CRUD, transactions, raw queries.

## Deviations

- No virtual tables.
- Backup progress cannot change the transfer rate or pause.
- `DELETE … ORDER BY … LIMIT` / `UPDATE … LIMIT` unsupported.
- Zero-length blobs bind as `NULL` (node:sqlite passes a null pointer for empty views).
- Integers beyond 2^53: `get()`/`all()` return lossy numbers (like better-sqlite3) by re-reading with BigInts; `iterate()` throws `RangeError` unless `safeIntegers()` is enabled.
- `Statement.readonly` is inferred from the leading keyword.
- `nativeBinding` is ignored.
- `serialize()` and `new Database(buffer)` need Node 24.16 / 26.1.
- Node 26.8's `sqlite.backup()` only completes when the event loop is woken; the package keeps a short interval alive until the backup settles.

## Performance

Node 24.21, in-memory, median of 3: insert 200k rows in a transaction 132 ms (better-sqlite3 166 ms, raw node:sqlite 115 ms); `all()` of 200k rows 125 ms (45 / 81 ms); 100k point `get()` 128 ms (69 / 104 ms); iterate 200k rows 125 ms (69 / 107 ms); 50k named-parameter `get()` 79 ms (49 / 65 ms).
