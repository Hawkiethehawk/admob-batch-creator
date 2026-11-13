import type { Batch } from './types.ts';

export interface BatchSummary {
  id: string;
  format: Batch['format'];
  mode: Batch['mode'];
  phase: Batch['phase'];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  total: number;
  succeeded: number;
}
export function summarizeBatch(batch: Batch): BatchSummary {
  return { id: batch.id, format: batch.format, mode: batch.mode ?? 'manual', phase: batch.phase,
    createdAt: batch.createdAt, startedAt: batch.startedAt ?? batch.confirmedAt, completedAt: batch.completedAt,
    total: batch.tasks.length, succeeded: batch.tasks.filter(task => ['success', 'exists'].includes(task.status)).length };
}
export function batchElapsed(batch: Pick<BatchSummary, 'startedAt' | 'completedAt' | 'phase'>, now = Date.now()): string {
  if (!batch.startedAt || (!batch.completedAt && batch.phase === 'done')) return '未知';
  const start = Date.parse(batch.startedAt), end = batch.completedAt ? Date.parse(batch.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '未知';
  return `${((end - start) / 1000).toFixed(1)} 秒${batch.completedAt ? '' : '（进行中）'}`;
}
