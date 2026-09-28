# Controller authority и scope запуска

Дата: 2026-09-27. KDD #145, track 6. Статус: **утверждена пользователем; номера зависимых задач исправлены**.

Основания: утверждённый [контракт #143](2026-09-27-kanban-orchestrator-contract-design.md), завершённая [основа store #144](2026-09-27-project-store-foundation-design.md) и [.planning/research/orchestration/ANALYSIS.md](../../../.planning/research/orchestration/ANALYSIS.md). Пользователь выбрал **сначала только Codex на macOS**. Route solo; текущая конфигурация primary разрешена пользователем после неуспешной проверки metadata.

## 1. Результат и границы

Контролируемый run действует только в выданном project/task/work-item scope. Actor обозначает авторство legacy Kanban, а не полномочия. Ни `actor.type=user`, ни KDD_ACTOR/KDD_SESSION, ни reason, новый provider session id или смена транспорта не создают права run, user approval или право менять чужую работу.

145 реализует authority storage/core guards, scoped MCP для run и проверяемый пакет native permissions для Codex/macOS. До выдачи пакета обязательные guarantees проходят реальные probes. Неподдерживаемый runtime/host, расширенный effective profile или failed/inconclusive probe дают отказ, не permissive fallback.

Не реализуются context assembly/input snapshot (#148), профили ролей (#149), start/resume/stop/stream adapters (#150), provisioning/cleanup clone (#151), scheduler/lease lifecycle (#152), DAG/results/questions lifecycle, human acceptance/merge (#158) или новая модель памяти (#147). CLI/MCP/UI для владельца controller появятся в #159. Выдача grant сама по себе не запускает процесс, не занимает writer и не выбирает задачу из backlog.

## 2. Граница доверия

Trusted controller и его KDD broker имеют доступ к project DB; код run и его native subprocesses — нет. Broker принадлежит controller, обслуживает только фиксированный grant и не экспортирует owner/controller methods. Его stdio endpoint может быть запущен Codex как отдельный доверенный MCP process; права native commands не распространяются на него, поэтому каждый broker call проверяется в core.

Controller bootstrap — библиотечная операция доверенного host, не CLI flag, MCP tool или поле запроса. Он получает process-local opaque handle. Core проверяет подлинность handle по собственной регистрации и конкретному connection/store; JSON, копия объекта и `Actor` его не заменяют. Код локального владельца может вызвать bootstrap или изменить SQLite напрямую; защита от владельца машины не заявляется.

Достоверный user-origin поступает через отдельный пользовательский канал trusted controller. Run channel никогда не становится user channel. В 145 нет операции принятия managed result: raw `move/place → done`, включая вызов от legacy user Actor, отклоняется. Проверяемые approvals и соответствующий owner command реализует 158; строка «пользователь сказал принять» не является receipt.

Native helpers не получают read/write к DB/WAL/SHM, registry/catalog, authority bootstrap/config, чужим run dirs, owner credentials и user API. MCP credentials доступны только trusted broker через отдельную конфигурацию/дескриптор, недоступные native file tools; они не включаются в prompt, tool arguments, события, errors, logs или recall. Секрет grant не передаётся в argv. Env native subprocesses не наследует broker secret и переменные инъекции вроде NODE_OPTIONS/GIT_SSH_COMMAND.

## 3. Данные и выдача

Append migration v14; прежние migrations не менять. Две небольшие группы данных:

| Запись | Назначение |
| --- | --- |
| managed_task_policy | task_id FK/PK, human-policy marker, created_at и источник controller instruction; marker остаётся после revoke, смены режима и окончания run |
| run_authorities | authority_id, task_id FK, work_item_id, run_id, generation, expires_at, revoked_at, token_hash, grant snapshot и created_at; уникальная актуальная generation по task/work_item |

Project id берётся из singleton #144 и входит в grant. Work-item/run ids сейчас внешние идентификаторы trusted host: они не объявляются scheduler records, provider sessions или work items, уже созданными в DB. #150/#152 свяжут их со своими durable records. Scope задачи проверяется по реальной tasks row.

Grant snapshot фиксирует разрешённые KDD operations, repo_id/binding, canonical readable paths, workspace write path при наличии и runtime requirements. Неизвестные operations и значения отклоняются. Context-only repo никогда не получает write grant. Implementation grant допускает только уже явно привязанный managed checkout/worktree, без записи в source. Существующие Git common-dir, worktree metadata и repository grants проверяются средствами #144, а не по remote URL или текстовому path prefix.

В начальном варианте project store находится вне выданных checkout/Git common-dir reads. Embedded store внутри такого scope не получает grant: проверенная file-deny модель для embedded stores здесь не заявляется. DB/WAL/SHM с существующим hardlink также дают отказ при выдаче и повторной проверке credential. Это не переносит/не удаляет store и не меняет discovery #144; controller должен выбрать scope, не открывающий служебные bytes.

DB/WAL/SHM должны также находиться вне **всех** writable roots, включая scratch независимо от наличия workspace write grant. Scratch сохраняется в grant и повторно разрешается при каждом credential lookup; отсутствующий scope в старом JSON даёт отказ, а не предполагаемое безопасное значение. Проверка размещения и файловых aliases выполняется до marker/grant/audit side effects.

Bootstrap/issue/protect/revoke доступны только с controller handle. Issue принимает expected generation, увеличивает fence и заменяет прежнее полномочие атомарно; два issuer calls с одним expected fence не получают две актуальные generation. Policy marker добавляется в этой же транзакции. Raw token — 256 random bits; в DB только SHA-256. Token выдаётся broker out of band один раз. Нельзя искать grant по выбранному worker actor id.

Каждый вызов сверяет project, task, work item/run, актуальную generation, expiry, revoke и operation. Проверка и запись выполняются в одной SQLite transaction, не только при MCP initialize. Чужой, неизвестный, просроченный, отозванный или stale token не создаёт side effect. Ответы о недостатке прав не раскрывают token/hash.

Revoke запрещает последующие broker/core calls. Он **не считается остановкой ОС-процесса** и не освобождает writer. Stop/reconciliation перед заменой writer — #150/#152. Истечение authority также не объявляет workspace свободным. В 145 нет синтетических lifecycle states.

## 4. Общий core guard и совместимость

Legacy задачи не становятся managed при migration, смене branch, открытии store или запуске MCP. Их ручной контракт и прежние решения о reason/self-accept сохраняются. Managed marker создаётся только trusted controller при явном поручении. Ручная работа над уже managed результатом не снимает marker.

Core принимает авторство отдельно от проверенного authority context. Context создаётся core после проверки credential; клиент не передаёт готовую запись grant или boolean `trusted`. Run attribution выводится из grant и не переопределяется Actor от клиента. На read paths также проверяются scope/expiry/revoke; полученный при initialize context не является бессрочным разрешением.

Для managed row legacy task mutations без controller authority отклоняются **до** старых checksMove/user/reason shortcuts, DB changes и файловых side effects. Run authority разрешает только узкие операции своего report/question channel; изменение требований/статуса/criteria/lease/config и human acceptance ему не выдаются. Controller operations проходят явные guards состояния; reason — только audit text. Для managed review обязательные checks нельзя объявить выполненными legacy checkboxes.

Guard покрывает все реальные writers, а не только moveTask: edit/comment/block/unblock, move/place, archive/unarchive, links, criteria, attachments, claim/release/reclaim/stop и операции, затрагивающие несколько карточек. `placeTask.orderedIds`, оба конца links, task владельца criterion/file и удаление track с изменением task.track_id проверяются целиком. Legacy queue/reclaim не выбирают protected managed rows. Сначала проверяются все затронутые rows, затем side effects; частичное изменение при отказе запрещено.

Проектные registry/settings/decisions mutations run broker не предоставляет. Прямой CLI/core/SQL запуск из native shell не обходит guard: runtime не даёт доступ к store и защищённой конфигурации. Прямой legacy UI request к managed row тоже не получает authority по одному user Actor. Worker requests к loopback/LAN user API блокируются native network policy; обычные human UI действия над legacy rows сохраняются.

`appendEvent` и существующие audit helpers переиспользуются. Authority events содержат ids/scope/generation/operation/outcome, не credentials. Проверяемые report/question proposals сохраняются как недоверенные сообщения с run provenance; сами по себе не меняют business state, не подтверждают checks и не удовлетворяют dependency. Context snapshot реализует #148, профили ролей — #149, scheduler/recovery — #152; durable questions — #155, независимые checks/review — #157.

## 5. Run MCP

Отдельный scoped server использует существующий MCP SDK и фиксированные db/grant, без выбора произвольного project из входа. Он не переиспользует global update_task как authority surface.

Минимальная поверхность: чтение разрешённого task/context snapshot, submit_report и request_question, каждый только при соответствующем grant. Непредоставленные tools не объявляются; прямой вызов отсутствующего tool тоже не проходит. Get/list чужих задач, чужой project path, actor/reason и вложенные owner commands не принимаются. Snapshot не синхронизирует decisions из workspace; используется общий сохранённый index #144. Новая scoped memory — 147.

Native read-only относится к коду repo; разрешённая отправка review/report/question через broker остаётся явным отдельным grant. Она не даёт права редактировать карточку или code. Worker результат не превращается в system check или user decision при сохранении.

Native preflight берёт operations из действующего authority. Каждая предоставленная операция проверяется положительным вызовом; отсутствующая не объявляется и её навязанный native tool call должен отказать без записи. Registry допускает только выданные business tools и закрытый набор встроенных adapters. Live revoke проверяет все предоставленные операции в уже initialized session, включая grant только с get_context.

Global manual MCP остаётся прежним. Protected tasks не меняются через него без controller context. Настоящая доска разработки не мигрируется новым бинарником; все новые runtime проверки выполняются с изолированными temp Git/SQLite/stores.

## 6. Native Codex/macOS

Использовать установленный Codex permission profile и его macOS Seatbelt enforcement, не новый sandbox engine или command-string blacklist. Проверенная исходная версия: codex-cli 0.157.0; version меняет applicability evidence и требует новый preflight. Наличие executable или название read-only не является proof.

Profile начинается с минимальных системных reads; конкретные repo/workspace roots открываются явно. Read-only не допускает изменения существующих файлов, create/delete/rename или запись через symlink/hardlink. Workspace-write открывает только выделенную рабочую копию implementation repo и отдельный scratch dir. Source, context-only backend, sibling workspace, Git metadata/refs/object store и служебные данные остаются закрыты для записи. Git mutation принадлежит trusted controller будущих workspace/integration операций; run может читать Git и править выданные продуктовые файлы, но не перемещать чужие refs.

Для final broker profile закрытая registry учитывает три встроенных Codex MCP resource adapters: `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`. Codex 0.157.0 добавляет их при любом configured MCP server ([official implementation](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/core/src/tools/spec_plan.rs#L1091)). Scoped broker не объявляет resources/templates и не реализует их чтение. Preflight реально проверяет пустые общие lists, отказ foreign server и отказ private config URI в обоих filesystem modes; ненулевой resource payload либо неизвестная surface не допускают package. Это не дополнительные broker business operations: их по-прежнему ровно три, с strict schemas и fresh authority lookup. MCP annotations правдивы: context readonly; reports/questions — недеструктивные closed-world записи untrusted events. Server approval mode `auto` не заменяет core authority и не выдаёт owner/user права.

Дополнение, разрешённое пользователем после первого gate: **во всех effective writable roots, включая scratch/TMPDIR, не допускаются существующие файлы с nlink > 1**. Preflight обходит дерево через lstat без следования symlink за пределы roots; найденный hardlink, недоступный/исчезнувший entry, неизвестный root или невозможность полного обхода дают отказ до создания Codex process. Symlink не расширяет effective writable roots: его target остаётся под native path policy; все writable targets должны быть в явно проверенном наборе. Безопасность existing hardlinks обеспечивается отказом launch, а не недоказанным свойством Seatbelt.

Проверка повторяется непосредственно перед **каждым start/resume**, даже если ранее получен verified package. Trusted controller берёт общий project control lock, проверяет identities/canonical roots/config и nlink, вызывает spawn без callback/await между последней проверкой и созданием процесса и удерживает lock до подтверждения spawn. Любые controller filesystem/config/binding mutations обязаны брать тот же lock; они не могут вклиниться между check и launch. Lock хранится вне writable roots и недоступен native tools. Busy/stale lock не обходится по таймеру; неизвестная ownership означает fail closed. Start/resume требуют отсутствия старого writer (#150/#152); guard не реализует lease/stop вместо этих задач. Все действия после start также должны сохранять условие безопасных roots; controller не может внедрить hardlink в root активного run.

При каждой проверке пакет заново разрешает canonical Git dir/common-dir всех readable repositories и сравнивает их с путями исходной native policy. Смена linked-worktree `commondir` инвалидирует пакет, даже если старые directory identities и `.git` pointer не изменились. Для start/resume с новыми Git bindings необходим новый preflight; проверка не подменяется хешем старых путей.

Обновлённая матрица отдельно доказывает отказ unsafe workspace/scratch **до actual tool execution**, и actual native запрет создания новых hardlinks из readonly/denied roots, включая destination scratch. Symlink inconclusive закрывается парным экспериментом на том же target: положительный write-control в отдельной fixture policy и отрицательная попытка в readonly policy через реальный apply_patch, с совпадающими filesystem inputs и подтверждёнными hashes. Расширенная control policy не выдаётся run. Generic failure без такого control по-прежнему inconclusive. Tasks 2–6 остаются остановлены до полной зелёной обновлённой матрицы.

Custom profile не смешивается с --sandbox/sandbox_mode/sandbox_workspace_write: Codex может предпочесть legacy policy и проигнорировать custom profile. Контролируемый пакет использует изолированную конфигурацию без загрузки user/project config и rules, выбирает конкретную policy и approval=never, запрещает дополнительные writable roots и расширение permissions. Не переиспользовать текущие permissive настройки интерактивной сессии.

Native command network отключён в первом варианте 145: build/test могут работать с установленными dependencies. Profile не выдаёт loopback/LAN/Unix socket access, чтобы shell не дошёл до пользовательского API или чужого broker. Model service connection и fixed stdio MCP — отдельные соединения, не blanket разрешение shell network. Network-enabled implementation требует отдельного подтверждённого policy/evidence в последующей работе; нельзя молча запускать install или расширять сеть. Read-only проверяет кодовые roots; приватный scratch может быть writable, не открывая repo или store.

Конфигурация разрешает только фиксированный run MCP. Hosted web search, apps/connectors, browser/computer use, пользовательские MCP/plugins/hooks и native spawning других агентов не включаются. Если выбранный runtime не позволяет доказать отключение поверхности или соблюдение запрошенного tool grant, preflight отказывает. Shell и apply_patch проверяются по разрешённым эффектам/path scope, даже если сам tool присутствует в native registry.

Preflight строит grant/config hash, разрешает realpath executable и roots и выполняет challenge в отдельном временном fixture. Он проверяет positive reads, разрешённую workspace write при таком grant и negative writes/reads/network. Для native apply_patch нужна проверка через **реальный Codex tool path**, не только Node fs под похожим profile. Допускается детерминированный локальный fixture provider для вызова tools без внешнего LLM; если actual tool path не выполнен, evidence incomplete и criterion 395 не отмечается.

После probes проверяется тот же effective config/cwd/roots/tool surface и runtime executable/version; пакет пригоден только для этого сочетания. Проверка не является разрешением стартовать произвольный run. 150 обязан использовать этот builder/preflight и тот же фиксированный пакет, без поздних флагов или config overlays, расширяющих права. Изменившийся hash или недоступная enforcement делает пакет непригодным.

Builder и native fixture используют общий template permissions/config/catalog. Catalog фиксирует закрытую tool metadata для выбранного trusted model id; выбор модели остаётся #149. Разрешение существует только как зарегистрированный process-local frozen object: копия или сохранённый JSON не удостоверяют запуск. Проверка под controller lock повторно сверяет identities roots/protected paths, bytes executable/runtime/catalog и отсутствие project config overlays. Codex 0.157.0 не отключает все project layers через `--ignore-user-config`, поэтому существующий `.codex/config.toml` в cwd или его предках означает отказ. Native write в workspace `.codex` закрыт отдельным read override. Adapter #150 обязан передать exact argv/env/cwd/writable roots из пакета и единственный positional prompt после `--`; поздние flags или injection env отказаны до child creation.

## 7. Наблюдения при реализации

| Сценарий | Evidence |
| --- | --- |
| v13 → v14 | Все прежние ids/rows/criteria/events/decisions сохранены; WAL-aware backup читается как v13; 0 managed markers/grants/auto-start без поручения |
| Forged actor/reason | Из core/CLI/global MCP/UI попытки менять protected task через user Actor, reason, другую session отклонены; rows/files/claims до/после совпадают |
| Run scope | Чужие task/project/operations отклонены; разрешённый report/question сохраняет выданный run provenance, не claimed user attribution |
| Multi-row side effects | Чужой orderedIds/link endpoint/criterion/file/track mutation отклонён до первого side effect |
| Fence/expiry/revoke | Два concurrent issue с одним expected generation дают один новый grant; stale/expired/revoked calls не записывают данные |
| Scoped MCP protocol | Реальный initialize/tools/list/call через SDK: нет owner tools; missing/forged/foreign calls отказаны; global manual surface сохранена |
| Native read-only | Реальные Codex shell и apply_patch не создают/заменяют/удаляют code; 3/3 повторения запрещённых writes; positive read успешен |
| Native workspace scope | Выделенный product file writable; source/backend/sibling/store/config/Git refs неизменны; symlink/hardlink/rename не обходят запрет; loopback write endpoint недоступен |
| Fail closed | Неверный host/version/config, legacy override, недоступный sandbox или неполный probe не дают пригодный launch package |
| Legacy | Прежние manual acceptance/reason правила и обычные UI/CLI/MCP flows проходят свои tests; защита decisions #144 сохранена |

Build и typecheck отдельно от tests. Собранные CLI/MCP и runnable observation script проверяются на temp fixtures. В комментарий задачи идут числа успешных/отклонённых попыток, версии, hashes и commands. Нет утверждения, что эти будущие проверки уже выполнены.

## 8. Два прохода references и решения

Recall выполнен первым: append-only decisions и legacy self-accept не переписываются. #14/#44 подтверждают пользу scoped tools и отсутствия лишних writes; #49 injection marking не заменяет authority; #67 не принимается как разрешение push; #125 reason escape не переносится на managed authority.

Actual fetch 2026-09-27: Buzz b0d6fb8a → b0d6fb8a, 0 commits; Control Center 9e567c86 → d0684d2a, 3 commits. Checkout не переключались. Первый проход: execution scope не является authorization, MCP grants не ограничивают native tools. После выбора Codex/macOS второй проход: общий resource guard плюс отдельная native policy остаются применимы; внешний permissive sandbox и bypass defaults не берутся. Код не копируется.

Citations: Buzz scope.rs:87–96/config.rs:460–472 @ b0d6fb8a; Control Center permission_resolver.dart:110–143, mode_capability_profile.dart:173–229 и macos_sandbox.dart:47–120 @ d0684d2a. Полные clone paths и verdicts записаны в #145. Основной контракт принадлежит KDD #143, не reference product.

Рассмотренные варианты: (1) Actor/env/текстовые инструкции — не удостоверяют полномочия и не закрывают native shell; (2) controller-issued capability + core guard + scoped broker + native Codex policy — выбран; (3) новый собственный sandbox/container engine — не требуется для выбранного macOS runtime, не добавляется.

Официальные первичные источники: [Codex profiles и границы поверхностей](https://learn.chatgpt.com/docs/permissions), [apply_patch safety установленной версии](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/core/src/safety.rs#L24), [Seatbelt установленной версии](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/sandboxing/src/seatbelt.rs). Локальные --help прочитаны до документации; `codex sandbox [COMMAND]` — актуальная форма, `codex sandbox macos` не существует. Документация и source — основания design, evidence исполнения будет получено отдельно.

## 9. Handoff

Пользователь утвердил спецификацию и порядок реализации: сначала реальные Codex native tools проверяют enforcement, затем реализуются authority и scoped MCP. План solo: [2026-09-27-controller-authority.md](../plans/2026-09-27-controller-authority.md). Если реализация выявит, что выбранный Codex не обеспечивает обязательный native scope, 145 остаётся незавершённой: limitation фиксируется, права не расширяются автоматически.

## 10. Измерение первого native gate

2026-09-27, macOS 26.5.2, codex-cli 0.157.0: gate **не пройден**. [Runnable check](../../../.planning/research/orchestration/codex-native-check.mjs), [evidence](../../../.planning/research/orchestration/codex-native-evidence.json). Provider локальный, исполнялись настоящие advertised `exec_command` и `apply_patch`, без внешней модели.

В расширенной матрице выполнены 50/50 tool calls. Readonly create/update/delete через каждый tool отказаны 3/3. Workspace product writes разрешены; backend direct writes, Git refs, защищённые reads, TCP loopback/LAN и Unix socket отказаны. Но **заранее созданный hardlink в writable workspace позволяет обоим tools изменить файл readonly backend**. Отдельная серия подтвердила изменение чужих bytes 3/3 для shell и 3/3 для apply_patch. Политика называет backend readonly, однако существующий inode доступен через разрешённый alias. `realpath` не обнаруживает hardlink.

Создание нового hardlink к backend через native `ln` отказано в обоих режимах. На момент первого gate fail-closed preflight, отказывающий writable roots с existing hardlinks, **ещё не был реализован и доказан**. Apply_patch symlink-write также не изменил backend, но generic `Failed to write file` был классифицирован как inconclusive, а не доказанный permission denial.

Выявлена дополнительная особенность tool surface: `features.multi_agent=false` не убирает collaboration tools при model metadata `multi_agent_version=v2`. В fixture закрытая registry получена фиксированным catalog с `multi_agent_version=disabled` и отключением `tools.experimental_request_user_input.enabled`; final registry содержит только exec_command/write_stdin/apply_patch. Настройки и executable SHA-256 зафиксированы в evidence. Вывод относится к этому проверенному сочетанию, не ко всем Codex profiles/models.

По обязательному gate task 1 tasks 2–6 не выполнялись: production core/schema/CLI/MCP/UI не менялись, пригодный launch package не выдан, критерии #394/#395 остаются unchecked. #145 не завершена. После этого измерения пользователь разрешил fail-closed дополнение раздела 6: все writable roots без nlink > 1, повторный check перед start/resume и исключение controller mutations между check и spawn. Исторический raw repro сохраняется; обновлённый gate не объявляется зелёным до новых измерений.

## 11. Дополнительный guard и обновлённый research gate

Коммит a4b8ac7 реализует nlink guard и protected controller lock. [Обновлённое evidence](../../../.planning/research/orchestration/codex-guarded-evidence.json): 125/125 actual Codex tool calls, 5 ожидаемых отказов до child creation и 3 положительных host controls для тех же network commands. Symlink apply_patch закрыт парными controls 3/3; protected hashes вне отдельных положительных controls неизменны. Core tests 417/417, общий suite 910/910, build/typecheck/plugin проверены.

Это прохождение дополнительного research gate, не завершение #145. Reusable builder обязан сам выполнить матрицу, выдать process-local package и доказать отказ при изменении bindings; final broker proof — task 5. Tasks 2–6 не начинались до завершения task 1. Historical raw escape не считается исправлением Seatbelt: launch отказывается при existing hardlinks, новые links запрещает native policy.

## 12. Reusable package: проверенный Task 1

[Общая native матрица](../../../.planning/research/orchestration/codex-native-package-evidence.json) прошла 129/129 actual tools, включая запрет shell/apply_patch создавать workspace `.codex/config.toml`: 0 failed/inconclusive, 5 отказов до child creation, 3 host network controls. Runtime SHA-256: `42da01b849103b53ca2461ef895fe2ed79e0f96bc6e24f1abf2afb6e8b48d64e`. Shared construction использует built-in openai provider; локальный fixture endpoint меняет только model responses.

[Реальная выдача пакета](../../../.planning/research/orchestration/codex-package-evidence.json): 124 native results без 5 отдельных control policies (14 allowed, 110 denied); все executed и protected bytes неизменны. 10/10 проверок package issuance/immutability, JSON/object copy, argv/env expansion, late hardlink/resume, project config/catalog/protected file/root replacement прошли. Первый package script ошибся при cleanup каталога уже после успешной выдачи/отказов; исправлен и полностью повторён, exit0.

13 focused tests, 421 core tests и общий suite 914/914 прошли; build/typecheck4/plugin fresh-install проверены. Один MCP test превысил timeout при конкурентном suite, отдельно прошёл за 1.06s; последовательный полный suite зелёный. Task 1 завершён, user-imposed gate открыт; native-only package ещё не является final broker proof task 5 и не завершает #145.

## 13. Финальный пакет с broker

[Runnable check](../../../.planning/research/orchestration/codex-broker-check.mjs) и [актуальное full-scope evidence](../../../.planning/research/orchestration/codex-broker-evidence.json): native-only preflight129, final broker preflight158, independent post-rotation29; exit0, 12/12 package checks. Final package содержит153 normal cases без5 отдельных positive controls:24 allowed,129 denied, все executed и protected bytes unchanged. После перевыдачи generation2:29/29 cases (10 allowed,19 denied),0 failed/inconclusive; все три actual outputs после live revoke отказывают get_context/submit_report/request_question. Generic resource adapters возвращают empty lists и отказывают private URI/foreign server; credentials и store недоступны native shell/apply_patch.

Codex0.157.0/macOS26.5.2; executable SHA-256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`, проверенный core runtime `e0177701fdd7147af667b4f51eb028f0e7c77b5b6d7bdf7b74b169728e0a6251`. JSON-copy, public broker binding change, legacy sandbox override, late private hardlink/resume и common-dir drift/start/resume отказаны. Настоящий пакет отказывает issue для SQLite в scratch без новых marker/grant/events. Token rotation сохраняет public binding и отзывает старый credential. Полный lifecycle остаётся #150; другие runtime/hosts не подтверждены.

[get_context-only evidence](../../../.planning/research/orchestration/codex-context-evidence.json) получено отдельным полным запуском на том же runtime:129→158→29,12/12 checks,153 normal cases (20 allowed,133 denied), final29 (6 allowed,23 denied). Registry содержит только7 tools, включая единственный business tool get_context. Во всех четырёх попытках report/question actual Codex dispatcher вернул unsupported call, events не изменились; после live revoke get_context отказал. Calibration не выдаёт package и не заменяет эти production preflight проверки.

## 14. Финальная проверка transports и compatibility

[Authority observations](../../../.planning/research/orchestration/authority-evidence.json):7/7, core/собранный CLI/stdio global MCP/реальный HTTP UI,0 изменений rows/blob при отказе; обычные legacy операции разрешены. #144 project-store check:8/8, включая backend с пустым/конфликтующим decisions и восстановление registry. Общий suite937/937 (core437,MCP75,UI211,CLI214), build/typecheck4/plugin fresh-install прошли. Criteria394/395 отмечаются как AI после fix commit; основная доска остаётся schema13, все новые fixtures schema14. Готовность к review не является human acceptance или разрешением закрыть карточку.

## 15. Исправление после review

Review выявил P2: сохранённые directory identities и hash `.git` pointer не замечали смену linked-worktree `commondir`. Общая проверка пакета теперь заново разрешает Git bindings перед выдачей authority и каждым start/resume. Regression test сначала воспроизвёл принятие stale packet (RED), затем прошёл с отказом обоих launch phases (GREEN); только медленная native matrix замокана в unit test, Git/filesystem и guards настоящие.

Для того исправления на свежей сборке полностью повторён actual129→156→27. Runnable broker check использует linked worktree и настоящий verified package: common-dir меняется под controller lock, start/resume отказывают до child creation; после восстановления исходного binding пакет снова valid. Все11 assertions прошли; эта серия и Task1 evidence остаются историческими, актуальный runtime hash/evidence приведён в §13.

## 16. Исправление private scratch и operation-aware matrix

После squash d14764a воспроизведены оба замечания. P1 unit RED выдал authority для настоящей SQLite в scratch в обоих modes; замокана только медленная native matrix, branded packet/Git/filesystem настоящие. Общий privateStore теперь проверяет DB/WAL/SHM относительно всех writable roots до marker/grant; scratch сохраняется в grant и заново разрешается при каждом lookup. Sidecar symlinks/hardlinks и старый grant без scratch отказывают. GREEN включает повторный lookup после подмены scratch и реальные package checks из §13.

P2 actual Codex calibration с get_context-only на прежней сборке остановилась на missing submit_report (executed7/attempted8, exit1). Матрица теперь получает operations из настоящего authority, проверяет разрешённые операции и отказ actual dispatcher для отсутствующих, включая отсутствие side effects. Live revoke проверяет все выданные operations в одной initialized session. Calibration GREEN29/29 дополняют два полных package proofs из §13; raw RED сохранён в локальном review ledger.

Два прохода references для fix: Buzz b0d6fb8a без изменений; Control Center actual fetch 9e567c86→b9fc708c (behind4). permission_resolver.dart:108–143 и macos_sandbox.dart:47–76 подтверждают отдельные resource scope и operation grants; permissive temporary-directory policy не переносится. Новые зависимости и модель памяти не добавлены.
