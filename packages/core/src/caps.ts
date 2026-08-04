// Контекст-бюджет как данные, не как дисциплина вывода: все капы CLI/MCP в одном
// месте (паттерн hermes tool_output_limits). Числа — контракт из спеки.
export const CAPS = {
  boardRows: 8,            // строк на колонку в CLI board (контракт ≤4KB, cyrillic ×2 байта)
  listRows: 20,            // строк на колонку в MCP list_tasks (Claude, без байт-бюджета)
  statusRows: 5,           // строк на секцию kdd status
  statusBytes: 2048,       // бюджет текстовой выдачи kdd status — контракт, structural cap в
                            // renderStatus (как recallBytes в renderRecall): строк не хватает
                            // как замера, заголовок/kind-маркер/blocked-reason не bounded by row count
  statusEvents: 5,         // recent-событий в statusDigest
  titleChars: 50,
  blockReasonChars: 40,
  bodyChars: 8192,         // тело задачи в show/get_task
  comments: 20,            // последних комментов в show/get_task
  commentChars: 500,
  events: 10,              // последних событий в show/get_task
  files: 20,               // вложений в show/get_task
  fileDescChars: 200,      // описание вложения в show/get_task
  fileNameChars: 100,      // original_name — с клиентского multipart-имени, режем на записи
  recallK: 10,             // дефолтный top-k
  recallKMax: 50,          // потолок k — больше не отдаём никому
  recallSnippetTokens: 12,
  recallBytes: 4096,       // бюджет текстовой выдачи kdd recall
  recallTitleChars: 60,
  trackDescChars: 200,
  // Единственные капы на ЗАПИСЬ. Всё выше режет выдачу — эти режут то, что вообще ложится в базу:
  // фид воркера принимает сырой ввод/вывод инструментов, и один `Read` большого файла кладёт
  // сотни КБ одной строкой в базу, которую шарят все worktree проекта.
  fileBytes: 20 * 1024 * 1024, // потолок вложения: доска личная, но 20 MB картинки хватает всем
  agentFieldChars: 4096,   // строковый лист в detail (вывод тула, аргумент, текст ответа)
  agentDetailItems: 64,    // элементов массива в detail — content-блоков у тула бывает много
  agentDetailBytes: 65536, // весь detail после капа листьев; выше — пишем только размер
  agentEventDays: 7,       // столько живёт подробный фид завершённой задачи (см. pruneAgentEvents)
  agentPruneBatch: 5000,   // строк за один проход ротации: DELETE держит write-lock, рядом пишут воркеры
} as const;

export function capText(s: string, n: number): string {
  if (s.length <= n) return s;
  // не резать суррогатную пару — lone surrogate ломает строгий JSON/UTF-8
  const cut = n - ((s.charCodeAt(n - 1) & 0xfc00) === 0xd800 ? 1 : 0);
  return `${s.slice(0, cut)}… [+${s.length - cut} chars]`;
}
