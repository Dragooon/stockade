import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { terminalScope } from "./scope.js";
import type { ChannelMessage, ChannelResponse, ApprovalChannel } from "../types.js";
import { formatToolApproval } from "../permissions.js";
import type { GatekeeperReview } from "../gatekeeper.js";

export class TerminalAdapter {
  private agentName: string;
  private onMessage: (msg: ChannelMessage, approvalChannel?: ApprovalChannel) => Promise<ChannelResponse>;
  private rl: Interface | null = null;
  private scope: string;

  constructor(
    config: { agent: string },
    onMessage: (msg: ChannelMessage, approvalChannel?: ApprovalChannel) => Promise<ChannelResponse>,
  ) {
    this.agentName = config.agent;
    this.onMessage = onMessage;
    const sessionId = randomUUID();
    const username = userInfo().username;
    this.scope = terminalScope(sessionId, username);
  }

  start(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    this.rl.prompt();

    this.rl.on("line", async (line: string) => {
      const content = line.trim();
      if (!content) {
        this.rl?.prompt();
        return;
      }

      const msg: ChannelMessage = {
        scope: this.scope,
        content,
        userId: userInfo().username,
        platform: "terminal",
      };

      process.stdout.write("Thinking...\n");

      try {
        const approvalChannel = this.createApprovalChannel();
        const response = await this.onMessage(msg, approvalChannel);
        process.stdout.write(`\n${response.text}\n\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`\nError: ${message}\n\n`);
      }

      this.rl?.prompt();
    });

    this.rl.on("close", () => {
      process.stdout.write("\nGoodbye!\n");
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  /** Deliver a scheduled task result to the terminal. */
  async send(_scope: string, text: string): Promise<void> {
    process.stdout.write(`\n[Scheduled task]\n${text}\n\n`);
    this.rl?.prompt();
  }

  /**
   * Create an ApprovalChannel for the terminal.
   *
   * Provides two rendering callbacks:
   *   - askUser: prompts via readline with optional risk review
   *   - notifyAutoApproved: prints informational line to stdout
   *
   * No gatekeeper logic — the orchestrator decides when to call which.
   */
  private createApprovalChannel(): ApprovalChannel {
    return {
      askUser: async (tool, input, review?) => {
        if (!this.rl) return false;

        return new Promise<boolean>((resolve) => {
          const desc = formatToolApproval(tool, input);
          let prompt = `\n--- Tool approval required ---\n${desc}\n`;
          if (review) {
            prompt += formatTerminalReview(review);
          }
          prompt += "Allow? [y/N] ";

          this.rl!.question(prompt, (answer) => {
            const normalized = answer.trim().toLowerCase();
            resolve(normalized === "y" || normalized === "yes");
          });
        });
      },

      notifyAutoApproved: async (tool, input, review) => {
        const desc = formatToolApproval(tool, input);
        process.stdout.write(
          `\n--- Auto-approved (${review.risk} risk) ---\n${desc}\n` +
          formatTerminalReview(review),
        );
      },
    };
  }
}

function formatTerminalReview(review: GatekeeperReview): string {
  return `  Risk: ${review.risk.toUpperCase()}\n  ${review.summary}\n`;
}
