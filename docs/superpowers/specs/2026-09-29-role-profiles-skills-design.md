# Профили ролей, skills и tool grants для managed run

Дата: 2026-09-29. KDD #149, track 6. Статус: **на review владельца**.

Основания: [контракт 143](2026-09-27-kanban-orchestrator-contract-design.md), [authority 145](2026-09-27-controller-authority-design.md), [run context 148](2026-09-29-run-context-design.md) и [консолидированный анализ](../../../.planning/research/orchestration/ANALYSIS.md) §§5, 8–9. Пользователь согласовал первый runtime **Codex/macOS** и управляемый пакет роли: закреплённые skill-файлы, Always в prompt, Available и связанные ресурсы через scoped MCP, отказ до старта при несовместимости. Маршрут разработки — solo.

## 1. Результат и граница

Роль — сохраняемый профиль проекта с неизменяемыми ревизиями, а не процесс или conversation. Ревизия задаёт prompt, runtime `codex`, точный model id и поддерживаемый effort, упорядоченные списки skills `Always`/`Available`, разрешённые KDD operations и native access class (`read` либо `workspace-write`). Пустой или неподдерживаемый model/runtime, неизвестный skill, конфликтующее имя, неразрешённый tool или право шире уже выданного native пакета дают явный отказ.

Изменение профиля создаёт новую ревизию. Один run закрепляет её, точные версии файлов skills, model metadata и эффективные grants вместе с #148 input snapshot. Изменение current revision не переписывает исторический run и не обновляет активный prompt. Продолжение с новым профилем требует нового generation/attempt по будущему lifecycle #150/#152; прежний пакет нельзя тихо освежить при чтении контекста.

Задача 149 предоставляет хранение и подготовку проверенного run-пакета, scoped чтение skill-файлов и реальное probe-доказательство загрузки в Codex. Она не создаёт scheduler, provider session lifecycle, UI редактор, установщик удалённых skills, произвольные внешние MCP servers или поддержку Claude. Start/resume/stop, поток событий и доставку обновлений реализует #150; owner API/CLI/MCP редактирования настроек — #159/#163. Обычный ручной Kanban и существующий global MCP сохраняются.

## 2. Почему управляемый пакет

Вариант «список имён в prompt + native skill discovery» не выполняет критерий Always: существующий проверенный Codex profile отключает host discovery (`skip_host_skill_discovery`, `project_doc_max_bytes=0`), а перечисление имён загружает только индекс. Открыть директории skills обычному shell означало бы расширить проверенные readable roots и получить mutable source вне run snapshot. Выбранная граница — controller сохраняет точные bytes в project store, prompt получает тела Always, а scoped broker выдаёт только закреплённые файлы. Никакой скрытой filesystem-read привилегии у агента из профиля не возникает.

Этот выбор не объявляет текст skill безопасным кодом: явное owner-подключение определяет, какие инструкции используются; runtime permissions #145 продолжают ограничивать возможные действия. Repo skills не выбираются автоматически по касанию файлов. Смена активного repo внутри run не меняет набор skills без нового профиля и run generation.

## 3. Ревизия и содержимое skills

Append migration v18 после неизменённых 1–17. `role_profiles` хранит стабильный id, project id, имя и current revision. `role_revisions` хранит `(role_id, revision)`, canonical профиль, hash, время и источник owner/controller change; UPDATE/DELETE ревизии запрещены. `role_skill_files` хранит bytes каждого файла по `(role_id, revision, skill_name, relative_path)` с SHA-256, типом/размером и отдельным immutable guard. Поле current revision меняется атомарно с записью новой ревизии и audit event. Исторические bytes доступны для аудита через trusted ControllerHandle; run получает только своё разрешённое подмножество.

