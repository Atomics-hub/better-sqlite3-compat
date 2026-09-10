/// <reference types="node" />
import type {Buffer} from 'node:buffer';

declare namespace Database {
  type SqlValue = null | number | bigint | string | Buffer | Uint8Array;
  /** Anonymous values, arrays of values, and at most one plain object of named parameters. */
  type BindParameter = SqlValue | undefined | readonly SqlValue[] | Record<string, SqlValue | undefined>;
  type RunResult = {changes: number; lastInsertRowid: number | bigint};
  type ColumnDefinition = {name: string; column: string | null; table: string | null; database: string | null; type: string | null};
  type Transaction<F extends (...args: any[]) => any> = F & {
    default: Transaction<F>;
    deferred: Transaction<F>;
    immediate: Transaction<F>;
    exclusive: Transaction<F>;
    readonly database: Database;
  };
  type BackupMetadata = {totalPages: number; remainingPages: number};
  type BackupOptions = {attached?: string; progress?: (info: BackupMetadata) => number | undefined};
  type SerializeOptions = {attached?: string};
  type PragmaOptions = {simple?: boolean};
  type RegistrationOptions = {varargs?: boolean; deterministic?: boolean; directOnly?: boolean; safeIntegers?: boolean};
  type AggregateOptions = RegistrationOptions & {
    start?: unknown | (() => unknown);
    step: (total: any, ...args: any[]) => unknown;
    inverse?: (total: any, ...args: any[]) => unknown;
    result?: (total: any) => unknown;
  };
  type Options = {
    readonly?: boolean;
    fileMustExist?: boolean;
    /** Busy timeout in milliseconds. Default 5000. */
    timeout?: number;
    verbose?: ((message: string) => void) | null;
    /** Accepted for compatibility and ignored: there is no native binding. */
    nativeBinding?: string;
  };

  interface Statement<BindParameters extends unknown[] = BindParameter[], Result = unknown> {
    readonly database: Database;
    readonly source: string;
    readonly reader: boolean;
    /** Inferred from the leading SQL keyword, not from sqlite3_stmt_readonly. */
    readonly readonly: boolean;
    readonly busy: boolean;
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): Result | undefined;
    all(...params: BindParameters): Result[];
    iterate(...params: BindParameters): IterableIterator<Result>;
    pluck(toggleState?: boolean): this;
    expand(toggleState?: boolean): this;
    raw(toggleState?: boolean): this;
    bind(...params: BindParameters): this;
    columns(): ColumnDefinition[];
    safeIntegers(toggleState?: boolean): this;
    toString(): string;
  }

  interface Database {
    readonly name: string;
    readonly open: boolean;
    readonly inTransaction: boolean;
    readonly readonly: boolean;
    readonly memory: boolean;
    prepare<BindParameters extends unknown[] | {} = BindParameter[], Result = unknown>(source: string): BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result>;
    transaction<F extends (...args: any[]) => any>(fn: F): Transaction<F>;
    exec(source: string): this;
    pragma(source: string, options?: PragmaOptions): unknown;
    checkpoint(databaseName?: string): this;
    explain(source: string): unknown[];
    function(name: string, cb: (...params: any[]) => unknown): this;
    function(name: string, options: RegistrationOptions, cb: (...params: any[]) => unknown): this;
    aggregate(name: string, options: AggregateOptions): this;
    /** Virtual tables are not available on node:sqlite; this method always throws TypeError. */
    table(name: string, definition: unknown): never;
    loadExtension(path: string, entryPoint?: string): this;
    close(): this;
    defaultSafeIntegers(toggleState?: boolean): this;
    unsafeMode(toggleState?: boolean): this;
    backup(destinationFile: string, options?: BackupOptions): Promise<BackupMetadata>;
    serialize(options?: SerializeOptions): Buffer;
  }

  interface DatabaseConstructor {
    new (filename?: string | Buffer, options?: Options): Database;
    (filename?: string | Buffer, options?: Options): Database;
    prototype: Database;
    SqliteError: SqliteErrorConstructor;
    Database: DatabaseConstructor;
    default: DatabaseConstructor;
  }

  interface SqliteError extends Error {
    name: string;
    /** An SQLite extended result code name such as "SQLITE_CONSTRAINT_UNIQUE". */
    code: string;
  }

  interface SqliteErrorConstructor {
    new (message: unknown, code: string): SqliteError;
    prototype: SqliteError;
  }
}

declare const Database: Database.DatabaseConstructor;
export = Database;
