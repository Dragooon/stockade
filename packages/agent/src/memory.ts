import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadMemory(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir);
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

    if (mdFiles.length === 0) {
      return '';
    }

    const sections: string[] = [];

    for (const file of mdFiles) {
      const content = await readFile(join(dir, file), 'utf-8');
      sections.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
    }

    return `## Memory\n\n${sections.join('\n\n')}`;
  } catch {
    return '';
  }
}
