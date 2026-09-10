import Database = require('better-sqlite3-compat');
const db: Database.Database = new Database(':memory:');
const stmt: Database.Statement<[number], {v: number}> = db.prepare<[number], {v: number}>('select ? as v');
const row: {v: number} | undefined = stmt.get(1);
const rows: {v: number}[] = stmt.all(2);
const info: Database.RunResult = db.prepare('create table t(a)').run();
const trx = db.transaction((n: number) => n * 2);
const doubled: number = trx.immediate(21);
const err: Database.SqliteError = new Database.SqliteError('m', 'SQLITE_ERROR');
void [row, rows, info, doubled, err, db.pragma('cache_size', {simple: true}), db.serialize(), db.backup('x.db', {progress: () => 100})];
// @ts-expect-error filename must be a string or Buffer.
new Database(123);
// @ts-expect-error unknown option types are rejected.
new Database(':memory:', {readonly: 'yes'});
db.close();
