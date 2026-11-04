import type { MeetingLogger } from "../../public/types.js";
import type { EngineEnvironment, TimerHandle } from "../env.js";
import { reconnectBackoffMs, type BackoffClock } from "./backoff.js";
import {
  isRecoveryWindowExhausted,
  markRecoveryWindowStart,
  resetRecoveryWindow,
  type RecoveryWindowState,
} from "./recoveryWindow.js";
import {
  reconnectLogFields,
  type ReconnectReasonClass,
  type ReconnectTrigger,
} from "./reasons.js";

export type ReconnectOpenResult = "recovered" | "retry" | "failed" | "cancelled";

export type ReconnectControllerDeps = {
  env: EngineEnvironment;
  logger: MeetingLogger | undefined;
  windowMs: number;
  /** Called to open a new meeting-service connection. Must not throw. */
  open: (attempt: number) => Promise<ReconnectOpenResult>;
  /** Called when the chain ends without recovery (window exhausted or hard failure). */
  onAbandoned?: (reason: ReconnectReasonClass) => void;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
};

/**
 * Schedules bounded meeting-service reconnect opens. Does not talk to signaling itself —
 * the engine supplies `open` and wires success/failure.
 */
export class ReconnectController {
  readonly #env: EngineEnvironment;
  readonly #logger: MeetingLogger | undefined;
  readonly #open: (attempt: number) => Promise<ReconnectOpenResult>;
  readonly #onAbandoned: ((reason: ReconnectReasonClass) => void) | undefined;
  readonly #clock: BackoffClock;
  readonly #window: RecoveryWindowState;

  #active = false;
  #attempt = 0;
  #trigger: ReconnectTrigger = "meeting_service";
  #timer: TimerHandle | undefined;
  #generation = 0;
  #inFlight = false;

  constructor(deps: ReconnectControllerDeps) {
    this.#env = deps.env;
    this.#logger = deps.logger;
    this.#open = deps.open;
    this.#onAbandoned = deps.onAbandoned;
    this.#clock = { random: deps.random ?? (() => Math.random()) };
    this.#window = { windowMs: deps.windowMs, windowStartedAtMs: undefined };
  }

  get active(): boolean {
    return this.#active;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Starts (or continues) a single active reconnect chain.
   * Overlapping starts while already active are ignored.
   */
  start(trigger: ReconnectTrigger = "meeting_service"): void {
    if (this.#active) return;
    this.#active = true;
    this.#trigger = trigger;
    this.#attempt = 0;
    markRecoveryWindowStart(this.#window, this.#env.now());
    this.#scheduleNext(0);
  }

  /** Cancels further opens and clears timers. Safe to call when idle. */
  cancel(reason: ReconnectReasonClass = "left"): void {
    if (!this.#active && this.#timer === undefined) return;
    const attempt = Math.max(1, this.#attempt);
    const started = this.#window.windowStartedAtMs;
    const elapsedMs = started === undefined ? 0 : Math.max(0, this.#env.now() - started);
    this.#clearTimer();
    this.#generation += 1;
    this.#active = false;
    this.#inFlight = false;
    resetRecoveryWindow(this.#window);
    this.#log("info", "reconnect cancelled", {
      attempt,
      elapsedMs,
      reason,
      trigger: this.#trigger,
    });
  }

  #scheduleNext(delayMs: number): void {
    this.#clearTimer();
    const generation = this.#generation;
    const run = (): void => {
      if (generation !== this.#generation) return;
      void this.#runAttempt();
    };
    // Immediate first attempt (and zero delays) via microtask so recovery starts without a timer tick.
    if (delayMs <= 0) {
      queueMicrotask(run);
      return;
    }
    this.#timer = this.#env.setTimeout(run, delayMs);
  }

  async #runAttempt(): Promise<void> {
    if (!this.#active || this.#inFlight) return;
    const now = this.#env.now();
    if (isRecoveryWindowExhausted(this.#window, now)) {
      this.#abandon("recovery_window_exhausted");
      return;
    }
    this.#attempt += 1;
    const attempt = this.#attempt;
    const generation = this.#generation;
    this.#inFlight = true;
    this.#log("info", "reconnect attempt started", { attempt, trigger: this.#trigger });
    let result: ReconnectOpenResult = "failed";
    try {
      result = await this.#open(attempt);
    } catch {
      result = "failed";
    }
    if (generation !== this.#generation) return;
    this.#inFlight = false;
    const started = this.#window.windowStartedAtMs;
    const elapsedMs = started === undefined ? 0 : Math.max(0, this.#env.now() - started);
    if (result === "recovered") {
      this.#active = false;
      resetRecoveryWindow(this.#window);
      this.#log("info", "reconnect succeeded", { attempt, elapsedMs, trigger: this.#trigger });
      return;
    }
    if (result === "cancelled") {
      this.cancel("left");
      return;
    }
    if (result === "failed") {
      this.#abandon("hard_failure");
      return;
    }
    // retry
    if (isRecoveryWindowExhausted(this.#window, this.#env.now())) {
      this.#abandon("recovery_window_exhausted");
      return;
    }
    const delay = reconnectBackoffMs(attempt + 1, this.#clock);
    this.#scheduleNext(delay);
  }

  #abandon(reason: ReconnectReasonClass): void {
    const attempt = Math.max(1, this.#attempt);
    const started = this.#window.windowStartedAtMs;
    const elapsedMs = started === undefined ? 0 : Math.max(0, this.#env.now() - started);
    this.#clearTimer();
    this.#generation += 1;
    this.#active = false;
    this.#inFlight = false;
    resetRecoveryWindow(this.#window);
    this.#log("warn", "reconnect failed", { attempt, elapsedMs, reason, trigger: this.#trigger });
    this.#onAbandoned?.(reason);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#env.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #log(
    level: "info" | "warn",
    message: string,
    fields: {
      attempt: number;
      trigger?: ReconnectTrigger;
      elapsedMs?: number;
      reason?: ReconnectReasonClass;
    },
  ): void {
    const logger = this.#logger;
    if (!logger) return;
    const method = logger[level];
    if (typeof method !== "function") return;
    try {
      method.call(logger, message, reconnectLogFields(fields));
    } catch {
      // A failing logger must never break recovery.
    }
  }
}
