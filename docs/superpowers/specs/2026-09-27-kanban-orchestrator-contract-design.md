# Kanban + Orchestrator: контракт продукта и миграции

Дата: 2026-09-27. Задача KDD: 143, track 6. Статус: **подтверждено пользователем**.

Основание: [консолидированный анализ](../../../.planning/research/orchestration/ANALYSIS.md). Этот документ определяет контракты для последующих работ; он не утверждает, что новая схема, полномочия или scheduler уже реализованы. Реализация начинается только после review этой спецификации. Создание backlog не разрешает автоматически выполнять все его карточки.

## 1. Цель и согласованные границы

KDD сохраняет ручную работу человека с Claude/Codex и добавляет автономное исполнение на той же доске, в той же локальной базе проекта. Пользователь задаёт цель, требования, доступность автономии и полномочия; controller механически применяет их. Модель не может расширить своё поручение, создать себе разрешение или принять собственный результат от имени пользователя.

Уточнение в этой сессии: после BA и включённой стадии Architect реализация запускается автоматически в рамках исходного поручения. Обязательного утверждения каждого плана человеком нет. Недостающие требования, противоречия и выход за поручение приостанавливают затронутую работу до ответа. Финальная приёмка автономного результата всегда принадлежит пользователю.

Возможные подходы: сохранить отдельный автономный продукт означало бы дублирование карточек; распространить новый workflow на всю ручную работу означало бы обязательные BA/approval там, где они не нужны. Выбран общий store с явным способом исполнения и отдельным контрактом managed-результатов.

В этой задаче создаётся только спецификация. DDL, transport API, runtime adapters и UI реализуются соответствующими карточками track 6. Не добавляются облачный backend, обязательный GitHub/PR, network DB, vector/graph memory, визуальный редактор произвольных workflow, постоянный repo watcher или автоматический push.

## 2. Ручная и автономная работа

| Действие | manual | orchestrated |
| --- | --- | --- |
| Создание | Форма с title или prompt с редактируемым черновиком | Те же способы; создание само по себе не запускает исполнителей |
| Основной исполнитель | Человек и его интерактивная Claude/Codex-сессия | Роли под управлением локального controller |
| Подготовка | BA по отдельному запросу | BA обязателен; Architect обязателен, если включён workflow проекта |
| Реализация | По явному поручению в текущем ручном сценарии | После подготовки и проверки плана controller, без обязательного human plan gate |
| Проверки | Можно отдельно заказать code/UI review | Все обязательные проверки workflow и независимый code review |
| Финальная приёмка | Существующая политика legacy Kanban, если нет managed-результата | Подтверждение пользователя для конкретной итоговой версии |
| Передача управления | Явное действие пользователя | Stop/checkpoint, подтверждение остановки writer, сохранение workspace, затем передача |

`execution_mode = manual | orchestrated` принадлежит задаче или подзадаче, а не actor и не способу intake. Подзадача получает явное значение при создании: выбор родителя используется как default, последующая смена родителя не меняет его молча. У существующих задач после миграции значение manual. У нового проекта автономия выключена, default manual; пользователь может изменить default для новых задач. Default не означает разрешение стартовать конкретную работу.

Start сохраняет поручение с task/scope, workflow revision, разрешёнными repos/tools и лимитами. Проектная доступность автономии, режим задачи и это поручение нужны одновременно. Карточки backlog не выбираются только потому, что автономия включена. Research может пройти подготовку, но не превращается автоматически в coding work item.

Ручная подготовка/review не включает весь autonomous workflow. Один заказанный reviewer не выдаёт разрешение на реализацию или финальную приёмку. Review относится к фиксированному snapshot; dirty-код предварительно снимается в явно выбранный snapshot, без автоматического commit/stash исходного checkout.

Для новой orchestration revision действует `acceptance_policy = human`. Чисто ручной legacy-контракт сохраняет `acceptance_policy = legacy`. Возврат managed-работы в manual не снимает human-policy с её результата. Если managed coding subtask входит в результат ручного родителя, итоговая интегрированная revision родителя тоже требует human-policy. Так смена режима или другой actor не обходят приёмку. Отдельный review ручной задачи сам по себе не меняет её policy.

Ручная takeover не стирает план, попытки, вопросы или ветку. Обратная передача проверяет актуальные требования, код и workflow и создаёт новую попытку с новым fence. Пока прежний writer не подтверждён остановленным, второй не запускается. Отключение автономии прекращает dispatch и инициирует остановку активных managed-runs; ожидания и результаты сохраняются.

