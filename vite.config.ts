import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    clearScreen: false,
    server: {
      host: env.BACKLOGGER_DEV_HOST || '127.0.0.1',
      port: 1420,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
    },
    build: { target: 'es2022' },
  };
});
