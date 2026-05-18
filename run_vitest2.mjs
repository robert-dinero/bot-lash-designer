import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = __dirname;

const child = spawn('node', ['node_modules/.bin/vitest', 'run', '--reporter=verbose'], {
  cwd,
  shell: false,
  env: { ...process.env },
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

child.on('close', (code) => {
  const out = stdout + '\n---STDERR---\n' + stderr + '\n---EXIT:' + code + '---';
  writeFileSync(join(cwd, 'test_output.txt'), out, 'utf8');
  process.stdout.write(out);
  process.exit(code ?? 0);
});
