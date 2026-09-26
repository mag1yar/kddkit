# KDDKit: итоговый анализ ручной работы и оркестрации

Дата: 2026-09-27. Статус: консолидированный анализ и упорядоченный backlog. Это основание для спецификации контрактов, не утверждение, что будущий runtime уже реализован. Источник требований — обсуждение с пользователем 2026-09-26/27. Предыдущая история исследования: `docs/orchestration-reference-analysis.md`.

## 1. Решение о продукте

Сохранить обычный KDD для работы человека один на один с Claude/Codex. Добавить полноценное автономное исполнение на той же доске и в той же базе проекта. У каждой задачи/подзадачи явно выбран способ исполнения: manual или orchestrated. Ручная работа может отдельно запускать подготовку или review. Способ создания задачи (форма/свободный запрос) независим от способа исполнения.

Настройки проекта задают доступность автономии, workflow, профили ролей, skills, инструменты, связанные репозитории и default. Они не создают вторую независимую систему задач. Между manual/orchestrated работами действуют общие зависимости и явная передача управления.

Прежнее позиционирование #136 оставляло orchestration вне основного сценария; текущий запрос намеренно расширяет продукт. Ручной сценарий сохраняется. Старый tick/autotick/simple worker заменяется после появления работающего нового контура. Переиспользовать lease, heartbeat, процессные группы, события, attachments и безопасные Git helpers, не сохранять старый driver только ради названия.

## 2. Зафиксированные ограничения

- Local-first: состояние и управление локальные, без обязательного GitHub, внешней очереди или облачного backend.
- Служебные prompts, роли, память, logs, screenshots и workspace metadata хранятся вне целевого проекта.
- Для строгой чистоты исходных Git refs использовать независимый managed clone с его worktrees. Не создавать агентские refs в исходном repo.
- Одна SQLite проекта координирует работу. Worktree — версия кода, не отдельная база задач.
- Пользователь имеет последнее слово в требованиях, настройках и финальной приёмке. Модель не может сама выдать себе полномочия.
- Постоянная роль — сохраняемый профиль, а не бесконечный процесс/разговор.
- Проверки относятся к конкретной версии требований и кода. Новые изменения делают прежние результаты проверки неактуальными.
- Решения сохраняют историю: редактирование памяти создаёт новую версию/supersede, не переписывает прошлые причины.
- Удалённый выбранный LLM получает переданный ему контекст; local-first не означает автоматически offline inference.
- Исследовать patterns и реализовать самостоятельно под стек KDD. Не копировать код референсов.

## 3. Повторная проверка текущего KDD

HEAD проекта перед исследованием: `235bbad`, ветка `master`. Recall прочитан до повторного исследования: #136, #12, #33, активные tracks и полный board. На доске: 87 backlog, 4 new, 0 in_progress, 2 review, 47 done. Track 5 явно исключает fleet orchestration; новый backlog размещается отдельно.

| Наблюдение | Проверенный источник | Следствие |
| --- | --- | --- |
| Linked worktrees уже находят общую DB по git-common-dir | `packages/core/src/paths.ts:17` | Не делить базу по веткам |
| Путь repo определяет identity | `paths.ts:27` | Managed clone/перенос пути требуют явной привязки к store |
| `depends_on` пока только произвольная строка связи | `ops.ts:273`, `claim.ts:55` | Нет scheduler dependency gate или cycle check |
| Worktree начинается от текущего HEAD; cleanup зависит от статуса карточки | `worktree.ts:76,96` | Нужны фиксированный base и собственный lifecycle workspace |
| Индекс решений синхронизируется из текущей ветки и удаляет отсутствующие записи | `recall.ts:8,55` | Нельзя использовать этот индекс как branch-independent общую память |
| Reason обходит AI guards; другой AI может принять результат | `state.ts:66` | Новый контур должен иметь controller-issued authority и явный approval |
| Task UI — modal поверх board | `packages/ui/src/web/App.tsx:1`, `components/TaskDialog.tsx:105` | Длительной работе нужна адресуемая поверхность задачи |
| React 19/shadcn/Base UI уже присутствуют | `packages/ui/package.json:1`, `components.json:1` | Новый layout не требует замены UI-стека |

