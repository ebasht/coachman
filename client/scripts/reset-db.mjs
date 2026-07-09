import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, '..', '..', 'server');
const htmlPath = join(__dirname, 'clear-local.html');

console.log('Очистка серверной базы данных…\n');

const result = spawnSync('go', ['run', './cmd/resetdb'], {
  cwd: serverDir,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('\nОткрываю страницу для очистки локальных данных (IndexedDB, PWA-кэш)…');
console.log('Если очистка заблокируется — закройте все вкладки приложения.\n');

if (process.platform === 'darwin') {
  spawnSync('open', [htmlPath], { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'start', '', htmlPath], { stdio: 'inherit', shell: true });
} else {
  console.log(`Откройте в браузере: file://${htmlPath}`);
}
