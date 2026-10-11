// SessionStart pointer for KDD. Never throws; always exits 0.
// Prints <=3 lines; records failures in the errors table when the db is reachable.
const POINTER = 'KDD substrate active. Tools: list_tasks, recall (MCP). Board UI: kdd ui.';

async function main() {
  let core;
  try {
    // Load the committed core bundle by path — a real plugin install has no
    // node_modules/@kddkit/core, so resolving by package name would always miss.
    core = await import(new URL('../packages/core/dist/index.js', import.meta.url));
  } catch (e) {
    // Too-old Node throws from the core import itself — say so instead of a healthy-looking pointer.
    console.log(POINTER);
    console.log(`KDD unavailable: ${e?.message ?? e}`);
    return;
  }

  let db;
  try {
    const { dbPath, projectPath } = core.resolveDbPath();
    db = core.openDb(dbPath, projectPath);
  } catch (e) {
    console.log(POINTER); // no db (not a git repo / unusable path)
    return;
  }

  try {
    const d = core.statusDigest(db);
    const parts = [];
    if (d.in_progress.length) parts.push(`${d.in_progress.length} in progress`);
    if (d.blocked.length) parts.push(`${d.blocked.length} blocked`);
    // memory-metadata (letta): каталог памяти, не контент — агент сам решает, когда pull
    try {
      const { readdirSync } = await import('node:fs');
      const dated = readdirSync(core.resolveDecisionsDir())
        .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f));
      if (dated.length) {
        parts.push(`${dated.length} decision${dated.length === 1 ? '' : 's'} (last ${dated.map((f) => f.slice(0, 10)).sort().at(-1)})`);
      }
    } catch { /* нет .planning/decisions — просто нет строки */ }
    console.log(POINTER);
    if (parts.length) console.log(parts.join(', ') + '. Pull detail: kdd status / recall.');
    const tracks = core.listTracks(db, { status: 'active' });
    if (tracks.length) {
      console.log(`Tracks: ${tracks.length} active — call list_tracks and orient (branch/worktree → track) before starting.`);
    }
  } catch (e) {
    try { core.logError(db, 'session-start', String(e)); } catch { /* ignore */ }
    console.log(POINTER);
  }
}

main().finally(() => process.exit(0));
