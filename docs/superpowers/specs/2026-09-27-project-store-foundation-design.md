# Project store: идентичность, привязки и миграция

Дата: 2026-09-27. Задача KDD: 144. Статус: **подтверждено пользователем с поправкой о legacy decisions; поправка включена**.

Основание: [контракт 143](2026-09-27-kanban-orchestrator-contract-design.md), [анализ](../../../.planning/research/orchestration/ANALYSIS.md), существующие `paths.ts` и `db.ts`.

## 1. Результат и граница

Одна доска сохраняет свои SQLite-файл, ids, историю и attachments. Независимый clone и его linked worktrees получают эту же доску только после явной привязки. В исходных checkout не появляются обязательные файлы, Git config или служебные refs.

Уточнение пользователя для 144: «Основа store сейчас, остальные таблицы в своих задачах». Это уточняет распределение физической схемы из §4 контракта 143: здесь реализуются project identity, repository records, checkout bindings и безопасная миграция. Таблицы requirements/plan/work items, памяти, ролей, sessions/attempts, workspace, вопросов и результатов добавляются с соответствующим поведением последующих задач. Логические связи и ограничения 143 сохраняются.

144 не запускает controller, не создаёт managed clone и не меняет legacy driver. Создание и безопасный lifecycle clone остаются задачей 151; полномочия — 145; подзадачи и execution mode — 146. Новая availability выключена, default manual. Это данные основы, а не работающий переключатель автономии.

## 2. Выбранный способ хранения

Стабильный локальный project_id хранится в текущей SQLite проекта. Каталог `KDD_HOME/<старый hash>/` и UI address `<hash>` сохраняются. Смена пути не пересчитывает project_id.

Авторитетные repo/binding records находятся в той же базе. Небольшой `KDD_HOME/registry.db` индексирует канонический git-common-dir → project_id/db_path/repo_id и обеспечивает уникальность привязки между stores на этой машине. Это locator, а не вторая доска: задач, запусков и знаний в нём нет.

Альтернатива без registry потребовала бы полного обхода всех баз при каждом запросе и не обеспечила бы атомарную проверку конфликтующих регистраций. JSON registry потребовал бы собственного межпроцессного lock и восстановления записи. SQLite уже установлена и предоставляет transaction/unique constraint; новых зависимостей нет.

Локальные ids — непустые случайные 128-bit hex strings, созданные один раз; remote, HEAD и путь их не определяют. Внутри project store нет необходимости добавлять project_id в каждую старую task: весь файл принадлежит одному project.

## 3. Минимальная схема

Append-only migration после существующей v12 добавляет:

| Таблица | Поля и ограничения |
| --- | --- |
| project | singleton key = 1; unique project_id; primary_repo_id FK; legacy_decisions_dir; autonomy_enabled = 0; default_execution_mode = manual; created_at; CHECK допустимых значений |
| repositories | repo_id PK; purpose; access `context_only` или `implementation`; optional remote metadata; created_at; remote не является credential или identity |
| repository_bindings | canonical common_dir PK; repo_id FK; checkout_path; kind `source` или `managed`; created_at; индекс repo_id |

Несколько bindings одного repo_id описывают один source и его независимые managed clones. Второй source для того же repo_id отклоняется; перенос исходного checkout выполняется через rebind. Дополнительный backend/frontend repo получает отдельный repo_id в том же store. Его разрешение доступа фиксируется явно; binding не является runtime capability и не разрешает запуск исполнителя.

Base/target/head не записываются как якобы выбранные execution inputs: их фиксируют будущие workspace/snapshot records по repo_id. В 144 нет синтетических attempts, approvals, requirements revisions или результатов старых задач.

Registry имеет собственную schema version и таблицу bindings с common_dir PK, абсолютным db_path, project_id и repo_id. Более новая неизвестная версия registry, как и project DB, вызывает явную ошибку. Все соединения закрываются при ошибках.

## 4. Поиск и регистрация

`KDD_DB` сохраняет приоритет и прежний смысл явного override. Он не переопределяет registry binding текущего checkout и не регистрирует произвольный cwd как source. Тестовые `:memory:` stores не регистрируются.

Обычный поиск:

1. Git возвращает абсолютный git-common-dir; существующий путь канонизируется через realpath. Linked worktrees и symlink-пути получают один ключ.
2. Registry hit проверяется по существующему файлу, project_id и авторитетной binding record в целевой базе. Проверка read-only, без миграции чужой доски. Missing file, identity mismatch, unknown schema или несовпадающая запись возвращают ошибку, без fallback к новой DB.
3. При registry miss проверяются авторитетные bindings уже существующих stores и legacy `meta.project_path`. Единственное совпадение восстанавливает locator; несколько совпадений требуют явного решения, без выбора первой базы. Обход нужен только для восстановления и первого открытия старого store.
4. Если совпадений нет, сохраняется legacy hash-путь. Для совместимости проверяется существующий каталог, вычисленный из исходного Git common-dir до realpath; канонизация не должна скрыть старую DB. Только отсутствие прежнего store и привязки допускает создание нового project.

