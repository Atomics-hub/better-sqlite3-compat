import Database, {SqliteError, type Statement, type RunResult} from 'better-sqlite3-compat';
const db = new Database(':memory:');
const stmt: Statement<[string], {name: string}> = db.prepare<[string], {name: string}>('select ? as name');
const value: {name: string} | undefined = stmt.get('x');
const info: RunResult = db.prepare('select 1').run();
const error: SqliteError = new SqliteError('message', 'SQLITE_BUSY');
const isDb: Database.Database = db;
void isDb;
const called = Database(':memory:');
void [value, info, error, called.open, db.inTransaction];
// @ts-expect-error pragma options must be an object.
db.pragma('cache_size', true);
db.close();
