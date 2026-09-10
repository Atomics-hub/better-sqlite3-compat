import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runChecks} from './checks.mjs';

const Database = createRequire(import.meta.url)('../src/index.cjs');
const {SqliteError} = Database;
const dir = mkdtempSync(join(tmpdir(), 'better-sqlite3-compat-test-'));
let counter = 0;
const file = () => join(dir, `db-${++counter}.db`);
test.after(() => rmSync(dir, {recursive: true, force: true}));

test('shared behavioral checks', () => {
  assert.deepEqual(runChecks(Database), {checks: 14});
});

test('constructor validation and properties', () => {
  assert.throws(() => new Database(123), TypeError);
  assert.throws(() => new Database(':memory:', {readonly: true}), TypeError);
  assert.throws(() => new Database(':memory:', {readOnly: false}), TypeError);
  assert.throws(() => new Database(':memory:', {timeout: -1}), TypeError);
  assert.throws(() => new Database(':memory:', {timeout: 0x80000000}), RangeError);
  assert.throws(() => new Database(':memory:', {verbose: true}), TypeError);
  assert.throws(() => new Database(join(dir, 'missing', 'x.db')), TypeError);
  let cantopen;
  try { new Database(file(), {readonly: true}); } catch (error) { cantopen = error; }
  assert.ok(cantopen instanceof SqliteError);
  assert.equal(cantopen.code, 'SQLITE_CANTOPEN');
  assert.throws(() => new Database(file(), {fileMustExist: true}), SqliteError);
  const memory = new Database(':memory:');
  assert.deepEqual([memory.name, memory.memory, memory.readonly, memory.open, memory.inTransaction], [':memory:', true, false, true, false]);
  memory.close();
  const called = Database(file());
  assert.ok(called instanceof Database);
  assert.equal(called.memory, false);
  assert.ok(existsSync(called.name));
  called.close();
  assert.equal(called.open, false);
  assert.equal(called.close(), called);
  assert.throws(() => called.prepare('SELECT 1'), TypeError);
  class Sub extends Database { extra() { return 1; } }
  const sub = new Sub(':memory:');
  assert.equal(sub.extra(), 1);
  assert.equal(Database.prototype.close, sub.close);
  sub.close();
});

test('SqliteError shape and result codes', () => {
  assert.equal(SqliteError.prototype.name, 'SqliteError');
  assert.throws(() => new SqliteError('x'), TypeError);
  assert.equal(new SqliteError(123, 'CODE').message, '123');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE u (a UNIQUE, b NOT NULL)');
  db.prepare('INSERT INTO u VALUES (1, 1)').run();
  const codeOf = fn => { try { fn(); } catch (error) { return `${error.constructor.name}:${error.code}`; } };
  assert.equal(codeOf(() => db.prepare('INSERT INTO u VALUES (1, 1)').run()), 'SqliteError:SQLITE_CONSTRAINT_UNIQUE');
  assert.equal(codeOf(() => db.prepare('INSERT INTO u VALUES (2, NULL)').run()), 'SqliteError:SQLITE_CONSTRAINT_NOTNULL');
  assert.equal(codeOf(() => db.prepare('SELEC 1')), 'SqliteError:SQLITE_ERROR');
  assert.equal(codeOf(() => db.exec('SELECT * FROM nope')), 'SqliteError:SQLITE_ERROR');
  db.close();
});

test('prepare rejects empty and multiple statements but keeps trailing comments', () => {
  const db = new Database(':memory:');
  assert.throws(() => db.prepare(''), RangeError);
  assert.throws(() => db.prepare(';'), RangeError);
  assert.throws(() => db.prepare('SELECT 1; SELECT 2'), RangeError);
  assert.throws(() => db.prepare('SELECT 1;/**/-'), RangeError);
  assert.throws(() => db.prepare(new String('SELECT 1')), TypeError);
  const stmt = db.prepare('SELECT 555;-- trailing comment\n/* more */');
  assert.equal(stmt.reader, true);
  assert.equal(stmt.readonly, true);
  assert.equal(stmt.source, 'SELECT 555;-- trailing comment\n/* more */');
  assert.equal(stmt.database, db);
  assert.throws(() => new stmt.constructor('SELECT 1'), TypeError);
  assert.equal(db.prepare('BEGIN').readonly, true);
  assert.equal(db.prepare('BEGIN IMMEDIATE').readonly, false);
  assert.equal(db.prepare('CREATE TABLE t (a)').reader, false);
  db.close();
});

