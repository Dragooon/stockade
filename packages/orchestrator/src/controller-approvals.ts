/**
 * Approvals for the controller API (D3b §6): one hub for the whole process.
 *
 * - app: and peer: scopes have no channel of their own: their approvals wait here for a
 *   decision from the app (POST /controller/approvals/:id), and are denied at the timeout.
 * - discord: and terminal: approvals are answered where they were raised. The hub mirrors
 *   them read-only (answerIn) so the app can show that a session needs its person, and
 *   settles them when the channel's answer comes back.
 *
 * Each person's ControllerService subscribes and forwards only the approvals in scopes
 * listed for that person.
 */

import { randomUUID } from "node:crypto";
import type { GatekeeperReview } from "./gatekeeper.js";
import type { ApprovalChannel } from "./types.js";

/** Same as Discord's approval timeout: unanswered means denied. */
export const CONTROLLER_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type ApprovalBehaviour = "allow" | "deny";

export interface ControllerApproval {
  id: string;
  scope: string;
  tool: string;
  input: Record<string, unknown>;
  /** ISO time it was raised. */
  receivedAt: string;
  agentId: string | null;
  review: GatekeeperReview | null;
  /** Where it's answered when not in the app (a read-only mirror), or null for app approvals. */
  answerIn: "discord" | "terminal" | null;
}

export type ApprovalHubEvent =
  | { type: "approval"; approval: ControllerApproval }
  | { type: "decision"; approval: ControllerApproval; behaviour: ApprovalBehaviour };

interface Pending {
  approval: ControllerApproval;
  /** App approvals only: settles the waiting tool call. */
  resolve?: (behaviour: ApprovalBehaviour) => void;
}

export class ControllerApprovals {
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: ApprovalHubEvent) => void>();

  constructor(private readonly options: { timeoutMs?: number; now?: () => number; newId?: () => string } = {}) {}

  subscribe(listener: (event: ApprovalHubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Approvals waiting right now, oldest first. */
  list(): ControllerApproval[] {
    return [...this.pending.values()].map((entry) => entry.approval);
  }

  get(id: string): ControllerApproval | null {
    return this.pending.get(id)?.approval ?? null;
  }

  /** An approval the app answers: true once allowed, false when denied or timed out. */
  ask(scope: string, tool: string, input: Record<string, unknown>, extras: { agentId?: string; review?: GatekeeperReview } = {}): Promise<boolean> {
    const approval = this.raise(scope, tool, input, extras, null);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle("deny"), this.options.timeoutMs ?? CONTROLLER_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const settle = (behaviour: ApprovalBehaviour) => {
        clearTimeout(timer);
        this.settle(approval.id, behaviour);
        resolve(behaviour === "allow");
      };
      this.pending.set(approval.id, { approval, resolve: settle });
      this.emit({ type: "approval", approval });
    });
  }

  /** The app decided. Read-only mirrors and unknown (or already answered) ids are refused. */
  decide(id: string, behaviour: ApprovalBehaviour): "decided" | "not_found" | "read_only" {
    const entry = this.pending.get(id);
    if (!entry) return "not_found";
    if (!entry.resolve) return "read_only";
    entry.resolve(behaviour);
    return "decided";
  }

  /** Callbacks for an app:/peer: scope: approvals wait for the app. */
  channel(scope: string): ApprovalChannel {
    return {
      askUser: (tool, input, review, agentId) => this.ask(scope, tool, input, { agentId, review }),
      notifyAutoApproved: async () => {},
    };
  }

  /** Wrap a Discord or terminal channel so its approvals also show, read-only, in the app. */
  mirror(inner: ApprovalChannel, scope: string, answerIn: "discord" | "terminal"): ApprovalChannel {
    return {
      ...inner,
      askUser: async (tool, input, review, agentId) => {
        const approval = this.raise(scope, tool, input, { agentId, review }, answerIn);
        this.pending.set(approval.id, { approval });
        this.emit({ type: "approval", approval });
        let approved = false;
        try {
          approved = await inner.askUser(tool, input, review, agentId);
          return approved;
        } finally {
          this.settle(approval.id, approved ? "allow" : "deny");
        }
      },
    };
  }

  private raise(
    scope: string,
    tool: string,
    input: Record<string, unknown>,
    extras: { agentId?: string; review?: GatekeeperReview },
    answerIn: ControllerApproval["answerIn"],
  ): ControllerApproval {
    return {
      id: this.options.newId?.() ?? randomUUID(),
      scope,
      tool,
      input,
      receivedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      agentId: extras.agentId ?? null,
      review: extras.review ?? null,
      answerIn,
    };
  }

  private settle(id: string, behaviour: ApprovalBehaviour): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.emit({ type: "decision", approval: entry.approval, behaviour });
  }

  private emit(event: ApprovalHubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[controller] approval listener failed:", err);
      }
    }
  }
}
