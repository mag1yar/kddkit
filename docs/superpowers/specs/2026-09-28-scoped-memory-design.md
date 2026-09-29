# Память project/task/subtask: версии, источники и scoped recall

Дата: 2026-09-28. Задача KDD: 147, track 6. Статус: **подтверждено пользователем**.

Основание: [контракт 143](2026-09-27-kanban-orchestrator-contract-design.md) §§4/8/9, [store 144](2026-09-27-project-store-foundation-design.md), [authority 145](2026-09-27-controller-authority-design.md), [подзадачи 146](2026-09-28-subtasks-dependencies-design.md), [анализ](../../../.planning/research/orchestration/ANALYSIS.md) §8.

## 1. Результат и согласованная граница

KDD получает локальную operational memory в общей SQLite проекта. Подзадача читает применимые знания проекта, родительской задачи и собственные записи; другой checkout не удаляет их, а исправление не стирает историю. Подтверждённое правило пользователя не заменяется предложением агента.

Пользователь выбрал: **«Core сейчас, интерфейсы в #159»**. Здесь реализуются схема, core operations, источники/статусы, версии, импорт выбранных документов и scoped recall. CLI/global MCP/scoped MCP/HTTP/UI tools и формы памяти относятся к #159/#163; сборка контекста, обязательная загрузка правил и input snapshot запуска — к #148. Новые tools, RunOperation и native capabilities в #147 не выдаются.

Core может читать память с существующим opaque RunContext, проверяя действующее право get_context. Это библиотечная граница для следующих задач, а не новый MCP tool. Существующий get_context response и его strict schema не расширяются сейчас.

Не создаются conversation/session/checkpoint store, analyser, curator, semantic conflict detector, embeddings, graph, decay, автозахват каждого сообщения или произвольный condition DSL. Приёмка/merge/workflow не меняются. Старые карточки #28/#29/#30/#53/#96/#110 сохраняются.

## 2. Выбранный подход

Legacy decisions сохраняют свои файлы, таблицу decisions, search_index, синхронизацию и публичный recall. Новые знания хранятся независимо; отсутствие исходного файла, переключение ветки и legacy rebuild не являются операциями над ними.

Расширять legacy index до общей operational memory нельзя: его rebuild/delete и текущий источник Markdown имеют другой контракт. Один общий FTS с фильтрацией после получения top-k также не подходит: чужие записи могут вытеснять разрешённые, а общий BM25 corpus влияет на ранжирование.

Выбран минимальный вариант: постоянные memory entries/revisions в SQLite; для каждого recall сначала выбираются допустимые записи, затем только они помещаются в отдельный временный in-memory FTS5 corpus. MATCH, snippet, BM25 и LIMIT выполняются над этим corpus. Переиспользуются установленный better-sqlite3, tokenize/sanitizeQuery и существующие caps; новых зависимостей нет.

Цена — O(n) допустимых записей на запрос и временная копия их текста. Это осознанный начальный предел, который нужно пометить ponytail-комментарием в реализации. При измеренном недостатке производительности можно заменить временный corpus на индексы с доказанной изоляцией; глобальный top-k с последующим отбрасыванием не допускается.

## 3. Запись и неизменяемая история

Append migration v16 добавляет только две постоянные таблицы:

| Таблица | Смысл и ограничения |
| --- | --- |
| memory_entries | Случайный id, неизменяемые scope task_id/null, repo_id/null и applicable_commit/null; optional immutable unique import_key; current_revision; created_at. FK на существующие task/repo, unique id и FK текущей revision; commit требует repo_id |
| memory_revisions | entry id + положительная revision; predecessor; kind, status, title/body; source/evidence/author; content hash; command id/hash; created_at. PK entry/revision, unique command id, FK predecessor в той же записи |

Весь файл принадлежит одному project_id #144; новые API требуют его явно и сверяют с singleton. Дублировать project_id в каждой строке не нужно. Task id null означает project scope; root task — task scope, task с parent_id — subtask scope. При обращении существование и принадлежность проверяются по #146; произвольный project/task из текста записи не считается разрешённым.

Kind: fact, decision, rule, candidate. Status текущей revision: active или withdrawn. Историческая revision имеет вычисляемый effective status superseded, сохраняя своё первоначальное status и текст. Active candidate — предложение, а не подтверждённое знание или обязательное правило; обычный recall его не включает. Отдельное явное чтение candidates показывает kind/status/source.

