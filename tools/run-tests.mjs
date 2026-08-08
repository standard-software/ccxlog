import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const mode = process.argv[2] ?? 'normal';
const testsDir = path.resolve('tests');
const allFiles = readdirSync(testsDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join('tests', name));
const watchFile = path.join('tests', 'watch.test.mjs');
const embeddedWatchFiles = [
  path.join('tests', 'codexInheritedHistory.test.mjs'),
  path.join('tests', 'includeSubagents.test.mjs'),
  path.join('tests', 'progressMemory.test.mjs'),
];

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

switch (mode) {
  case 'normal':
    run(
      ['--test', ...allFiles.filter(file => file !== watchFile)],
      { CCXLOG_SKIP_WATCH_TESTS: '1' },
    );
    break;
  case 'watch-smoke':
    run(['--test', '--test-name-pattern=^SMOKE/', watchFile]);
    break;
  case 'watch':
    run(['--test', watchFile]);
    run(['--test', '--test-name-pattern=watch', ...embeddedWatchFiles]);
    break;
  case 'all':
    run(['--test', ...allFiles]);
    break;
  default:
    process.stderr.write('Usage: node tools/run-tests.mjs <normal|watch-smoke|watch|all>\n');
    process.exit(2);
}
