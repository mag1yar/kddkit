import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kddHome, releaseInfo } from '@kddkit/core';

const home = kddHome();
const temporary = join(home, `update-check.json.${process.pid}.tmp`);

try {
  const info = await releaseInfo();
  mkdirSync(home, { recursive: true });
  writeFileSync(temporary, JSON.stringify({
    latest: info.error ? null : info.latest,
    checkedAt: Date.now(),
  }), { mode: 0o600 });
  renameSync(temporary, join(home, 'update-check.json'));
} catch {
  // The foreground command never depends on the updater.
} finally {
  try { rmSync(temporary, { force: true }); } catch { /* cleanup is best effort */ }
}
