# Changelog

## 0.1.0

- The better-sqlite3 `Database`, `Statement` and `SqliteError` API implemented on `node:sqlite`: prepare/run/get/all/iterate, pluck/expand/raw, bind, columns, toString, transactions with savepoints and `deferred`/`immediate`/`exclusive`, pragma, explain, checkpoint, exec, function, aggregate (including window functions), loadExtension, backup, serialize, verbose, safeIntegers/defaultSafeIntegers, unsafeMode.
- better-sqlite3 binding validation, error codes (`SQLITE_CONSTRAINT_UNIQUE` and friends), busy/iterating protections and `cache_size` default.
- Passes 274 of better-sqlite3 13.0.3's own 321 tests on Node 24; the parity runner and expectations ship in the repository.
- Zero runtime dependencies; CommonJS and ESM entry points; TypeScript declarations.