Редактирование, отзыв, принятие candidate и исправление источника создают новую revision. Исторические строки нельзя UPDATE/DELETE; SQL triggers защищают их, а изменение current pointer проходит CAS. Нет физического delete памяти и автоматического garbage collection.

Обычная правка сохраняет kind. Принятие candidate в fact/decision/rule требует соответствующей проверки из §5 и сохраняет прежнюю candidate revision. Агентское предложение исправить существующее decision/rule создаёт отдельный candidate со ссылкой на исходную revision; его публикация не меняет current pointer пользовательского знания.

Scope/repo/applicable_commit записи не изменяются при правке. Расширение знания из subtask до project или перенос факта на другой commit — отдельная явно авторизованная запись с provenance на исходную revision. Таким образом branch-specific facts не могут заменить общую запись через изменение её области. Между записями нет автоматического supersede по одинаковому title/topic или похожему тексту.

Source содержит закрытый discriminator и структурированные ссылки: user instruction/answer, run report event с authority binding, host observation, Git document или другая memory revision. Текст сообщения сам по себе не является источником подтверждения. Хранятся автор, время и известные ссылки task/work item/run/tool/path/commit/hash; неизвестные сведения остаются неизвестными, не синтезируются. Code source проверяется как существующий полный commit SHA; applicable_commit имеет тот же строгий формат и не является произвольной branch/ref строкой.

## 4. Область чтения и версия repo

Наследование вычисляется по ссылкам; копии родительских записей не создаются:

- project view: project records;
- task view: project + эта root task;
- subtask view: project + её текущий root parent + эта subtask.

Соседние задачи и подзадачи не входят в view. Parent не получает приватные записи детей автоматически; итог и вопросы приходят через опубликованные результаты/будущий context assembly. Dependency edge #146 не разрешает чтение чужой памяти или разговора. Передача конкретных опубликованных результатов и snapshot реализуется #148, без расширения всего recall scope.

Owner/controller может явно выбрать другую разрешённую view. Run получает scope из действующего grant: project_id, task_id, repositories, а не из query/Actor/reason. Core каждый раз повторно проверяет revoke, expiry, generation и modeled ownership/inputs по #145/#146; fake, foreign, stale или закрытый context отказывает до поиска. Subtask run может наследовать parent records, но не запросить произвольную sibling или root task.

Repo-specific запись доступна только при наличии repo_id в разрешённой view. Неизвестный repo, foreign binding, неверный realpath/common-dir дают отказ без fallback к project scope. Implementation/context_only определяют native доступ #145, а чтение знаний само по себе не выдаёт право менять код.

Code fact обязательно имеет repo_id и полный Git commit SHA; branch label может быть provenance, но не заменяет commit. В начальном контракте применимость code fact **строго к declared commit**. View с другим commit его не включает даже при ancestor relation; новая версия кода требует отдельного подтверждённого факта. Переоценку и обновление фактов выполнят #164/#165/#167. Это консервативное ограничение, не заявление об автоматическом анализе изменений.

Run view использует фактически разрешённые checkout/bindings и проверенные HEAD; запрос не может подменить repo/commit. Trusted host view может явно выбрать существующие pinned commits в своих зарегистрированных bindings для подготовки будущего snapshot. Ошибка проверки версии не превращается в unversioned fact.

Source commit и applicability различаются: пользовательское общее правило может ссылаться на документ конкретного commit, оставаясь общим только по явной пользовательской authority. Факт о принятой ветке не становится фактом target/main по accepted/done, совпадению remote, branch name или одному ancestry check. Для утверждения о target нужен новый источник, проверяющий соответствующую target version; merge receipts реализуются #158.

Read-by-id, чтение revision/history, lists, mandatory-rule enumeration и recall используют один scope predicate. Знание id не обходит область. History/candidates/withdrawn читаются только явно внутри той же разрешённой view. Все проверки и выбор текущих pointers выполняются в одной согласованной DB transaction.

## 5. Authority и публикация

Все мутации памяти принимают authentic ControllerHandle. Actor задаёт авторство, но не полномочия: type=user, reason, provider session id или строка «пользователь сказал» не подтверждают решение. Как и в #146, controller host является доверенной границей; native run не получает DB и готовый host handle.