## 3. Local-first и идентичность

Один project store — одна SQLite WAL для задач, operational knowledge и координации. UI, CLI и MCP читают общую проекцию core; ни клиент, ни LLM не реализуют свою альтернативную машину состояний. Controller работает без открытой UI. Local-first означает локальные состояние и управление, а не гарантированно offline LLM: выбранный удалённый runtime получает переданный контекст.

Project имеет стабильный локальный `project_id`, не вычисляемый заново из текущего пути. Старый каталог `~/.kdd/<git-common-dir-hash>/` и его DB остаются на месте; при миграции в нём сохраняется project_id и регистрируется прежняя привязка. Локальный registry связывает канонический git-common-dir каждого разрешённого checkout/managed clone с этим store. Поиск из cwd учитывает привязку до legacy path hash; `KDD_DB` остаётся явным override. Неизвестный независимый clone не наследует доску только по совпадению remote URL. Коллизия привязок требует решения пользователя; перенос пути — явная rebind, без копирования доски.

Repository binding хранит `repo_id`, purpose, source path/common-dir, managed path, optional remote, выбранные branch/base/target и доступ `context_only | implementation`. Heads записываются по repo_id. Дополнительный context-only backend не становится writable из-за чтения его документации. Несколько implementation repo используют один project store, но отдельные workspaces, integration heads и merge receipts.

Служебные prompts, role/workflow revisions, knowledge, logs, screenshots, credentials и workspace metadata находятся под локальным KDD_HOME вне целевых checkout. Они не создают `.kdd/`, `AGENTS.md` или другие служебные файлы в исходниках. Существующие инструкции проекта читаются. Продуктовые документы и код могут быть результатом задачи; явный export знаний в git — отдельное пользовательское действие.

Управляемый clone независим от исходного repo: собственные объекты, без зависимости от alternates/shared object storage. Его worktrees и агентские refs принадлежат ему. Исходный checkout не используется для фонового checkout/rebase/reset/stash/commit. Base выбирается явно, включая локальные commits; dirty/untracked исходные файлы импортируются только по выбранному snapshot. До явного local merge/import исходные refs не меняются.

## 4. Логическая модель и версии

Это обязательные различия данных, не требование сервиса или таблицы на каждое название. Физическая схема и индексы — задача 144; она должна обеспечить следующие связи и ограничения.

| Запись | Минимальные данные и смысл |
| --- | --- |
| Project | project_id, store location, repo bindings, availability/default, актуальные configuration revisions |
| Task/subtask | Существующий task id, parent_id, execution_mode, title/body/kind, business status, актуальная requirements revision; parent принадлежит тому же project, иерархия без циклов |
| Requirements revision | Неизменяемые цель/критерии, source user instruction/answer, predecessor, автор и время; комментарий не заменяет контракт |
| Workflow revision | Entry BA, включённый Architect, допустимые роли/stages, обязательные checks, лимиты и acceptance policy |
| Plan revision | Task + requirements/workflow revisions, work items/edges, обязательные outputs; BA предлагает, controller валидирует и активирует |
| Work item | Plan/task, kind `analysis \| architecture \| implementation \| check \| integration \| human_action \| curation`, owner role, repo/scope, зависимости и ожидаемый output |
| Dependency | Вид требуемого результата, producer/consumer work item и repo_id, нужная result revision/artifact и проверки; ребро относится к потребляющей стадии |
| Role profile revision | Prompt, runtime/model selection, skills Always/Available с версиями, tool grants и scope; профиль не является живым процессом |
| Session | project/task/subtask scope, recipient, provider session id и доступный checkpoint; conversation отделён от knowledge |
| Run/attempt | Work item, attempt number, predecessor, input snapshot, session/workspace links, runtime/model, lifecycle, lease/fence, timestamps, outcome/usage |
| Input snapshot | requirements/workflow/plan/role revisions, knowledge/skill hashes, tools/capabilities, dependency result ids/artifact hashes, readiness evidence, repo base heads и target heads |
| Workspace | repo, path, branch/detached head, фиксированный base, target, current/result head, writer ownership и lifecycle |
| Question/answer | question_id/correlation id, scope, sender/recipient, blocking work item, source revision, статус и ответ с авторством |
| Result/check/artifact | Producer attempt, входные revisions, проверяемые heads, verdict, команда/exit code или findings, content hash/path и environment |
| Approval/merge receipt | Пользовательское подтверждение result revision, repo heads/base/target; отдельно outcome фактического local merge/import |
| Memory revision | Scope project/task/subtask, тип fact/decision/rule/candidate, source refs/commit, author, predecessor/supersedes и статус |

