import {mkdir, readFile, writeFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/index.cjs', root), 'utf8');
if (!/module\.exports = Database;/.test(source)) throw new Error('Review build exports');
await mkdir(new URL('dist/', root), {recursive: true});
await writeFile(new URL('dist/index.cjs', root), source);
await writeFile(new URL('dist/index.mjs', root), "import Database from './index.cjs';\nconst {SqliteError} = Database;\nexport {Database, SqliteError};\nexport default Database;\n");
await writeFile(new URL('dist/index.d.cts', root), await readFile(new URL('src/index.d.cts', root), 'utf8'));
await writeFile(new URL('dist/index.d.mts', root), await readFile(new URL('src/index.d.mts', root), 'utf8'));