Публикация active decision/rule, изменение/отзыв такого знания и принятие соответствующего candidate требуют проверенного user observation. Active fact требует host evidence; code fact дополнительно проверяет repo/commit и evidence bytes. Candidate может быть опубликован из недоверенного report, сохраняя явный статус предложения.

Верификатор — trusted host callback, не LLM-текст или сериализованный verdict из запроса. Request включает полный hash payload, scope/repo/commit, operation, ожидаемую revision и source ref. Observation должен точно совпадать с request, иметь требуемый origin user/host, verdict pass и корректные времена. Missing/fail/inconclusive, несоответствие hash/version/scope/operation и просроченное observation дают отказ. Шаблон сверки evidence из #146 переиспользуется; новые receipts human acceptance или runtime lifecycle здесь не изобретаются.

Run-derived source проверяет реальный run_report event, task/work-item/run/generation tuple и живую authority с submit_report; для modeled work проверяется ownership/актуальность inputs по общему guard #146. Внешний work-item id #145 не объявляется существующим scheduler record. Такой источник разрешает только candidate в собственной task/subtask области. Он не подтверждает fact, не выдаёт user observation, не создаёт project rule и не заменяет существующее пользовательское знание. Fact из результата агента подтверждает host verifier отдельно по evidence, а не по авторитету отчёта.

Каждая запись проходит shape/enum/id/FK/hash/CAS проверки. Title/body/source metadata ограничены существующими caps; overflow отклоняется с limit и разрешёнными current refs, без усечения сохраняемого знания, удаления старых записей или автоматической консолидации. Известные credential/token/key формы и private runtime source paths не принимаются в memory/FTS/audit. Переиспользуется существующая redaction detection; она не заявляется универсальным распознаванием произвольных секретов. Config/env/credentials не импортируются как память.

Write command id + canonical request hash обеспечивают идемпотентность: тот же разрешённый запрос возвращает первоначальный receipt без второй revision/event; тот же id с другим payload/source/scope/CAS отклоняется. Проверка полномочий предшествует replay. Возвращённый старый receipt не переставляет current pointer назад. Два процесса с одним expected revision дают одного победителя; конкурент получает stale revision, история не расходится.

Validate → immediate transaction → revision/current pointer/audit event — один атомарный переход. События содержат ids, kind/status, source refs и hashes, а не дубликат body или credentials. Отказ не создаёт частичной revision, pointer или event.

## 6. Явный импорт и совместимость legacy

Core предоставляет импорт **выбранного** документа из зарегистрированного Git repo и указанного commit с явным scope. Это не скан всего каталога, не watcher и не автоматическая миграция decisions. Source фиксирует repo_id, относительный path, commit и hash реальных bytes. Читать продуктовые документы нужно через Git blob выбранной версии, без checkout/reset/stash/commit и записи в source.

Путь не может быть абсолютным, содержать traversal или разрешаться в symlink/submodule/private credentials; object проверяется как допустимый текстовый blob. Неверные UTF-8, hash, type, размер, неизвестный repo или отсутствующий commit/file дают отказ без записи. Реальный bound checkout/common-dir подтверждает repo identity; remote URL и переданный текст не заменяют проверку.

Повтор выбранного source/commit/hash в том же scope/repo/applicability возвращает существующий import receipt, без дубля; canonical import_key защищён UNIQUE. Изменённые kind/status/source authority не считаются тем же запросом: требуется явная новая revision, а не скрытая смена импортированного знания. Replay возвращает первоначальный receipt с текущим состоянием записи и не оживляет withdrawn/superseded revision. Импорт в другую область — отдельное явное действие. Same path на другом commit не перезаписывает прежнюю запись. Неактивный legacy decision остаётся историческим/candidate/withdrawn по явно выбранному импорту; импорт не может молча оживить superseded правило.

Документ по умолчанию публикуется как candidate. Создание подтверждённого fact/decision/rule и его дальнейшие изменения проходят §5. Author legacy файла не выдумывается, provenance выбранного пользовательского import сохраняется отдельно.

Legacy recall из основной ветки B, связанного backend с пустым/conflicting .planning/decisions и managed clone не меняет imported revisions A. Legacy rebuild затрагивает только старый индекс. Новые чтения/записи памяти не вызывают syncIndex и не редактируют Markdown или decisions rows. Legacy export не включает operational memory молча; её явный export в git — последующее owner action.

## 7. Core API и consumer contract

