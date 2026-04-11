/**
 * ConcurrencyGate — global concurrency limiter for active agent sessions.
 *
 * Replaces the DispatchQueue's global activeCount/waitingAgents machinery.
 * Per-scope serialization is no longer needed at the orchestrator level —
 * the worker's ConversationChannel handles message ordering natively.
 *
 * acquire(scope) is re-entrant: if the scope already holds a slot,
 * subsequent calls return immediately (for message injection into an
 * already-active session).
 */

export class ConcurrencyGate {
  private readonly activeScopes = new Set<string>();
  private readonly waitQueue: Array<{ scope: string; resolve: () => void }> = [];

  constructor(private readonly maxConcurrent: number) {}

  /**
   * Acquire a concurrency slot for a scope.
   * - Same scope: always resolves immediately (re-entrant).
   * - New scope under limit: resolves immediately.
   * - New scope at limit: waits until a slot is released.
   */
  acquire(scope: string): Promise<void> {
    // Re-entrant: scope already has a slot
    if (this.activeScopes.has(scope)) {
      return Promise.resolve();
    }

    if (this.activeScopes.size < this.maxConcurrent) {
      this.activeScopes.add(scope);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push({ scope, resolve });
    });
  }

  /** Release a scope's concurrency slot and unblock the next waiter. */
  release(scope: string): void {
    this.activeScopes.delete(scope);

    while (this.waitQueue.length > 0 && this.activeScopes.size < this.maxConcurrent) {
      const next = this.waitQueue.shift()!;
      this.activeScopes.add(next.scope);
      next.resolve();
    }
  }

  /** Check if a scope currently holds a slot. */
  isActive(scope: string): boolean {
    return this.activeScopes.has(scope);
  }

  /** Current number of active scopes. */
  get activeCount(): number {
    return this.activeScopes.size;
  }
}
