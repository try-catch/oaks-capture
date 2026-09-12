import type { Session, JSONMap } from './protocol';
import type { PlayAction } from './shop';

// 可恢复采集由 Actions 注入；默认本地工具保持原有接口。
export interface PendingRound { id: string; session: Session; action: PlayAction; frames: JSONMap[] }
export interface CaptureRuntime {
  pending(): PendingRound | undefined;
  savePending(round: PendingRound): void;
  // 丢弃无法完成的未完成局：必须同时清掉请求日志键，
  // 否则后续请求会复用同一个键并被协调器用旧响应重放，重新登录也会被缓存掉。
  discardPending(): void;
  requestStep(id: string, step: number): void;
  writeDocument(document: Record<string, unknown>): void;
  acknowledge(document: Record<string, unknown>): void;
  syncFiles(): void;
  shouldStop(): boolean;
}
export let captureRuntime: CaptureRuntime | undefined;
export function installCaptureRuntime(runtime: CaptureRuntime | undefined): void { captureRuntime = runtime; }
