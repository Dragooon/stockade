import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { getMessages } from '@/lib/sessions';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ scope: string }> },
) {
  try {
    const { scope } = await params;
    const decodedScope = decodeURIComponent(scope);
    const db = getDb();

    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.scope, decodedScope))
      .get();

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const messages = getMessages(db, session.id);

    return NextResponse.json({
      session,
      messageCount: messages.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
