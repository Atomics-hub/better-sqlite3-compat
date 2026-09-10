import assert from 'node:assert/strict';

// Shared behavioral checks used by the unit tests and by the packed-consumer test in both module systems.
export function runChecks(Database) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE cats (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, photo BLOB)');
  const insert = db.prepare('INSERT INTO cats (name, age, photo) VALUES (@name, @age, ?)');
  assert.deepEqual(insert.run({name: 'Joey', age: 2}, Buffer.from([1, 2])), {changes: 1, lastInsertRowid: 1});
  assert.deepEqual(insert.run({name: 'Sally', age: 4}, null), {changes: 1, lastInsertRowid: 2});
  const rows = db.prepare('SELECT name, age, photo FROM cats ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.ok(Buffer.isBuffer(rows[0].photo));
  assert.equal(db.prepare('SELECT age FROM cats WHERE name = ?').pluck().get('Sally'), 4);
  assert.deepEqual(db.prepare('SELECT name FROM cats ORDER BY id').raw().all(), [['Joey'], ['Sally']]);
  const insertMany = db.transaction(cats => { for (const cat of cats) insert.run(cat, null); return cats.length; });
  assert.equal(insertMany([{name: 'Junior', age: 1}]), 1);
  assert.throws(() => insertMany([{name: null, age: 9}]), Database.SqliteError);
  assert.equal(db.prepare('SELECT count(*) FROM cats').pluck().get(), 3);
  let constraint;
  try { db.prepare('INSERT INTO cats (id, name) VALUES (1, ?)').run('dup'); } catch (error) { constraint = error; }
  assert.ok(constraint instanceof Database.SqliteError);
  assert.equal(constraint.code, 'SQLITE_CONSTRAINT_PRIMARYKEY');
  assert.throws(() => db.prepare('SELECT ?, ?').get(1), RangeError);
  assert.equal(db.pragma('journal_mode', {simple: true}), 'memory');
  db.function('shout', s => String(s).toUpperCase());
  assert.equal(db.prepare("SELECT shout('hi')").pluck().get(), 'HI');
  assert.equal(db.prepare('SELECT 9007199254740993 AS big').safeIntegers().get().big, 9007199254740993n);
  const names = [];
  for (const row of db.prepare('SELECT name FROM cats ORDER BY id').iterate()) names.push(row.name);
  assert.deepEqual(names, ['Joey', 'Sally', 'Junior']);
  db.close();
  assert.equal(db.open, false);
  return {checks: 14};
}
