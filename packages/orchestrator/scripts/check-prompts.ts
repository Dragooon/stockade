import { buildSystemPrompt } from '../src/dispatcher.js';
import { loadConfig } from '../src/config.js';
import * as os from 'os';
import * as path from 'path';

const cfg = loadConfig(path.join(os.homedir(), '.stockade'));
const allAgents = cfg.agents;

function estTokens(s: string) { return Math.round(s.length / 4); }

for (const [id, agent] of Object.entries(allAgents.agents)) {
  const prompt = buildSystemPrompt(agent as any, true, allAgents, false);
  if (!prompt) { console.log(`${id.padEnd(12)}: (no system prompt)`); continue; }
  const text = typeof prompt === 'string' ? prompt : (prompt as any).append;
  console.log(`${id.padEnd(12)} ~${estTokens(text).toString().padStart(5)} tokens  (${text.length} chars)`);
}
