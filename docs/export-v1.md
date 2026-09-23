# JSON board snapshot, version 1

`kdd export` writes one UTF-8 JSON object and a newline. It is a snapshot of one
project's board data for read-only consumers and future importers. It is not a
self-contained backup: restoring attachments also requires a separate copy of
the board's files directory. No importer is included in version 1.

An empty board has this shape:

```json
{"schema_version":1,"tasks":[],"tracks":[],"criteria":[],"comments":[],"task_links":[],"decisions":[],"events":[],"files":[]}
```

Every array is present. The fields in each row are:

| Array | Fields |
| --- | --- |
| `tasks` | `id`, `title`, `body`, `status`, `blocked`, `block_reason`, `priority`, `area`, `kind`, `track_id`, `position`, `archived_at`, `created_at`, `updated_at` |
| `tracks` | `id`, `name`, `description`, `status`, `created_at` |
| `criteria` | `id`, `task_id`, `text`, `checked_at`, `evidence`, `checked_by`, `position`, `created_at` |
| `comments` | `id`, `task_id`, `author`, `body`, `created_at` |
| `task_links` | `from_id`, `to_id`, `kind` |
| `decisions` | `slug`, `title`, `created`, `superseded_by`, `source_task_ids`, `body` |
| `events` | `id`, `task_id`, `actor_type`, `actor_id`, `action`, `detail`, `created_at`, `parent_id`, `type`, `level` |
| `files` | `id`, `task_id`, `sha256`, `ext`, `original_name`, `mime_type`, `size_bytes`, `description`, `created_at` |

IDs and references retain their board values. Archived tasks remain. Task,
track, criterion, comment, event, and file arrays sort by ID; task links sort
by `(from_id, to_id, kind)` and decisions by slug. Objects use the field order
shown above. Numeric fields stay JSON numbers and nullable fields stay explicit
`null`. Times are Unix seconds, except decision `created`, which is the date
string from its Markdown frontmatter. Decision `body` is the Markdown below its
title; `source_task_ids` connects it to tasks. Attachment bytes are excluded.

The default command redacts recognized secret patterns in exported text:

```sh
kdd export > board.json
```

Use `kdd export --include-sensitive` to preserve the original text. This flag
disables only secret redaction. It does not restore internal fields or local
paths. In particular, `events.detail.manual_provenance.worktree` is removed
from JSON object details in **both** modes; session, branch, and commit remain.
Older non-JSON event details remain text. The redactor is best effort: arbitrary
secrets or paths typed into free text may remain. Store the sensitive export
accordingly.

The export never includes task lease state (`claimed_by`, `claim_expires`,
`failed_attempts`), decision or attachment paths, file bytes, or runtime tables
such as `agent_events`, `errors`, `meta`, and the search index. Decision Markdown
is synchronized before one SQLite read transaction. Repeating an export against
unchanged board data and decision files produces byte-identical JSON. Readers
may ignore unknown fields; removing or changing a documented field requires a
new `schema_version`.