Источник skill выбирает владелец явно: локальная установленная директория с `SKILL.md` либо дерево зарегистрированного repo на указанном commit. Для repo источник читается из Git objects закреплённого commit, не из меняющегося checkout. Controller читает всё дерево, сохраняет bytes и больше не следует за live source. Предел одного файла — 1 MiB, всего skill — 8 MiB и 128 файлов; превышение отказывает целиком. Локальный путь должен быть каноническим и внутри явно выбранного source root. Symlink, hardlink, traversal, submodule, special file, изменившееся во время чтения локальное дерево, невозможность прочитать файл и отсутствующий `SKILL.md` дают отказ до новой ревизии. `SKILL.md` обязан быть валидным UTF-8; остальные bytes остаются bytes с явным MIME/encoding. Бинарные assets допускаются в лимите и передаются как base64 при запросе. Содержимое не пишется в целевой checkout и не попадает в legacy memory/FTS.

Имена skills в одной роли уникальны без учёта регистра. Относительные пути из manifest нормализованы; `..`, абсолютные пути и ссылки наружу запрещены. `Always` и `Available` — непересекающиеся группы. Manifest перечисляет все файлы, их hashes и source provenance (локальный configured source либо repo id/commit/path); один общий hash покрывает сортированный manifest и bytes. Нет remote fetch/install, исполняемого auto-hook или установки зависимостей из manifest.

Для `Always` controller помещает **полные** тела `SKILL.md` в собранный prompt при каждом start. Для `Available` prompt содержит только имя, краткое описание из bounded owner config и точный reference к закреплённому чтению. Любой файл выбранного skill, включая `references/`, `scripts/`, `assets/`, доступен через broker по `(skill, relative_path)`, с повторной проверкой authority и manifest hash. Доступ к ресурсам не означает автоматический запуск scripts: агент может запросить bytes и выполнить их только в рамках native grants. Пустой body, пропавший blob, повреждённый hash, известная credential pattern в файлах или overflow обязательного prompt отказывают, а не заменяются ссылкой или усечением. Этот scan не обещает распознавать все возможные секреты; владелец явно выбирает source.

## 4. Привязка к authority и входам run

Owner выбирает существующую role revision до `issueRunAuthority`. Core сверяет project, work item, роль, операции и native class с настоящим `VerifiedCodexPackage`; роль не может увеличить repo write scope, выдать user/controller command или расширить catalog #145. Только closed scoped `kdd_run` MCP разрешён в первом варианте. Запрос произвольного server/plugin/connector, credentials в profile или operation вне текущего broker catalog отклоняется до marker/grant/audit записи. Credentials остаются в локальных настройках trusted runtime/broker и никогда не входят в prompt, роль, skill blobs, run snapshot или события.

Новая versioned секция input snapshot закрепляет role id/revision/hash, model id/effort, точный skill manifest/hash, effective KDD operations, native config hash и подтверждённый runtime/model budget. Исторические snapshots v1 #148 остаются читаемыми; им не придумывается роль. Grant без новой секции не получает нового managed start, даже если в DB появилась current role. Новая выдача atomically записывает grant, snapshot и события на основании одной ревизии; при ошибке не остаётся partial role/run state и прежняя generation не отзывается.

Проверка current inputs включает неизменность выбранной role revision и pinned bytes. Появление новой current revision не мутирует historical snapshot; для **новой** попытки выбирают новую revision явно. Если политика owner требует обновления активной роли, host создаёт `update_required` и останавливает/перепланирует работу через #150/#155; одна запись в DB не объявляется доставкой обновления LLM. Отзыв или удаление source directory после snapshot не меняет сохранённые bytes; явный отзыв роли делает её непригодной для новых запусков.

## 5. Prompt, модель и preflight

Trusted core собирает один детерминированный prompt: роль и её полные Always bodies, затем сохранённые обязательные входы #148 и индекс Available. Порядок и разделители стабильны; содержимое task/skill не превращается в controller command, grant или user approval. `get_context` продолжает возвращать сохранённый #148 пакет, без второй независимой версии требований. Prompt hash и точные bytes фиксируются в host-only launch receipt; секреты и приватные абсолютные пути не сериализуются в run-visible sections.

