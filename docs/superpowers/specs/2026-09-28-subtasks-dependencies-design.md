# Подзадачи, зависимости и способ исполнения

Дата: 2026-09-28. KDD #146, track 6. Статус: **утверждена владельцем**. Пользователь утвердил спецификацию `66e2597`, затем план `349100a` и поручил реализацию solo на текущей ветке.

Основания: утверждённый [контракт #143](2026-09-27-kanban-orchestrator-contract-design.md), завершённые [store #144](2026-09-27-project-store-foundation-design.md) и [authority #145](2026-09-27-controller-authority-design.md), [анализ](../../../.planning/research/orchestration/ANALYSIS.md). Route solo. Работа продолжается на `task/143-kanban-orchestrator-contract` после `cb7e7a8`; разрешение primary в текущей конфигурации сохраняется.

## 1. Согласованный результат и границы

Пользователь подтвердил один уровень: основная задача → несколько подзадач. BA должен иметь возможность предложить подзадачи разным исполнителям; последовательность и параллельность задаются зависимостями. `parent_id` означает принадлежность, зависимость означает требование к результату, происхождение от run хранится отдельно. Допустима зависимость от другой основной задачи того же project store. Вложенные подзадачи не нужны.

#146 реализует core-модель подзадач, `manual | orchestrated`, work items, типизированных зависимостей, их результатов и атомарного владения. Проверка готовности и получение резервации — библиотечные операции trusted host. Они не выбирают агента, не запускают runtime и не превращают backlog в очередь.

Назначение агентов и role profiles остаются #149; context/input snapshots — #148; runtime start/resume/stop — #150; workspace lifecycle — #151; dispatch, heartbeat, retry и recovery — #152; workflow и активация планов BA — #153; durable questions — #155; Git-интеграция — #156; проверки и независимый review — #157; human acceptance/merge — #158; owner API/CLI/MCP — #159; UI — #161. Новая память остаётся #147. Проверка перед запуском будет использовать guards #146, но сам запуск здесь не реализуется.

## 2. Выбранный подход

| Подход | Решение |
| --- | --- |
| Добавить `parent_id` и трактовать старые `task_links` как исполнимый граф карточек | Не подходит: связывает подготовку с готовностью кода и не доказывает требуемый output |
| Добавить небольшую core-модель work items и результатов, сохраняющую обычные карточки | Выбран: позволяет блокировать нужную стадию, хранить происхождение и проверять ownership без runtime |
| Реализовать одновременно workflow, scheduler, runtime и новый интерфейс | Выходит за подтверждённый объём #146 и дублирует следующие задачи |

SQLite, существующие транзакции, события, registry/repo bindings и opaque controller handle переиспользуются. Новые зависимости, отдельный сервис или общий policy engine не нужны.

## 3. Подзадачи и происхождение

В `tasks` добавляются nullable `parent_id` с FK на `tasks.id` и `execution_mode` с закрытым набором `manual | orchestrated`. Старые записи получают `parent_id = NULL`, `execution_mode = manual`; миграция ничего не запускает и не создаёт managed markers.

Родитель существует в этой же DB и является основной задачей (`parent_id IS NULL`). Self-parent, отсутствующий родитель и попытка создать ребёнка у подзадачи отклоняются. В новом host API parent/source task reference содержит `project_id + task_id`; project id сверяется с authentic handle/store, затем разрешается локальная строка. Совпадающий числовой task id чужой DB не означает тот же parent. SQL FK/constraints и проверки write path сохраняют один уровень, включая защиту от изменения родителя основной задачи с детьми. Поддерживаемый API задаёт принадлежность при создании; перепривязка существующих карточек в #146 не добавляется.

У ребёнка своё зафиксированное `execution_mode`. Если значение не передано, оно берётся от родителя один раз при создании; у новой основной задачи — из project default. Последующая смена режима родителя не меняет детей. `parent_id` не создаёт dependency edge, не выбирает branch/base и не закрывает родителя по статусам детей. Интеграция и обязательные outputs родителя определяются будущим workflow.

Происхождение хранится в событии создания: `source_task_id`, а при создании из run — `source_work_item_id`, `source_run_id`, generation и source instruction/proposal reference. Эти данные не подменяют `parent_id` и не устанавливают зависимости. Existing `manual_provenance` и `events.parent_id` сохраняют прежнее значение. Run provenance проверяется trusted host относительно реального authority scope, а не принимается из произвольного поля worker request. Source guard переиспользует проверку актуального grant scoped runtime: текущие inputs и ownership, generation, marker, repository/native scope и размещение store. Сохранённый report не позволяет создать детей после того, как этот grant перестал проходить проверку.

Создание из BA будет выглядеть так: BA отправляет недоверенное предложение → controller проверяет поручение и лимит будущего workflow → core атомарно создаёт детей и явные work-item edges. BA не получает owner API или свободное право создавать/запускать задачи. #146 предоставляет операцию host; BA adapter и лимит числа детей по поручению подключаются в #153 до разрешения автоматического создания. Самопорождение вложенных детей уже невозможно из-за ограничения глубины.

## 4. Work items и исполнимые зависимости

Карточка остаётся пользовательской целью. Work item — конкретная стадия её работы; у основной задачи и у подзадачи может быть несколько work items. Минимальная запись хранит собственный id, task id, kind из контракта #143, optional repo id, revision входного контракта, объявленные outputs и состояние. Входной контракт фиксирует те версии, которые уже известны host; отсутствие будущих workflow/requirements records не заменяется синтетическими revisions или approvals.

До появления полных requirements revisions work item сохраняет fingerprint title/body/текстов criteria своей карточки, её основного родителя при наличии и явно указанных дополнительных source task contracts. Fingerprint вычисляет core по канонической форме с критериями, упорядоченными по id; checked/evidence, позиция, комментарии и business-status в него не входят. Parent contract включается core, его нельзя молча исключить полем запроса. Publish/readiness/reservation сравнивают fingerprint с реальными текущими rows. Изменённые требования дают stale даже до #148/#153; внешняя строка revision сама по себе не доказывает актуальность. Новая модель requirements позже связывается с этими pinned inputs, не стирая прежнее происхождение.

Определение work item и набор его зависимостей версионируются. Изменение definition/output requirements или edges создаёт новую revision и сохраняет предыдущую в истории; активный owner не переключается на неё молча. Текущие указатели и состояние — mutable projection. После terminal-state повторная работа создаёт новый work item, а не превращает историю в цикл. Полные snapshots и внешние revision relations связывает #148/#153 с уже сохранёнными ids.

Ребро хранит consumer work item/revision, producer work item/ожидаемую revision, вид результата, output key и требуемые repo/resource/version bindings. Producer может принадлежать соседней подзадаче, другой основной задаче или её подзадаче в том же store. Оно не ссылается на неопределённое «когда-нибудь готово»: известны нужный output и revision производителя. Будущий result id закрепляется при разрешении зависимости; уже опубликованный результат можно закрепить явно сразу. Автоматического выбора новой версии вместо закреплённой нет.

| Вид | Требование к удовлетворению |
| --- | --- |
| `contract` | Опубликованный проверенный BA/Architect/API/schema output: producer revision, source repo/head при наличии, artifact/content hash и evidence обязательных checks |
| `code` | Проверенный result head той же repository identity, включённый в зафиксированный base потребителя; head и доказательство включения относятся к нужной revision |
| `merged` | Успешный local merge/import receipt для нужных repo/target и принятого result; статус карточки не является receipt |
| `readiness` | User-origin подтверждение ресурса/env/CI плюс актуальный pass probe из scope потребителя с ожидаемыми возможностями/версией |

Для разных `repo_id` code edge отклоняется при записи, до побочных эффектов. Backend передаёт frontend через contract зафиксированный API/schema artifact, а через readiness — доступное совместимое окружение. Git histories и frontend base не объединяются с backend. Реальная доставка same-repo code и fan-in остаются #156.

Граф использует только явные исполнимые edges актуальных revisions. `task_links` сохраняются как legacy-навигация и не импортируются автоматически, независимо от их kind. Иерархия родителей не участвует в cycle check и не создаёт неявное ожидание полной приёмки другой карточки.

Self-edge, отсутствующий endpoint, неверная revision, неизвестный kind, несовместимый output/repo scope и цикл отклоняются целиком. Проверка цикла выполняется по work-item edges всего project, включая межзадачные. Добавление и замена набора edges проверяются и записываются в одной `BEGIN IMMEDIATE` transaction с событием. Два одновременных обратных ребра не могут пройти проверку на старых снимках. Конфликтующий expected revision также даёт отказ без частично записанного графа.

Пример: B.contract → A.frontend разрешает подготовку и код A после нужного API-контракта B. Незавершённый B.implementation при этом не блокирует стадию, которой его код не нужен. A.frontend и A.tests — work items основной задачи A или её разных подзадач; зависимость задаётся только там, где нужен output.

## 5. Results и проверка готовности

Небольшой result record хранит id/revision, producer work item и revision входов, output key/kind, provenance, repo/head/artifact или readiness/receipt manifest, evidence refs и fence источника, если результат произведён под ownership. Payload неизменяемый; supersede/invalidation сохраняются отдельно от прежнего содержания. Повторная публикация того же command/result идемпотентна; конфликтующий повтор не заменяет историю.

Публикация доступна только controller handle после проверки источника и версии. `submit_report`, `request_question`, legacy comment, checkbox criteria, `status=done` и exit 0 не публикуют verified result. Ошибочный/отменённый producer, waiting attempt, отсутствующий output, fail/inconclusive check, stale revision или неактуальный fence не удовлетворяют ребро. Producer нельзя отметить completed без объявленных обязательных outputs. Публикация output не подтверждает остановку writer и не освобождает ownership.

Для legacy/manual производителя требуется явная host-публикация результата с происхождением и evidence. Между manual и orchestrated используется один result/dependency validator. Зависимость не меняет режим, не запускает BA и не выдаёт user acceptance. Managed policy #145 сохраняется при смене режима; публикация проверенного результата не является финальной приёмкой карточки.

Core возвращает структурированную проекцию: удовлетворённые edges с закреплёнными result ids и bindings; неудовлетворённые edges с кодом причины. Минимальные причины: `missing_output`, `producer_not_completed`, `failed`, `cancelled`, `stale_revision`, `checks_not_passed`, `base_missing_code`, `merge_not_succeeded`, `readiness_unconfirmed`, `readiness_unverified`, `readiness_expired`, `scope_mismatch`. Это вычисляемое ожидание; legacy `blocked/block_reason` остаётся отдельным ручным stop. Pending dependency не снимается редактированием этого флага.

В #146 реализуется проверка нормализованных result/evidence bindings и актуальности модели. Реальные checks, user receipts, Git/environment observations поставляет trusted host через соответствующие будущие подсистемы. Отсутствующий verifier или обязательное наблюдение означает неудовлетворённую зависимость. Worker JSON, `verified=true` или caller-provided `ready=true` не принимаются за доказательство. Fixture evidence в тесте не объявляется готовым production runtime.

Положительный базовый contract-путь #146 проверяет реальные bytes опубликованного artifact/manifest и content hash, producer/input bindings и явно объявленные обязательства. Нужные внешние checks разрешаются trusted host observer для конкретных evidence refs; неизвестный ref или отсутствующий observer даёт inconclusive/blocked. Каждый mandatory check request содержит `payloadHash` — SHA-256 канонического полного payload; это связывает check с artifact/hash, head или resource/receipt manifest всех result kinds. Pass для другого payload, включая прежний superseded output той же producer revision, не применяется. Необъявленный workflow не изображается пройденным: без #153/#157 этот путь проверяет локальную модель/manifest и не выдаёт право на autonomous implementation. При следующем чтении изменённый или недоступный обязательный artifact снова закрывает ребро.

Readiness manifest сохраняет user source reference, resource/env identity, repo/config/input revisions, нужную API/schema version, probe/evidence refs, consumer access scope, `observed_at` и срок при наличии. Credentials в него не попадают. Один текст «готово», failed/inconclusive probe и probe из другого scope оставляют ребро закрытым. Перед будущим dispatch #150/#152 заново выполняют требуемый probe; #146 проверяет привязку нового наблюдения к текущим inputs. Сохранённый pass без этой проверки не является бессрочным Start permission.

Для code нужен актуальный proof включения pinned head в pinned same-repo base; для merged — актуальный receipt, а для contract — применимый проверенный manifest/hash. #146 не делает cherry-pick/merge, не запускает CI, не подтверждает ответы от имени пользователя и не создаёт фальшивые receipts, чтобы открыть положительный путь.

Смена применимых входов/обязательств, supersede/invalidation результата или несовместимая версия ресурса делает затронутую проекцию stale. Исторические записи остаются. Если consumer уже владеет работой, изменение не запускает второго owner и не продолжает его на новой revision: сохраняется необходимость stop/revalidation; доставка steering и replanning остаются #148/#150/#153.

Общий live-owner guard сверяет сохранённые input result ids с точными pins текущей revision и повторно проверяет их актуальность тем же result validator, включая upstream pins, invalidation, producer revision/fence/requirements, artifact hash и readiness expiry. Это закрывает launch intent, выдачу/использование modeled grant и применение сохранённого BA-report для создания детей после устаревания входов. Guard не выдаёт новый verified result или Start: свежие host observations по-прежнему обязательны для readiness/reservation/publication/completion и будущего dispatch. Владение и snapshot сохраняются до подтверждённого stop/handoff.

## 6. Атомарное владение и передача управления

Ownership — durable резервация конкретного work item под logical owner id и mode с monotonically increasing fence и revision входов. Это не назначение роли/агента, provider session, authority token или уже запущенный process. Новое ownership хранилище переиспользует SQLite CAS и partial uniqueness: на work item допускается ровно одна unreleased reservation. Предыдущие записи остаются для provenance.

Локальные revision numbers/fences и их expected values проверяются как конечные safe integers в разрешённом диапазоне; overflow даёт отказ. Logical owner и observation ids ограничены своим store/work item, а не выбираются по worker Actor.

`reserveWorkItem` принимает authentic controller handle, expected fence/revision и необходимые наблюдения, затем в одной immediate transaction повторно проверяет состояние, handoff intent, режим, ручную блокировку, актуальные dependencies/results и отсутствие owner. При успешной резервации fence увеличивается и сохраняется событие. Конкурент получает явный отказ. Readiness projection, прочитанная раньше, сама по себе резервацию не выдаёт. Ready и reservation также не являются Start: scope, workflow, budgets, native preflight и workspace uniqueness проверят следующие подсистемы.

При первой управляемой write-резервации используются managed guard/policy #145. Существующий legacy claim, включая просроченный claim с неизвестным writer, препятствует переходу; marker не появляется поверх чужого claim. После защиты legacy claim/reclaim/move/reason/user Actor не освобождают и не подменяют новое владение. Создание карточки, выбор mode или один read-only review сами по себе не принимают managed result и не снимают human policy.

Для смены управления trusted host сохраняет handoff intent и ожидаемые mode/fences. Пока intent действует, новый owner целевой работы не допускается. Stop выполняет будущий runtime adapter вне SQLite transaction. #146 завершает handoff только по наблюдению trusted host для тех же owner/fence/revision и повторной проверке всех записей в transaction; отказ или изменение снимка сохраняют прежнего владельца/intent с диагностикой. Подтверждённый переход атомарно освобождает прежние reservations, отзывает связанные credentials #145, меняет mode и сохраняет receipt/event; повтор того же command не дублирует переход. Смена режима касается work items выбранной карточки; дети сохраняют собственный mode.

Observation об остановке не берётся из worker report, Actor, reason или произвольного RPC boolean. Host observer вызывается через доверенный библиотечный путь; отсутствие observer, exception, unknown или живые дочерние writers не освобождают reservation. Для резервации, заведомо не переданной запуску, разрешён отдельный исход `never_started`. Будущий #150 обязан записать launch intent **до** возможного spawn: после него `never_started` уже не подходит, даже если runtime id не получен. Положительное stop observation должно относиться к полному набору writers и persisted launch identity.

Revoke/expiry authority, heartbeat timeout, mode change, cancel intent, `completed` или business-status не доказывают остановку и не освобождают слот. В #146 нет автоматического TTL reclaim. #152 добавит lease/recovery поверх этого правила, а не заменит его освобождением по часам. После подтверждённого завершения handoff старые fence/result/ownership operations отклоняются; следующий owner получает новую generation и актуальные входы.

Нельзя смешивать authority generation #145 и ownership fence: первое ограничивает broker credential, второе — исключительное владение. Credential rotation не освобождает writer. Имеющиеся low-level grants с внешними ids не мигрируются в вымышленные work items/attempts. #146 не добавляет обходной Start через выдачу grant; #150/#152 свяжут реальный launch с резервацией и credential. При взаимодействии с уже смоделированным work item host сверяет обе identity/fence tuples.

Handoff snapshot включает все grants выбранной карточки, в том числе external work-item ids и credentials, связанные через work item. Grant без точной связи с наблюдаемым владельцем удерживает переход как unknown; revoke/expiry не устраняет неизвестного writer. Grants прежнего владельца допускаются только при уже завершённом handoff этого ownership tuple. Снимок и связи credentials повторно сверяются после observer, прежде чем освобождать reservations, отзывать credentials и менять mode.

Параллельные siblings с разными work items получают независимые резервации. Гарантия одного writer на физический workspace/repo target добавляется с их реальными durable identities в #151/#152/#156; #146 не обещает её по произвольному строковому path.

## 7. Core API и совместимость

Все новые mutations требуют authentic controller handle, фиксированный store, expected revisions/fences и closed input shapes. RunContext и legacy Actor не заменяют handle. Public core API предоставляет создание подзадач/модели work items, запись и чтение typed dependencies, host-публикацию/invalidation результатов, readiness projection, reservation и handoff. Произвольный JSON result не становится trusted check; разрешённые envelope variants и их bindings проверяются в общих guards.

Контроль mode для управляемой работы проходит через handoff. Для ещё не занятой карточки явная смена mode проверяет отсутствие legacy/new owners и не создаёт launch/approval. Legacy ручные задачи без новой управляемой работы сохраняют нынешние команды и правило self-accept; новая модель доступна host API, а не через необъявленные флаги клиентов. Все transports для owner появятся в #159 и вызовут эти же функции.

Legacy queue не получает новые orchestrated задачи, независимо от явного id в `claimTask`. Сохранение ручного legacy tick до cutover #170 не считается новым autonomous workflow: он не исполняет managed rows, не интерпретирует typed DAG и не получает разрешение из `autonomy_enabled`. Новый scheduler не отбирает manual/backlog только по колонке или project default.

Task reads сохраняют parent/mode и дают структурированные children/graph/dependency projections в core. Отсутствие children/work items представлено пустыми списками. UI renderer, новый owner MCP server и prompt BA не добавляются. Ограничение существующих capped/brief выдач сохраняется; не раздувать resume packet всем графом и не скрывать число опущенных записей.

## 8. Схема и сохранность

Append migration v15; существующие 14 migrations неизменны. Кроме двух task fields добавляются только записи, необходимые #146: work-item definitions/revisions, typed edges, immutable result manifests с invalidation history и ownership/handoff metadata. Конкретное размещение current pointers не создаёт отдельную таблицу для каждого термина #143. Полные role/workflow/session/attempt/check/approval/memory schemas здесь не создаются.

Task ids, statuses, claims, criteria/evidence, events/provenance, attachments, decisions/search index, project_id и repo bindings сохраняются. Старые links/results не преобразуются в verified dependencies, synthetic approvals или Start instructions. Запись source repo/backend не синхронизирует общий legacy decisions index и не ослабляет защиту #144.

`openController` и compiled consumers признают новую известную schema; неизвестная будущая версия по-прежнему даёт отказ. Сохранённые grants не объявляются execution records. Generated core/MCP/CLI/plugin runtime пересобираются перед implementation commit. Настоящая доска разработки остаётся v13: bookkeeping — совместимый установленный MCP/изолированный legacy CLI, проверка migration — только временные copies/stores.

## 9. Наблюдаемая приёмка реализации

Это программа будущих проверок, а не заявление о уже выполненных тестах #146.

| ID | Проверка |
| --- | --- |
| D01 | Upgrade v14 → v15 сохраняет rows/ids/history/project/bindings/decisions и существующие markers/grants, все прежние tasks manual/root, 0 новых markers/owners/starts; повтор upgrade не дублирует записи |
| D02 | Основная задача имеет несколько детей; self-parent/другой store/несуществующий parent/ребёнок у подзадачи отклоняются без частичных rows/events; режим наследуется однократно, provenance отдельно |
| D03 | Независимые siblings не блокируют друг друга; явное A.output → B.stage блокирует B до требуемого output; parent не создаёт execution edge |
| D04 | Зависимость от work item другой основной задачи работает; цикл через разные задачи/подзадачи и self-edge отклоняются; в 20 гонках двух противоположных edges граф всегда остаётся DAG |
| D05 | Done/comment/checked criteria/exit 0 без нужного output, failed/cancelled/waiting producer и fail/inconclusive/stale result дают 0 открытых зависимостей; host-публикация актуального проверенного contract открывает только нужные edges |
| D06 | Cross-repo code edge отклонён; contract закрепляет backend artifact без изменения frontend Git base/refs; same-repo code без proof включения, merged без receipt и readiness без свежего consumer-scope probe остаются закрыты |
| D07 | Result/inputs supersede и изменение реального title/body/criteria contracts закрывают затронутые edges, сохраняют историю и не переключают активного owner на новую revision; comment/checked/position не меняют requirements fingerprint; повтор публикации не создаёт второй result, конфликтующий повтор отказан |
| D08 | В 20 гонках двух отдельных процессов/SQLite connections одна reservation на work item; другой controller получает отказ; независимые work items могут резервироваться одновременно; stale fence не публикует результат |
| D09 | Handoff с missing/throwing/unknown/live stop observer сохраняет owner/intent; revoke/expiry/move/legacy reason не дают второго owner; подтверждённый never-started handoff меняет mode атомарно и новый owner имеет новый fence |
| D10 | Записанный launch intent исключает never_started release; остановка с несовпадающим owner/fence не меняет rows; положительный stop observation проверяется на реальном fixture process tree; fixture не называется start/stop Codex runtime |
| D11 | Fake controller handle, RunContext, user Actor/reason и worker report не получают model mutations/check outcome; protected policy остаётся после takeover в manual |
| D12 | Legacy ручной CLI/MCP/UI smoke и #144 store/decisions regression проходят; orchestrated row не попадает в legacy explicit/auto claim; новые owner tools/agent launches отсутствуют |

Core tests используют реальные SQLite/temp Git и существующий test stack. Конкуренция проверяется отдельными процессами по 20 rounds для edges и reservation. Внешнее наблюдение — сценарий против свежего compiled core с чтением сохранённых ids, edges, result bindings, ownership fences и audit, а не только assertions на mock callback. Test и typecheck — отдельные gates всех четырёх packages; build и plugin sync также проверяются. Изменения общего authority guard требуют regression scoped MCP/native permission paths #145; старые сохранённые evidence не объявляются результатом новой проверки.

Критерий 396 закрывается D03–D07, критерий 397 — D08–D11. Полный BA→agent execution, настоящий runtime stop/recovery, Git integration и human merge не заявляются выполненными по model tests. Задача уходит в review только после измерений; done — по слову владельца.

## 10. Grounding и второй проход

Recall выполнен до references; применимых decision records по dependency/ownership не найдено. Старые #33/#42/#100 прочитаны как идеи, не specs. #33 «явный id обходит manual автоотбор» не применяется к managed authority; #42 цикл-чек полезен, task-status predicate недостаточен; #100 task parent/run provenance разделены и глубина один уровень подтверждена пользователем.

Actual fetch обоих reference clone выполнен 2026-09-28. Local checkout не переключались. Agent Kanban: `a26bef6` → upstream `7fea6dc111ea0da85e164763bbb1d2af04adf409`, behind 78, commits после анализа 0. Vibe Kanban: `4deb7ec` → `d5cbb5380fa0b32e98ef9b8d987f63decce4be3a`, behind 10, commits после анализа 0. Источники обоих проходов прочитаны через `git show` на этих upstream commits.

| Источник | Вердикт после уточнения пользователя |
| --- | --- |
| Agent Kanban `server/adapters/d1/taskDeps.ts:5-25,28-44`, `taskRepo.ts:101-109,424-432` @ `7fea6dc` | Recursive reachability подходит; KDD объединит cycle check и write в SQLite transaction. Task-level done/cancelled predicate не подходит versioned work-item results |
| Vibe Kanban `crates/db/src/models/task.rs:23-33`, `workspace.rs:41-54`, `workspace_repo.rs:229-250` @ `d5cbb53` | Происхождение workspace отделено от задачи. Не наследуем parent_workspace как task parent или автоматическое изменение targets детей: принадлежность и code dependencies в KDD независимы |
| KDD `packages/core/src/claim.ts:245,286,319`, `ops.ts:281`, `authority.ts:103,132` @ `cb7e7a8` | CAS/immediate transactions и controller guard переиспользуются. Legacy claim не является новым work-item ownership; revoke не доказывает stop |

Второй проход подтвердил первый и уточнил scope: граф относится к нужным outputs/stages, parent не управляет исполнением, а референсы не дают готового механизма stop proof или readiness. Паттерны адаптируются самостоятельно; код не копируется. Citations и согласованные ограничения записаны в карточке #146.
