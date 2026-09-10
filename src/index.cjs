'use strict';
// better-sqlite3-compat: the better-sqlite3 API implemented over node:sqlite. No native code.
const sqlite = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = sqlite;

// ---------------------------------------------------------------------------
// SQLite result codes (public domain constants from sqlite3.h)
const PRIMARY = ['SQLITE_OK', 'SQLITE_ERROR', 'SQLITE_INTERNAL', 'SQLITE_PERM', 'SQLITE_ABORT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_NOMEM', 'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOTFOUND', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL', 'SQLITE_EMPTY', 'SQLITE_SCHEMA', 'SQLITE_TOOBIG', 'SQLITE_CONSTRAINT', 'SQLITE_MISMATCH', 'SQLITE_MISUSE', 'SQLITE_NOLFS', 'SQLITE_AUTH', 'SQLITE_FORMAT', 'SQLITE_RANGE', 'SQLITE_NOTADB', 'SQLITE_NOTICE', 'SQLITE_WARNING'];
const EXTENDED = new Map();
const ext = (primary, n, name) => EXTENDED.set(primary | (n << 8), name);
['MISSING_COLLSEQ', 'RETRY', 'SNAPSHOT'].forEach((s, i) => ext(1, i + 1, 'SQLITE_ERROR_' + s));
['READ', 'SHORT_READ', 'WRITE', 'FSYNC', 'DIR_FSYNC', 'TRUNCATE', 'FSTAT', 'UNLOCK', 'RDLOCK', 'DELETE', 'BLOCKED', 'NOMEM', 'ACCESS', 'CHECKRESERVEDLOCK', 'LOCK', 'CLOSE', 'DIR_CLOSE', 'SHMOPEN', 'SHMSIZE', 'SHMLOCK', 'SHMMAP', 'SEEK', 'DELETE_NOENT', 'MMAP', 'GETTEMPPATH', 'CONVPATH', 'VNODE', 'AUTH', 'BEGIN_ATOMIC', 'COMMIT_ATOMIC', 'ROLLBACK_ATOMIC', 'DATA', 'CORRUPTFS', 'IN_PAGE'].forEach((s, i) => ext(10, i + 1, 'SQLITE_IOERR_' + s));
['SHAREDCACHE', 'VTAB'].forEach((s, i) => ext(6, i + 1, 'SQLITE_LOCKED_' + s));
['RECOVERY', 'SNAPSHOT', 'TIMEOUT'].forEach((s, i) => ext(5, i + 1, 'SQLITE_BUSY_' + s));
['NOTEMPDIR', 'ISDIR', 'FULLPATH', 'CONVPATH', 'DIRTYWAL', 'SYMLINK'].forEach((s, i) => ext(14, i + 1, 'SQLITE_CANTOPEN_' + s));
['VTAB', 'SEQUENCE', 'INDEX'].forEach((s, i) => ext(11, i + 1, 'SQLITE_CORRUPT_' + s));
['RECOVERY', 'CANTLOCK', 'ROLLBACK', 'DBMOVED', 'CANTINIT', 'DIRECTORY'].forEach((s, i) => ext(8, i + 1, 'SQLITE_READONLY_' + s));
ext(4, 2, 'SQLITE_ABORT_ROLLBACK');
['CHECK', 'COMMITHOOK', 'FOREIGNKEY', 'FUNCTION', 'NOTNULL', 'PRIMARYKEY', 'TRIGGER', 'UNIQUE', 'VTAB', 'ROWID', 'PINNED', 'DATATYPE'].forEach((s, i) => ext(19, i + 1, 'SQLITE_CONSTRAINT_' + s));
['RECOVER_WAL', 'RECOVER_ROLLBACK', 'RBU'].forEach((s, i) => ext(27, i + 1, 'SQLITE_NOTICE_' + s));
ext(28, 1, 'SQLITE_WARNING_AUTOINDEX');
ext(23, 1, 'SQLITE_AUTH_USER');
ext(0, 1, 'SQLITE_OK_LOAD_PERMANENTLY');
ext(0, 2, 'SQLITE_OK_SYMLINK');
function codeName(errcode) {
  if (EXTENDED.has(errcode)) return EXTENDED.get(errcode);
  const primary = errcode & 0xff;
  if (errcode === primary && PRIMARY[primary]) return PRIMARY[primary];
  if (errcode === 100) return 'SQLITE_ROW';
  if (errcode === 101) return 'SQLITE_DONE';
  if (PRIMARY[primary]) return PRIMARY[primary];
  return 'UNKNOWN_SQLITE_ERROR_' + errcode;
}

class SqliteError extends Error {
  constructor(message, code) {
    if (new.target == null) throw new TypeError("Class constructor SqliteError cannot be invoked without 'new'");
    if (typeof code !== 'string') throw new TypeError('Expected second argument to be a string');
    super(String(message));
    this.code = code;
    Error.captureStackTrace(this, SqliteError);
  }
}
Object.defineProperty(SqliteError.prototype, 'name', { value: 'SqliteError', writable: true, configurable: true });

function convertError(err) {
  if (err == null || typeof err !== 'object') return err;
  switch (err.code) {
    case 'ERR_SQLITE_ERROR':
      if (/Returned JavaScript value cannot be converted/.test(err.message)) return new TypeError(err.message);
      return typeof err.errcode === 'number' ? new SqliteError(err.message, codeName(err.errcode)) : new SqliteError(err.message, 'SQLITE_ERROR');
    case 'ERR_INVALID_STATE':
      return new TypeError(/finalized|closed|not open/i.test(err.message) ? 'The database connection is not open' : err.message);
    case 'ERR_INVALID_ARG_TYPE':
      return new TypeError(err.message);
    case 'ERR_INVALID_ARG_VALUE':
      return new RangeError(err.message);
    case 'ERR_OUT_OF_RANGE':
      return new RangeError(err.message);
    default:
      return err;
  }
}
function attempt(fn) {
  try { return fn(); } catch (err) { throw convertError(err); }
}

// ---------------------------------------------------------------------------
// SQL scanning: statement counting and parameter discovery (comment/string/identifier aware)
const isNameChar = c => /[A-Za-z0-9_$]/.test(c);
function scan(sql) {
  const tokens = [];   // parameter tokens: {start, end, index, name}
  const slots = [];    // 1-based parameter slots: slots[index] = name|null
  const named = new Map();
  let statements = 0;
  let sawToken = false;
  let firstEnd = -1;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e === -1 ? n : e + 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';') { if (sawToken) { statements++; if (firstEnd === -1) firstEnd = i + 1; sawToken = false; } i++; continue; }
    sawToken = true;
    if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < n) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } i = j + 1; continue; }
    if (c === '[') { const e = sql.indexOf(']', i); i = e === -1 ? n : e + 1; continue; }
    if ((c === 'x' || c === 'X') && sql[i + 1] === "'") { const e = sql.indexOf("'", i + 2); i = e === -1 ? n : e + 1; continue; }
    if (c === '?') {
      let j = i + 1; while (j < n && /[0-9]/.test(sql[j])) j++;
      let index;
      if (j > i + 1) { index = Number(sql.slice(i + 1, j)); } else { index = slots.length + 1; }
      while (slots.length < index) slots.push(undefined);
      if (slots[index - 1] === undefined) slots[index - 1] = null;
      tokens.push({ start: i, end: j, index, name: null });
      i = j; continue;
    }
    if (c === ':' || c === '@' || c === '$') {
      let j = i + 1;
      if (j < n && isNameChar(sql[j])) {
        while (j < n && (isNameChar(sql[j]) || (c === '$' && sql[j] === ':'))) j++;
        const name = sql.slice(i + 1, j);
        let index = named.get(name);
        if (index === undefined) { index = slots.length + 1; slots.push(name); named.set(name, index); }
        tokens.push({ start: i, end: j, index, name });
        i = j; continue;
      }
    }
    i++;
  }
  if (sawToken) { statements++; if (firstEnd === -1) firstEnd = n; }
  const anonymous = slots.filter(s => s === null || s === undefined).length;
  return { statements, tokens, slots, anonymous, names: [...named.keys()], firstEnd };
}