Ссылки, не копии разговоров, задают наследование project → task → subtask. У роли новый контекст на независимую работу; reviewer не продолжает разговор исполнителя. Provider session id не является credential или правом писать в DB.

Неизменяемые revisions остаются в истории. Текущие указатели, очередь и projections изменяемы в транзакции вместе с событием. Изменение цели, критериев, обязательных checks или нужного кода создаёт новую revision и делает затронутые результаты/approvals stale. Обычный комментарий и перестановка карточки не инвалидируют кодовые проверки. Если нельзя доказать независимость результата от изменённого входа, его нужно перепроверить.

Новые runs используют новые config revisions. Активный run не переходит на live workflow молча: steering явно записывает доставленные изменения; существенное изменение останавливает попытку и запускает replanning. Обязательные правила нельзя незаметно выкинуть из context из-за лимита; run должен сообщить невозможность собрать корректный контекст.

## 5. Состояния и ownership

### 5.1 Карточка

Колонки сохраняются: `backlog → new → in_progress → review → done`. Возвраты: new → backlog, in_progress → new, review → in_progress, done → review. Это business lifecycle; ожидания, retries, cancellation и отключение controller не добавляют колонок.

| Состояние | Значение для managed revision |
| --- | --- |
| backlog | Не запущена; не источник автоматического dispatch |
| new | Готова к поручению/подготовке; ещё не означает право на coding |
| in_progress | Подготовка/исполнение/доработка текущей revision; durable wait может оставаться здесь |
| review | Интегрированный результат и все обязательные evidence актуальны; ждёт человека |
| done | Пользователь принял эту result revision; merge status виден отдельно |

В managed-контуре прямой drag/move не подменяет Start, Cancel, takeover или Accept. UI может вызвать соответствующее действие, а core проверяет его контракт. `blocked/block_reason` legacy остаются; новые причины ожидания вычисляются по явным вопросам/зависимостям. Archive скрывает карточку, но не убивает процесс и не разрешает cleanup; активную managed-работу сначала явно останавливают.

### 5.2 Work item и попытка

Work item: `pending | ready | running | waiting_input | retry_wait | completed | failed | cancelled`.

- pending → ready только после проверки всех нужных dependency outputs и stage guards; ожидание зависимости остаётся pending с явной причиной.
- ready → running атомарно резервирует writer и создаёт attempt. Другой controller/process получает отказ.
- running → waiting_input сохраняет вопрос и checkpoint; слот освобождается только после подтверждённой остановки процесса.
- Ответ → pending/ready с новым attempt, если входы всё ещё применимы. Ответ на старую revision не запускает текущую автоматически.
- Runtime failure → retry_wait при допустимом retry; по времени и повторной проверке входов → ready. Исчерпание лимита → failed и Inbox.
- Валидный output → completed. Exit 0 без нужного output не является completed. Human action ждёт пользовательскую запись, а не имитирует LLM.
- Явная отмена → cancelled после stop; отмена и failure не публикуют успешного результата. Повторная работа после terminal-state — новый work item/plan revision, не цикл в прежнем DAG.

Attempt: `created | running | waiting | completed | failed | cancelled`. Created включает подготовку и запуск. Waiting — завершённая приостановкой попытка с checkpoint/question, без занимаемого compute-слота; продолжение создаёт новый attempt, даже при provider resume того же session id. Retry расписан на work item, прежний failed attempt не переписывается. Waiting не считается успешным output.

Stop intent хранится отдельно до фактической остановки. Пока процесс или его дочерние writers живы/непроверены, writer reservation сохраняется независимо от UI-state, lease expiry и намерения cancel. После crash сначала reconciliation процессов, workspace и side-effect receipts, потом dispatch. Stale lease/result никогда не становится актуальным результатом по одному exit code.

Workspace: `provisioning | available | retained | removing | removed`. Единственный writer принадлежит work item/attempt с generation fence; available не означает незанятость. Pause/review/done удерживают workspace retained. Removing допускается только после доказанной остановки процессов, проверки dirty/untracked, сохранности commits и обязательных artifacts. Ошибка удаления оставляет retained с диагностикой; force cleanup по business-status запрещён.

