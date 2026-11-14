// Evaluates a JavaScript expression against the real Apps Script files and prints the result
// as JSON, so the Python tests can check that both phases agree (schema, settings, rules).
//   node gas_eval.js 'TABLES'        or, for long expressions, on stdin:   node gas_eval.js < expr.js
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script');
const ctx = { console };
vm.createContext(ctx);
for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
}
const expr = process.argv.length > 2 ? process.argv[2] : fs.readFileSync(0, 'utf8');
const value = vm.runInContext(expr, ctx);
// RegExps from the sandbox aren't instanceof this realm's RegExp, so check the tag.
const isRe = v => Object.prototype.toString.call(v) === '[object RegExp]';
process.stdout.write(JSON.stringify(value, (k, v) => (isRe(v) ? v.source : v)));