// ---------------------------------------------------------------------------
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const ctor = Object.prototype.hasOwnProperty.call(proto, 'constructor') ? proto.constructor : null;
  return typeof ctor === 'function' && ctor.name === 'Object';
}
const isBlob = value => value instanceof Uint8Array || ArrayBuffer.isView(value);
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);
function checkValue(value) {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'string') return value;
  if (t === 'bigint') { if (value > INT64_MAX || value < INT64_MIN) throw new RangeError('BigInt is too big to be represented as a 64-bit signed integer'); return value; }
  if (isBlob(value)) return value;
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
}
// Validates arguments exactly like better-sqlite3 and produces the node:sqlite call arguments.
function normalizeBindings(info, args) {
  const anon = [];
  let source;
  let sourceCount = 0;
  for (const arg of args) {
    if (Array.isArray(arg)) { for (let k = 0; k < arg.length; k++) anon.push(checkValue(arg[k])); continue; }
    if (arg !== null && typeof arg === 'object' && !isBlob(arg)) {
      if (!isPlainObject(arg)) throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
      if (sourceCount++) throw new TypeError('You cannot specify named parameters in two different objects');
      source = arg; continue;
    }
    if (typeof arg === 'function') throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
    anon.push(checkValue(arg));
  }
  if (anon.length !== info.anonymous) throw new RangeError(anon.length < info.anonymous ? 'Too few parameter values were provided' : 'Too many parameter values were provided');
  let namedValues;
  if (info.names.length) {
    if (source === undefined) throw new TypeError('Missing named parameters');
    namedValues = {};
    for (const name of info.names) {
      if (!(name in source)) throw new RangeError(`Missing named parameter "${name}"`);
      namedValues[name] = checkValue(source[name]);
    }
  }
  return { anon, named: namedValues };
}
function copyBlob(value) { return isBlob(value) ? Buffer.from(Buffer.from(value.buffer, value.byteOffset, value.byteLength)) : value; }