SQLite хранит lease owner/generation/expiry; heartbeat и result submission сверяют generation. CAS и ограничения уникальности обеспечивают одного writer на work item/workspace и одну Git mutation на integration target. Смерть процесса не является транзакцией SQLite: неизвестный исход сначала проверяют, не повторяют слепо.

Start требует конечных валидных project/runtime/role concurrency, retry count, review rounds, timeout/idle и budget limits. Human/dependency wait не расходует compute-slot и не считается runtime timeout. Исчерпание лимита прекращает автоматические попытки и создаёт адресное human action. Неизвестные cost/usage сохраняются как unknown, не как ноль; если выбранный денежный лимит невозможно контролировать, это ограничение показывается до start. Runtime failure, dependency wait, human wait, cancelled, stale result и exhausted limit имеют разные коды исхода.

## 6. Workflow, зависимости и вопросы

Базовый autonomous flow: исходный запрос → BA → Architect при включении → work items исполнителей → проверки каждого результата → integration → проверки интегрированного head → human review → приёмка → выбранный local merge/import. Curation после приёмки не блокирует merge.

BA не создаёт отсутствующие роли, не отключает checks и не расширяет tool grants. Controller активирует план только если роли разрешены, входы и scope определены, зависимости без self-links/циклов, обязательные стадии присутствуют и соблюдены лимиты. Не нужен отдельный approval каждого плана, но отсутствие такого gate не является разрешением расширять цель. Изменение поручения/новая обязательная политика принадлежит пользователю.

Dependency требует конкретный результат из закрытого набора:

| Вид | Что удовлетворяет ребро |
| --- | --- |
| contract | Опубликованный BA/Architect output либо API-контракт/схемы с producer repo/head, result revision и artifact hash после обязательных проверок; новое пользовательское ограничение требует его ответа |
| code | Только для одного repo: проверенный result head нужной revision и его реальное включение в base зависимого workspace того же repo_id |
| merged | Успешный local merge/import receipt в указанный repo/target, соответствующий принятому result |
| readiness | Подтверждённая пользователем готовность ресурса/env/CI плюс актуальный pass требуемой планом проверки доступности/совместимости из окружения потребителя |

Результат человеческой подготовки env/CI — readiness record: human_action/work item и source пользовательского подтверждения, resource/environment id, применимые repo/requirements/config revisions, endpoint или CI workflow reference, ожидаемые возможности/версия, check/evidence ids и observed_at; valid_until записывается, если план задаёт срок. Credentials передаются через runtime settings, не через этот record или artifacts. После подтверждения выполняется разрешённая планом проверка (например, доступ к endpoint и нужному API/schema version либо к CI workflow с нужными правами). Human action становится completed только с подтверждением и pass; зависимое ребро затем позволяет pending → ready. Отказ/unknown или один текст «готово» оставляют потребителя pending, а невыполненное действие — waiting_input с диагностикой. Общие вопросы и иные human actions не обязаны создавать readiness: они публикуют соответствующий контракт/ответ/approval.

Перед фактическим запуском потребителя controller повторно проверяет readiness из его runtime/access scope; старое подтверждение не гарантирует доступность сейчас. Смена ресурса/версии/прав, истечение срока или failed/inconclusive probe делают результат stale и сохраняют ожидание зависимости. Повторный probe может опубликовать новую проверку прежнего подтверждения, если его scope не менялся; изменённая человеческая подготовка требует нового подтверждения. Новый result связан с прежним, историю не перезаписывают. Разблокирование проверяется снова атомарно при dispatch, без постоянного watcher.

Для разных repo `code`-ребро недопустимо: backend head не включается в frontend base. Потребляющая стадия получает через `contract` закреплённые API/схемы/artifacts с source repo/head и hash, включённые в её input snapshot; проверка совместимости относится к этим версиям. Если требуется живой backend, отдельное `readiness`-ребро закрепляет окружение и нужную API/schema version. Разработка frontend может ждать только контракта, а его integration checks — дополнительно backend readiness. Например: backend B@b1 публикует OpenAPI h1; frontend F@f1 использует h1, сохраняя собственный Git base; затем проверки F требуют доступного E1, совместимого с h1. Изменение h1 или несовместимый E1 инвалидируют затронутые inputs/checks; сообщение «backend done» ничего не разблокирует. Source code другого repo можно читать при наличии context grant, но это не merge и не право писать в него.

