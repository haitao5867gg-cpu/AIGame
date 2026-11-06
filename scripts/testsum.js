'use strict';

// Runs the test suite and prints only the summary and failing tests (keeps agent context small).
// usage: node scripts/testsum.js [test files...]   (default: test/*.test.js)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let files = process.argv.slice(2);
if (!files.length) {
  files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
}
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n');
const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^ℹ (tests|pass|fail)/.test(l)) out.push(l);
  else if (/^✖/.test(l) && !/^✖ failing tests:/.test(l)) {
    out.push(l);
    // a few lines of assertion detail after each failure
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      if (/^[✔✖ℹ]/.test(lines[j])) break;
      out.push(lines[j].slice(0, 300));
    }
  }
}
const seen = new Set();
console.log(out.filter((l) => (seen.has(l) ? false : seen.add(l))).join('\n'));
process.exitCode = r.status || 0;
