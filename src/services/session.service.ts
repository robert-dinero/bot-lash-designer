import { getDb } from '../db';
import type { Message, Session, AppointmentState } from '../types';
import { log, maskPhone } from '../utils/logger';

const HISTORY_LIMIT = 10;

// ─── User ────────────────────────────────────────────────────────────────────

export async function upsertUser(phone: string): Promise<void> {
  const db = getDb();
  const result = await db.raw(
    'INSERT OR IGNORE INTO users (phone, created_at) VALUES (?, ?)',
    [phone, new Date().toISOString()]
  );
  const changes = result[0]?.changes ?? result?.changes ?? 0;
  if (changes > 0) log.info(maskPhone(phone), 'SESSION', 'New user created');
}

// ─── Session ─────────────────────────────────────────────────────────────────

export async function getOrCreateSession(phone: string): Promise<{ session: Session; isNew: boolean }> {
  const db = getDb();
  const now = new Date().toISOString();
  const result = await db.raw(
    'INSERT OR IGNORE INTO sessions (phone, cart_json, misunderstanding_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    [phone, '{}', now, now]
  );
  const changes = result[0]?.changes ?? result?.changes ?? 0;
  const isNew = changes > 0;
  if (isNew) log.info(maskPhone(phone), 'SESSION', 'New session created');
  const session = await db('sessions').where({ phone }).first() as Session;
  return { session, isNew };
}

export async function incrementMisunderstanding(phone: string): Promise<number> {
  const db = getDb();
  await db('sessions').where({ phone }).increment('misunderstanding_count', 1);
  await db('sessions').where({ phone }).update({ updated_at: new Date().toISOString() });
  const session = await db('sessions').where({ phone }).first() as Session;
  return session.misunderstanding_count;
}

export async function resetMisunderstanding(phone: string): Promise<void> {
  const db = getDb();
  await db('sessions')
    .where({ phone })
    .update({ misunderstanding_count: 0, updated_at: new Date().toISOString() });
}

/**
 * Reset session booking state while preserving client identity (name + nameAsked flag).
 * This prevents the name gate from firing again for known clients after cancellation,
 * session expiry, or post-confirmation cleanup.
 */
export async function resetSession(phone: string): Promise<void> {
  const db = getDb();
  // Read current state to preserve clientName and nameAsked
  const session = await db('sessions').where({ phone }).first() as Session | undefined;
  let preserved: Pick<AppointmentState, 'clientName' | 'nameAsked'> = {};
  if (session?.cart_json) {
    try {
      const existing = JSON.parse(session.cart_json) as AppointmentState;
      if (existing.clientName) preserved = { clientName: existing.clientName, nameAsked: true };
    } catch {
      // ignore parse error — reset cleanly
    }
  }
  await db('sessions')
    .where({ phone })
    .update({
      cart_json: JSON.stringify({ ...preserved, confirmed: false }),
      misunderstanding_count: 0,
      updated_at: new Date().toISOString(),
    });
  log.info(maskPhone(phone), 'SESSION', `Session reset${preserved.clientName ? ` (kept name: ${preserved.clientName})` : ''}`);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function saveMessage(
  phone: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await trx('messages').insert({ phone, role: 'user', content: userMessage, created_at: now });
    await trx('messages').insert({ phone, role: 'assistant', content: assistantReply, created_at: now });
  });
}

export async function getHistory(phone: string): Promise<Message[]> {
  const db = getDb();
  const rows = await db('messages')
    .where({ phone })
    .orderBy('id', 'desc')
    .limit(HISTORY_LIMIT);

  // Return in chronological order (oldest first)
  return (rows as Message[]).reverse();
}

// ─── Appointment State ────────────────────────────────────────────────────────

export async function saveAppointmentState(phone: string, state: AppointmentState): Promise<void> {
  const db = getDb();
  const json = JSON.stringify(state);
  await db('sessions')
    .where({ phone })
    .update({
      cart_json: json,
      updated_at: new Date().toISOString(),
    });
  log.info(maskPhone(phone), 'SESSION', `Appointment state saved: ${state.confirmed ? 'CONFIRMADO' : 'PENDING'}`);
}

export async function getAppointmentState(phone: string): Promise<AppointmentState> {
  const db = getDb();
  const session = await db('sessions').where({ phone }).first() as Session | undefined;
  if (!session) return { confirmed: false };
  try {
    return JSON.parse(session.cart_json) as AppointmentState;
  } catch {
    log.warn(maskPhone(phone), 'SESSION', `Could not parse cart_json, returning empty state`);
    return { confirmed: false };
  }
}