Связи могут пересекать manual/orchestrated задачи одного project. Подготовка B может идти до готовности кода A; блокируется только нуждающийся в нём work item. Для legacy зависимости controller требует явную публикацию result с provenance; один status done не доказывает нужный code/merge. Старые `task_links` сохраняются как история/навигация; из них не создаётся исполнимый DAG без проверки.

Fan-in кодовых результатов одного repo выполняется последовательной интеграцией pinned heads в его отдельном workspace. Для каждого implementation repo сохраняются собственные integration head/base/target; Git histories разных repo не объединяются. Зависимому исполнителю передаётся base с нужным same-repo кодом и закреплённые contract/readiness results остальных зависимостей, а не только comments о них. Разные siblings работают параллельно в разных workspaces. Review читает фиксированный head. Rework адресуется владельцу результата, создаёт новую попытку/план, инвалидирует затронутых dependents и повторяет обязательные checks. Review crash/неполный verdict не дают pass.

Вопрос любой роли адресуется BA, Architect или пользователю и сохраняется атомарно с waiting state. `question_id`, correlation id и source revision обязательны; сообщения не пробуждают всех ролей. BA/Architect отвечают в рамках утверждённых решений; новый scope или противоречие отправляют пользователю. Pending question, failed runtime, dependency wait и cancellation различимы. Ответ идемпотентен; конфликтующий повтор не заменяет первый ответ тихо. «Стоп» — control command, не обычное сообщение очереди.

## 7. Полномочия, проверки и финальная приёмка

Авторство `Actor` старого Kanban и полномочия нового run различаются. Controller выдаёт run-scoped credential/capability с project/work item, сроком, generation, разрешёнными tools/repos и путями. Worker может представить output или question; он не устанавливает собственные права, user approval или system check outcome. User-origin подтверждается пользовательским каналом controller, а не `actor.type`, KDD_ACTOR или строкой reason от агента. Credential не попадает в prompt, logs или memory.

Для managed revision все транспортные пути, включая move/place/criteria из старых CLI/MCP, проходят общий guard core. `reason` остаётся объяснением, но не обходом lease, обязательных checks или human-policy. Другой AI, новый session id, смена транспорта/режима и установка KDD_ACTOR=user не дают финальную приёмку. Интерактивное поручение «прими» может быть передано агентом только с controller-issued записью пользовательского подтверждения, а не его собственным пересказом.

Локальный владелец компьютера может вручную изменить SQLite; это не граница защиты от него. Гарантии относятся к поддерживаемым путям и реально ограниченным runtime. Read-only MCP не ограничивает native shell. Before start controller проверяет техническую возможность требуемых grants/isolation. Если обязательная гарантия недоступна, такой run не стартует; пользователь может явно пересмотреть policy, ограничение нельзя скрыть. Конкретный механизм credentials/runtime enforcement — задача 145.

Check хранит command/cwd/environment, входные revisions/head, timestamps, exit code, artifact refs и verdict `pass | fail | inconclusive`. LLM-review хранит findings с severity/location/reproduction/evidence, независимую session и тот же version binding. Build/test/typecheck — отдельные обязательства, команда в manifest не означает выполненную проверку. UI Review запускает приложение проверяемого snapshot и сохраняет viewport/SHA/screenshots/console/network evidence; mobile использует simulator/device. Checkboxes старых criteria — не замена этих записей.

Controller переводит managed task в review только при актуальном интегрированном результате и всех обязательных pass. Пользователь может попросить rework или изменить workflow, но пропущенная проверка остаётся видимой: изменение обязательств создаёт новую workflow revision, не фальшивый pass.

Approval относится к точному набору: `task_id + requirements_revision + plan/workflow revisions + result_revision + per-repo integrated_head/base/target_head + checks`. Verdict пользователя `accepted | changes_requested | rejected` сохраняется с source command/answer и временем. Для accepted сохраняется неизменяемый receipt; он переводит карточку в done. Повтор того же command/result не создаёт второй approval или curation. Новые код/требования делают прежнее подтверждение историческим, но непригодным для нового результата; карточка возвращается в review либо in_progress по наличию актуальных checks.

Acceptance и merge — разные операции. Пользователь может принять без переноса в свой target; `done` тогда означает принятую версию, а доставка видна как pending/not_requested. Явное «принять и слить локально» может включить обе операции, с отдельными receipts. Agent никогда не делает push.

