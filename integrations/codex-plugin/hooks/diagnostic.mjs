import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function diagnostic(source, error) {
  try {
    if (!process.env.PLUGIN_DATA) return;
    mkdirSync(process.env.PLUGIN_DATA, { recursive: true });
    appendFileSync(join(process.env.PLUGIN_DATA, 'kdd-hook-error.log'),
      `${new Date().toISOString()} ${source} ${String(error)}\n`);
  } catch { /* diagnostics are best-effort */ }
}