Точный model id и effort сверяются с metadata **установленного** runtime, не со статическим списком в KDD. Контекстный лимит обязан быть достоверно известен для этого model/runtime; budget учитывает собранный prompt, реальные tool schemas/обязательный системный overhead и резерв ответа. Для измерения использовать поддерживаемый runtime token count либо подтверждённую консервативную верхнюю границу; простая оценка `chars / 4` не подходит. Неизвестный лимит, overhead или неподтверждённая модель означают `unsupported` до child creation. #148 byte cap остаётся независимым предварительным gate.

Native preflight #145 проверяет **эффективную** версию Codex, model catalog, tool registry, read/write roots, broker и отключённые surfaces. Новая операция чтения skill-файла расширяет только scoped `kdd_run`: positive/negative tool calls, чужой path, повреждённый blob и live revoke проверяются настоящим Codex/MCP probe. У `get_context` остаётся старый scope. Любая новая native registry entry, MCP resource surface или непроверенная версия требует новых измерений. `VerifiedCodexPackage` остаётся process-local permit; JSON-копия, строка profile id и сохранённый configHash не заменяют его. Прямой managed launch без валидного role permit отклоняется; будущий adapter #150 обязан передать ровно проверенные argv/env/cwd/prompt, без позднего model/tool override.

На этой машине 2026-09-29 `codex --version` возвращает `codex-cli 0.159.0`, а действующий preflight #145 принимает `0.157.0`. Это **текущий отказ**, не совместимость. До реального managed-start 0.159.0 должна пройти повторную native матрицу и её exact-version binding; не менять константу версии ради зелёного теста. Если probe не проходит, 149 остаётся с незакрытым runtime-критерием.

## 6. Scoped MCP и API

В существующий run server добавляется одна read-only операция `read_skill_file` со строгими `skill`/`path`/`offset` arguments. Server объявляет её только когда grant содержит разрешённые skills и соответствующую operation; прямой вызов отсутствующего tool отказывает. Core получает genuine `RunContext`, перечитывает live authority/generation/expiry/revoke и закреплённый manifest из snapshot, затем выдаёт только конкретный файл. Никакого произвольного path или role id в аргументах, раскрытия source root, DB path либо списка чужих roles. Response содержит не более 32 KiB bytes, MIME/encoding, SHA-256 полного файла и offset/length. Следующий chunk выбирается точным offset в тех же пределах; каждый вызов проверяет тот же grant. MCP resources/templates по-прежнему не объявляются.

Публичный core API для trusted host: создать новую role revision из явного source, прочитать current/historical metadata, подготовить роль для конкретной authority и проверить её актуальность. Run API: только закреплённое чтение файла. Ни run broker, ни global manual MCP не получают owner mutation API в 149. Конкретные имена функций не являются частью design-контракта; реализация использует существующие `ControllerHandle`, `RunContext`, `issueRunAuthority` и `run_input_snapshots`, без второй системы полномочий.

## 7. Отказы, миграция и наблюдение

Ошибки policy/model/skills/tool surface происходят до изменения task protection и до создания Codex process. Исторический role/snapshot доступен trusted host после revoke; run после revoke не читает даже старый skill. Один профиль может использоваться многими work items; каждый pin связывает конкретную revision с конкретной authority generation. Concurrent revision writes с одним expected revision дают одного победителя. Повтор того же owner command возвращает тот же receipt, а changed payload с тем же command id отказывает.

Migration из v17 сохраняет старые задачи, память, grants и run snapshots byte-for-byte, создаёт пустые role tables и не выбирает default role. Older binary отказывает на неизвестной schema. Существующие grants без role pin остаются историческими/диагностическими, но не считаются готовыми к новому managed launch. Legacy CLI/MCP/UI и ручные карточки не получают обязательную роль автоматически. Настоящую доску разработки не мигрировать ради теста: использовать изолированные temp Git/SQLite fixtures.

