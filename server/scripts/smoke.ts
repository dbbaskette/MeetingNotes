import { spawn } from 'node:child_process';
// Intentionally requires the isolated real-storage stack; never substitutes mocks.
const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'tests/integration.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, INTEGRATION: '1' },
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