Перед local merge/import заново проверяются approved heads, target SHA, чистота и выбранный destination. Изменённый target требует обновлённой интеграции, checks и нового approval: прежний receipt нельзя применить к другой версии. Конфликт или dirty destination сохраняют результат и показывают ожидание/ошибку; нет автоматического stash/reset. При сбое после Git side effect controller сверяет фактические refs с receipt intent до повторения. Per-repo outcome `not_requested | pending | succeeded | failed | stale` виден отдельно; частичный multi-repo merge не выдаётся за атомарный успех.

## 8. Знания, роли и контекст

Legacy `.planning/decisions/*.md` сохраняет append-only контракт, синхронизацию своего индекса и CLI/MCP. Его branch-dependent индекс не используется как единственная operational память managed-runs. Импорт выбранных документов создаёт локальные memory revisions с path/commit/hash/provenance; отсутствие файла в другой ветке не удаляет эти знания. Экспорт в git только по запросу, без тихого supersede существующих decision files.

Fact хранит evidence и repo version; decision/rule хранит полномочие пользователя; candidate остаётся предложением. Код принятой ветки не объявляется фактом target до merge receipt. Противоречащие project/task/subtask rules требуют решения, а не скрытого приоритета самого узкого scope. Пользовательская правка памяти создаёт revision; гипотеза агента не заменяет её. Secrets остаются локальными runtime credentials и не индексируются в FTS.

Always skills фактически загружаются с нужными references/scripts/assets для каждого run, Available дают индекс и чтение по запросу. Использованные версии/hashes и capabilities входят в input snapshot. Роль хранит сохраняемый профиль; model id выбирается из установленного runtime, без зашитого списка. Claude/Codex должны нормализовать start/resume/stop/events/results; stream/schema error — failure или inconclusive, никогда success.

Project assistant использует BA profile с видимым project/task/subtask scope. Вопросы/чтение не требуют новой карточки; изменение кода привязано к задаче и поручению. Analyser публикует evidence-backed карту проекта, не выдумывает выполненные команды. Curator после accepted revision сохраняет итог и проверенные facts; inferred preferences остаются candidates. Дедуп curation: task + accepted result revision + per-repo heads. Сбой curator не отменяет приёмку и merge.

## 9. Миграция и совместимость

Миграция данных и переключение автономии — разные фазы. Только append новых MIGRATIONS; существующие SQL и исторические события не переписываются. UI layout/маршруты реализуются позже и не являются условием существования общего store.

1. **Снимок и backup.** Для затрагиваемого store фиксируются schema version, task/criteria/event/file/track ids и counts, legacy configuration, claims/runs и workspace inventory. Согласованный SQLite backup включает WAL; отдельно учитываются files/knowledge/workspaces и commits. Ошибка backup прекращает изменение. Нельзя считать копию одного kdd.db backup всего проекта.
2. **Добавление контрактов.** В транзакционных migrations добавить project identity/bindings и новую модель, сохранив каталог DB. Всем старым задачам manual/legacy; statuses, checked_at/evidence, комментарии, ссылки, attachments, provenance и history сохранены. Ни одна старая done/review не получает выдуманный human approval. Новые managed tables пусты, availability disabled до явного включения. Повтор migration/open не дублирует ids или imports.
3. **Совместимый ручной доступ.** Актуальные CLI/MCP/UI сохраняют обычные операции/форматы ручного Kanban; optional новые поля и адресуемая task surface не требуют обязательного BA. В managed-записи legacy-команда возвращает явный guard error/нужное действие, а не молча обходит controller. Более старая версия отказывается работать с неизвестной schema. Перед upgrade долгоживущие старые writers останавливаются: уже открытый connection нельзя обезопасить одним user_version.
4. **Operational knowledge.** Legacy Markdown не перемещается и не переписывается. Выбранный импорт регистрируется идемпотентно по source/commit/hash с явным scope; derived facts не заменяют user decisions. Новые runs читают независимую локальную память, legacy recall продолжает обслуживать старый сценарий.
5. **Cutover автономии (задача 170).** Только после готовности нового исполнения: остановить dispatch tick/autotick/OS scheduler, подтвердить завершение/остановку worker process groups, сохранить legacy runs/leases/workspaces и previous settings в audit. Неизвестный живой writer блокирует cutover. Старые workers не преобразуются в якобы восстановленные новые attempts; resumable работу пользователь передаёт явно с pinned input/result. Legacy refs/workspaces инвентаризируются и сохраняются; автоматическое force-delete запрещено.
6. **Включение.** Старый и новый dispatcher не работают параллельно в project. Новый controller проверяет compatibility/ownership, fixtures upgrade и recovery; затем пользователь включает автономию и отдельно стартует выбранные задачи. Legacy autotick flag не становится разрешением нового dispatch. До cutover новые orchestration tasks не исполняются старым driver. Последующее добавление новых задач в backlog также не разрешает запуск.
7. **Восстановление.** Все writers остановлены; restore делается явно из полного выбранного backup с согласованным inventory файлов/knowledge/refs. Старую программу не запускают на новой DB, migrations не «откатывают» удалением SQL. Restore может потерять изменения после backup — показать пользователю inventory/diff до замены. Нет автоматического rollback, стирающего результаты более новых runs.