// SQL expansion for toString() and verbose (mirrors sqlite3_expanded_sql formatting)
function formatNumber(n) {
  if (Number.isNaN(n)) return 'NULL';
  if (!Number.isFinite(n)) return n > 0 ? 'Inf' : '-Inf';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n + '.0';
  let s = n.toPrecision(15).replace(/(\.\d*?)0+($|e)/, '$1$2').replace(/\.($|e)/, '.0$1');
  return s;
}
function formatValue(value, limit) {
  if (value === null) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') {
    if (limit && Buffer.byteLength(value) > limit) { const head = Buffer.from(value).subarray(0, limit).toString(); return `'${head.replace(/'/g, "''")}'/*+${Buffer.byteLength(value) - limit} bytes*/`; }
    return `'${value.replace(/'/g, "''")}'`;
  }
  const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (limit && buf.length > limit) return `x'${buf.subarray(0, limit).toString('hex')}'/*+${buf.length - limit} bytes*/`;
  return `x'${buf.toString('hex')}'`;
}
function expandSql(sql, info, bindings, limit) {
  if (!info.tokens.length) return sql;
  const byIndex = new Map();
  let anonAt = 0;
  for (let idx = 1; idx <= info.slots.length; idx++) {
    const name = info.slots[idx - 1];
    if (name === null) byIndex.set(idx, bindings.anon[anonAt++]);
    else if (name !== undefined) byIndex.set(idx, bindings.named[name]);
  }
  let out = '';
  let last = 0;
  for (const t of info.tokens) { out += sql.slice(last, t.start) + formatValue(byIndex.has(t.index) ? byIndex.get(t.index) : null, limit); last = t.end; }
  return out + sql.slice(last);
}

// ---------------------------------------------------------------------------
const STATEMENT_KEY = Symbol('statement');
const busyError = () => new TypeError('This database connection is busy executing a query');
const closedError = () => new TypeError('The database connection is not open');