test('binding rules match better-sqlite3', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE e (a TEXT, b INTEGER, c REAL, d BLOB)');
  const stmt = db.prepare('INSERT INTO e VALUES (?, @b, @b, ?)');
  stmt.run({b: 1}, ['x'], Buffer.alloc(2));
  stmt.run(['x'], {b: 2}, [Buffer.alloc(2)]);
  assert.throws(() => stmt.run({b: 1}, ['x']), RangeError);
  assert.throws(() => stmt.run({b: 1}, ['x'], Buffer.alloc(1), Buffer.alloc(1)), RangeError);
  assert.throws(() => stmt.run({}, ['x'], Buffer.alloc(1)), RangeError);
  assert.throws(() => stmt.run({b: 1}, {b: 1}, 'x', Buffer.alloc(1)), TypeError);
  assert.throws(() => stmt.run({b: 1}, 'x', new Number(1)), TypeError);
  assert.throws(() => stmt.run({b: 1}, 'x', true), TypeError);
  assert.throws(() => stmt.run({b: 1}, 'x', new Date()), TypeError);
  assert.throws(() => stmt.run(new (class { get b() { return 1; } })(), 'x', null), TypeError);
  assert.throws(() => db.prepare('SELECT ?').get(2n ** 70n), RangeError);
  const plain = db.prepare('INSERT INTO e VALUES (?, ?, ?, ?)');
  plain.run('a', 1, 1.5, null, {ignored: true});
  plain.run(undefined, undefined, undefined, undefined);
  assert.equal(db.prepare('SELECT count(*) FROM e WHERE a IS NULL').pluck().get(), 1);
  assert.equal(db.prepare('SELECT $x AS v').get({x: 'named'}).v, 'named');
  assert.equal(db.prepare('SELECT :x AS v').get({x: 5}).v, 5);
  assert.equal(db.prepare('SELECT ?2 AS v').get('first', 'second').v, 'second');
  db.close();
});

test('run, get, all, iterate, modes and columns', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
  assert.deepEqual(db.prepare("INSERT INTO t (name, data) VALUES ('a', x'0102'), ('b', NULL)").run(), {changes: 2, lastInsertRowid: 2});
  assert.deepEqual(db.prepare('SELECT 1').run(), {changes: 0, lastInsertRowid: 2});
  assert.deepEqual(db.prepare('BEGIN').run(), {changes: 0, lastInsertRowid: 2});
  db.prepare('ROLLBACK').run();
  const stmt = db.prepare('SELECT *, 1.5 AS extra FROM t ORDER BY id');
  const rows = stmt.all();
  assert.ok(Buffer.isBuffer(rows[0].data));
  assert.deepEqual(rows[1], {id: 2, name: 'b', data: null, extra: 1.5});
  assert.deepEqual(stmt.pluck().get(), 1);
  assert.deepEqual(stmt.raw().get(), [1, 'a', Buffer.from([1, 2]), 1.5]);
  assert.deepEqual(stmt.expand().get(), {t: {id: 1, name: 'a', data: Buffer.from([1, 2])}, $: {extra: 1.5}});
  assert.deepEqual(stmt.expand(false).get(), {id: 1, name: 'a', data: Buffer.from([1, 2]), extra: 1.5});
  assert.deepEqual(stmt.columns().map(c => [c.name, c.table, c.type]), [['id', 't', 'INTEGER'], ['name', 't', 'TEXT'], ['data', 't', 'BLOB'], ['extra', null, null]]);
  assert.throws(() => db.prepare('CREATE TABLE x (a)').get(), TypeError);
  assert.throws(() => db.prepare('CREATE TABLE x (a)').iterate(), TypeError);
  const it = stmt.iterate();
  assert.equal(stmt.busy, true);
  assert.equal(typeof it.throw, 'undefined');
  assert.equal(it[Symbol.iterator](), it);
  assert.throws(() => db.exec('SELECT 1'), TypeError);
  assert.throws(() => db.prepare('INSERT INTO t (name) VALUES (?)').run('c'), TypeError);
  assert.throws(() => stmt.get(), TypeError);
  assert.equal(db.prepare('SELECT count(*) FROM t').pluck().get(), 2);
  it.return();
  assert.equal(stmt.busy, false);
  db.exec('SELECT 1');
  const seen = [];
  for (const row of stmt.pluck().iterate()) { seen.push(row); if (seen.length === 1) break; }
  assert.deepEqual(seen, [1]);
  assert.equal(stmt.busy, false);
  db.close();
});

