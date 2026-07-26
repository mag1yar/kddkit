// Отдельный конфиг: vite.config.ts задаёт root src/web (фронтенд),
// а тесты живут в test/ на уровне пакета — vitest не должен наследовать root.
// Плагин react и алиас '@' нужны только компонентным тестам: они импортируют ровно тот код,
// что идёт в сборку. Окружение jsdom каждый такой файл просит сам докблоком
// `// @vitest-environment jsdom` — серверные тесты обязаны остаться в node.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
  test: {},
});