Public barrel предоставляет operations создания/новой revision/отзыва, выбранного import, чтения entry/revision/history, list/recall, списка применимых active rules и чтения с RunContext. Новые helpers валидации/DB/выборки остаются internal; клиент не передаёт готовую trusted scope или grant row.

Host operations требуют ControllerHandle и типизированную scope/view; run read требует genuine RunContext и get_context. Run write API не создаётся. Действующие transport responses и каталоги tools сохраняются. API возвращает entry/revision ids, content hashes, kind/status, applicability и provenance, чтобы #148 мог закрепить точные inputs.

Обычный recall ищет active fact/decision/rule, ранжирует внутри допустимого corpus и применяет k в нём. Candidate/history — явный режим, без превращения в active rule. User decision/rule не демотируется под inferred candidate. Один sanitizeQuery исключает FTS operators/injection; deterministic tie-breaker использует устойчивые ids.

Применимые обязательные rules возвращаются отдельной полной коллекцией ссылок/revisions; k или слабое keyword совпадение не снимают обязательность. #148 проверит загрузку и budget, сохраняя отказ вместо молчаливого усечения. Recall в #147 сам не инжектирует prompt и не заменяет уже сохранённый input snapshot.

Конфликтующие project/task/subtask rules не разрешаются правилом «самый узкий scope побеждает» или автоматическим supersede. Core сохраняет все применимые active rules и provenance; явная попытка заменить чужую область отклоняется. Semantic обнаружение противоречия, question/steering и остановка запуска принадлежат #110/#148/#155. Само наличие двух похожих текстов не даёт разрешение начать работу или удалить один из них.

## 8. Миграция и измеримые проверки

Добавить v16 после неизменённых migrations 1–15. WAL-aware backup и newer-schema refusal остаются существующими. Legacy tasks, criteria/evidence, comments/events, decisions/FTS, project/bindings, work-item results, ownership/handoffs сохраняют ids/values. Новые memory tables пусты: ноль auto-imports, auto-starts, approvals и изменения execution mode. Повторное open/migration не создаёт знания.

| ID | Требуемое наблюдение |
| --- | --- |
| M01 | Upgrade заполненного v15 + WAL сохраняет все прежние rows/ids; читаемый v15 backup; reopen идемпотентен, memory пустая, старый binary отказывает |
| M02 | Project/task/subtask получают ровно project, project+task, project+parent+subtask; sibling/other project id не доступны через recall/list/get/history/rules |
| M03 | Много чужих совпадений и k=1 не вытесняют разрешённый hit; чужие corpus statistics не меняют его snippet/rank/order; фильтрация precedes FTS |
| M04 | Неизвестный repo/foreign binding/подмена commit дают отказ; fact A@a1 отсутствует в B@b1, HEAD другого repo не подходит; branch label не расширяет scope |
| M05 | Правка/отзыв/принятие создают revision и predecessor; прошлые bytes/hashes/provenance неизменны; прямые UPDATE/DELETE revision запрещены |
| M06 | 20 процессных CAS races дают 20 single winners; same command replay не дублирует revision/event, changed command payload отказывает, crash/rollback не оставляет partial state |
| M07 | Actor=user/reason/report pass не создают rule/fact; missing/fail/inconclusive/wrong hash/origin/scope/expiry evidence отклонены; проверенный host/user evidence даёт соответствующий результат |
| M08 | Genuine run read наследует только свою область/repos; forged/expired/revoked/stale context и изменённые pinned inputs #146 отказывают; run candidate не заменяет decision/rule и не создаёт project policy |
| M09 | Явный Git import соответствует blob bytes/commit/path/hash; повтор не создаёт дубль; changed path/version/scope остаются отдельными; malformed/traversal/symlink/private/oversized input отклонён |
| M10 | Import A переживает primary branch-B legacy recall/rebuild и backend empty/conflicting decisions; новые memory bytes/rows/history совпадают до/после, защита #144 не ослаблена |
| M11 | Candidates/withdrawn/superseded не становятся default knowledge; history читается явно, связанные источники и авторство сохранены; candidate approval требует соответствующей authority |
| M12 | Все применимые active rules доступны независимо от query/top-k; narrower scope не скрывает parent rule; источники конфликтующих rules видны, без автоматического judge/override |
| M13 | Записи не обрезаются; known secrets/private credentials и oversize отклонены; ошибки/audit/recall не раскрывают закрытые payloads; 0 служебных файлов/refs/exports в source |
| M14 | Свежий compiled-core сценарий читает реальные сохранённые revisions/hashes/scopes через public API; существующие CLI/MCP/UI форматы и каталоги tools не меняются |