test('bind, toString and verbose', () => {
  const calls = [];
  const db = new Database(':memory:', {verbose: sql => calls.push(sql)});
  db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
  const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
  assert.equal(stmt.toString(), 'INSERT INTO t VALUES (?, ?)');
  const buffer = Buffer.from([0xde]);
  stmt.bind('foo', 25);
  assert.equal(stmt.toString(), "INSERT INTO t VALUES ('foo', 25.0)");
  assert.throws(() => stmt.bind('x', 1), TypeError);
  assert.throws(() => stmt.run('x', 1), TypeError);
  stmt.run();
  const blob = db.prepare('INSERT INTO t VALUES (?, ?)').bind(null, buffer);
  assert.equal(blob.toString(), "INSERT INTO t VALUES (NULL, x'de')");
  buffer.fill(0);
  blob.run();
  assert.deepEqual(db.prepare('SELECT b FROM t WHERE a IS NULL').pluck().get(), Buffer.from([0xde]));
  db.prepare('SELECT ?').get('this is a slightly longer parameter');
  assert.deepEqual(calls, ['CREATE TABLE t (a TEXT, b INTEGER)', "INSERT INTO t VALUES ('foo', 25.0)", "INSERT INTO t VALUES (NULL, x'de')", "select b from t where a is null".toUpperCase().replace('SELECT B FROM T WHERE A IS NULL', 'SELECT b FROM t WHERE a IS NULL'), "SELECT 'this is a slightly longer parame'/*+3 bytes*/"]);
  db.close();
  assert.equal(stmt.toString(), 'INSERT INTO t VALUES (?, ?)');
});

test('transactions, savepoints and rollback', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE d (x UNIQUE)');
  const insert = db.prepare('INSERT INTO d VALUES (?)');
  const one = db.transaction(x => insert.run(x).changes);
  const many = db.transaction((...xs) => xs.reduce((n, x) => n + one(x), 0));
  assert.equal(many.immediate(1, 2, 3), 3);
  assert.throws(() => many(4, 5, 3), SqliteError);
  assert.deepEqual(db.prepare('SELECT x FROM d ORDER BY x').pluck().all(), [1, 2, 3]);
  assert.equal(db.inTransaction, false);
  assert.equal(many.database, db);
  assert.equal(many.default, many);
  assert.throws(() => db.transaction('not a function'), TypeError);
  const outer = db.transaction(() => { assert.equal(db.inTransaction, true); try { many(10, 3); } catch {} return one(11); });
  assert.equal(outer(), 1);
  assert.deepEqual(db.prepare('SELECT x FROM d ORDER BY x').pluck().all(), [1, 2, 3, 11]);
  db.close();
});

test('pragma, explain, checkpoint, exec and defaults', () => {
  const db = new Database(file());
  assert.equal(db.pragma('cache_size', {simple: true}), -16000);
  assert.deepEqual(db.pragma('cache_size'), [{cache_size: -16000}]);
  assert.throws(() => db.pragma('cache_size', {simple: 'yes'}), TypeError);
  assert.throws(() => db.pragma('cache_size; PRAGMA cache_size'), RangeError);
  assert.deepEqual(db.pragma('journal_mode = wal'), [{journal_mode: 'wal'}]);
  assert.equal(db.pragma('foreign_keys', {simple: true}), 1);
  db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
  assert.equal(db.checkpoint(), db);
  assert.ok(db.explain('SELECT * FROM t WHERE a = ?').length > 0);
  assert.ok(db.explain('QUERY PLAN SELECT * FROM t WHERE a = ?').length > 0);
  assert.equal(db.exec('SELECT 1'), db);
  assert.throws(() => db.exec(5), TypeError);
  db.close();
});

