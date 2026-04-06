/**
 * WorkerSession — manages one running agent query() loop.
 *
 * Owns the ConversationChannel used as the query() prompt. Events are
 * buffered so a late SSE subscriber gets the full history on connect.
 * The session is considered "done" once a terminal event is emitted
 * (result, error, or stale_session).
 */

import { ConversationChannel } from "./channel.js";
import type { WorkerSessionRequest, WorkerEvent } from "./types.js";
import { runAgentSession } from "./agent.js";

export type EventListener = (event: WorkerEvent) => void;

export class WorkerSession {
  private readonly channel = new ConversationChannel();
  private readonly eventBuffer: WorkerEvent[] = [];
  private readonly listeners: EventListener[] = [];
  private _done = false;

  get done(): boolean {
    return this._done;
  }

  /**
   * Register a listener and immediately drain all buffered events.
   * After draining, the listener will receive future events in real time.
   */
  subscribe(listener: EventListener): void {
    for (const ev of this.eventBuffer) {
      listener(ev);
    }
    this.listeners.push(listener);
  }

  /** Emit an event — buffers it and forwards to all subscribers. */
  private emit(event: WorkerEvent): void {
    this.eventBuffer.push(event);
    for (const l of this.listeners) l(event);
    if (event.type === "result" || event.type === "error" || event.type === "stale_session") {
      this._done = true;
      this.channel.close();
    }
  }

  /**
   * Push a follow-up message into the running query() loop.
   * Call this to inject mid-conversation messages.
   */
  inject(text: string): void {
    this.channel.push(text);
  }

  /** Abort the session — closes the channel, causing query() to finish. */
  abort(): void {
    this.channel.close();
  }

  /**
   * Start the agent loop in the background.
   * Push the initial message and begin the async agent iteration.
   */
  start(request: WorkerSessionRequest): void {
    // Push the initial user message before starting the loop
    this.channel.push(request.prompt);

    runAgentSession(request, this.channel, (ev) => {
      // Mirror SDK session ID into channel so injected messages carry it
      if (ev.type === "started") {
        this.channel.setSessionId(ev.sessionId);
      }
      this.emit(ev);
    }).catch((err) => {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
