/**
 * ConversationChannel — push-able async iterable used as the query() prompt.
 *
 * The worker starts query() with this channel as the prompt. The initial
 * user message is pushed before query() starts. Mid-conversation messages
 * (injected via POST /sessions/:id/inject or pushed by background agent
 * completions) are pushed here and picked up by the running query() loop.
 */

export interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export class ConversationChannel {
  private buffer: SdkUserMessage[] = [];
  private waiters: Array<() => void> = [];
  private _closed = false;
  private _sessionId = "";

  get closed(): boolean {
    return this._closed;
  }

  /** Number of messages buffered but not yet consumed by query(). */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Update the current SDK session ID so injected messages carry it. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /** Push a user message into the running query() loop. */
  push(text: string): void {
    if (this._closed) return;
    this.buffer.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this._sessionId,
    });
    this.drain();
  }

  /** Close the channel — causes the query() iterator to end after buffered messages. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.drain();
  }

  private drain(): void {
    const w = this.waiters.splice(0);
    for (const resolve of w) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SdkUserMessage> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this._closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