Прежние #12/#33 остаются историческими идеями, не implementation contract: action-chain без scheduler не обеспечивает validated DAG; явный id не обходит managed guards. #136 сохраняет continuity как ручной сценарий, но прежнее исключение orchestration из продукта намеренно расширено. Решение 2026-08-03 о self-accept не переписывается: legacy-policy продолжает его соблюдать; отдельная human-policy регулирует managed-результаты. Следующие specs/API/docs должны явно различать эти политики.

## 10. Инварианты и приёмочная проверка последующих работ

Это программа наблюдений будущей реализации, не отчёт о уже выполненных тестах.

| ID | Наблюдение, которое должно подтвердить контракт |
| --- | --- |
| C01 | Source checkout, linked worktree и привязанный managed clone разрешают одну DB; перенос/rebind сохраняет task ids; независимый clone без привязки не присваивает чужой store |
| C02 | Два concurrent dispatch одного work item дают ровно одного writer; stale heartbeat/result с прежним fence отклонены |
| C03 | Переход backlog/manual → другая колонка и включение project autonomy сами по себе не запускают coding; отдельный Start даёт BA/Architect → implementation без дополнительного plan approval |
| C04 | Новое ограничение отправляет durable question; restart оставляет вопрос/workspace, 0 running slots после stop; ответ создаёт ровно один актуальный attempt |
| C05 | Contract подготовлен до code dependency; same-repo coding ждёт base с нужным head; cancelled/failed/done без нужного output не удовлетворяют ребро |
| C06 | Изменённые requirements/code/workflow делают затронутые checks stale; provider resume не продолжает молча на другой revision |
| C07 | Каждый implementation result и интегрированный head проходят обязательные checks; reviewer crash, malformed stream и exit 0 без output не дают pass |
| C08 | AI reason, другой actor, KDD_ACTOR=user и takeover в manual не принимают managed result; пользовательский канал принимает только проверенную version tuple |
| C09 | Acceptance без merge даёт accepted/done + отдельное состояние доставки; changed target требует recheck/reapproval; повтор команды не удваивает merge/curation |
| C10 | Crash после Git side effect определяется по refs/intent; конфликт, dirty/untracked и живой writer не уничтожаются cleanup; не делают stash/reset исходного checkout |
| C11 | До явного local import/merge нет новых служебных файлов и refs в исходном repo; после него изменён только выбранный target; 0 push |
| C12 | Manual-only flow без BA и managed child под manual parent работают на одной доске; handoff останавливает прежнего writer до нового |
| C13 | Legacy upgrade сохраняет ids/counts/evidence/files/provenance/decisions, 0 синтетических approvals, 0 auto-start; повтор migration не дублирует записи |
| C14 | После cutover 0 legacy dispatch/worker writers; незавершённая legacy работа сохранена; старый binary и уже открытые writers не меняют managed DB |
| C15 | Branch B legacy recall не удаляет local imported knowledge A; user rules не заменены candidates; curator failure не меняет accepted/merge outcome |
| C16 | Multi-repo показывает каждый head/approval/receipt, частичный merge явно виден; mobile review имеет simulator/device evidence |
| C17 | Env/CI human_action: подтверждение без probe и failed/inconclusive probe не разблокируют; подтверждение + pass из scope потребителя разблокируют ровно нужную стадию; restart/повтор ответа не дублируют результат; перед dispatch недоступный/устаревший env вновь блокирует |
| C18 | Backend B@b1 передаёт frontend F@f1 API/schema h1 через contract, с 0 merge/cherry-pick backend commits в F; F coding стартует с h1, integration check ждёт совместимый E1; новый h2/несовместимый E1 делает зависимые inputs/checks stale; cross-repo code edge отклонён |

