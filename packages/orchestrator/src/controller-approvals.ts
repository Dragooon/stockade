/**
 * Approvals for the controller API (D3b §6): one hub for the whole process.
 *
 * - app: and peer: scopes have no channel of their own: their approvals wait here for a
 *   decision from the app (POST /controller/approvals/:id), and are denied at the timeout.
 * - discord: and terminal: approvals are answered where they were raised. The hub mirrors
 *   them read-only (answerIn) so the app can show that a session needs its person, and
 *   settles them when the channel's answer comes back.
 *
 * AskUserQuestion questions (d3b-6) travel the same way: an approval with tool
 * AskUserQuestion and the questions, decided with answers (allow) or declined (deny).
 *
 * Each person's ControllerService subscribes and forwards only the approvals in scopes
 * listed for that person.
 */

import { randomUUID } from "node:crypto";
import type { GatekeeperReview } from "./gatekeeper.js";
import type { ApprovalChannel, AskQuestion, QuestionAnswers } from "./types.js";

/** Same as Discord's approval timeout: unanswered means denied. */
export const CONTROLLER_APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Longest answer the app may send for one question. */
export const QUESTION_ANSWER_MAX_CHARS = 2000;

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
  /** AskUserQuestion: the questions to answer (also in input.questions); null for tool approvals. */
  questions: AskQuestion[] | null;
}

export type ApprovalHubEvent =
  | { type: "approval"; approval: ControllerApproval }
  | { type: "decision"; approval: ControllerApproval; behaviour: ApprovalBehaviour };

interface Pending {
  approval: ControllerApproval;
  /** App approvals only: settles the waiting tool call (answers for an allowed question). */
  resolve?: (behaviour: ApprovalBehaviour, answers?: Record<string, string>) => void;
}

/**
 * Why these answers don't fit the questions, or null when they do: one non-empty answer of at
 * most QUESTION_ANSWER_MAX_CHARS per question, keyed by the exact question text, and nothing else.
 */
export function answersError(questions: AskQuestion[], answers: unknown): string | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return "answers must be an object of question text to answer";
  const given = answers as Record<string, unknown>;
  const texts = questions.map((q) => q.question);
  for (const key of Object.keys(given)) {
    if (!texts.includes(key)) return `no question reads "${key.slice(0, 80)}"`;
  }
  for (const text of texts) {
    const answer = given[text];
    if (typeof answer !== "string" || !answer.trim()) return `"${text.slice(0, 80)}" needs an answer`;
    if (answer.length > QUESTION_ANSWER_MAX_CHARS) return `the answer to "${text.slice(0, 80)}" is over ${QUESTION_ANSWER_MAX_CHARS} characters`;
  }
  return null;
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
    return this.wait(this.raise(scope, tool, input, extras, null)).then(({ behaviour }) => behaviour === "allow");
  }

  /** Questions the app answers: the answers, "declined" (Skip), or null at the timeout. */
  askQuestions(scope: string, questions: AskQuestion[], agentId?: string): Promise<QuestionAnswers> {
    const approval = this.raise(scope, "AskUserQuestion", { questions }, { agentId }, null, questions);
    return this.wait(approval).then(({ behaviour, answers, timedOut }) =>
      timedOut ? null : behaviour === "allow" && answers ? answers : "declined");
  }

  /**
   * The app decided. Read-only mirrors and unknown (or already answered) ids are refused, and so
   * is allowing a question without fitting answers (check answersError first for the reason).
   */
  decide(id: string, behaviour: ApprovalBehaviour, answers?: Record<string, string>): "decided" | "not_found" | "read_only" | "invalid_answers" {
    const entry = this.pending.get(id);
    if (!entry) return "not_found";
    if (!entry.resolve) return "read_only";
    const questions = entry.approval.questions;
    if (questions && behaviour === "allow" && answersError(questions, answers)) return "invalid_answers";
    entry.resolve(behaviour, questions && behaviour === "allow" ? answers : undefined);
    return "decided";
  }

  /** Callbacks for an app:/peer: scope: approvals and questions wait for the app. */
  channel(scope: string): ApprovalChannel {
    return {
      askUser: (tool, input, review, agentId) => this.ask(scope, tool, input, { agentId, review }),
      notifyAutoApproved: async () => {},
      askQuestions: (questions, agentId) => this.askQuestions(scope, questions, agentId),
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
      ...(inner.askQuestions ? {
        askQuestions: async (questions: AskQuestion[], agentId?: string) => {
          const approval = this.raise(scope, "AskUserQuestion", { questions }, { agentId }, answerIn, questions);
          this.pending.set(approval.id, { approval });
          this.emit({ type: "approval", approval });
          let answers: QuestionAnswers = null;
          try {
            answers = await inner.askQuestions!(questions, agentId);
            return answers;
          } finally {
            this.settle(approval.id, answers && answers !== "declined" ? "allow" : "deny");
          }
        },
      } : {}),
    };
  }

  /** Register an app approval and wait for its decision, or deny at the timeout. */
  private wait(approval: ControllerApproval): Promise<{ behaviour: ApprovalBehaviour; answers?: Record<string, string>; timedOut: boolean }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle("deny", undefined, true), this.options.timeoutMs ?? CONTROLLER_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const settle = (behaviour: ApprovalBehaviour, answers?: Record<string, string>, timedOut = false) => {
        clearTimeout(timer);
        this.settle(approval.id, behaviour);
        resolve({ behaviour, answers, timedOut });
      };
      this.pending.set(approval.id, { approval, resolve: settle });
      this.emit({ type: "approval", approval });
    });
  }

  private raise(
    scope: string,
    tool: string,
    input: Record<string, unknown>,
    extras: { agentId?: string; review?: GatekeeperReview },
    answerIn: ControllerApproval["answerIn"],
    questions: AskQuestion[] | null = null,
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
      questions,
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