class Statement {
  constructor(key, db, sql) {
    if (key !== STATEMENT_KEY) throw new TypeError('Statement objects can only be created via db.prepare()');
    this.database = db;
    this.source = sql;
    this._info = scan(sql);
    this._native = attempt(() => db._native.prepare(sql));
    this._mode = 'object';
    this._safeIntegers = db._safeIntegers;
    this._bound = null;
    this._busy = false;
    this._columns = null;
    this.reader = attempt(() => this._native.columns().length > 0);
    this.readonly = isReadonlySql(sql);
    this._dml = /^(insert|update|delete|replace)$/i.test(leadingKeyword(sql));
    this._appliedSafeIntegers = null;
  }
  _applySafeIntegers() {
    if (this._appliedSafeIntegers !== this._safeIntegers) { this._native.setReadBigInts(this._safeIntegers); this._appliedSafeIntegers = this._safeIntegers; }
  }
  _check(selfBusyBlocked) {
    const db = this.database;
    if (!db.open) throw closedError();
    if (db._unsafe) return;
    if (db._busy) throw busyError();
    if (selfBusyBlocked && this._busy) throw new TypeError('This statement is busy executing a query');
  }
  _bindings(args) {
    if (this._bound) { if (args.length) throw new TypeError('This statement already has bound parameters'); return this._bound; }
    return normalizeBindings(this._info, args);
  }
  _log(bindings) {
    const verbose = this.database._verbose;
    if (verbose) verbose(expandSql(this.source, this._info, bindings, 32));
  }
  _callArgs(bindings) { return bindings.named ? [bindings.named, ...bindings.anon] : bindings.anon; }
  _prepareMode() {
    this._applySafeIntegers();
    this._native.setReturnArrays(this._mode !== 'object');
  }
  _row(row) {
    if (row === undefined) return undefined;
    if (this._mode === 'pluck') return convertValue(row[0]);
    if (this._mode === 'raw') { for (let k = 0; k < row.length; k++) { const v = row[k]; if (typeof v === 'object' && v !== null && !Buffer.isBuffer(v)) row[k] = convertValue(v); } return row; }
    if (this._mode === 'expand') return expandRow(row, this._native.columns());
    if (Object.getPrototypeOf(row) === null) Object.setPrototypeOf(row, Object.prototype);
    for (const key in row) { const v = row[key]; if (typeof v === 'object' && v !== null && !Buffer.isBuffer(v)) row[key] = convertValue(v); }
    return row;
  }
  _lossy(rows) {
    const fix = v => typeof v === 'bigint' ? Number(v) : v;
    const fixRow = row => { if (Array.isArray(row)) { for (let k = 0; k < row.length; k++) row[k] = fix(row[k]); } else if (row && typeof row === 'object') { for (const key of Object.keys(row)) row[key] = fix(row[key]); } else return fix(row); return row; };
    return Array.isArray(rows) && this._mode !== 'raw' && this._mode !== 'pluck' ? rows.map(fixRow) : (Array.isArray(rows) ? rows.map(fixRow) : fixRow(rows));
  }
  _execute(kind, bindings) {
    const args = this._callArgs(bindings);
    try { this._prepareMode(); const out = attempt(() => this._native[kind](...args)); this.database._afterSuccess(); return out; }
    catch (err) {
      if (!(err instanceof RangeError) || !/too large to be represented as a JavaScript number/.test(err.message) || this._safeIntegers) throw err;
      this._native.setReadBigInts(true); this._appliedSafeIntegers = true;
      try { const out = attempt(() => this._native[kind](...args)); this.database._afterSuccess(); return kind === 'all' ? out.map(r => lossyRow(r)) : lossyRow(out); }
      finally { this._native.setReadBigInts(false); this._appliedSafeIntegers = false; }
    }
  }
  run(...args) {
    this._check(true);
    const bindings = this._bindings(args);
    const db = this.database;
    if (!db._unsafe && db._iterators) throw busyError();
    this._log(bindings);
    db._busy++;
    try {
      this._applySafeIntegers();
      const before = this._dml ? 0 : db._totalChanges();
      const r = attempt(() => this._native.run(...this._callArgs(bindings)));
      const changes = this._dml || db._totalChanges() !== before ? Number(r.changes) : 0;
      const rowid = this._safeIntegers ? BigInt(r.lastInsertRowid) : Number(r.lastInsertRowid);
      return { changes, lastInsertRowid: rowid };
    }
    finally { db._busy--; }
  }
  get(...args) {
    this._check(true);
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
    const bindings = this._bindings(args);
    const db = this.database;
    this._log(bindings);
    db._busy++;
    try { return this._row(this._execute('get', bindings)); }
    finally { db._busy--; }
  }
  all(...args) {
    this._check(true);
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
    const bindings = this._bindings(args);
    const db = this.database;
    this._log(bindings);
    db._busy++;
    try { const rows = this._execute('all', bindings); for (let k = 0; k < rows.length; k++) rows[k] = this._row(rows[k]); return rows; }
    finally { db._busy--; }
  }
  iterate(...args) {
    this._check(true);
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
    const bindings = this._bindings(args);
    const db = this.database;
    const stmt = this;
    let inner = null;
    let done = false;
    const finish = () => { if (!done) { done = true; stmt._busy = false; db._iterators--; if (inner && typeof inner.return === 'function') { try { inner.return(); } catch {} } } };
    stmt._busy = true;
    db._iterators++;
    const iterator = {
      next() {
        if (done) return { value: undefined, done: true };
        if (!db.open) { finish(); throw closedError(); }
        if (db._busy && !db._unsafe) throw busyError();
        try {
          if (inner === null) { stmt._log(bindings); db._busy++; try { stmt._prepareMode(); inner = attempt(() => stmt._native.iterate(...stmt._callArgs(bindings))); } finally { db._busy--; } }
          db._busy++;
          let r;
          try { r = attempt(() => inner.next()); } finally { db._busy--; }
          if (r.done) { finish(); return { value: undefined, done: true }; }
          return { value: stmt._row(r.value), done: false };
        } catch (err) { finish(); throw err; }
      },
      return() { if (db._busy && !db._unsafe && !done) throw busyError(); finish(); return { value: undefined, done: true }; },
      [Symbol.iterator]() { return iterator; },
    };
    return iterator;
  }
  bind(...args) {
    this._check(true);
    if (this._bound) throw new TypeError('This statement already has bound parameters');
    const bindings = normalizeBindings(this._info, args);
    bindings.anon = bindings.anon.map(copyBlob);
    if (bindings.named) for (const k of Object.keys(bindings.named)) bindings.named[k] = copyBlob(bindings.named[k]);
    this._bound = bindings;
    return this;
  }
  _setter() { const db = this.database; if (db.open && !db._unsafe) { if (db._busy) throw busyError(); if (this._busy) throw new TypeError('This statement is busy executing a query'); } }
  pluck(toggle = true) { this._setter(); this._mode = toggle ? 'pluck' : (this._mode === 'pluck' ? 'object' : this._mode); return this; }
  expand(toggle = true) { this._setter(); this._mode = toggle ? 'expand' : (this._mode === 'expand' ? 'object' : this._mode); return this; }
  raw(toggle = true) { this._setter(); this._mode = toggle ? 'raw' : (this._mode === 'raw' ? 'object' : this._mode); return this; }
  safeIntegers(toggle = true) { this._setter(); this._safeIntegers = !!toggle; return this; }
  columns() {
    this._check(false);
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
    return attempt(() => this._native.columns()).map(c => ({ name: c.name, column: c.column, table: c.table, database: c.database, type: c.type }));
  }
  toString() {
    if (!this.database.open || !this._bound) return this.source;
    return expandSql(this.source, this._info, this._bound, 0);
  }
  get busy() { return this._busy; }
}
function convertValue(v) { return v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v; }
function convertArg(v, safeIntegers) { if (typeof v === 'bigint') return safeIntegers ? v : Number(v); return convertValue(v); }
function lossyRow(row) {
  if (row == null) return row;
  if (typeof row === 'bigint') return Number(row);
  if (typeof row !== 'object') return row;
  const keys = Array.isArray(row) ? row.keys() : Object.keys(row);
  for (const key of keys) if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
  return row;
}
function expandRow(values, columns) {
  const out = {};
  columns.forEach((c, k) => { const ns = c.table == null ? '$' : c.table; (out[ns] ??= {})[c.name] = convertValue(values[k]); });
  return out;
}
function skipLeadingTrivia(sql) {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) { i++; continue; }
    if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      const end = sql.indexOf('\n', i + 2);
      if (end === -1) return n;
      i = end + 1;
      continue;
    }
    if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return n;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}
