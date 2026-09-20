// Codex hooks accept only a top-level JSON object on stdout.
import { diagnostic } from './diagnostic.mjs';

const pointer = 'KDD substrate active. Tools: list_tasks, recall (MCP). Board UI: kdd ui.';

function emit(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

try {
  const core = await import(new URL('../runtime/core.js', import.meta.url));
  let db;
  try {
    const { dbPath, projectPath } = core.resolveDbPath();
    db = core.openDb(dbPath, projectPath);
    const digest = core.statusDigest(db);
    const parts = [];
    if (digest.in_progress.length) parts.push(`${digest.in_progress.length} in progress`);
    if (digest.blocked.length) parts.push(`${digest.blocked.length} blocked`);
    try {
      const decisions = core.resolveDecisionsDir();
      const dated = (await import('node:fs')).readdirSync(decisions)
        .filter((file) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(file));
      if (dated.length) parts.push(`${dated.length} decision${dated.length === 1 ? '' : 's'}`);
    } catch { /* optional context */ }
    const tracks = core.listTracks(db, { status: 'active' });
    if (tracks.length) parts.push(`${tracks.length} active track${tracks.length === 1 ? '' : 's'}; call list_tracks before starting`);
    emit(parts.length ? `${pointer} ${parts.join(', ')}.` : pointer);
  } catch (error) {
    try {
      if (db) core.logError(db, 'codex-session-start', String(error));
      else diagnostic('codex-session-start', error);
    } catch { diagnostic('codex-session-start', error); }
    emit(pointer);
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
} catch (error) {
  diagnostic('codex-session-start', error);
  emit(pointer);
}
