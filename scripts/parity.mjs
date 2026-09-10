// Runs better-sqlite3's own test suite (test/parity/better-sqlite3, MIT) against this package, one file at a time,
// and compares the outcome with the expectations recorded in test/parity/expected.json.
// Usage: node scripts/parity.mjs [--update]
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const suite = join(root, 'test/parity/better-sqlite3');
const work = join(root, `temp/parity-${process.pid}`);
rmSync(work, {recursive: true, force: true});
mkdirSync(join(work, 'test'), {recursive: true});
cpSync(suite, join(work, 'test'), {recursive: true});
writeFileSync(join(work, 'index.js'), `module.exports = require(${JSON.stringify(join(root, 'dist/index.cjs'))});\n`);
writeFileSync(join(work, 'package.json'), '{"private":true}\n');
const mocha = join(root, 'node_modules/mocha/bin/mocha.js');
const files = readdirSync(join(work, 'test')).filter(f => /^\d\d\..*\.js$/.test(f) && f !== '00.setup.js').sort();
const results = {};
let pass = 0, fail = 0;
for (const file of files) {
  const out = spawnSync(process.execPath, [mocha, '--exit', '--slow=75', '--timeout=5000', '--reporter', 'json', 'test/00.setup.js', `test/${file}`], {cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000});
  let report;
  try { report = JSON.parse(out.stdout); } catch { report = {stats: {passes: 0, failures: 1}, passes: [], failures: [{fullTitle: `${file} (no result: ${(out.stderr || '').split('\n').find(Boolean) || 'crash or timeout'})`}]}; }
  results[file] = {passes: report.passes.map(t => t.fullTitle), failures: report.failures.map(t => t.fullTitle)};
  pass += report.stats.passes; fail += report.stats.failures;
  console.log(`${file.padEnd(32)} pass ${String(report.stats.passes).padStart(3)} fail ${String(report.stats.failures).padStart(3)}`);
}
console.log(`total pass ${pass} fail ${fail} (node ${process.version})`);
const expectedPath = join(root, 'test/parity/expected.json');
const major = process.versions.node.split('.')[0];
const all = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
if (process.argv.includes('--update')) {
  const expected = {};
  for (const [file, r] of Object.entries(results)) if (r.failures.length) expected[file] = r.failures;
  all[major] = expected;
  writeFileSync(expectedPath, JSON.stringify(all, null, 2) + '\n');
  console.log('updated', expectedPath, 'for node', major);
} else {
  const expected = all[major] ?? all[Object.keys(all).sort().pop()] ?? {};
  const unexpected = [];
  for (const [file, r] of Object.entries(results)) for (const title of r.failures) if (!(expected[file] || []).includes(title)) unexpected.push(`${file}: ${title}`);
  const minimum = Number(process.env.PARITY_MINIMUM || 270);
  if (unexpected.length) { console.error('Unexpected parity failures:\n' + unexpected.map(x => '  ' + x).join('\n')); process.exit(1); }
  if (pass < minimum) { console.error(`Parity below minimum: ${pass} < ${minimum}`); process.exit(1); }
  console.log('parity ok: no unexpected failures');
}
rmSync(work, {recursive: true, force: true});
