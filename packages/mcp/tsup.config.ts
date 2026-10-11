import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  splitting: false, // The entry is copied/deployed as a standalone broker.
  clean: true,
  noExternal: ['@kddkit/core', '@modelcontextprotocol/sdk', 'zod'],
});
