import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/run_main.ts'],
  format: 'esm',
  splitting: false, // Each entry is copied/deployed as a standalone broker.
  clean: true,
  noExternal: ['@kddkit/core', '@modelcontextprotocol/sdk', 'zod'],
  external: ['better-sqlite3'], // native .node — installed by smart-install
});