Наблюдаемая проверка: заново собран core и запущена изолированная проверка с 6 assertions. Подтверждены общая DB worktree, отсутствие dependency gating, удаление отсутствующего решения из общего индекса, приёмка другим AI и обход guards через reason. Проверка использует отдельный временный Git/SQLite, не реальные карточки. Воспроизводимый файл: `current-behavior.mjs` рядом с этим анализом. Это проверка существующих ограничений, не тест готовности будущего оркестратора.

Старый документ `docs/superpowers/specs/2026-07-24-agent-role-pipeline-design.md` не является утверждённой спецификацией. Его утверждения «DAG уже есть» и «scheduler не нужен» не подтверждаются текущим кодом; .kdd/roles внутри проекта и восстановление через force cleanup не подходят новым ограничениям.

## 4. Повторное чтение референсов и drift

Для всех десяти репозиториев выполнен настоящий `git fetch origin --prune`. Рабочие checkout не переключались. Если clone отстал, источники прочитаны через `git show` обновлённого upstream. Поэтому строки ниже относятся к указанному commit, а не обязательно к файлу старого checkout.

| Референс | Local HEAD → изученный upstream; отставание | Вердикт |
| --- | --- | --- |
| Symphony | be10a1b → be10a1b; 0 | Взять механический dispatch/reconciliation/retry; не брать tracker как обязательный сервис и не считать это готовым multi-role продуктом |
| Buzz | b0d6fb8a → b0d6fb8a; 0 | Взять адресные сообщения и scope сессий; не переносить Nostr/Postgres/Redis |
| Vibe Kanban | 4deb7ec → d5cbb53; 10 | Взять различие workspace/session/execution и target branch; не переносить весь execution cockpit |
| Agent Kanban | a26bef6 → 7fea6dc; 78 | Взять цикл-чек и blocked predicate; не считать cancelled успешным результатом |
| LangGraph | fde306897 → 7daa3ab49; 54 | Взять durable interrupt/resume; не добавлять Python framework |
| Control Center | 9e567c86 → 9e567c86; 0 | Взять template/run, явные reviews и skills profiles; не переносить registry произвольных тел и сложную memory infrastructure |
| Hermes Agent/Desktop | b3aa561faf → e29517479e; 23 357 | Взять project shell, contextual panes и bounded context; не разделять mutable Markdown нескольких workers |
| Canary | 36a29a0 → 36a29a0; 0 | Взять реальные browser QA evidence и replay; runtime проекта не запускался в исследовании |
| Design Review Workflow | b738d08 → b738d08; 0 | Взять validated visual findings/evidence; не копировать Noncommercial-код |
| Screenshot Review | 84f7f54 → 84f7f54; 0 | Взять независимый before/after взгляд; это skill оценки изображений, не scheduler и не полноценный тест приложения |

Проверенные citations:
- `references/symphony/elixir/lib/symphony_elixir/orchestrator.ex:259` @ be10a1b — reconciliation.
- `/Users/magiyar/Projects/My/References/buzz/crates/buzz-acp/src/scope.rs:30` и `session_model_thread.md:3` @ b0d6fb8a — Channel default, Thread opt-in; core memory общая, conversation context раздельный.
- `/Users/magiyar/Projects/My/References/vibe-kanban/crates/db/src/models/workspace.rs:42`, `session.rs:23`, `execution_process.rs:62` @ d5cbb53 — отдельные сущности исполнения.
- `/Users/magiyar/Projects/My/References/agent-kanban/server/adapters/d1/taskDeps.ts:5,28` @ 7fea6dc — актуальный путь после refactor; done/cancelled считаются удовлетворившими dependency, это последнее правило не берём.
- `/Users/magiyar/Projects/My/References/langgraph/libs/langgraph/langgraph/types.py:887` @ 7daa3ab49 — resume повторно выполняет node с начала: side effects перед ожиданием требуют защиты.
- `references/control-center/packages/cc_domain/lib/features/pipelines/domain/services/pipeline_engine.dart:523` @ 9e567c86 — resumeAll.
- `references/control-center/docs/src/content/docs/manual/concepts/memory-knowledge.mdx:50,77` @ 9e567c86 — все active policies попадают всем, reads fail-open: эти правила для scoped KDD не подходят.
- `references/control-center/docs/src/content/docs/manual/concepts/agent-model.mdx:33` @ 9e567c86 — skill index/frontmatter не равны обязательной загрузке тела.
- `/Users/magiyar/Projects/My/References/hermes-agent/apps/desktop/DESIGN.md:46,76` @ e29517479e — panes сохраняют контекст, background events не забирают focus.
- `/Users/magiyar/Projects/My/References/hermes-agent/website/docs/user-guide/features/memory.md:20,22,57` @ e29517479e — snapshot, границы sessions, конфликт нескольких writers.
- `references/canary/README.md:8` @ 36a29a0 — screenshots/video/trace и воспроизводимый script (заявленные возможности README).
- `references/design-review-workflow/packages/core/src/review/business-grade.ts:39` @ b738d08 — validate до применения visual review.
- `references/screenshot-review/SKILL.md:47` @ 84f7f54 — before/after и приоритет замечаний.