Повреждённый registry или недоступный кандидат на восстановление не трактуется как «нет доски». Ошибка чтения при discovery сообщается явно: неполный обход не доказывает отсутствие прежнего store. Remote URL никогда не используется для автоматического подключения.

Для legacy KDD_DB сохранённый checkout path нормализуется Git-командой, без назначения произвольного cwd нового override. Прежний внешний источник решений восстанавливается из путей существующего legacy index; для пустого индекса explicit directory принимается при upgrade из подтверждённого source caller, а не из backend.

После открытия старого store миграция и bootstrap создают один project_id и исходный repo/binding из сохранённого `meta.project_path`, если Git-путь доступен и валиден. Отсутствующий старый путь не мешает сохранить DB и identity; его подключают явной rebind. Новая база получает source binding из проверенного Git checkout. Повторное открытие не меняет identity и не добавляет дубликаты.

Регистрация alias принимает целевой существующий store, repo_id, checkout и kind. Проверяет Git, канонический common-dir, принадлежность repo к store, identity и конфликт с existing registry/legacy store. Если у нового clone уже есть своя доска, она не скрывается привязкой к другой. Никакого `--force` для молчаливой смены владельца.

Межпроцессная регистрация сериализуется write transaction registry. Под этим lock повторяется проверка авторитетных bindings; запись проекта и audit event коммитятся сначала, locator — затем. Два WAL-файла не объявляются crash-atomic. Crash между commit оставляет авторитетную binding, которую обнаружит восстановление при miss. Повтор операции с теми же аргументами идемпотентен; успешный ответ выдаётся только после обоих commit. Конкурирующий другой owner получает конфликт, включая случай незавершённой предыдущей регистрации.

Rebind после переноса явно заменяет старый common-dir новым для выбранного binding, сохраняя store/repo/project ids; новый путь проверяется теми же правилами. Audit содержит прежний и новый путь. Stale locator после crash обнаруживается проверкой авторитетной записи и сообщает необходимость повторить rebind; не подключает путь к другой доске. Уже открытые клиенты перед rebind останавливаются: существующий connection не меняет owner по новой записи registry.

## 5. Core и пользовательская поверхность

Core предоставляет чтение project identity/repositories/bindings, явные register/rebind операции и общий поиск store. Мутации получают Actor, валидируют вход и пишут событие в project DB в одной транзакции с изменением. Имена и ids проверяются; вызывающий не передаёт произвольный SQL или готовую запись registry.

CLI получает минимальные `project show`, `project bind` и `project rebind` с JSON-ответом. Bind указывает checkout, целевой project store и существующий repo_id; отдельная явная операция добавляет дополнительный repo с purpose/access. Команды реализуют тонкие адаптеры core. Binding managed означает роль пути в данных, а не доказательство независимости Git objects — это проверяет 151 при создании clone.

Новые write tools MCP и UI-формы управления repos в 144 не добавляются. Существующие CLI/MCP/UI операции из связанного clone должны открывать ту же DB. MCP list_projects использует bindings, включая доступные managed worktrees, а не только `meta.project_path`. UI сохраняет прежние hash identifiers и показывает один project на store. Непривязанный независимый clone сохраняет независимую доску.

`meta.project_path` и `project_toplevel` не перезаписываются путём managed clone; legacy scheduler не перенаправляется на него. Открытая MCP-сессия не обещает обновления закэшированных contexts после rebind — требуется restart.

### Защита общего legacy decisions/search index

`primary_repo_id` устанавливается при bootstrap из первоначального source проекта, а не из первого дополнительного checkout, вызвавшего recall. `legacy_decisions_dir` фиксирует каталог решений относительно канонического source checkout; явно настроенный внешний каталог сохраняется через realpath. Bootstrap не превращает существующий foreign symlink в разрешённый внешний источник. Bind дополнительного repo или managed clone не меняет этот источник. Недоступный старый source не заменяется backend-каталогом: до явного восстановления источника сохраняется прежний индекс.

Core проверяет источник до изменения decision rows и decision-части FTS. Источник допустим, если каталог принадлежит первоначальному source common-dir основного repo (включая его linked worktrees) либо совпадает с зафиксированным внешним legacy_decisions_dir. При явно выбранном внешнем каталоге он остаётся единственным источником синхронизации: основной default-каталог не является fallback. Default-каталог всегда проходит проверку Git-владельца, даже при точном совпадении пути. Проверка учитывает realpath и существующего предка отсутствующего каталога; symlink в чужой repo не авторизует его. Сам repo_id managed clone не даёт права заменять общий индекс своей веткой.

Для дополнительного backend/frontend repo и managed clone `recall`, `show/get_task`, `decision` и export читают уже общий decision index, не синхронизируя его из переданного `.planning/decisions`. Task-часть FTS продолжает обновляться по events. Пустой каталог не удаляет решения; файл с совпадающим slug не заменяет content/title/hash/path/provenance или FTS основного проекта. Защита находится в общем core write-path `syncIndex`, а не только в CLI/MCP path resolver.

