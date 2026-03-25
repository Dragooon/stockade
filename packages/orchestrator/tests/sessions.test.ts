import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getOrCreateSession, getMessages, saveMessages, deleteSession } from '@/lib/sessions';
import { createDb } from '@/lib/db';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Session Manager', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let closeDb: () => void;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const testDb = createDb(dbPath);
    db = testDb.db;
    closeDb = testDb.close;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateSession', () => {
    it('creates a new session for a new scope', () => {
      const session = getOrCreateSession(db, 'discord:123:456:789', 'main');
      expect(session.id).toBeDefined();
      expect(session.scope).toBe('discord:123:456:789');
      expect(session.agentId).toBe('main');
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThan(0);
    });

    it('returns existing session for same scope', () => {
      const session1 = getOrCreateSession(db, 'discord:123:456:789', 'main');
      const session2 = getOrCreateSession(db, 'discord:123:456:789', 'main');
      expect(session1.id).toBe(session2.id);
    });

    it('creates different sessions for different scopes', () => {
      const session1 = getOrCreateSession(db, 'discord:123:456:789', 'main');
      const session2 = getOrCreateSession(db, 'discord:123:456:000', 'main');
      expect(session1.id).not.toBe(session2.id);
    });
  });

  describe('getMessages', () => {
    it('returns empty array for new session', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      const messages = getMessages(db, session.id);
      expect(messages).toEqual([]);
    });

    it('returns messages in order', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      saveMessages(db, session.id, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);

      const messages = getMessages(db, session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hi there!');
    });
  });

  describe('saveMessages', () => {
    it('persists messages to the database', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      saveMessages(db, session.id, [
        { role: 'user', content: 'Question' },
      ]);

      const messages = getMessages(db, session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Question');
    });

    it('appends to existing messages', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      saveMessages(db, session.id, [
        { role: 'user', content: 'First' },
      ]);
      saveMessages(db, session.id, [
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second' },
      ]);

      const messages = getMessages(db, session.id);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Response');
      expect(messages[2].content).toBe('Second');
    });

    it('updates session updatedAt timestamp', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      const initialUpdatedAt = session.updatedAt;

      saveMessages(db, session.id, [
        { role: 'user', content: 'Hello' },
      ]);

      const updatedSession = getOrCreateSession(db, 'test:scope', 'main');
      expect(updatedSession.updatedAt).toBeGreaterThanOrEqual(initialUpdatedAt);
    });
  });

  describe('deleteSession', () => {
    it('deletes a session and its messages', () => {
      const session = getOrCreateSession(db, 'test:scope', 'main');
      saveMessages(db, session.id, [
        { role: 'user', content: 'Hello' },
      ]);

      deleteSession(db, 'test:scope');

      const newSession = getOrCreateSession(db, 'test:scope', 'main');
      expect(newSession.id).not.toBe(session.id);

      const messages = getMessages(db, newSession.id);
      expect(messages).toHaveLength(0);
    });

    it('does nothing for non-existent scope', () => {
      expect(() => deleteSession(db, 'nonexistent:scope')).not.toThrow();
    });
  });
});