Второй pass изменил акцент: не наследовать всю «память канала», а разделить проверенные знания, разговор и конфигурацию. Не объявлять DAG готовым из-за наличия task_links. Не считать UI reviewer универсальным решением: нужны работающий runtime приложения и проверяемые artifacts. Концепция одной доски и механического scheduler подтверждена.

## 5. Модель исполнения

| Сущность | Ответственность |
| --- | --- |
| Project/store | Identity, настройки и локальная база; явные привязки checkout/clone/repos |
| Task/subtask | Пользовательская цель, контракт, parent, статус и способ исполнения |
| Work item | Анализ, реализация, проверка, интеграция или человеческое действие |
| Workflow revision | Постоянные правила проекта: entry, роли, stages и обязательные checks |
| Plan revision | Конкретные work items и зависимости задачи |
| Role profile | Prompt/model/runtime, выбранные skills, tools и область действий |
| Session | Разговор в scope project/task/subtask; отдельный от process |
| Run/attempt | Входные версии, lease, runtime session, попытка и результат |
| Workspace | Repo/path/branch/base/target, сохранность и lifecycle |
| Question/decision | Адресат, ожидание, ответ, authority и происхождение |
| Check/artifact/approval | Команда, verdict, diff/screenshots и конкретная версия приёмки |
| Memory revision | Знание/правило/гипотеза с областью и источником |

Это различия домена, не требование отдельных сервисов или таблицы на каждое название. Точные schema/API contracts — первая задача backlog. Начать с локального controller/scheduler в существующем TypeScript-стеке и SQLite WAL.

Карточка отражает business lifecycle, run — running/waiting/retry/failed/cancelled/completed. Ждать ответа не значит держать рабочий process и lease бесконечно. Рабочая копия сохраняется отдельно от процесса. Один активный writer на work item; параллельные work items — отдельные workspaces.

## 6. Workflow, планирование и управление

BA обязателен в autonomous workflow; manual Kanban не требует запуска BA. Архитектор — настраиваемая обязательная стадия для проектов, где он нужен. В frontend-проекте доступны Frontend, Code Review и UI Review; в другом — Backend/Mobile и дополнительные проверки. BA не создаёт отсутствующие роли и не отключает guards.

Базовый flow: raw request → BA → Architect review при включении → work items исполнителей → review каждого результата → integration → проверки интегрированного результата → human review → локальный merge. После приёмки отдельно запускается memory curator.

Не каждый шаг обязан вызывать LLM: команды build/test/lint — реальные детерминированные checks. Code reviewer — отдельный независимый контекст. Проверки можно запускать параллельно; следующая стадия ждёт всех обязательных результатов.

Возврат на доработку адресуется владельцу конкретного результата. Изменение плана/требований инвалидирует затронутые зависимые результаты. DAG не превращается в цикл: повторная работа — новая attempt/plan revision. Лимит итераций, retries и бюджет заканчивают спор обращением к пользователю.

Любая роль может спросить BA, архитектора или пользователя. Вопрос/ответ — durable record с correlation ID. Pending question, failure, retry и cancellation различаются. BA отвечает внутри утверждённых решений; новые ограничения/противоречия решает пользователь.

## 7. Git, зависимости и приёмка

Зависимость описывает требуемый результат, не просто статус карточки. BA может заранее подготовить задачу, пока другая не завершена; реализации выдаются только после готовности необходимых artifacts. Отмена/ошибка не равна успешной зависимости.

Managed clone получает выбранный base commit, включая локальные коммиты по явному выбору. Не выполнять автоматический stash/commit/reset пользовательского checkout. Незакоммиченный пользовательский код импортируется только как явный snapshot.

Каждый исполняемый work item получает workspace с фиксированным base. Зависимый workspace должен реально содержать требуемый код. Результаты нескольких зависимостей объединяются в integration workspace последовательно. Конфликты сохраняются, а их решение проходит повторную проверку.