| ID | Требуемое наблюдение |
| --- | --- |
| R01 | v17 WAL upgrade сохраняет прежние rows/ids/attachments/snapshots; v18 role tables пусты, reopen идемпотентен, старый binary отказывает |
| R02 | Две ревизии роли сохраняют разные prompt/model/grants; первая immutable и читаема, concurrent CAS имеет одного победителя |
| R03 | Явный source с `SKILL.md`, reference, script и asset фиксирует exact bytes/hashes; symlink/hardlink/traversal/special/changed/oversize source отказывает без revision |
| R04 | Always body полностью присутствует в реальном Codex prompt на каждом test run; Available body отсутствует до запроса, индекс содержит только его pinned reference |
| R05 | Реальный scoped MCP возвращает reference/script/asset нужной версии, включая chunk/hash; чужой skill/path и revoked/stale grant отказывают без leak |
| R06 | Role operations/native class уже существующего grant не расширяют; неизвестный MCP server, write у readonly и forged role permit отказывают до child/DB side effects |
| R07 | Prompt вместе с Always/inputs/tool overhead и output reserve вмещается в подтверждённый model limit; unknown/stale metadata и overflow отказывают, обязательный текст не режется |
| R08 | Actual Codex native full/readonly matrices и broker positive/negative/live-revoke probes проходят для **установленной** exact версии/model; изменение версии/registry делает старое evidence неприменимым |
| R09 | role/skills/grants/hashes сохранены у run и переживают reopen; смена current revision не меняет old snapshot, новый generation получает выбранную новую версию |
| R10 | Полный suite, build, typecheck и fresh plugin smoke проходят отдельно; source Git refs/status и legacy manual flows не изменены |

Тестовый prompt через actual Codex provider должен сообщить наблюдаемое содержимое unique marker из Always и не знать marker только Available до `read_skill_file`. Inspect runtime metadata/tool calls, не выводить «загрузилось» из собранной строки. При невозможности exact-version probe или token budget proof критерии 402/403 остаются unchecked. После реализации close-comment содержит counts, версии, hashes и отрицательные случаи; сдача в review не означает self-acceptance.

## 8. Референсы и применимость

Recall сделан до references: 143/144/145/148 и прежние #14/#54/#56. #54 — идея поля model/effort без движка; у 149 уже есть потребитель и проверяемый запуск. #56 описывает area как свойство работы, не выдаёт role profile права; не добавлять registry зон. #14 полезен для run-scoped MCP, уже реализован в 145. Утверждённые контракты проекта имеют приоритет над внешними patterns.

Первый pass: actual `git fetch origin --prune` обоих clones; после зафиксированной границы Codex/macOS выполнен второй pass по тем же источникам на обновлённых upstream. Checkout не переключались. На 2026-09-29 Control Center local `9e567c86` → upstream `f0f139bd`, 9 commits после анализа; Buzz local `b0d6fb8a` → upstream `12423f28`, 20 commits. Цитируемые файлы не изменились после analysis commit; источник читался через `git show origin/main`. Код не копируется.

| Источник | Verdict для 149 |
| --- | --- |
| `references/control-center/docs/src/content/docs/manual/concepts/agent-model.mdx:33–62` @ `f0f139bd` | Имена skills и linked directories сами не гарантируют загрузку bodies. Взять различие index/body и pinned файлов; не брать автоматическую подмену набора skills при смене active repo или permissive fallback |
| `/Users/magiyar/Projects/My/References/buzz/crates/buzz-acp/src/config.rs:460–499` @ `12423f28` | Отдельные system/team instructions подтверждают композицию prompt; bypass-permissions default не подходит managed Codex |
| `/Users/magiyar/Projects/My/References/buzz/crates/buzz-acp/src/scope.rs:30–100` и `session_model_thread.md:3–5` @ `12423f28` | Conversation scope не равен role revision или authorization; session routing не переносится в 149 |
