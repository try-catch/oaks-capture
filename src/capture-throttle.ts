import { ProtocolHttpError } from "./protocol";

export interface RateLimitEvent {
  slug: string;
  waitMs: number;
  observedAt: string;
}

export interface CaptureThrottleOptions {
  spinDelayMs: number;
  fallbackSpinDelayMs: number;
}

function validateDelay(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`非法采集等待值: ${value}`);
}

// CaptureThrottle 只保存不含会话凭据的节流状态，供同一顺序采集队列复用。
export class CaptureThrottle {
  spinDelayMs: number;
  readonly events: RateLimitEvent[] = [];
  private rateLimitCount = 0;

  constructor(private readonly options: CaptureThrottleOptions) {
    validateDelay(options.spinDelayMs);
    validateDelay(options.fallbackSpinDelayMs);
    this.spinDelayMs = options.spinDelayMs;
  }

  recordRateLimit(error: unknown, slug: string): number {
    if (!(error instanceof ProtocolHttpError) || error.status !== 429) return 0;
    this.rateLimitCount += 1;
    if (this.rateLimitCount >= 2) this.spinDelayMs = this.options.fallbackSpinDelayMs;
    const waitMs = Math.max(10_000, error.retryAfterMs);
    this.events.push({ slug, waitMs, observedAt: new Date().toISOString() });
    return waitMs;
  }
}
