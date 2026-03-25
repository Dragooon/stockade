import { eq, asc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { SessionRecord, CoreMessage } from '@/types';

export function getOrCreateSession(
  db: BetterSQLite3Database<typeof schema>,
  scope: string,
  agentId: string,
): SessionRecord {
  const existing = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.scope, scope))
    .get();

  if (existing) {
    return existing;
  }

  const now = Date.now();
  const newSession: SessionRecord = {
    id: uuidv4(),
    scope,
    agentId,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.sessions).values(newSession).run();
  return newSession;
}

export function getMessages(
  db: BetterSQLite3Database<typeof schema>,
  sessionId: string,
): CoreMessage[] {
  const rows = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(asc(schema.messages.createdAt))
    .all();

  return rows.map((row) => ({
    role: row.role as CoreMessage['role'],
    content: row.content,
  }));
}

export function saveMessages(
  db: BetterSQLite3Database<typeof schema>,
  sessionId: string,
  newMessages: CoreMessage[],
): void {
  const now = Date.now();

  for (const msg of newMessages) {
    db.insert(schema.messages)
      .values({
        id: uuidv4(),
        sessionId,
        role: msg.role,
        content: msg.content,
        createdAt: now,
      })
      .run();
  }

  db.update(schema.sessions)
    .set({ updatedAt: now })
    .where(eq(schema.sessions.id, sessionId))
    .run();
}

export function deleteSession(
  db: BetterSQLite3Database<typeof schema>,
  scope: string,
): void {
  const session = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.scope, scope))
    .get();

  if (!session) return;

  db.delete(schema.messages)
    .where(eq(schema.messages.sessionId, session.id))
    .run();

  db.delete(schema.sessions)
    .where(eq(schema.sessions.id, session.id))
    .run();
}
