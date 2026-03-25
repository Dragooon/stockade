import { generateText, type CoreMessage, type LanguageModel } from 'ai';

const KEEP_RECENT = 20;

export function estimateTokens(messages: CoreMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          totalChars += part.text.length;
        }
      }
    }
  }
  return Math.floor(totalChars / 4);
}

export function shouldCompact(messages: CoreMessage[], threshold: number): boolean {
  return estimateTokens(messages) > threshold;
}

export async function compact(
  messages: CoreMessage[],
  model: LanguageModel,
): Promise<CoreMessage[]> {
  if (messages.length <= KEEP_RECENT) {
    return messages;
  }

  const olderMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(messages.length - KEEP_RECENT);

  const conversationText = olderMessages
    .map((m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    })
    .join('\n');

  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: `Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation:\n\n${conversationText}`,
      },
    ],
  });

  const summaryMessage: CoreMessage = {
    role: 'system',
    content: `Summary: ${text}`,
  };

  return [summaryMessage, ...recentMessages];
}
