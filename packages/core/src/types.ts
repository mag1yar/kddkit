import type { Status, Priority, Kind } from './state.js';

export interface Task {
  id: number; title: string; body: string | null; status: Status;
  blocked: 0 | 1; block_reason: string | null; priority: Priority; area: string | null;
  kind: Kind;                   // feature | bug | chore | research; дефолт feature (см. migration 9)
  track_id: number | null;
  claimed_by: string | null;    // 'ai:<id>' | 'user'; NULL когда не занята (инвариант claim)
  claim_expires: number | null; // unix-сек истечения lease
  failed_attempts: number;      // неудачные попытки агента; reset при review, block при K (claim.ts)
  position: number; archived_at: number | null; created_at: number; updated_at: number;
}
// Строка доски: Task + производные поля, посчитанные на чтении (не хранятся).
export interface TaskListRow extends Task {
  ready: 0 | 1;               // takeable now: new & не blocked & не archived
  criteria_checked: number;
  criteria_total: number;
}
export interface Track {
  id: number; name: string; description: string | null;
  status: 'active' | 'done'; created_at: number;
}
export interface Criterion {
  id: number; task_id: number; text: string;
  checked_at: number | null; position: number; created_at: number;
}
export interface Comment {
  id: number; task_id: number; author: string; body: string; created_at: number;
}
export interface FileRow {
  id: number; task_id: number; sha256: string; ext: string;
  original_name: string; mime_type: string | null; size_bytes: number;
  description: string | null; created_at: number;
}
export interface EventRow {
  id: number; task_id: number | null; actor_type: 'user' | 'ai';
  actor_id: string | null; action: string; detail: string | null; created_at: number;
  parent_id: number | null; type: string | null; level: 'info' | 'warn' | 'error';
}
