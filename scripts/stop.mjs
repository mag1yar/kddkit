// Stop hook for KDD. Never throws; always exits 0.
// Silent by default: prints JSON only when THIS session closed every acceptance criterion
// of a task and left it in in_progress. See #119 and the spec next to this file's plan.

/** Одна строка — кап тот же, что у session-start.mjs. Больше трёх номеров не перечисляем. */
function line(ids) {
  const head = ids.slice(0, 3).map((n) => `#${n}`).join(', ');
  const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
  return `kdd: ${head}${more} — all acceptance criteria checked, still in_progress. `
    + `Submit (update_task { id, move: { to: "review" } }) or say why you are not.`;
}

async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function main() {
  let input;
  try { input = await readInput(); } catch { return; } // мусор на stdin — не наше дело
  // JSON.parse('null') не бросает, но дальше — обращение к полям null; ловим отдельно.
  if (!input || typeof input !== 'object') return;

  // Сабагент сдаёт не свою задачу, а на восстановительном ходу напоминание уже прозвучало.
  if (input.agent_id || input.stop_hook_active === true) return;

  let core;
  try {
    // Бандл ядра по пути: в установленном плагине нет node_modules/@kddkit/core.
    core = await import(new URL('../packages/core/dist/index.js', import.meta.url));
  } catch { return; }

  // Хук читает доску, которую написал кто-то другой (CLI/MCP-процесс той же сессии), под
  // своим собственным правилом identity — а не пишет её сам. Тот процесс мог посчитать автора
  // по KDD_SESSION, по CLAUDE_CODE_SESSION_ID или по CLAUDE_PID (см. agentId() в state.ts);
  // хук не знает, какое из них сработало, и переменных окружения Claude Code у него может не
  // быть вовсе. Поэтому пробуем все кандидатуры, какими автор мог оказаться, и объединяем
  // результат — вместо того, чтобы гадать одну и молчать навсегда при промахе.
  // Порядок кандидатов важен: KDD_SESSION первым — так worker в tick сходится с claimed_by.
  const stdinSession = input.session_id ? `cc:${String(input.session_id).slice(0, 8)}` : undefined;
  const candidates = [...new Set(
    [process.env.KDD_SESSION, stdinSession, core.agentId()].filter(Boolean),
  )];
  if (!candidates.length) return;
  // Ключ дедупа — первый кандидат: он стабилен на весь сеанс хука.
  const session = candidates[0];

  let db;
  try {
    const { dbPath, projectPath } = core.resolveDbPath(input.cwd || process.cwd());
    db = core.openDb(dbPath, projectPath);
  } catch { return; } // не git-репозиторий, база недоступна — молчим

  try {
    const already = core.getReminded(db, session);
    const ids = [...new Set(
      candidates.flatMap((c) => core.unsubmitted(db, `ai:${c}`)),
    )].sort((a, b) => a - b);
    const fresh = ids.filter((id) => !already.includes(id));
    if (!fresh.length) return;
    core.setReminded(db, session, [...already, ...fresh]);
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: line(fresh) },
    }));
  } catch (e) {
    try { core.logError(db, 'stop', String(e)); } catch { /* ignore */ }
  } finally {
    // Закрываемся явно, в отличие от session-start.mjs: тот читает раз за сессию, а этот пишет
    // на каждом ходу — закрытие чекпойнтит WAL, иначе он растёт рядом с базой без причины.
    try { db.close(); } catch { /* ignore */ }
  }
}

main().finally(() => process.exit(0));
