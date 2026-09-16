import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readText = path => readFile(new URL(path, import.meta.url), 'utf8');

test('Windows rollout preserves the released identity, app-data database, and platform-specific version', async () => {
  const [baseConfigText, windowsConfigText, rustSource] = await Promise.all([
    readText('../src-tauri/tauri.conf.json'),
    readText('../src-tauri/tauri.windows.conf.json'),
    readText('../src-tauri/src/lib.rs'),
  ]);
  const baseConfig = JSON.parse(baseConfigText);
  const windowsConfig = JSON.parse(windowsConfigText);

  assert.equal(baseConfig.identifier, 'local.backlogger.desktop');
  assert.equal(windowsConfig.version, '0.1.5');
  assert.match(baseConfig.app.security.csp, /connect-src[^;]*https:\/\/\*\.supabase\.co/);
  assert.match(baseConfig.app.security.csp, /connect-src[^;]*wss:\/\/\*\.supabase\.co/);
  assert.match(rustSource, /LOCAL_DATABASE_URL:\s*&str\s*=\s*"sqlite:backlogger-v2\.db"/);
});

test('the staged release retains an explicit legacy-sync rollback build', async () => {
  const packageJson = JSON.parse(await readText('../package.json'));
  assert.match(packageJson.scripts['build:legacy-sync'], /VITE_RECORD_SYNC_PROTOCOL=legacy/);
  assert.match(packageJson.scripts['windows:build:legacy-sync'], /VITE_RECORD_SYNC_PROTOCOL=legacy/);
});

test('the shipped Windows UI no longer contains the manual branch-repair instruction', async () => {
  const source = await readText('../src/main.ts');
  assert.doesNotMatch(source, /resolve it before connecting this device/i);
});