Human approval относится к интегрированному head, target/base и версии требований. Перед merge проверить, что target не изменился; иначе перепроверить обновлённую интеграцию. Acceptance и merge success — разные записи. Локальный merge/import не делает push. Работа с несколькими repo хранит отдельные heads и approvals; не обещает атомарный merge разных repo.

Pause/review/done не являются разрешением force-delete workspace. Cleanup допустим только после проверки живых процессов, dirty/untracked файлов и сохранности commits/artifacts. Env/CI подготовка может быть отдельной человеческой работой; secrets не становятся memory entries.

## 8. Память и пользовательские правила

Project → task → subtask наследуют применимые записи ссылками. Session history и checkpoint существуют отдельно. В контекст попадают обязательные правила, релевантные факты, требования и опубликованные результаты зависимостей. Остальное доступно через scoped FTS recall.

Типы записи: подтверждённый факт, принятое решение, обязательное правило, гипотеза/кандидат. Источник — task/message/tool/path/commit. Кодовые факты имеют версию repo; факт принятой ветки не считается фактом main до merge.

Пользователь редактирует память напрямую или разговором. Изменение создаёт версию и сохраняет историю. Важные user rules можно закрепить. Агент не заменяет их своей гипотезой. Противоречие требует решения, а не скрытого «локальный scope всегда побеждает».

Назначение «роль всегда использует skill X» находится в конфигурации профиля, не только в recall. Новые runs используют новые версии. Активным работам изменения доставляются явно через steering/checkpoint или остановку/перепланирование. Не обрезать обязательные правила незаметно из-за лимита контекста.

Для начала достаточно SQLite/events/FTS5. Не нужны embedding store, автоматический graph reasoning, decay formulas или анализ всей истории на каждой задаче.

## 9. Skills, MCP и runtime

Профиль роли хранит prompt, выбранную модель/runtime, skills Always/Available и tool grants. Always — фактическая загрузка обязательных инструкций при каждом run; Available — индекс и чтение по запросу. Сохранять доступ к rules/scripts/assets и использованную версию/hash.

MCP подключает инструменты. Credentials — локальные настройки runtime, не память или prompt. Проверять права и native tools агента: read-only MCP не ограничивает его собственный shell. Контроль — технические настройки доступного runtime; недоступные гарантии показываются как limitation до старта, без молчаливого урезания обещаний.

Начальная поддержка: Claude и Codex с нормализованными start/resume/stop/results. Модель роли выбирается явно. Конкретные идентификаторы моделей — из установленного runtime, не зашитый список. Ошибка stream/schema не может превратиться в success.

## 10. Проектный помощник, intake и связанные repo

Постоянная открываемая AI-панель по умолчанию использует BA profile с project conversation. В задаче — разговор task BA; scope/recipient видимы. Вопросы и чтение кода не требуют новой карточки. Изменение кода привязывается к существующей/новой задаче и workflow.

Ручной intake требует минимум title. Prompt intake сохраняет исходный запрос и готовит редактируемый черновик критериев, ролей, подзадач и зависимостей. «Подготовить» и «запустить» — разные действия.

Связанный backend может быть context-only. Хранить repo purpose/path/remote/branch, технические права и last viewed SHA. По команде «посмотри новые коммиты» анализировать from/to, API/contracts и предложить frontend работы. Fetch выполняется в управляемой копии без переключения пользовательской ветки. Viewed ≠ implemented. Постоянный watcher не требуется первым.

Для нескольких implementation repo — явная маршрутизация work items и per-repo integration. Mobile роли допускаются настройками; UI review мобильного приложения использует simulator/device evidence, не имитирует native UI браузером.

## 11. Анализатор и хранитель памяти

Анализатор при первом подключении и по запросу читает существующие instructions/docs/manifests/CI/tests/UI. Готовит локальную карту модулей, соглашений, команд и design system с evidence. Неизвестное отмечает. Команда из package.json не считается выполненной. Повторный анализ обновляет производные факты без уничтожения user decisions.

Memory curator запускается после human acceptance, не задерживает merge. Анализирует принятую версию, замечания и пользовательские исправления. Сохраняет краткий итог и проверенные versioned facts; выводы о предпочтениях предлагает как candidates с примерами. Явные user commands уже действуют без повторного подтверждения.

Дедупликация по task/accepted revision/commit. Сбой curator не отменяет приёмку. Кандидатные правила не становятся обязательным контекстом до принятия пользователем. Автообновления видны в журнале, предложения можно подтвердить группой, без модального окна после каждой задачи.

