// src/update-check-worker.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { kddHome, releaseInfo } from "@kddkit/core";
var home = kddHome();
var temporary = join(home, `update-check.json.${process.pid}.tmp`);
try {
  const info = await releaseInfo();
  mkdirSync(home, { recursive: true });
  writeFileSync(temporary, JSON.stringify({
    latest: info.error ? null : info.latest,
    checkedAt: Date.now()
  }), { mode: 384 });
  renameSync(temporary, join(home, "update-check.json"));
} catch {
} finally {
  try {
    rmSync(temporary, { force: true });
  } catch {
  }
}
