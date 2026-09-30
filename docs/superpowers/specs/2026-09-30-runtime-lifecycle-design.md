# Claude и Codex: managed start, resume, stop и события

Дата: 2026-09-30. KDD #150, track 6. Статус: **на review владельца до плана реализации**.

Основания: [контракт продукта](2026-09-27-kanban-orchestrator-contract-design.md), [authority #145](2026-09-27-controller-authority-design.md), [context #148](2026-09-29-run-context-design.md), [roles #149](2026-09-29-role-profiles-skills-design.md), [консолидированный анализ](../../../.planning/research/orchestration/ANALYSIS.md) §§5, 9, 13. Пользователь согласовал **оба runtime на macOS**, установленные CLI, разделение session/attempt и проверяемую остановку. Маршрут — `audit`: реализация в основной сессии, затем свежий независимый `gpt-6.1-sol/high` проверяет accumulated diff и evidence; при сложных спорных invariants — `xhigh`. Это выбор маршрута, не утверждение о переключении модели основной сессии.

## 1. Результат и граница

Trusted controller может запустить выбранную роль через `claude -p` либо `codex exec`, остановить попытку и продолжить **ту же provider session** новой попыткой при совместимых закреплённых входах. Состояние, events и provider identity переживают закрытие SQLite и controller process. Runtime completion не публикует dependency result, не принимает задачу и не меняет её business status.

Начальная платформа — macOS. Остальные платформы дают `unsupported` до запуска managed child. Модели, effort, tool surface и версии CLI проверяются по реально установленному runtime; статического общего списка моделей нет. Неподтверждённые обязательные ограничения или context budget запрещают start/resume, а не включают менее строгий fallback.

#150 включает библиотечный host API, долговечные runtime records, два CLI-адаптера, scoped broker delivery и воспроизводимые smoke commands. Managed clone/workspace provisioning — #151; scheduler, очередь, retry policy и автоматический restart — #152; workflow — #153; адресные вопросы, durable human pause и steering — #155; result/review pipeline — #156/#157; пользовательские API/CLI/UI — #159/#161; полноценная экономика — #168. Существующий manual Kanban и legacy worker продолжают работать. Старый tick не начинает использовать новый runtime до scheduler migration.

Сравнение вариантов: CLI выбран ради существующих launch guards и отсутствия новых dependencies. SDK/app-server transport допустим в отдельной работе, если понадобится непрерывное управление ходом, которое CLI не подтверждает. Одна внешняя ACP-обёртка не нужна: она добавляет transport и не доказывает ограничения native tools.

## 2. Наблюдаемая исходная точка

HEAD перед подготовкой — `b422a3b`, ветка `task/143-kanban-orchestrator-contract`. #145, #148, #149 на доске `done`. Установлены `codex-cli 0.159.0` и `Claude Code 2.1.263`; это прочитанные версии, **не evidence готового lifecycle**.

- `packages/core/src/role_prompt.ts:105` запускает только start и требует authentic process-local permit.
- `packages/core/src/codex_permissions.ts:187` включает `--ephemeral`. Нынешнее native evidence не доказывает persistent start или настоящий provider resume. Метка `phase: resume` в низкоуровневом probe сама по себе такого доказательства не даёт.
- `packages/core/src/roles.ts:20` и authority принимают только проверенный Codex package. Claude требует полноценной проверки и расширения общей границы, а не обходного launch рядом с ней.
- `packages/core/src/agent_events.ts:17` пропускает Claude `result` и malformed JSON. Это поведение display feed нельзя использовать как completion validator.
- `packages/core/src/execution_ownership.ts` уже содержит launch intent, handoff и `StopObservation`. Переиспользовать их scope/fence и stop gate вместо второго ownership registry.

## 3. Session, attempt и хранение

Session — conversation одного project/task/work item и runtime. Она хранит внутренний id, точный provider session id, model/effort, compatibility hash и host-only reference к сохранённому provider transcript/checkpoint. Provider id не является credential. Независимая работа и независимый reviewer получают новые sessions. Resume по `--last`, имени, приблизительному поиску или чужому transcript запрещён.

Attempt — один запуск process: id/runId, session id, predecessor, authority id/generation, ownership fence, input snapshot/hash, role pin, native/runtime receipt, launch id/writer scope, timestamps, process identity, outcome и usage. Новая попытка после stop/resume не переписывает прежнюю. Незавершённый provider turn может оставаться в transcript; продолжение получает явный новый prompt, без автоматического повтора прежнего tool call.

Append migration **v19** после неизменённых 1–18: `runtime_sessions`, `runtime_attempts`, `runtime_events`. FK/scope checks связывают существующие project/task/work item/authority; CAS и уникальные ограничения запрещают две активные попытки одной session и одного work item. Runtime не вводит второго writer fence: авторитетным остаётся #146 ownership. Session identity, attempt input binding и terminal outcome после фиксации неизменяемы. Events append-only, `(attempt_id, sequence)` уникален; control command id/payload hash фиксируются в receipt для идемпотентности. Повтор команды возвращает прежний receipt; иной payload с тем же id отказывает.

Новый managed snapshot имеет versioned секцию **v3** с runtime id и runtime verification binding наряду с role pin. Исторические v1/v2 snapshots читаются с прежней семантикой и hashes; они не получают выдуманные runtime/session records. Новые Claude role revisions допускаются только с проверяемым runtime/model/effort. Старые Codex role revisions сохраняют bytes/hash. New managed attempt требует snapshot нового контракта; чужой runtime package никогда не принимается за Codex permit.

Prompt/config/transcript/checkpoint и полные runtime logs живут в защищённом project store вне целевого checkout, с directories 0700 и files 0600. Credentials не попадают в роль, public snapshot, events или prompt; transport получает их через локальный trusted auth/broker. Не менять реальные `HOME`/`CODEX_HOME` глобально и не копировать весь пользовательский home. Выбранная локальная authentication сохраняется, если совместима с isolation; несовместимость — явный preflight error, без требования нового API key по умолчанию.

## 4. Start и durable launch intent

Host API принимает authentic `ControllerHandle`, точные work item/ownership/role refs и конечные launch limits. Переиспользует #145–#149: dependencies и current inputs, role skills, native scope, broker operations и prompt budget. Шаблон launch связывает runtime executable/version, argv, env, cwd, model/effort, broker и roots; caller не дописывает поздние flags. Persisted JSON verification receipt не заменяет живой verified permit.

До spawn одна transaction фиксирует attempt `created`, launch intent #146 и idempotent command receipt. Последняя проверка под существующим controller lock повторяет authority/inputs/native roots и template binding непосредственно перед spawn. DB не держит transaction во время LLM request. После настоящего spawn сохраняются process identity и `running`; provider session id фиксируется только из допустимого provider сообщения и сравнивается с ожидаемым id.

Для Claude controller заранее выбирает UUID, если установленный CLI это поддерживает, но всё равно требует provider acknowledgment. Для Codex id приходит из его initial session event. Запуск идёт в собственной process group, prompt marker содержит безопасный launch id без credential. PID/PGID без проверки identity недостаточны для остановки после restart.

Gap между durable intent, spawn и записью PID может дать `unknown`. Повтор команды с существующим intent не делает второй spawn. Host diagnostic API сверяет namespace/process identity и сохранённые receipts; пока исход неизвестен, writer удерживается и resume запрещён. Автоматическая reconciliation/retry остаётся #152, но #150 предоставляет факты и stop observer для неё. `never_started` допустим только при доказанном отсутствии launch side effect, а не при отсутствующей PID row.

## 5. Resume и обновление входов

Resume всегда создаёт новый attempt/runId и новую authority generation после доказанного завершения прежних writers. Новая reservation/fence берётся через #146; прежний grant отзывается и больше не работает. Старый terminal attempt не становится `running` снова. Session id сохраняется, если provider действительно возобновил эту session; неизвестный/missing checkpoint, неподдерживаемый resume или иной provider id дают отказ, без молчаливого fresh start.

`inputHash` #148 содержит authority/generation и поэтому не обязан совпадать между попытками. Совместимость session проверяется отдельно по canonical содержимому: project/task/work item/revision; contracts и parent membership; pinned dependency result ids/hashes; mandatory rules и selected knowledge revisions/hashes; role revision/manifest; runtime/version/model/effort/tool surface; repo ids, input commits, canonical bindings; native read/write/protected roots и network policy. Различия run ids, generation, timestamps, authority credential и проверенного per-attempt broker endpoint не являются изменением требований. Эта нормализация не удаляет поля grants, безопасности или входного содержания.

При изменении любого обязательного compatibility поля прежняя session не используется. Host фиксирует `update_required` через #148, останавливает старую попытку и явно создаёт новую attempt/session с актуальным пакетом. Полное содержимое Always и requirements/rules передаётся заново. Это минимальная доставка новых входов в #150; адресная steering/ACK protocol — #155. При unchanged inputs новый resume prompt также сообщает актуальные run refs и роли, не возобновляет старые credentials.

Current role revision сама не изменяет pinned historical role; используются правила #149. Изменение workspace output HEAD от предыдущей попытки не подменяет input commit и отдельно проверяется по разрешённому workspace/ownership. Новый base либо inputs от другой revision не считаются совместимым resume.

## 6. Stop и освобождение ownership

Stop — host control command с attempt/generation binding, а не текстовое сообщение модели. Идемпотентно фиксируется stop intent, закрываются новые broker actions старого grant, отправляется SIGTERM собственной проверенной process group; после конечного grace period — SIGKILL оставшимся идентифицированным processes. Локальная запись intent не является остановкой. Вывод дочерних процессов дочитывается в bounded drain period, затем закрываются pipes и listeners.

Observer возвращает настоящий `StopObservation` #146: launch id, writer scope, owner/fence, свежий timestamp, `complete` и состояния writers. Закрытие provider process и отсутствие лидера группы недостаточны: проверяются group members и известные descendants, включая child, переживший родителя. Если detached/escaped writer или полноту наблюдения нельзя проверить, outcome `unknown`, ownership остаётся held. Не обещать произвольное дерево процессов остановленным по одному `kill(-pgid)`; profiles без доказуемой необходимой границы отказывают до launch. Native/stop matrix включает escaped-child case.

`finishHandoff` и release path используют один проверенный stop gate. Task-wide handoff #146 не используется для stop одной попытки: он затронул бы siblings. Добавить в существующий ownership module scoped retire operation для точного owner/fence/launch id: после свежего stop observation она атомарно сохраняет release receipt, освобождает только этот owner и отзывает только его authority. Concurrent task handoff, changed fence или иной launch блокируют retire. Receipt учитывается существующим handoff validation как доказанная остановка прежнего owner; второго ownership registry нет. Для следующей попытки controller явно возвращает тот же work item в reservable state с проверкой current inputs и CAS, без completed output или автоматического retry. Stop из-за отмены даёт `cancelled`; timeout/idle, revoke, stale inputs и provider errors получают свои reason codes. `waiting` зарезервирован для доказанного host pause/checkpoint; #150 не создаёт human question workflow. В любом исходе сохранность checkout, commits, untracked files и artifacts не зависит от остановки. Runtime не удаляет workspace.

Отсутствие процесса после неудачного spawn позволяет завершить попытку только при достоверном наблюдении. Живой/unknown writer удерживает reservation даже после terminal provider message, expiry, revoke или crash. Отсутствующий/ошибочный observer не превращается в success.

## 7. CLI и native boundary

Codex: сохраняемые sessions вместо `--ephemeral` только в новом проверенном профиле. Start и `exec resume <exact-id>` имеют отдельные фиксированные argv templates, сохраняют закрытый tool catalog, отключённые дополнительные surfaces и #145 native isolation. Resume CLI имеет иной набор flags; не конструировать его перестановкой непроверенных start flags. Session storage должен быть доступен самому runtime и закрыт от его native tools, соседних sessions и target source. Persistent profile и реальные resumed tool calls проходят повторную exact-version matrix.

Claude: отдельный verified package того же trust boundary, с разрешёнными native read/workspace-write classes и scoped `kdd_run` MCP. В installed CLI есть `--restricted`, `--tools`, permission modes и strict MCP config; наличие flags **не является доказательством enforcement**. Технический profile закрывает host/project hooks/plugins/skills discovery и лишние MCP/native tools, проверяет эффективные settings и deny-before-start. Bash, Read, Edit/Write и любые другие доступные native tools проверяются реально по read/write/protected roots, symlink/hardlink, runtime configuration/session storage и network. Если нужен внешний macOS sandbox wrapper, он становится частью exact package/hash и той же native matrix. Bypass-permissions или инструкции в prompt не заменяют enforcement.

Нужны настоящие positive controls: allowed tool operations обязаны проходить, иначе массовое denial ничего не доказывает. Scoped MCP checks покрывают чужой task/path/skill, write у read-only, revoked/stale generation, известные и неизвестные operations, resources/templates и tool discovery. Shared authority/grants/snapshot guard расширяется на оба authentic runtime packages; не создаётся Claude путь без role permit.

Model/effort/context limit получают из подтверждённого runtime/provider metadata. Budget покрывает полный assembled prompt, tool schemas, обязательный системный overhead, output reserve и при resume сохранённую conversation. Unknown context size, неподтверждённый overhead или невозможность подтвердить помещающуюся историю блокируют launch. Compaction, если runtime её поддерживает, требует отдельного evidence сохранения обязательных инструкций; она не считается автоматическим решением overflow. Native version/registry/model/config drift отменяет старый permit.

## 8. Events, outcomes и ограничения

Нормализованные events: session binding, attempt start, text, tool start/finish с correlation id, usage, error, provider terminal и host stop/end observation. Каждое событие связано с attempt/session/generation и sequence. Один terminal outcome, включая гонку `error`/`close`/stop; поздний event старой generation сохраняется только как диагностический stale event и не мутирует активную попытку. `runtime_events` — canonical journal; existing display feed может получать безопасную projection, без второго completion validator.

Parsers ограничивают размер строки, total buffered bytes, nesting, stderr/log bytes и drain time. Malformed protocol event, противоречивый/повторный terminal result, неверная session binding и provider error оставляют non-success. Дополнительное неизвестное telemetry сообщение допускается только как явно ignorable diagnostic; оно не заменяет session/result. Empty stream, EOF без required terminal, process exit 0 без валидного результата, failure terminal при exit 0 и success terminal при nonzero exit не дают success. Неизвестный outcome маркируется `inconclusive`, не угадывается из текста ответа.

Attempt states соответствуют #143: `created | running | waiting | completed | failed | cancelled`. `created` включает подготовку; stop intent и uncertainty — отдельные host diagnostics, не дополнительные business columns. `completed` требует valid provider success, exit 0, актуальных input/authority/fence и доказанного отсутствия writers. Это успешный **runtime turn**, а не accepted work-item output. Error taxonomy: `unsupported`, `spawn_failed`, `protocol_error`, `provider_error`, `timeout`, `idle_timeout`, `cancelled`, `authority_revoked`, `update_required`, `session_unavailable`, `stop_unknown`, `context_overflow`; дополнительные lifecycle reason codes остаются закрытым проверяемым набором.

Usage/cost отсутствует — `unknown`, не 0. Сохраняются provider-reported значения, единицы и scope `attempt` либо `session_cumulative`; cumulative amount при resume не суммируется повторно как стоимость попытки. Events/logs проходят bounded redaction до persist/export; произвольные raw config/env/credentials и полные tool payloads не копируются в public journal. Исторические transcript доступны только trusted host в защищённом store.

Finite timeout, idle timeout, stop grace, drain cap, max prompt/event bytes и concurrency admission должны быть проверены до spawn. #150 исполняет supplied limits и запрет второго launch на owned work item/session; #152 управляет project/runtime/role scheduling и retries. #168 задаёт project budget policy. Если caller заявляет hard monetary ceiling, которое этот runtime не может обеспечить, start отказывает с limitation; telemetry estimate не выдаётся за hard cap.

## 9. Приёмка и воспроизводимые измерения

Проверки выполняются в изолированных temporary Git/SQLite/store, без изменения development source refs/status и реальных карточек. Host smoke command сохраняет safe JSON evidence с runtime versions, command hashes, attempt/session ids, input pins, terminal/exit status, stop observations, expected/actual markers и native verdicts. Mock protocol tests не заменяют настоящие CLI/provider requests.

| ID | Наблюдение |
| --- | --- |
| L01 | v18 WAL upgrade сохраняет прежние rows/ids/attachments/role bytes/input hashes; v19 tables пусты, reopen идемпотентен, old binary отказывает |
| L02 | Для **каждого runtime 3/3 циклов**: настоящий start получает session id и unique marker; stop прерывает следующий длинный ход; новый process/resumed attempt возвращает прежний marker без повторной передачи marker и тот же provider id |
| L03 | Stop matrix: normal exit, SIGTERM grace, SIGKILL escalation, child surviving parent и escaped child; live/unknown удерживают owner, доказанная остановка освобождает через scoped retire #146; sibling owner/grant не изменены; task handoff распознаёт прежний retire receipt; повтор stop не создаёт другой outcome |
| L04 | Для обоих runtime start **и настоящий resume**: native read/workspace-write matrices с positive controls, foreign/protected roots, links, settings/session files, network, scoped MCP and live revoke; exact-version/tool hashes записаны |
| L05 | Current role/requirements/rules/dependency changes дают update_required; revoked/stale generation не пишет/report; unchanged semantic pins допускают новую generation той же session, changed pins — новую session; Always bodies и новые requirements реально присутствуют в provider request |
| L06 | Malformed/truncated/oversize/empty stream, missing/conflicting terminal, неверный session id, exit/result disagreement, spawn error и error/close race: **0 ложных success**, один outcome; known unknown telemetry не даёт completion |
| L07 | Повтор start/resume command и конкурентный launch дают не более одного child; crash windows до/после spawn удерживают uncertain owner и не повторяют side effect; reopen восстанавливает exact session/attempt/event binding |
| L08 | Missing/foreign/tampered checkpoint отказывает без fresh-start fallback; unknown model/effort/version/limits/context budget и изменённый executable/config/registry отказывают до child |
| L09 | Usage без данных остаётся unknown; cumulative resume cost не double-counted; known secret markers отсутствуют в public events/logs/export; source checkout files и refs сохранны |
| L10 | Tests, build, typecheck и fresh plugin smoke проходят отдельно; manual CLI/MCP/legacy worker regressions не изменены; fresh independent review: ship |

Для критерия **404** нужны L02 для обоих runtime и настоящие stop receipts L03/L07. Для **405** — L04–L06/L08, включая native resumed calls. Закрывать критерий по собранному argv, названию флага или одной зелёной попытке запрещено. При невозможности provider login, сохранённой session, model budget proof или native matrix соответствующий критерий остаётся unchecked с точной причиной. Числа/version/hash и traps идут в task comment. Реализация сдаётся в review; done — только по слову владельца.

## 10. References: два прохода и применимость

Recall до внешних references: #143/#145/#148/#149 и прежние #38/#48/#95. #38 даёт Windows shell hypothesis, вне согласованной macOS границы; прямой spawn без login shell убирает её из нового launch. #48 подтверждает необходимость читать terminal/usage, но consumption/budget UI остаётся #168. #95 описывает новую попытку с исправленной инструкцией, а не тихое повторение прежнего run или reset ветки; feedback/question workflow остаётся #155.

2026-09-30 выполнен настоящий `git fetch origin --prune`, checkout не переключались. Symphony `be10a1b` → `be10a1b`, 0 commits; Control Center `9e567c86` → `51666898`, 13 commits; Buzz `b0d6fb8a` → `2664d143`, 28 commits со времени анализа. Первый pass прочитал analysis и цитируемые источники через updated upstream. Второй — те же источники после согласования обоих CLI/macOS, с вопросами session identity, resumed native enforcement и stop proof.

| Источник | Verdict для #150 |
| --- | --- |
| `references/symphony/elixir/lib/symphony_elixir/orchestrator.ex:259–325` @ `be10a1b` | Разделить worker outcome и reconciliation; полноценный dispatch/retry оставить #152. Не брать внешний tracker как обязательный сервис |
| `references/control-center/packages/cc_domain/lib/features/pipelines/domain/services/pipeline_engine.dart:523–602` @ `51666898` | Новая attempt после interrupted execution, сохранение history. Не брать resume against live template вместо pinned revision; pipeline resume не доказывает provider conversation resume |
| `references/control-center/docs/src/content/docs/manual/concepts/agent-model.mdx:33–87` @ `51666898` | Различать adapter enforcement и навыки/index. Не брать Claude bypass-permissions и чужую capability matrix как доказательство свойств нашего CLI |
| `/Users/magiyar/Projects/My/References/buzz/crates/buzz-acp/src/config.rs:443–481` @ `2664d143` | Session metadata/model configuration отделены от prompt. Не брать silent ignore effort и bypass-permissions default |
| [Claude headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [sandboxing](https://code.claude.com/docs/en/sandboxing) + installed CLI help | Stream terminal/session metadata, exact resume, interrupted SIGTERM turn и native isolation — входы к нашим probes; документация не заменяет измерение |
| Installed `codex exec --help` и `codex exec resume --help`, существующие `codex_permissions.ts`/native evidence | Exact resume есть, argv отличается; persistent profile требует нового proof, ephemeral start недостаточен |

Второй pass изменил вывод о Claude: отсутствие resume у конкретного reference adapter не означает отсутствие resume у установленного Claude. Подтвердил CLI путь для macOS и необходимость независимой native матрицы обоих runtime. Patterns адаптируются самостоятельно; код reference repositories не копируется.