## 12. UI и visual review

Сохранить React 19/shadcn/Base UI/Tailwind. Общий shell: слева project/navigation; центр — board/list или task workspace; справа — сворачиваемые requirements/dependencies/review/files/preview. Task/subtask talks — threads. Inbox собирает вопросы, human review и предложения памяти.

Длительные destinations адресуемые; modal нужен коротким действиям. Background events обновляют indicators, не меняют foreground/focus. На узком viewport панели открываются последовательно. Keyboard/focus, независимый scroll и сохранение контекста проверяются наблюдением.

Использовать vercel-composition-patterns: явные BoardView/TaskWorkspace и ManualTaskForm/PromptTaskComposer, общие части через composition. Provider только для реально разделяемого состояния. Не строить универсальный dock/layout/plugin engine.

UI reviewer запускает приложение в workspace проверяемого commit, проходит сценарии, изучает screenshots и сравнивает с реальными компонентами/design system. Verdict содержит severity, location, reproduction и evidence; console/network ошибки не скрываются красивым изображением. Сохранять viewport/environment/SHA. Before/after сравнение не означает автоматическую победу последней версии. После исправлений повторять затронутые проверки и соблюдать round/budget cap.

## 13. Надёжность, лимиты и миграция

Controller хранит queue/lease/questions/results и восстанавливается без UI. CAS/fencing/идемпотентные commands не допускают двойной writer. Недетерминированные side effects после crash проверяются по сохранённому состоянию, не повторяются слепо.

Лимиты: project/runtime/role concurrency, retries, review rounds, timeout/idle и budget. Неизвестные cost/usage маркируются unknown. Error taxonomy отличает runtime failure, dependency wait, human wait, cancellation и exhausted budget.

Миграция сохраняет старые tasks/events/criteria/files/decisions и ручные CLI/MCP. Старые AI self-accept правила не выдаются за human-only. Новая orchestration acceptance усиливается отдельно. Decision files остаются append-only; local knowledge импортируется с provenance, explicit export только по запросу. Старые workers/drivers не работают параллельно с новым scheduler.

Отложено: облако, обязательный GitHub/PR, общая командная DB по сети, marketplace, произвольный визуальный workflow editor, dock engine, vector/graph memory, always-on repo watcher и автоматический push.

## 14. Порядок и критерии готовности

30 работ образуют отдельный backlog. У каждой карточки указаны зависимости, legacy intersections, критерии и source citations. Порядок списка — допустимая последовательность исполнения; независимые ветви можно делать параллельно только в отдельных деревьях после согласованных интерфейсов.

Первая работа — спецификация контрактов и миграции с review пользователя. Это отделяет обсуждённую архитектуру от утверждённой schema/API. Пользователь явно запросил эту декомпозицию; backlog не означает разрешение начать реализацию всех работ автоматически.

Вертикальные результаты:
1. Ручная/автономная работа делит store и ownership; процессы и рабочие копии восстанавливаются.
2. Один frontend workflow проходит BA/Architect, implementation, question/rework, review и human acceptance.
3. Пользователь управляет им через новую рабочую поверхность и project assistant.
4. Scoped knowledge, backend context, analyser и curator поддерживают последующие задачи.
5. Multi-role/multi-repo и mobile расширяют проверенный контур.
6. Tick отключён, старые данные мигрированы, fresh install/upgrade наблюдены.

Сквозные измерения перед готовностью: два dispatch на одну работу; restart в ожидании вопроса; stale lease/result; отсутствие backend результата; cancelled dependency; rework после нового требования; reviewer crash; сохранность dirty workspace; changed target после approval; повторное событие acceptance; frontend-only flow; mobile/backend/frontend flow; manual takeover и обратная передача; отсутствие служебных файлов/refs в исходном checkout.

Новый scheduler ещё не реализован: ссылки depends_on на нынешней доске документируют порядок, но не исполняют guards. Поэтому все implementation tasks оставлены backlog.

## 15. Checklist

KDD track #6: `Orchestration: local-first workflow`. Созданы #143–#172; все в backlog, 60 unchecked acceptance criteria и 103 dependency links. Пересечения со старыми карточками записаны в телах новых задач; прежние карточки не архивированы и не изменены. В текущем KDD dependency links — документирование порядка, не автоматический execution gate.

