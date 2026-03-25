import {
  generateText,
  streamText,
  type CoreMessage,
  type CoreTool,
  type LanguageModel,
} from 'ai';
import type { AgentConfig, RunRequest, RunResponse, ToolDefinition } from './types.js';
import { getTools } from './tools/index.js';
import { loadMemory } from './memory.js';
import { shouldCompact, compact } from './compaction.js';

export class AgentRunner {
  private config: AgentConfig;
  private model: LanguageModel;
  private tools: Record<string, CoreTool>;

  constructor(config: AgentConfig, model: LanguageModel) {
    this.config = config;
    this.model = model;
    this.tools = config.tools.length > 0 ? getTools(config.tools) : {};
  }

  async run(request: RunRequest): Promise<RunResponse> {
    const systemPrompt = await this.buildSystemPrompt(request.systemPrompt);
    const maxSteps = request.config?.maxSteps ?? this.config.maxSteps;

    // Compact messages before sending to the model if they exceed the threshold
    const messages = await this.maybeCompact(request.messages);

    const result = await generateText({
      model: this.model,
      system: systemPrompt,
      messages,
      tools: this.tools,
      maxSteps,
    });

    return {
      messages: result.response.messages as CoreMessage[],
      usage: result.usage as Record<string, unknown>,
      finishReason: result.finishReason,
    };
  }

  async stream(request: RunRequest): Promise<ReadableStream> {
    const systemPrompt = await this.buildSystemPrompt(request.systemPrompt);
    const maxSteps = request.config?.maxSteps ?? this.config.maxSteps;

    // Compact messages before sending to the model if they exceed the threshold
    const messages = await this.maybeCompact(request.messages);

    const result = streamText({
      model: this.model,
      system: systemPrompt,
      messages,
      tools: this.tools,
      maxSteps,
    });

    return result.toDataStream();
  }

  private async maybeCompact(messages: CoreMessage[]): Promise<CoreMessage[]> {
    if (shouldCompact(messages, this.config.compactionThreshold)) {
      return compact(messages, this.model);
    }
    return messages;
  }

  getToolDefinitions(): ToolDefinition[] {
    return Object.entries(this.tools).map(([name, t]) => ({
      name,
      description: (t as Record<string, unknown>).description as string ?? '',
      inputSchema: (t as Record<string, unknown>).parameters
        ? JSON.parse(JSON.stringify((t as Record<string, unknown>).parameters))
        : {},
    }));
  }

  private async buildSystemPrompt(basePrompt: string): Promise<string> {
    if (!this.config.memoryDir) {
      return basePrompt;
    }

    const memory = await loadMemory(this.config.memoryDir);
    if (!memory) {
      return basePrompt;
    }

    return `${basePrompt}\n\n${memory}`;
  }
}
