/**
 * DispatchQueue — Per-scope serialization with global concurrency control.
 *
 * Messages for the same scope (conversation) are processed sequentially.
 * Each enqueued message carries a resolve callback so the caller gets the
 * result when processing completes.
 *
 * If a dispatch is in-flight and a new message arrives for the same scope,
 * the message is queued. When the current dispatch finishes, the queue
 * drains the next message (which will use session resume for continuity).
 *
 * Design:
 * - Per-scope serialization (no concurrent dispatches to the same scope)
 * - Global concurrency limit (MAX_CONCURRENT across all scopes)
 * - Exponential backoff retry on failure
 * - Waiting queue for scopes blocked by concurrency limit
 * - Priority: scheduled tasks run before queued messages
 */

export interface QueueConfig {
  /** Maximum concurrent active dispatches across all scopes. Default: 5. */
  maxConcurrent: number;
}

export interface QueuedTask {
  id: string;
  agentKey: string;
  fn: () => Promise<void>;
}

/** A message waiting to be dispatched, with a callback to return the result. */
export interface PendingMessage {
  text: string;
  resolve: (result: string) => void;
  /** Optional caller metadata — carried through the queue for identity propagation. */
  meta?: Record<string, unknown>;
}

interface AgentState {
  active: boolean;
  /** The dispatch is idle — finished processing, waiting for new input */
  idleWaiting: boolean;
  /** Whether the current dispatch is a scheduled task */
  isTask: boolean;
  /** Currently running task ID, if any */
  runningTaskId: string | null;
  /** Messages waiting to be dispatched */
  pendingMessages: PendingMessage[];
  /** Scheduled tasks waiting to run */
  pendingTasks: QueuedTask[];
  /** Retry count for exponential backoff */
  retryCount: number;
  /** Whether a retry timer is pending (prevents drainAgent from double-firing) */
  retryScheduled: boolean;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export class DispatchQueue {
  private readonly agents = new Map<string, AgentState>();
  private activeCount = 0;
  private readonly waitingAgents: string[] = [];
  private processMessageFn:
    | ((agentKey: string, message: PendingMessage) => Promise<boolean>)
    | null = null;
  private injectMessageFn:
    | ((agentKey: string, text: string) => boolean)
    | null = null;
  private shuttingDown = false;

  constructor(private readonly config: QueueConfig) {}

  /**
   * Set the function that processes a single message for an agent.
   * Called when it's the agent's turn with the next pending message.
   * The function must call message.resolve() with the result.
   * Returns true on success, false on failure (triggers retry).
   */
  setProcessMessageFn(
    fn: (agentKey: string, message: PendingMessage) => Promise<boolean>
  ): void {
    this.processMessageFn = fn;
  }

  /**
   * Set the function that injects a follow-up message into a running dispatch.
   * Returns true if the message was injected, false if no active dispatch.
   */
  setInjectMessageFn(fn: (agentKey: string, text: string) => boolean): void {
    this.injectMessageFn = fn;
  }

  /**
   * Enqueue a message for an agent scope.
   * If the agent has an active dispatch that's idle, inject via the message fn.
   * Otherwise, queue for the next dispatch cycle.
   *
   * Returns a promise that resolves with the dispatch result.
   */
  enqueue(agentKey: string, text: string, meta?: Record<string, unknown>): Promise<string> {
    return new Promise<string>((resolve) => {
      if (this.shuttingDown) {
        resolve("Queue is shutting down.");
        return;
      }

      const state = this.getAgent(agentKey);
      const pending: PendingMessage = { text, resolve, meta };

      // If active and idle, try to inject the message directly
      if (state.active && state.idleWaiting && !state.isTask) {
        if (this.injectMessageFn?.(agentKey, text)) {
          state.idleWaiting = false;
          // Injection pipes the message into the running dispatch.
          // The result comes from that dispatch, not the queue.
          // Resolve immediately — the running dispatch handles the work.
          resolve("(injected into active dispatch)");
          return;
        }
      }

      // If active but not idle, queue for later
      if (state.active) {
        state.pendingMessages.push(pending);
        return;
      }

      // If at concurrency limit or retry is pending, queue and wait
      if (this.activeCount >= this.config.maxConcurrent || state.retryScheduled) {
        state.pendingMessages.push(pending);
        if (!this.waitingAgents.includes(agentKey)) {
          this.waitingAgents.push(agentKey);
        }
        return;
      }

      // Start processing immediately
      state.pendingMessages.push(pending);
      this.runForAgent(agentKey, "messages").catch(() => {});
    });
  }

  /**
   * Legacy enqueueMessage — fire-and-forget variant for backward compat.
   * Used by scheduled tasks and internal retry logic.
   */
  enqueueMessage(agentKey: string, text?: string): void {
    if (this.shuttingDown) return;

    const state = this.getAgent(agentKey);

    // If active and idle, try to inject the message directly
    if (state.active && state.idleWaiting && !state.isTask && text) {
      if (this.injectMessageFn?.(agentKey, text)) {
        state.idleWaiting = false;
        return;
      }
    }

    // If active but not idle, mark pending (fire-and-forget has no resolver)
    if (state.active) {
      if (text) {
        state.pendingMessages.push({ text, resolve: () => {} });
      }
      return;
    }

    // If at concurrency limit or retry is pending, queue
    if (this.activeCount >= this.config.maxConcurrent || state.retryScheduled) {
      if (text) {
        state.pendingMessages.push({ text, resolve: () => {} });
      }
      if (!this.waitingAgents.includes(agentKey)) {
        this.waitingAgents.push(agentKey);
      }
      return;
    }

    // Start processing immediately
    if (text) {
      state.pendingMessages.push({ text, resolve: () => {} });
    }
    this.runForAgent(agentKey, "messages").catch(() => {});
  }

  /**
   * Enqueue a scheduled task for an agent.
   * Tasks take priority over messages when draining.
   */
  enqueueTask(agentKey: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getAgent(agentKey);

    // Prevent double-queuing
    if (state.runningTaskId === taskId) return;
    if (state.pendingTasks.some((t) => t.id === taskId)) return;

    if (state.active) {
      state.pendingTasks.push({ id: taskId, agentKey, fn });
      // If idle, preempt to run the task sooner
      if (state.idleWaiting) {
        this.notifyClose(agentKey);
      }
      return;
    }

    if (this.activeCount >= this.config.maxConcurrent) {
      state.pendingTasks.push({ id: taskId, agentKey, fn });
      if (!this.waitingAgents.includes(agentKey)) {
        this.waitingAgents.push(agentKey);
      }
      return;
    }

    // Run immediately
    this.runTask(agentKey, { id: taskId, agentKey, fn }).catch(() => {});
  }

  /**
   * Signal that the active dispatch for an agent is now idle
   * (finished work, waiting for more input).
   */
  notifyIdle(agentKey: string): void {
    const state = this.getAgent(agentKey);
    state.idleWaiting = true;
    // If tasks are pending, preempt immediately
    if (state.pendingTasks.length > 0) {
      this.notifyClose(agentKey);
    }
  }

  /**
   * Signal the active dispatch to wind down (close its input).
   * Used when tasks need to preempt an idle session.
   */
  notifyClose(agentKey: string): void {
    const state = this.getAgent(agentKey);
    if (!state.active) return;
    this.onClose?.(agentKey);
  }

  /** Callback invoked when a close is requested. Set by the wiring layer. */
  onClose: ((agentKey: string) => void) | null = null;

  /**
   * Check if an agent currently has an active dispatch.
   */
  isActive(agentKey: string): boolean {
    return this.getAgent(agentKey).active;
  }

  /**
   * Check if an agent is idle (active but waiting for input).
   */
  isIdle(agentKey: string): boolean {
    const state = this.getAgent(agentKey);
    return state.active && state.idleWaiting;
  }

  /**
   * Check if an agent has pending messages in the queue.
   */
  hasPending(agentKey: string): boolean {
    const state = this.getAgent(agentKey);
    return state.pendingMessages.length > 0 || state.pendingTasks.length > 0;
  }

  /** Number of currently active dispatches. */
  get active(): number {
    return this.activeCount;
  }

  /** Whether the queue has been shut down. */
  get isShutDown(): boolean {
    return this.shuttingDown;
  }

  /** Number of tracked agent states (for diagnostics / testing). */
  get agentCount(): number {
    return this.agents.size;
  }

  /**
   * Remove agent states that are idle with no pending work.
   * Call periodically to prevent unbounded growth of the state map.
   */
  cleanup(): void {
    for (const [key, state] of this.agents) {
      if (
        !state.active &&
        !state.retryScheduled &&
        state.pendingMessages.length === 0 &&
        state.pendingTasks.length === 0
      ) {
        this.agents.delete(key);
      }
    }
  }

  /**
   * Graceful shutdown — stop accepting new work.
   * Active dispatches finish naturally.
   * Resolves all pending messages with an error.
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const [, state] of this.agents) {
      for (const msg of state.pendingMessages) {
        msg.resolve("Queue is shutting down.");
      }
      state.pendingMessages = [];
      // Clear pending tasks so they aren't silently dropped
      state.pendingTasks = [];
    }
    this.waitingAgents.length = 0;
  }

  // ── Private ──

  private getAgent(agentKey: string): AgentState {
    let state = this.agents.get(agentKey) as
      | (AgentState)
      | undefined;
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTask: false,
        runningTaskId: null,
        pendingMessages: [],
        pendingTasks: [],
        retryCount: 0,
        retryScheduled: false,
      };
      this.agents.set(agentKey, state);
    }
    return state;
  }

  private async runForAgent(
    agentKey: string,
    _reason: "messages" | "drain"
  ): Promise<void> {
    const state = this.getAgent(agentKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTask = false;
    this.activeCount++;

    // Take the next pending message before the try so it's accessible in catch
    const message = state.pendingMessages.shift();
    try {
      if (message && this.processMessageFn) {
        const success = await this.processMessageFn(agentKey, message);
        if (success) {
          state.retryCount = 0;
        } else {
          // Re-queue the message for retry
          state.pendingMessages.unshift(message);
          this.scheduleRetry(agentKey, state);
        }
      } else if (message) {
        // No processMessageFn set — resolve with error to avoid hanging promises
        message.resolve("Error: no message processor configured.");
      }
    } catch {
      // Re-queue the message so retry can pick it up
      if (message) {
        state.pendingMessages.unshift(message);
      }
      this.scheduleRetry(agentKey, state);
    } finally {
      state.active = false;
      state.idleWaiting = false;
      this.activeCount--;
      this.drainAgent(agentKey);
    }
  }

  private async runTask(agentKey: string, task: QueuedTask): Promise<void> {
    const state = this.getAgent(agentKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTask = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    try {
      await task.fn();
    } catch {
      // Task error — logged by caller
    } finally {
      state.active = false;
      state.isTask = false;
      state.runningTaskId = null;
      state.idleWaiting = false;
      this.activeCount--;
      this.drainAgent(agentKey);
    }
  }

  private scheduleRetry(
    agentKey: string,
    state: AgentState
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      state.retryCount = 0;
      // Resolve all pending messages with error
      for (const msg of state.pendingMessages) {
        msg.resolve("Failed after maximum retries.");
      }
      state.pendingMessages = [];
      return;
    }

    state.retryScheduled = true;
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    setTimeout(() => {
      state.retryScheduled = false;
      if (!this.shuttingDown && state.pendingMessages.length > 0) {
        this.runForAgent(agentKey, "drain").catch(() => {});
      }
    }, delayMs);
  }

  private drainAgent(agentKey: string): void {
    if (this.shuttingDown) return;

    const state = this.getAgent(agentKey);

    // Tasks first (they won't be re-discovered like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(agentKey, task).catch(() => {});
      return;
    }

    // Then pending messages (but not if a retry timer is pending)
    if (state.pendingMessages.length > 0 && !state.retryScheduled) {
      this.runForAgent(agentKey, "drain").catch(() => {});
      return;
    }

    // Nothing pending — check if other agents are waiting
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingAgents.length > 0 &&
      this.activeCount < this.config.maxConcurrent
    ) {
      const nextKey = this.waitingAgents.shift()!;
      const state = this.getAgent(nextKey);

      // Tasks first
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextKey, task).catch(() => {});
      } else if (state.pendingMessages.length > 0) {
        this.runForAgent(nextKey, "drain").catch(() => {});
      }
    }
  }
}
