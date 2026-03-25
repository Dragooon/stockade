import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { terminalScope } from "./scope.js";
import type { ChannelMessage } from "../types.js";

export class TerminalAdapter {
  private agentName: string;
  private onMessage: (msg: ChannelMessage) => Promise<string>;
  private rl: Interface | null = null;
  private scope: string;

  constructor(
    config: { agent: string },
    onMessage: (msg: ChannelMessage) => Promise<string>
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
        const response = await this.onMessage(msg);
        process.stdout.write(`\n${response}\n\n`);
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
}
