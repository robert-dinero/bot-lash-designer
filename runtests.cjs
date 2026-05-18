const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname);
const result = spawnSync('node', ['node_modules/.bin/vitest', 'run', '--reporter=verbose'], {
  cwd,
  encoding: 'utf8',
  timeout: 90000,
  env: { ...process.env, FORCE_COLOR: '0' },
});

const output = [
  '=== STDOUT ===',
  result.stdout || '(empty)',
  '=== STDERR ===',
  result.stderr || '(empty)',
  '=== STATUS: ' + result.status + ' ===',
  '=== SIGNAL: ' + result.signal + ' ===',
].join('\n');

fs.writeFileSync(path.join(cwd, 'test_output.txt'), output, 'utf8');
process.stdout.write(output);
process.exit(result.status ?? 0);