`rebuild` из неавторитетного каталога отклоняется до любых DELETE; `addDecision`/supersede — до записи файлов или индекса. `KDD_DECISIONS_DIR` на дополнительном checkout само по себе не назначает новый источник. `KDD_DB` также не снимает проверку источника выбранного store. Из основного source прежняя синхронизация сохраняется, включая обновления из его linked worktree; branch-independent memory и отдельные знания backend остаются следующим задачам.

## 6. Миграция и сохранность

Не менять существующие MIGRATIONS и не перемещать DB. Использовать имеющийся WAL-aware `VACUUM INTO` backup; ошибка backup прекращает upgrade. Перед upgrade остановить старые долгоживущие writers: schema-version guard не защищает уже открытый connection.

Новая миграция сохраняет все старые таблицы и строки: task/status/claim, criteria/evidence, comments, links, events/provenance, tracks, files, decisions и search index. Новые проектные записи добавляются без выдуманного user approval. Schema guard старого бинарника после upgrade должен отказывать. Повторное открытие не создаёт второй identity/source binding.

Backup project DB не объявляется backup всего проекта. Проверка фиксирует inventory attachments/knowledge/workspaces и их сохранность без копирования или cleanup. Registry — восстанавливаемый locator; восстановление project DB выполняется при остановленных клиентах вместе с проверкой registry identity, а не автоматическим overwrite или удалением новых данных.

## 7. Наблюдаемые проверки

Проверки выполнены; измерения и уточнения реализации записаны в [implementation plan](../plans/2026-09-27-project-store-foundation.md#execution-result--2026-09-27).

| Сценарий | Наблюдаемый результат |
| --- | --- |
| Upgrade заполненной v12 DB с WAL | Все прежние строки и ids совпадают; backup читается как v12 и содержит последние WAL-данные; files/knowledge/workspaces не изменены |
| Reopen/две регистрации | Один project_id, один source binding; одинаковый alias идемпотентен; конкурирующие разные owners не получают два успешных назначения |
| Source → independent clone → linked worktree | После bind одинаковые DB/project/repo ids; task mutation из worktree видна из source; до bind clone не подключён автоматически |
| Symlink/перенос/separate-git-dir | Канонические bindings устойчивы; старая hashed DB остаётся доступна; перенос требует явной rebind |
| Registry missing/crash gap | Binding восстанавливается из project DB, без новой пустой доски; stale/mismatched/повреждённая запись возвращает ошибку |
| Override и конфликт | KDD_DB сохраняет приоритет; clone с собственной доской не перепривязывается молча |
| Три поверхности | CLI/MCP из alias и UI старого store показывают одну задачу; MCP перечисляет доступный alias; UI address сохраняется |
| Backend recall: пустой/конфликтующий decisions | Оба recall возвращают решения основного проекта; все decision rows и decision FTS rows до/после совпадают, конфликтующий slug не заменяет title/body/hash/path/provenance; task FTS обновляется |
| Общий core write-path | Прямой syncIndex и CLI/MCP recall из backend защищены; чужой rebuild/addDecision отклоняется до удаления/записи; symlink и override не обходят защиту; primary source по-прежнему обновляет индекс |
| Чистота исходников | Нет новых обязательных файлов, config или refs в source; нет автоматического clone/checkout/cleanup/dispatch |

Запустить целевые tests с реальными temp Git/SQLite, отдельный typecheck и build затронутых packages. Проверить собранный CLI на изолированном KDD_HOME и сравнить идентичность/задачи между source, clone и worktree. Настоящую доску задачи не мигрировать тестовым бинарником.

## 8. Основания и review

Recall 55 подтверждает проблему path identity, но его предложение искать по origin/first commit не принимается: контракт 143 требует явных bindings. Recall 100 относится к происхождению подзадач, отложенному в 146; attempt не используется как project/repo identity.

Actual fetch reference clone 2026-09-27: local `4deb7eca8f38`, upstream `d5cbb5380fa0`, отставание 10; upstream после анализа не изменился. Два прохода: сначала workspace/session separation, после уточнения — repository id и per-workspace target. `/Users/magiyar/Projects/My/References/vibe-kanban/crates/db/src/models/repo.rs:38`, `workspace_repo.rs:11`, `workspace.rs:42`, `session.rs:23`, `execution_process.rs:62` на указанном upstream. Применяется разделение идентичности repo и конкретного исполнения; runtime tables и Git lifecycle не переносятся в 144. Patterns изучены, код не копируется.

Пользователь проверил документ и подтвердил его с единственной поправкой: защитить общий legacy decisions/search index от дополнительного repo и проверить пустой/конфликтующий backend-каталог. Эта поправка включена в §3/§5/§7. Новая модель памяти остаётся последующим задачам. Пользователь разрешил исполнение плана; реализация выполнена solo на текущей ветке. Готовый результат остаётся на review до пользовательской приёмки.
