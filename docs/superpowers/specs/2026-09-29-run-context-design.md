# Контекст запуска и неизменяемый снимок входов

Дата: 2026-09-29. KDD #148, track 6. Статус: **реализована; gates пройдены; ожидает review владельца**.

Основания: утверждённый [контракт #143](2026-09-27-kanban-orchestrator-contract-design.md), завершённые [authority #145](2026-09-27-controller-authority-design.md), [зависимости #146](2026-09-28-subtasks-dependencies-design.md), [память #147](2026-09-28-scoped-memory-design.md) и [анализ](../../../.planning/research/orchestration/ANALYSIS.md). Текущая ветка task/143-kanban-orchestrator-contract, base e8f01bf. SELECTIVE ROUTE: solo. Разрешение работать в текущей конфигурации primary сохраняется; подтверждённые Sol/High metadata не заявляются.

## 1. Согласованная граница

Владелец выбрал «Core + get_context сейчас»: собрать и сохранить точные входы run, выдавать их через существующий scoped MCP get_context, явно обозначать необходимость обновления. Подзадача получает требования и обязательные правила основной задачи вместе со своими требованиями, применимой project memory и закреплёнными результатами зависимостей. История снимка остаётся читаемой trusted host после изменений, отзыва grant и restart.

#148 включает библиотечную сборку, хранение, проверку актуальности и диагностику изменения входов, а также подключение сохранённого пакета к существующему get_context. Каталог RunOperation и MCP tools не расширяется. Ordinary Kanban CLI/MCP/UI и legacy recall сохраняются.

Профили ролей, prompt/model и фактическая загрузка Always/Available skills — #149; реальный start/resume/stop и подтверждение доставки в provider session — #150; workspace lifecycle — #151; scheduler/recovery — #152; workflow — #153; вопросы, checkpoint и steering — #155; Git-интеграция — #156; пользовательские интерфейсы — #159. Нельзя объявлять сохранение notice доставкой в LLM или остановкой процесса. Новые model/session/runtime/plan/workflow сущности не создаются заранее ради пустых ссылок.

## 2. Выбранный подход

| Подход | Решение |
| --- | --- |
| Только live read карточки, памяти и artifact paths | Не обеспечивает воспроизводимость и допускает неявную смену входов |
| Неизменяемый снимок в project SQLite, связанный с конкретным authority/generation | Выбран: атомарен с grant, сохраняет bytes и использует существующие guards |
| Отдельное файловое хранилище prompt bundles и собственный delivery queue | Не требуется для #148; добавляет второй источник состояния и копирует будущий runtime |

Снимок — структурированные данные с provenance, а не новый произвольный system prompt. Требования, memory bodies и результаты агента не превращаются в права, user receipt, выполненные checks или команды controller. В составе пакета явно различаются требования, принятые правила и справочные данные. Противоречащие rules сохраняются все, без «узкий scope побеждает». Семантический анализ конфликтов и получение решения относятся к #110/#155; сборка не выдаёт certificate согласованности или разрешение workflow.

## 3. Состав снимка

Пакет содержит schemaVersion, project/task/work-item/run/authority ids, generation, время, inputHash, manifest, обязательные секции и выбранные дополнительные знания. Сериализация и порядок детерминированы. inputHash вычисляется по canonical payload без самого поля inputHash и покрывает фактически сохранённые данные и бюджет; token, token hash и private native config отсутствуют.

**Требования.** Полные title/body и criteria id/text основной карточки либо parent + subtask, соответствующие taskContractHash #146. У modeled work item сохраняются его revision, inputsHash, definition и объявленные sourceTasks с их точными contracts. SourceTasks нужны как явно объявленные входы работы; они не расширяют область memory до чужой основной задачи. Пустые body сохраняются как null. Business status, checkbox checked/evidence и комментарии не выдаются за требования или pass; прежние поля ответа get_context имеют историческое значение на момент снимка.

**Обязательные правила.** Полные title/body всех применимых active rule из #147: project → task либо project → parent → subtask. Набор применяется после проверки authentic store, task membership, repository bindings и точной commit applicability. Для каждой записи сохраняются entry id, revision, content hash, scope, repo/commit, source и author. Ни query/top-k, ни факт наличия дочернего правила не снимают parent rule. Candidate, withdrawn и superseded не становятся обязательными.

**Зависимости.** Только точные result ids, уже закреплённые #146 за revision/owner, с edge key, producer revision, kind, version, repo, payload hash и доказанным результатом. Нельзя брать «последний похожий» output вместо pin. Contract включает проверенные UTF-8 bytes документа и его SHA256; code — head и доказательство присутствия в base; merged — точные head/base/target и acceptance/merge refs; readiness — resource/config/scope/capabilities, confirmation/probe refs и срок действия. Чужой repo может дать contract/readiness, но его код не объединяется с frontend branch. Raw report не публикует dependency result.

Contract artifact читается только по опубликованному, разрешённому dependency result. Не принимаются directory/symlink/hardlink alias, DB/WAL/SHM, credential/config/runtime files и произвольный путь из запроса get_context. Проверяются canonical path, тип, размер, UTF-8, известные secrets и hash реальных bytes; чтение идёт через проверенный file handle без следования подменённому symlink, с проверкой identity. Если нельзя подтвердить безопасный источник, сборка отказывает. Явно защищённый root внутри checkout/filesDir или совпадающий с ним сохраняет запрет; исключение для опубликованных документов действует только для более широкого родительского root. Полные private filesystem paths не возвращаются агенту: публичный manifest содержит logical source/result refs и hashes. Исчезновение или изменение исходного artifact впоследствии делает его pin неактуальным; прежний текст сохраняется для host-аудита.

**Дополнительные знания.** Короткий FTS shortlist active facts/decisions внутри той же разрешённой memory view; сначала scope, затем поиск. Загружаются полные записи выбранных revisions с hashes, без усечения body. Default query строится детерминированно из цели работы; trusted host может передать bounded query и k в существующих пределах #147. Произвольные query/scope/budget через run get_context не принимаются. Не вошедшие optional records учитываются в omitted count; кандидаты и история не инжектируются по умолчанию. Остальные знания доступны через уже существующие scoped core reads; нового MCP recall tool в #148 нет.

**Репозитории и capabilities.** Manifest фиксирует repo ids, canonical binding identity, input commits и write/read classification из реального grant, операции и native config hash. Commit определяется по реальному разрешённому checkout до выдачи authority, а не по branch label или переданному тексту. Unknown/mismatched repo и недоступный commit отказывают. Будущие role/skill/workflow revisions здесь не выдумываются.

Input commit — версия исходного знания, не обещание текущего HEAD результата. При чтении снимка и run memory view используется закреплённый commit. Изменение workspace HEAD не заменяет этот input commit молча и не превращает base fact в факт нового output head. Проверка bindings/object availability остаётся живой; проверки кода зависимости и выбранного workspace/base не ослабляются. Выбор нового base создаёт новые входы, а не редактирует старый снимок.

## 4. Бюджет без потери обязательств

Core устанавливает конечный UTF-8 byte budget, по умолчанию 65536, с тем же жёстким потолком. Trusted host может уменьшить его. Измеряются serialized response и escaped MCP text envelope, включая manifest и служебные поля. Проверка идёт по реально выдаваемым bytes, не string.length или оценке «четыре символа на токен».

Сначала собирается обязательная часть: полные требования, rules и dependency inputs. Если она превышает бюджет или не может быть загружена корректно, вся выдача authority отказывает с безопасной причиной и измеренным requiredBytes/limit. Нельзя заменять обязательный body snippet, ссылкой без загрузки, удалить правило, silently compact или попросить агента восстановить недостающее через recall. Grant, marker, snapshot и события успешной выдачи не создаются частично. Optional знания добавляются только целыми записями в оставшийся бюджет, в устойчивом порядке.

Это byte budget, **не измеренный token count выбранной модели**. #149/#150 обязаны проверить весь итоговый runtime prompt с загруженными Always skills, инструментами и резервом вывода относительно реального model context limit. Неизвестный либо непроверенный лимит не разрешает managed-start. #148 гарантирует отсутствие усечения обязательных входов и отказ при своём cap, не заявляет доказанную вместимость произвольной модели.

## 5. Атомарное хранение и выдача

Добавить migration v17 после неизменённых 1–16: run_input_snapshots с authority_id как PRIMARY KEY/FK на run_authorities, input_hash, payload_json и created_at; CHECK JSON/hash shape, immutable UPDATE/DELETE triggers. Run ids внешнего типа #145 остаются текстовыми ids, а не выдуманными work_items rows. Actual modeled ownership связывается и проверяется по настоящему owner/fence в grant/manifest.

issueRunAuthority собирает пакет из реальных разрешённых входов до mark/grant и сохраняет grant + snapshot + audit receipt в одной immediate transaction. У каждого нового authority/generation ровно один снимок. Повтор выдачи с прежней generation сохраняет существующий отказ CAS, без второго снимка. Rotation создаёт новую generation и новый снимок, не меняя прежний. Изменение входов в callbacks, переполнение, malformed data и отказ наблюдателя откатывают весь переход, включая revocation прежнего grant.

Внешние work-item ids, допускаемые #145, также получают task/parent/memory/repo snapshot; work-item definition/dependencies/owner остаются null/пустыми, а не фабрикуются. Если id существует в work_items, необходим настоящий owner и полная проверка #146; трактовать modeled id как внешний fallback запрещено.

Миграция сохраняет существующие grants и историю, но не выдаёт старым grants выдуманный снимок. Grant без снимка непригоден для дальнейшего run доступа и запуска; trusted host должен подтвердить stop/reconciliation по существующему lifecycle и выдать новую generation. Истечение/revoke/migration само по себе не освобождает writer. Миграция не выбирает работу, не запускает runtime, не импортирует legacy decisions и не меняет mode/status.

## 6. Актуальность и явное обновление

Снимок не пересобирается в get_context. Общая проверка актуальности сверяет contracts и parent membership, modeled work-item revision/owner fence, pinned results и их transitive inputs, readiness expiry, hashes artifact bytes, выбранные memory revisions и полный актуальный набор применимых обязательных rules в закреплённой repo view. Добавление нового rule также делает снимок устаревшим, даже когда старые выбранные ids не изменились. Изменение выбранного fact/decision или его отзыв нельзя замаскировать историческими bytes.

Новый невыбранный optional fact/candidate, комментарий, перестановка карточки, business status и checkbox progress сами по себе не меняют inputHash. Selected knowledge остаётся историческим после правки; наличие старой revision не доказывает её пригодность для продолжения.

Устаревшие inputs блокируют выдачу/использование run authority, launch intent, получение и публикацию результата из run, создание детей из сохранённого BA-report и completion. Проверка распространяется на modeled owner даже если trusted host опустил optional authority field в owned source/launch intent: соответствующий снимок нельзя обойти отсутствием поля. Новый grant не расширяет scope, operations или write rights. Старые generation/credential не оживают после rotation.

Сохраняется проверка stop/handoff #146: stale inputs не блокируют необходимые read-only host diagnostics и доказанную остановку, но не освобождают owner. Невозможность продолжить не равна никогда не запускавшемуся process. Snapshot validity helper не вызывает liveOwner рекурсивно; используется общая проверка уже закреплённых данных.

Trusted host получает два core API: runInputSnapshot(handle, {projectId, authorityId}) читает immutable history; checkRunInputs(handle, {projectId, authorityId}) возвращает current либо update_required с безопасными reason codes, точными изменившимися refs и прежним inputHash. Для memory/rule changes это entryId и previous/current revision + hash (null для отсутствующего ref); разные версии или additions дают разные changeHash, повтор той же проверки сохраняет eventId. Тела записей в notice не попадают. Проверка update_required фиксирует идемпотентное событие run_inputs_changed по authority/inputHash/changeHash, без повторного body или credentials. Повтор той же проверки не создаёт дубль. Guard failure внутри откатываемой transaction не выдаётся за сохранённое notice: controller выполняет checkRunInputs отдельной успешной host operation.

Такое notice означает «изменения обнаружены, требуется явное обновление», а не «LLM уже получил изменения». #150/#155 должны связать его с stop/checkpoint/доставкой и runtime acknowledgment. В #148 прежняя generation не продолжает выполнение с новыми требованиями и не меняет snapshot по ACK агента. Продолжение требует валидных новых входов и новой generation/attempt через будущий lifecycle. Автоматический restart/replan не добавляется.

## 7. Core и scoped MCP

readRunContext требует genuine process-local RunContext, get_context operation, актуальные generation/expiry/revoke/scope/bindings и пригодный snapshot. Возвращает сохранённые bytes/версии, включая прежние поля projectId/taskId/workItemId/runId/generation/task/criteria/decisions и дополнительный inputs с manifest и секциями. Внутренние binding identities/абсолютные checkout paths нужны host для валидации, но не сериализуются в публичную секцию inputs; её logical repo refs достаточно для provenance. Прежние decisions title/slug — историческая справка legacy, не обязательная operational policy; чтение не запускает syncIndex.

Два чтения одной authority при неизменных inputs дают одинаковые данные. После restart новый authentic RunContext с тем же живым token читает тот же snapshot. Legacy formats вне scoped get_context не расширяются. Никакие scope, чужой authority id, refs или новые operations из caller payload не принимаются. Ограниченный grant с get_context продолжает работать; submit_report/request_question остаются отсутствующими.

Исторический snapshot отозванного/stale grant не доступен run для обхода guards; его читает только authentic ControllerHandle того же project store. Ошибки MCP остаются bounded безопасным отказом без закрытых ids, paths или payloads. Более подробная причина доступна trusted host через checkRunInputs. MCP и runtime не получают host handle или методы истории/записи notice.

## 8. Миграция и измеримые проверки

| ID | Требуемое наблюдение |
| --- | --- |
| C01 | Upgrade заполненного v16 + WAL сохраняет прежние tables/rows/ids и читаемый backup; reopen идемпотентен, snapshots пусты, старый binary отказывает |
| C02 | Подзадача получает полные parent + own requirements и project/parent/own rules; sibling/foreign memory и неразрешённый repo отсутствуют |
| C03 | Query/k=1 и большое число optional hits не вытесняют обязательные rules; mandatory overflow отказывает до marker/grant, без частичных rows/events |
| C04 | Contract bytes/hash соответствуют реальному опубликованному artifact; code/merged/readiness сохраняют точные pins, cross-repo не требует merge кода |
| C05 | Missing/cancelled/invalidated/transitively stale result, artifact mutation и readiness expiry блокируют сборку и продолжение |
| C06 | get_context в реальном stdio MCP возвращает сохранённый inputHash/bytes; reopen/restart не читает вместо них новое live body |
| C07 | Правка parent/own/source contracts, выбранной memory revision и добавление/отзыв rule создают update_required; old snapshot неизменен, notice дедуплицирован |
| C08 | Новые optional candidates/невыбранные facts, комментарии и checkbox progress не вызывают скрытой пересборки или ложной invalidation |
| C09 | Stale inputs отказывают в report/result/children/completion/launch; omission authority в owned host call не обходит guard; stop/handoff остаются возможны |
| C10 | Forged/copied/foreign/expired/revoked contexts и прямые UPDATE/DELETE snapshot отказывают; credential rotation создаёт отдельный снимок |
| C11 | Unicode/escaped JSON измерены в bytes; optional knowledge опускается целиком, mandatory data не усечены; known secrets/private source/DB aliases не попадают в snapshot/audit/MCP |
| C12 | Реальные checkout/object/binding проверки закрепляют input commit; HEAD drift не заменяет base fact новым автоматически; выбранный новый base получает новый snapshot |
| C13 | 20 separate-process generation races дают по одному grant/snapshot/event; crash/rollback не оставляет partial issuance или лишний notice |
| C14 | Заполненные #144/#146/#147 данные, legacy backend empty/conflicting decisions и ordinary CLI/MCP/UI сохраняются; старые external ids не обходят snapshot/handoff guards |
| C15 | Fresh full-operations и get_context-only native broker matrices проходят на точных текущих built runtime hashes; native tools не получают DB/snapshot/config access |

Программа выполнена: C01–C15, D01–D12, M01–M14, 20 generation races и обе genuine native-матрицы прошли на одинаковых текущих runtime hashes; exit0. Полные команды, hashes и limitations записаны в [плане](../plans/2026-09-29-run-context.md). Gates реализации: fresh build + plugin sync, tests и отдельный typecheck всех четырёх packages, plugin smoke, compiled-core C01–C15 observations и regressions #145/#146/#147. Тесты core на mock preflight не заменяют реальные native gates. Native fixtures создают обязательные rules до выдачи проверяемого grant либо проверяют отказ новой stale generation; нельзя удалить freshness check ради прежнего fixture порядка. User/host fixture receipts не объявляются настоящим пользовательским approval.

Настоящая доска остаётся schema 13: progress выполняется совместимым установленным MCP, development v17 к ней не применяется. Runtime hashes и producer JSON сохраняются с command exit codes; passing fixtures не объявляют выполненными #149/#150/#155.

## 9. Grounding и второй проход

Recall сделан до references: «контекст», «orchestrator», #11/#103 и завершённые #146/#147. #11 дал требование аудита реально вытянутых входов, #103 — структурированный пакет, бюджет и trust separation. Старые claim/tick и одна WORKER_PROMPT не переносятся; эти карточки не закрываются в рамках #148.

Первый pass: actual fetch origin --prune всех трёх repos, exit 0, checkout не переключались. После ответа core + get_context повторно прочитаны те же источники на зафиксированных обновлённых upstream. Второй pass подтвердил разделение снимка и live scope guard и усилил запрет неявного обновления при compression. Полные citations и verdicts записаны также в карточке #148.

| Референс / commit | Прочитанный источник | Вердикт |
| --- | --- | --- |
| Buzz 12670bd0f037c66a682272bb81c46c3f254fad74; lag/drift 16/16 | crates/buzz-acp/src/scope.rs:30–100; session_model_thread.md:3–5 | Conversation scope отделён от authorization и общей памяти; shared conversation context и relay infrastructure не подходят |
| Control Center a5cda44935f5514459bf9941373918dc5478cdcb; 8/8 | docs/src/content/docs/manual/concepts/memory-knowledge.mdx:45–60,118–133; packages/cc_domain/lib/features/dispatch/domain/usecases/build_memory_context_use_case.dart:28–145; agent-model.mdx:33–58 | Rules отдельно от bounded shortlist полезны; fail-open загрузка, repo boost вместо фильтра и policy injection всем не подходят; index не доказывает загрузку Always skill |
| Hermes d9f6a844c1b3f7168ab261dde8cb9d26ac02d597; 24990/1633 | website/docs/user-guide/features/memory.md:20–65; agent/system_prompt.py:778–833 | Snapshot/budget полезны; memory doc не изменился, но actual code reload при compression противоречит never-changes описанию; implicit refresh и shared mutable Markdown не берём |

Паттерны адаптируются самостоятельно под TypeScript/SQLite. Код референсов не копируется, названия не добавляются в product source/schema/tests/commit trailers.

## 10. Review владельца

На review вынесены: core + existing get_context; atomic per-authority snapshot; полный обязательный пакет и byte overflow refusal; pinned repo view; live invalidation без скрытой пересборки; durable host notice без заявления provider delivery; обязательный новый generation при смене входов; v17 без fabricated legacy snapshots. Владелец утвердил документ bd97d40: «Утверждаю, составь план». План fe97f44 также утверждён: «План подтверждаю, начинай». Реализация и self-review выполнены solo. Fresh build/typecheck4/4, tests1112, plugin smoke/sync и compiled/native gates прошли; пользовательская приёмка ожидается.

Review corrections разрешены владельцем: «Исправь». Приоритет protected roots и точные versioned change refs реализованы и проверены регрессиями, compiled C07/C11 и обновлёнными native gates. Fresh tests1117, build/typecheck4/4 и plugin checks прошли; подробности в плане. Статус — review.