test('functions and aggregates', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE n (v)');
  db.prepare('INSERT INTO n VALUES (?), (?), (?)').run(3, 5, 7);
  db.function('add2', (a, b) => a + b);
  assert.equal(db.prepare('SELECT add2(?, ?)').pluck().get(2, 3), 5);
  assert.throws(() => db.prepare('SELECT add2(1)').get(), SqliteError);
  db.function('any', {varargs: true}, (...args) => args.length);
  assert.equal(db.prepare('SELECT any(1, 2, 3)').pluck().get(), 3);
  db.function('noop', () => {});
  assert.equal(db.prepare('SELECT noop()').pluck().get(), null);
  db.function('echo', x => x);
  assert.ok(Buffer.isBuffer(db.prepare("SELECT echo(x'01')").pluck().get()));
  db.function('big', {safeIntegers: true}, x => typeof x);
  assert.equal(db.prepare('SELECT big(1)').pluck().get(), 'bigint');
  const boom = new Error('boom');
  db.function('boom', () => { throw boom; });
  assert.throws(() => db.prepare('SELECT boom()').get(), error => error === boom);
  assert.throws(() => db.function('x', {}), TypeError);
  assert.throws(() => db.function('', () => {}), TypeError);
  db.aggregate('total', {start: 0, step: (t, v) => t + v});
  assert.equal(db.prepare('SELECT total(v) FROM n').pluck().get(), 15);
  db.aggregate('avg2', {start: () => [], step: (arr, v) => { arr.push(v); }, result: arr => arr.reduce((a, b) => a + b, 0) / arr.length});
  assert.equal(db.prepare('SELECT avg2(v) FROM n').pluck().get(), 5);
  db.aggregate('win', {start: 0, step: (t, v) => t + v, inverse: (t, v) => t - v});
  assert.deepEqual(db.prepare('SELECT win(v) OVER (ORDER BY v ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM n ORDER BY v').pluck().all(), [3, 8, 12]);
  assert.throws(() => db.aggregate('bad', {}), TypeError);
  assert.throws(() => db.table('vt', {columns: ['x'], rows: function* () {}}), TypeError);
  db.close();
});

test('safe integers', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE b (v INTEGER)');
  const big = 1006028374637854687n;
  db.prepare('INSERT INTO b VALUES (?)').run(big);
  const stmt = db.prepare('SELECT v FROM b').pluck();
  assert.equal(stmt.get(), 1006028374637854700);
  assert.equal(stmt.safeIntegers().get(), big);
  assert.equal(stmt.safeIntegers(false).get(), 1006028374637854700);
  const insert = db.prepare('INSERT INTO b VALUES (?)');
  assert.equal(typeof insert.run(1n).lastInsertRowid, 'number');
  assert.equal(typeof insert.safeIntegers().run(2n).lastInsertRowid, 'bigint');
  db.defaultSafeIntegers(true);
  assert.equal(db.prepare('SELECT v FROM b').pluck().get(), big);
  db.function('argtype', x => typeof x);
  assert.equal(db.prepare('SELECT argtype(?)').pluck().get(big), 'bigint');
  db.close();
});

test('unsafe mode toggles SQLite defensive protections', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE foo (x)');
  db.pragma('writable_schema = ON');
  assert.throws(() => db.exec("UPDATE sqlite_master SET name = 'bar' WHERE name = 'foo'"), SqliteError);
  db.unsafeMode(true);
  const read = db.prepare('SELECT 5');
  for (const _ of read.iterate()) db.exec('SELECT 5');
  db.unsafeMode(false);
  db.close();
});

test('backup and serialize', async () => {
  const db = new Database(file());
  db.exec('CREATE TABLE t (a)');
  db.prepare('INSERT INTO t VALUES (?)').run('value');
  const destination = file();
  await assert.rejects(db.backup(':memory:'), TypeError);
  await assert.rejects(db.backup(''), TypeError);
  await assert.rejects(db.backup(join(dir, 'missing', 'x.db')), TypeError);
  const calls = [];
  const result = await db.backup(destination, {progress: info => { calls.push(info); }});
  assert.deepEqual(result, {totalPages: 2, remainingPages: 0});
  assert.deepEqual(calls, [{totalPages: 2, remainingPages: 2}]);
  const copy = new Database(destination);
  assert.equal(copy.prepare('SELECT a FROM t').pluck().get(), 'value');
  copy.close();
  const bad = file();
  writeFileSync(bad, 'not a database');
  await assert.rejects(db.backup(bad), SqliteError);
  if (typeof db._native.serialize === 'function') {
    const buffer = db.serialize();
    assert.ok(Buffer.isBuffer(buffer));
    const restored = new Database(buffer);
    assert.equal(restored.memory, true);
    assert.equal(restored.prepare('SELECT a FROM t').pluck().get(), 'value');
    restored.close();
    const readonly = new Database(buffer, {readonly: true});
    assert.throws(() => readonly.exec("INSERT INTO t VALUES ('x')"), SqliteError);
    readonly.close();
  }
  db.close();
});