function leadingKeyword(sql) {
  const m = sql.slice(skipLeadingTrivia(sql)).match(/^[A-Za-z]+/);
  return m ? m[0] : '';
}
function isReadonlySql(sql) {
  const first = sql.slice(skipLeadingTrivia(sql)).match(/^([A-Za-z]+)(?:\s+([A-Za-z]+))?/);
  if (!first) return true;
  const a = first[1].toUpperCase(), b = (first[2] || '').toUpperCase();
  if (a === 'SELECT' || a === 'EXPLAIN' || a === 'VALUES' || a === 'COMMIT' || a === 'END' || a === 'ROLLBACK' || a === 'RELEASE' || a === 'SAVEPOINT') return true;
  if (a === 'BEGIN') return !(b === 'IMMEDIATE' || b === 'EXCLUSIVE');
  if (a === 'PRAGMA') return !/=/.test(sql);
  if (a === 'WITH') return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, ''));
  return false;
}

// ---------------------------------------------------------------------------
function getBooleanOption(options, key) {
  let value = false;
  if (key in options && typeof (value = options[key]) !== 'boolean') throw new TypeError(`Expected the "${key}" option to be a boolean`);
  return value;
}
const DEFAULT_TIMEOUT = 5000;

function Database(filenameGiven, options) {
  if (new.target == null) return new Database(filenameGiven, options);
  let buffer;
  if (Buffer.isBuffer(filenameGiven)) { buffer = filenameGiven; filenameGiven = ':memory:'; }
  if (filenameGiven == null) filenameGiven = '';
  if (options == null) options = {};
  if (typeof filenameGiven !== 'string') throw new TypeError('Expected first argument to be a string');
  if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
  if ('readOnly' in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"');
  if ('memory' in options) throw new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)');
  const filename = filenameGiven.trim();
  const anonymous = filename === '' || filename === ':memory:';
  const readonly = getBooleanOption(options, 'readonly');
  const fileMustExist = getBooleanOption(options, 'fileMustExist');
  const timeout = 'timeout' in options ? options.timeout : DEFAULT_TIMEOUT;
  const verbose = 'verbose' in options ? options.verbose : null;
  if (readonly && anonymous && !buffer) throw new TypeError('In-memory/temporary databases cannot be readonly');
  if (!Number.isInteger(timeout) || timeout < 0) throw new TypeError('Expected the "timeout" option to be a positive integer');
  if (timeout > 0x7fffffff) throw new RangeError('Option "timeout" cannot be greater than 2147483647');
  if (verbose != null && typeof verbose !== 'function') throw new TypeError('Expected the "verbose" option to be a function');
  if (!anonymous && !fs.existsSync(path.dirname(filename))) throw new TypeError('Cannot open database because the directory does not exist');
  if (!anonymous && !readonly && fileMustExist && !fs.existsSync(filename)) throw new SqliteError('unable to open database file', 'SQLITE_CANTOPEN');
  const native = attempt(() => new DatabaseSync(anonymous ? (filename === '' ? '' : ':memory:') : filename, { readOnly: readonly && !buffer, timeout, allowExtension: true, defensive: true }));
  attempt(() => native.enableLoadExtension(false));
  if (buffer) {
    if (typeof native.deserialize !== 'function') throw new TypeError('Opening a database from a buffer requires node:sqlite deserialize() (Node 24.16+ / 26.1+)');
    attempt(() => native.deserialize(buffer, { readOnly: readonly }));
    if (readonly) attempt(() => native.exec('PRAGMA query_only = 1'));
  }
  // better-sqlite3 opens with cache_size = -16000. The pragma needs a shared lock, so it is tried without waiting; when
  // another connection holds an exclusive lock at open time it is applied after the first successful statement instead.
  let cachePending = true;
  try {
    native.exec('PRAGMA busy_timeout = 0');
    try { native.exec('PRAGMA cache_size = -16000'); cachePending = false; } catch {}
  } finally {
    attempt(() => native.exec(`PRAGMA busy_timeout = ${timeout}`));
  }
  Object.defineProperties(this, {
    _native: { value: native, writable: true },
    _verbose: { value: verbose },
    _busy: { value: 0, writable: true },
    _iterators: { value: 0, writable: true },
    _unsafe: { value: false, writable: true },
    _safeIntegers: { value: false, writable: true },
    _open: { value: true, writable: true },
    _transactions: { value: null, writable: true },
    _totals: { value: null, writable: true },
    _cachePending: { value: cachePending, writable: true },
    name: { value: filename, enumerable: true },
    memory: { value: anonymous, enumerable: true },
    readonly: { value: readonly, enumerable: true },
  });
}
Object.defineProperties(Database.prototype, {
  open: { get() { return this._open; }, enumerable: true },
  inTransaction: { get() { return this._open && this._native.isTransaction; }, enumerable: true },
});
const proto = Database.prototype;
proto._afterSuccess = function () { if (this._cachePending) { this._cachePending = false; try { this._native.exec('PRAGMA cache_size = -16000'); } catch { this._cachePending = true; } } };
proto._totalChanges = function () { if (!this._totals) this._totals = this._native.prepare('SELECT total_changes()'); this._totals.setReturnArrays(true); return this._totals.get()[0]; };
function checkOpen(db) { if (!db.open) throw closedError(); }
function checkIdle(db) { checkOpen(db); if (db._unsafe) return; if (db._busy) throw busyError(); if (db._iterators) throw busyError(); }
function checkNotBusy(db) { checkOpen(db); if (db._unsafe) return; if (db._busy) throw busyError(); }