- [ ] #143 Контракт продукта и миграции: Kanban + Orchestrator — зависит от —.
- [ ] #144 Project store: идентичность проекта и схема исполнения — зависит от #143.
- [ ] #145 Полномочия controller и область доступа каждого запуска — зависит от #144.
- [ ] #146 Подзадачи, зависимости и выбор ручного/автономного исполнения — зависит от #144, #145.
- [ ] #147 Память project/task/subtask: версии, источники и scoped recall — зависит от #144, #145.
- [ ] #148 Сборка контекста и снимок входов каждого запуска — зависит от #146, #147.
- [ ] #149 Профили ролей: prompt, model, skills Always/Available и MCP — зависит от #144, #145.
- [ ] #150 Исполнение Claude и Codex: start, resume, stop и события — зависит от #145, #148, #149.
- [ ] #151 Managed clone и безопасный lifecycle workspace — зависит от #144, #145.
- [ ] #152 Локальный scheduler: dispatch, lease, recovery и идемпотентность — зависит от #146, #150, #151.
- [ ] #153 Workflow проекта: обязательные стадии, роли и проверки — зависит от #146, #149, #152.
- [ ] #154 BA и Architect: подготовка, проверка и версии плана — зависит от #148, #150, #153.
- [ ] #155 Вопросы BA/Architect/User, durable pause и адресная доработка — зависит от #150, #152, #153.
- [ ] #156 Передача кода зависимостей и интеграция параллельных веток — зависит от #146, #151, #152.
- [ ] #157 Checks и независимый Code Review после исполнителя — зависит от #150, #153, #155, #156.
- [ ] #158 Human review, локальный merge и устаревшие approvals — зависит от #145, #155, #156, #157.
- [ ] #159 Единый API/CLI/MCP для ручной работы и оркестратора — зависит от #145, #146, #147, #149, #152, #153, #155, #158.
- [ ] #160 Layout: общий shell, маршруты и композиция компонентов — зависит от #143, #159.
- [ ] #161 Общая доска, Task workspace, threads и Inbox — зависит от #160, #159.
- [ ] #162 Проектный BA-помощник и ручной/prompt intake — зависит от #154, #155, #159, #160.
- [ ] #163 Настройки workflow, ролей, skills/MCP и редактор памяти — зависит от #147, #149, #153, #159, #160.
- [ ] #164 Связанные репозитории: context-only и анализ новых коммитов — зависит от #145, #147, #151, #162, #163.
- [ ] #165 Первичный и повторный анализ проекта для стартовой памяти — зависит от #147, #148, #150, #162, #164.
- [ ] #166 UI Review: браузер, screenshots, сценарии и evidence — зависит от #151, #155, #157, #161, #163.
- [ ] #167 Хранитель памяти после пользовательской приёмки — зависит от #147, #148, #152, #158, #163.
- [ ] #168 Лимиты, стоимость, диагностика и наблюдаемость запусков — зависит от #150, #152, #155, #159, #161.
- [ ] #169 Mobile/backend/frontend: исполнение в нескольких репозиториях — зависит от #153, #156, #158, #164, #168.
- [ ] #170 Замена tick/autotick/simple worker и миграция старой автономии — зависит от #158, #159, #161, #163, #168.
- [ ] #171 Сквозная проверка workflow, конкуренции и аварийного восстановления — зависит от #162, #163, #165, #166, #167, #168, #169, #170.
- [ ] #172 Документация, upgrade/backup и smoke дистрибуции — зависит от #171.

## 16. Что проверено при подготовке анализа

- `pnpm --filter @kddkit/core build`: exit 0, свежий ESM и declarations.
- `pnpm --filter @kddkit/core typecheck`: exit 0.
- `node .planning/research/orchestration/current-behavior.mjs`: exit 0, 6 assertions для наблюдений из раздела 3.
- Read-only проверка KDD store: 30/30 задач в правильном track и backlog; 60/60 criteria unchecked; 103/103 dependency links сохранены; порядок без циклов; поля прежних карточек совпадают со снимком до изменений.
- Документ: 30 checklist entries, 10 reference commits разрешены в Git, нет TODO/TBD.

Будущие runtime/UI/browser/recovery сценарии не запускались: их реализация входит в backlog. Скриншоты UI-референсов были просмотрены на предыдущем проходе; текущий проход проверил актуальные upstream источники layout, памяти и исполнения. Не выдавать эти наблюдения за проверку будущего KDD UI.