Это программа будущей проверки, **не выполненные тесты**. Реальные SQLite/temp Git, без product/native mocks для scope/authority/evidence. Evidence callbacks проверяются против реальных fixtures/commands и помеченных отрицательных наблюдений; mock callback не объявляется реальной native проверкой.

Gate реализации: свежие build/plugin sync, tests и отдельный typecheck всех четырёх packages, plugin smoke, compiled-core M01–M14 observations. Изменение общего authority/read boundary требует regression #145/#146 и свежих full-operations/get_context-only native broker проверок; старые evidence или подмена медленного preflight не являются доказательством. Настоящую доску не открывать development schema; использовать совместимый установленный MCP для progress.

## 9. Grounding и второй проход

Recall выполнен до референсов. Append-only decision остаётся ограничением. #144/#145/#146 завершены; их фактические guards, parent model и отдельный legacy index прочитаны. Сопоставлены прежние идеи: #53 scope/branch покрывается новой memory identity/applicability, #28 — ограничением write и candidate separation; transport decide #29, UI #30, condition matching #96 и semantic conflict batch #110 остаются отдельными работами, без молчаливой реализации/закрытия старых criteria.

Первый проход: actual fetch всех трёх repos, exit 0; checkout не переключались. Local lag / commits после источника анализа: Control Center 8/8, Buzz 3/3, Hermes 24564/1207. Во втором проходе, после выбора core-only, повторно прочитаны те же paths. Upstream Hermes изменился; выполнен ещё один actual fetch, exit 0, новый lag 24608, после analysis source 1251. Memory doc не изменился ни после первого прохода, ни после анализа. Источники прочитаны через git show pinned commits, приложения референсов не запускались.

| Референс / commit второго прохода | Прочитанный источник | Вердикт для core-only |
| --- | --- | --- |
| Control Center a5cda44935f5514459bf9941373918dc5478cdcb | docs/src/content/docs/manual/concepts/memory-knowledge.mdx:45–60,69–106,118–133; packages/cc_persistence/lib/repositories/dao_memory_fact_repository.dart:111–145; packages/cc_domain/lib/features/memory/domain/services/memory_repo_scope_resolver.dart:43–63 | Facts/policies/provenance и отказ неизвестному repo полезны; repo boost, fail-open reads, автоматический выбор победителя конфликта и общая инъекция не подходят |
| Hermes 6d42313deee63b13dbf2f262d9a31cf603d3f1bc | website/docs/user-guide/features/memory.md:20–33,57–65 | Bounded memory и snapshots подтверждают границу; shared mutable Markdown/replace/remove не обеспечивают multi-writer историю; snapshots реализуем #148 |
| Buzz ebe99a46e8802b9ff20fdf6a1028ce93bdefaa43 | crates/buzz-acp/src/scope.rs:65–90; session_model_thread.md:3–5 | Conversation scope отделён от authorization и общей памяти; не считать его готовым project/task/subtask ACL или переносить relay infrastructure |

Второй проход подтвердил первый и уточнил поиск: scope enforcement происходит до FTS corpus, а не только при сортировке или выдаче. Паттерны адаптируются самостоятельно под TypeScript/SQLite; код не копируется. Полные citations также записаны в карточке #147.

## 10. Пользовательский review

На review вынесены: core-only граница; независимость operational memory от legacy; строгая commit applicability фактов; immutable revisions/CAS; host/user evidence вместо доверия Actor; candidate не меняет user rules; prefiltered FTS; явный выбранный import.

Пользователь подтвердил спецификацию `f026fd0` 2026-09-29: «Утверждаю, составь план», затем план `034c850`: «План подтверждаю, начинай». Реализация завершена solo в согласованной core-only границе; измерения и ограничения записаны в [план](../plans/2026-09-29-scoped-memory.md). Финальные M01–M14 — 14/14, whole-repo tests после исправления review P1 — 1079/1079, обе genuine native broker matrices — 29/29, build/typecheck/plugin gates exit 0. Работа передаётся в review владельца; пользовательская приёмка не выполнялась.
