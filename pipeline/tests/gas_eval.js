// Evaluates a JavaScript expression against the real Apps Script files and prints the result
// as JSON, so the Python tests can check that both phases agree (schema, settings, rules).
//   node gas_eval.js 'TABLES'
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps-script');
const ctx = { console };
vm.createContext(ctx);
for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
}
const value = vm.runInContext(process.argv[2], ctx);
// RegExps from the sandbox aren't instanceof this realm's RegExp, so check the tag.
const isRe = v => Object.prototype.toString.call(v) === '[object RegExp]';
process.stdout.write(JSON.stringify(value, (k, v) => (isRe(v) ? v.source : v)));