Реализация проверяется изолированными Git/SQLite fixtures, реальными запросами CLI/MCP/controller и metadata attempts, затем UI/browser/device наблюдениями на нужных heads. Test и typecheck — отдельные gates. Конкуренция/повторная доставка/crash проверяются сериями, а не единственным успешным проходом. В close-comment указываются counts, exit codes, SHA, artifact paths и ограничения фактически проверенной среды.

Для задачи 143 достаточно письменного контракта, проверки ссылок/непротиворечивости и пользовательского review. C01–C18 не отмечаются выполненными до реализации. Порядок последующих задач и их зависимости остаются в анализе; approval этой спецификации не является командой выполнить весь backlog.

## 11. Grounding и повторный проход

Recall и чтение #136/#12/#33 и действующих append-only/self-accept decisions выполнены до чтения референсов. Текущее KDD подтверждает common-dir identity, lack of dependency gating, branch-dependent legacy index и reason bypass; это ограничения текущей версии, не свойства предлагаемого controller.

Actual fetch выполнен 2026-09-27, checkout не переключались. Commits за время после анализа: Symphony 0, Control Center 2, Vibe Kanban 0, Agent Kanban 0, LangGraph 0. Источники прочитаны на pinned обновлённом upstream; отставание local checkout соответственно 0/2/10/78/54. История исследований сохранена в [первом анализе](../../orchestration-reference-analysis.md).

| Референс и pinned commit | Прочитанный источник | Вердикт обоих проходов |
| --- | --- | --- |
| Symphony `be10a1b79df7` | `SPEC.md:635-768`; `elixir/lib/symphony_elixir/orchestrator.ex:256-315` | Механический dispatch/reconcile и отдельное scheduling state подходят автоматическому старту. Tracker-driven recovery без durable DB и cleanup по terminal status не подходят |
| Control Center `610c4931bc9e` | `pipeline_engine.dart:523-645`; `node_type_library.dart:323-337` в `packages/cc_domain/lib/features/pipelines/domain/services/` | Durable waits и отдельный approval подходят. Во втором проходе исключены resume по live graph и human/lead как взаимозаменяемая финальная authority |
| Vibe Kanban `d5cbb5380fa0` | `crates/db/src/models/workspace.rs:42-54`, `session.rs:23-31`, `execution_process.rs:43-78,112-120` | Workspace/session/process — разные сроки жизни и связи. Не переносим весь cockpit или policy приёмки |
| Agent Kanban `7fea6dc111ea` | `server/adapters/d1/taskDeps.ts:5-45` | Cycle check применим; cancelled как satisfied dependency непригоден. Требуется результат, не один task status |
| LangGraph `7daa3ab49d67` | `libs/langgraph/langgraph/types.py:887-909` | Durable interrupt/checkpoint подходит; re-execution при resume требует idempotency и version checks. Python framework не требуется |

Паттерны адаптируются самостоятельно под TypeScript/SQLite и ограничения KDD. Источники не копируются. Детальные citations записаны также в карточке задачи.

Review fixes: повторно прочитаны analysis §7/§10 (human env/CI и связанные repo), `WorkspaceRepo.repo_id/target_branch` в Vibe Kanban `d5cbb5380fa0:crates/db/src/models/workspace_repo.rs:11-34` и human gate Control Center `d0684d2a908c:packages/cc_domain/lib/features/pipelines/domain/services/node_type_library.dart:323-337`. После actual fetch Control Center продвинулся ещё на 1 commit относительно первого прохода; прочитанные gate/engine paths не изменились, Vibe Kanban upstream прежний. Узкий второй проход подтвердил отдельные per-repo targets и явный ответ; readiness probe и версионированные межрепозиторные artifacts определены требованиями KDD, а не заявлены готовой функцией референсов.

## 12. Review этой спецификации

На пользовательский review вынесены прежде всего: автоматический старт в пределах поручения; legacy/manual рядом с human-policy managed-результатов; done как приёмка с отдельным merge receipt; закреплённые revisions вместо resume по live graph; migration по умолчанию в manual без запуска старых задач.

Пользовательский review выявил два пробела: результат human env/CI work и межрепозиторная передача результатов. Исправления readiness и contract dependencies, per-repo fan-in и сценарии C17/C18 внесены в `cb483de`. Пользователь подтвердил обновлённую спецификацию 2026-09-27: «Ок. можно продолжать». Это основание проверить критерий пользовательского review и принять результат задачи 143. Подтверждение контракта не утверждает готовность будущего runtime; реализация задач 144–172 требует их отдельного выбора.