proto.prepare = function prepare(sql) {
  checkNotBusy(this);
  if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string');
  const info = scan(sql);
  if (info.statements === 0) throw new RangeError('The supplied SQL string contains no statements');
  if (info.statements > 1) throw new RangeError('The supplied SQL string contains more than one statement');
  return new Statement(STATEMENT_KEY, this, sql);
};
proto.exec = function exec(sql) {
  checkIdle(this);
  if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string');
  const verbose = this._verbose;
  if (verbose) for (const piece of splitStatements(sql)) verbose(piece);
  this._busy++;
  try { attempt(() => this._native.exec(sql)); this._afterSuccess(); } finally { this._busy--; }
  return this;
};
function splitStatements(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  let start = 0;
  let sawToken = false;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e === -1 ? n : e + 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < n) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } i = j + 1; sawToken = true; continue; }
    if (c === ';') { if (sawToken) out.push(sql.slice(start, i).trim()); start = i + 1; sawToken = false; i++; continue; }
    if (!/\s/.test(c)) sawToken = true;
    i++;
  }
  if (sawToken) out.push(sql.slice(start).trim());
  return out;
}
proto.pragma = function pragma(source, options) {
  checkIdle(this);
  if (options == null) options = {};
  if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string');
  if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
  const simple = getBooleanOption(options, 'simple');
  const stmt = this.prepare(`PRAGMA ${source}`);
  if (!stmt.reader) { stmt.run(); return simple ? undefined : []; }
  return simple ? stmt.pluck().get() : stmt.all();
};
proto.checkpoint = function checkpoint(databaseName) {
  checkIdle(this);
  if (databaseName != null && typeof databaseName !== 'string') throw new TypeError('Expected first argument to be a string');
  const target = databaseName == null ? '' : `"${databaseName.replace(/"/g, '""')}".`;
  const result = this.prepare(`PRAGMA ${target}wal_checkpoint(RESTART)`).raw().get();
  if (result && result[0]) throw new SqliteError('database is busy', 'SQLITE_BUSY');
  return this;
};
proto.explain = function explain(sql) {
  checkIdle(this);
  if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string');
  const stmt = attempt(() => this._native.prepare(`EXPLAIN ${sql}`));
  return attempt(() => stmt.all());
};
proto.transaction = function transaction(fn) {
  checkOpen(this);
  if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function');
  const db = this;
  const controllers = getTransactionControllers(db);
  const properties = { default: { value: wrapTransaction(fn, db, controllers.default) }, deferred: { value: wrapTransaction(fn, db, controllers.deferred) }, immediate: { value: wrapTransaction(fn, db, controllers.immediate) }, exclusive: { value: wrapTransaction(fn, db, controllers.exclusive) }, database: { value: db, enumerable: true } };
  Object.defineProperties(properties.default.value, properties);
  Object.defineProperties(properties.deferred.value, properties);
  Object.defineProperties(properties.immediate.value, properties);
  Object.defineProperties(properties.exclusive.value, properties);
  return properties.default.value;
};
function getTransactionControllers(db) {
  if (db._transactions) return db._transactions;
  const exec = sql => () => { checkIdle(db); db._busy++; try { attempt(() => db._native.exec(sql)); } finally { db._busy--; } };
  const shared = { commit: exec('COMMIT'), rollback: exec('ROLLBACK'), savepoint: exec('SAVEPOINT `\t_bs3.\t`'), release: exec('RELEASE `\t_bs3.\t`'), rollbackTo: exec('ROLLBACK TO `\t_bs3.\t`') };
  db._transactions = { default: { begin: exec('BEGIN'), ...shared }, deferred: { begin: exec('BEGIN DEFERRED'), ...shared }, immediate: { begin: exec('BEGIN IMMEDIATE'), ...shared }, exclusive: { begin: exec('BEGIN EXCLUSIVE'), ...shared } };
  return db._transactions;
}
function wrapTransaction(fn, db, { begin, commit, rollback, savepoint, release, rollbackTo }) {
  return function sqliteTransaction(...args) {
    const before = db.inTransaction ? savepoint : begin;
    const after = db.inTransaction ? release : commit;
    const undo = db.inTransaction ? rollbackTo : rollback;
    before();
    try { const result = fn.apply(this, args); after(); return result; }
    catch (ex) { if (db.inTransaction) { undo(); if (undo !== rollback) after(); } throw ex; }
  };
}
proto.function = function defineFunction(name, options, fn) {
  if (options == null) options = {};
  if (typeof options === 'function') { fn = options; options = {}; }
  checkIdle(this);
  if (typeof name !== 'string') throw new TypeError('Expected first argument to be a string');
  if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
  if (typeof fn !== 'function') throw new TypeError('Expected last argument to be a function');
  if (!name) throw new TypeError('User-defined function name cannot be an empty string');
  const varargs = getBooleanOption(options, 'varargs');
  const deterministic = getBooleanOption(options, 'deterministic');
  const directOnly = getBooleanOption(options, 'directOnly');
  const safeIntegers = 'safeIntegers' in options ? getBooleanOption(options, 'safeIntegers') : this._safeIntegers;
  let length = fn.length;
  if (!varargs) {
    if (!Number.isInteger(length) || length < 0) throw new TypeError('Expected function.length to be a positive integer');
    if (length > 100) throw new RangeError('User-defined functions cannot have more than 100 arguments');
  }
  const db = this;
  const wrapped = function (...args) { db._busy++; try { for (let k = 0; k < args.length; k++) args[k] = convertArg(args[k], safeIntegers); const r = fn.apply(this, args); return r === undefined ? null : r; } finally { db._busy--; } };
  Object.defineProperty(wrapped, 'length', { value: varargs ? 0 : length });
  attempt(() => this._native.function(name, { deterministic, directOnly, varargs, useBigIntArguments: true }, wrapped));
  return this;
};
proto.aggregate = function defineAggregate(name, options) {
  checkIdle(this);
  if (typeof name !== 'string') throw new TypeError('Expected first argument to be a string');
  if (options == null || typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
  if (!name) throw new TypeError('User-defined function name cannot be an empty string');
  const { start, step, inverse, result } = options;
  if (typeof step !== 'function') throw new TypeError('Expected the "step" option to be a function');
  if (inverse != null && typeof inverse !== 'function') throw new TypeError('Expected the "inverse" option to be a function');
  if (result != null && typeof result !== 'function') throw new TypeError('Expected the "result" option to be a function');
  const varargs = getBooleanOption(options, 'varargs');
  const deterministic = getBooleanOption(options, 'deterministic');
  const directOnly = getBooleanOption(options, 'directOnly');
  const safeIntegers = 'safeIntegers' in options ? getBooleanOption(options, 'safeIntegers') : this._safeIntegers;
  const checkLength = (fn, label) => {
    if (varargs) return 0;
    const len = fn.length;
    if (!Number.isInteger(len) || len < 0) throw new TypeError(`Expected ${label}.length to be a positive integer`);
    if (len > 101) throw new RangeError('User-defined functions cannot have more than 100 arguments');
    return len;
  };
  const stepLength = checkLength(step, 'step');
  const inverseLength = inverse == null ? 0 : checkLength(inverse, 'inverse');
  let length = Math.max(stepLength, inverseLength) - 1;
  const variadic = varargs || length < 0;
  if (length < 0) length = 0;
  const db = this;
  const guard = f => f == null ? undefined : function (...args) { db._busy++; try { for (let k = 0; k < args.length; k++) args[k] = convertArg(args[k], safeIntegers); return f.apply(this, args); } finally { db._busy--; } };
  const wrappedStep = function (acc, ...args) { db._busy++; try { for (let k = 0; k < args.length; k++) args[k] = convertArg(args[k], safeIntegers); const r = step.call(this, acc, ...args); return r === undefined ? acc : r; } finally { db._busy--; } };
  Object.defineProperty(wrappedStep, 'length', { value: variadic ? 1 : length + 1 });
  const wrappedInverse = inverse == null ? undefined : function (acc, ...args) { db._busy++; try { for (let k = 0; k < args.length; k++) args[k] = convertArg(args[k], safeIntegers); const r = inverse.call(this, acc, ...args); return r === undefined ? acc : r; } finally { db._busy--; } };
  if (wrappedInverse) Object.defineProperty(wrappedInverse, 'length', { value: variadic ? 1 : length + 1 });
  const wrappedResult = result == null ? undefined : function (acc) { db._busy++; try { const r = result.call(this, acc); return r === undefined ? null : r; } finally { db._busy--; } };
  const opts = { step: wrappedStep, varargs: variadic, deterministic, directOnly, useBigIntArguments: true };
  opts.start = start === undefined ? null : typeof start === 'function' ? guard(start) : (start !== null && typeof start === 'object' ? () => start : start);
  if (wrappedInverse) opts.inverse = wrappedInverse;
  if (wrappedResult) opts.result = wrappedResult;
  attempt(() => this._native.aggregate(name, opts));
  return this;
};
proto.table = function defineTable(name) {
  checkIdle(this);
  if (typeof name !== 'string') throw new TypeError('Expected first argument to be a string');
  throw new TypeError('Virtual tables are not supported by node:sqlite');
};
proto.loadExtension = function loadExtension(filename, entryPoint) {
  checkIdle(this);
  if (typeof filename !== 'string') throw new TypeError('Expected first argument to be a string');
  if (entryPoint != null && typeof entryPoint !== 'string') throw new TypeError('Expected second argument to be a string');
  attempt(() => this._native.enableLoadExtension(true));
  try { attempt(() => entryPoint == null ? this._native.loadExtension(filename) : this._native.loadExtension(filename, entryPoint)); }
  finally { try { this._native.enableLoadExtension(false); } catch {} }
  return this;
};
proto.backup = function backup(filename, options) {
  const db = this;
  return new Promise((resolve, reject) => {
    checkOpen(db);
    if (options == null) options = {};
    if (typeof filename !== 'string') throw new TypeError('Expected first argument to be a string');
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
    filename = filename.trim();
    const attached = 'attached' in options ? options.attached : 'main';
    const progress = 'progress' in options ? options.progress : null;
    if (!filename) throw new TypeError('Backup filename cannot be an empty string');
    if (filename === ':memory:') throw new TypeError('Cannot save backup to ":memory:"');
    if (typeof attached !== 'string' || !attached) throw new TypeError('Expected the "attached" option to be a non-empty string');
    if (progress != null && typeof progress !== 'function') throw new TypeError('Expected the "progress" option to be a function');
    if (!fs.existsSync(path.dirname(filename))) throw new TypeError('Cannot save backup because the directory does not exist');
    setImmediate(() => {
      try {
        if (!db.open) throw new TypeError('The database connection is not open');
        const quoted = `"${attached.replace(/"/g, '""')}"`;
        const totalPages = Number(attempt(() => db._native.prepare(`PRAGMA ${quoted}.page_count`).get()).page_count);
        let remaining = totalPages;
        const rate = 100;
        const report = () => { if (!progress) return; const r = progress({ totalPages, remainingPages: remaining }); if (r !== undefined && typeof r !== 'number') throw new TypeError('Expected progress callback to return a number'); };
        report();
        let failure = null;
        const opts = { source: attached, rate, progress(info) {
          remaining = info.remainingPages;
          if (remaining > 0 && !failure) { try { report(); } catch (err) { failure = err; throw err; } }
        } };
        // Node 26.8 only delivers backup completion when something else wakes the event loop; keep it turning until settled.
        const keepAlive = setInterval(() => {}, 10);
        sqlite.backup(db._native, filename, opts).then(
          () => { clearInterval(keepAlive); resolve({ totalPages, remainingPages: 0 }); },
          err => { clearInterval(keepAlive); reject(failure ?? convertError(err)); });
      } catch (err) { reject(err); }
    });
  });
};
proto.serialize = function serialize(options) {
  checkIdle(this);
  if (options == null) options = {};
  if (typeof options !== 'object') throw new TypeError('Expected first argument to be an options object');
  const attached = 'attached' in options ? options.attached : 'main';
  if (typeof attached !== 'string' || !attached) throw new TypeError('Expected the "attached" option to be a non-empty string');
  if (typeof this._native.serialize !== 'function') throw new TypeError('serialize() requires node:sqlite serialize() (Node 24.16+ / 26.1+)');
  const bytes = attempt(() => this._native.serialize(attached));
  return Buffer.from(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};
proto.defaultSafeIntegers = function defaultSafeIntegers(toggle = true) { this._safeIntegers = !!toggle; return this; };
proto.unsafeMode = function unsafeMode(toggle = true) {
  checkOpen(this);
  this._unsafe = !!toggle;
  if (typeof this._native.enableDefensive === 'function') attempt(() => this._native.enableDefensive(!this._unsafe));
  return this;
};
proto.close = function close() {
  if (!this._open) return this;
  if (!this._unsafe && (this._busy || this._iterators)) throw busyError();
  this._open = false;
  attempt(() => this._native.close());
  return this;
};

Database.SqliteError = SqliteError;
Database.Database = Database;
Database.default = Database;
module.exports = Database;
