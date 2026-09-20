// Codex Stop hooks block once, or stay silent. Errors never reach stdout.
import { diagnostic } from './diagnostic.mjs';

function line(ids) {
  const head = ids.slice(0, 3).map((id) => `#${id}`).join(', ');
  const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
  return `kdd: ${head}${more} — all criteria checked; submit to review or say why not.`;
}

async function input() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

try {
  const event = await input();
  if (!event || typeof event !== 'object' || event.agent_id || event.stop_hook_active === true) process.exit(0);
  const stdinSession = typeof event.session_id === 'string' && event.session_id
    ? `codex:${event.session_id}` : undefined;
  const core = await import(new URL('../runtime/core.js', import.meta.url));
  const candidates = [...new Set(
    [process.env.KDD_SESSION, stdinSession, core.agentId()].filter(Boolean),
  )];
  if (!candidates.length) process.exit(0);
  const session = candidates[0];
  let db;
  try {
    const { dbPath, projectPath } = core.resolveDbPath(event.cwd || process.cwd());
    db = core.openDb(dbPath, projectPath);
    const reminded = core.getReminded(db, session);
    const ids = [...new Set(
      candidates.flatMap((candidate) => core.unsubmitted(db, `ai:${candidate}`)),
    )].sort((a, b) => a - b).filter((id) => !reminded.includes(id));
    if (ids.length) {
      core.setReminded(db, session, [...reminded, ...ids]);
      process.stdout.write(`${JSON.stringify({ decision: 'block', reason: line(ids) })}\n`);
    }
  } catch (error) {
    try {
      if (db) core.logError(db, 'codex-stop', String(error));
      else diagnostic('codex-stop', error);
    } catch { diagnostic('codex-stop', error); }
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
} catch (error) { diagnostic('codex-stop', error); }
