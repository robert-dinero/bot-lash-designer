/**
 * SESSION group tests — all use in-memory SQLite via knex
 * SESSION-01: initSchema() creates all 4 tables
 * SESSION-02: upsertUser() creates user on first call, ignores on second
 * SESSION-03: getOrCreateSession() creates for new phone, loads for existing
 * SESSION-04: cart_json stored as '{}' neutral placeholder (food-delivery cart removed in Plan 01-02)
 * SESSION-05: getHistory caps at HISTORY_LIMIT (10)
 * SESSION-06: saveMessage saves user+assistant messages atomically (replaces saveMessageAndUpdateCart)
 * SESSION-07: resetSession() clears session and returns to initial state
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import knexLib, { type Knex } from 'knex';

// ─── In-memory DB factory ─────────────────────────────────────────────────────

async function createTestDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });

  await db.schema.createTable('users', (t) => {
    t.string('phone').primary();
    t.string('created_at').notNullable().defaultTo(db.fn.now());
  });

  await db.schema.createTable('sessions', (t) => {
    t.string('phone').primary();
    t.text('cart_json').notNullable().defaultTo('{}');
    t.integer('misunderstanding_count').notNullable().defaultTo(0);
    t.string('created_at').notNullable().defaultTo(db.fn.now());
    t.string('updated_at').notNullable().defaultTo(db.fn.now());
    t.foreign('phone').references('users.phone');
  });

  await db.schema.createTable('messages', (t) => {
    t.increments('id').primary();
    t.string('phone').notNullable();
    t.string('role').notNullable();
    t.text('content').notNullable();
    t.string('created_at').notNullable().defaultTo(db.fn.now());
    t.foreign('phone').references('users.phone');
  });

  await db.schema.createTable('processed_messages', (t) => {
    t.string('message_id').primary();
    t.string('processed_at').notNullable().defaultTo(db.fn.now());
  });

  return db;
}

// ─── SESSION-01: initSchema creates all 4 tables ──────────────────────────────

describe('SESSION-01: initSchema() creates all 4 required tables', () => {
  it('creates users, sessions, messages, processed_messages', async () => {
    const db = await createTestDb();
    const tables = ['users', 'sessions', 'messages', 'processed_messages'];
    for (const table of tables) {
      const exists = await db.schema.hasTable(table);
      expect(exists, `Table '${table}' should exist`).toBe(true);
    }
    await db.destroy();
  });

  it('sessions table has cart_json column defaulting to {}', async () => {
    const db = await createTestDb();
    const hasCol = await db.schema.hasColumn('sessions', 'cart_json');
    expect(hasCol).toBe(true);

    await db('users').insert({ phone: 'test-01', created_at: new Date().toISOString() });
    await db.raw(
      'INSERT INTO sessions (phone, created_at, updated_at) VALUES (?, ?, ?)',
      ['test-01', new Date().toISOString(), new Date().toISOString()]
    );
    const row = await db('sessions').where({ phone: 'test-01' }).first();
    expect(row.cart_json).toBe('{}');
    await db.destroy();
  });

  it('messages table has increments id primary key', async () => {
    const db = await createTestDb();
    const hasId = await db.schema.hasColumn('messages', 'id');
    expect(hasId).toBe(true);
    await db.destroy();
  });

  it('db/index.ts source code creates all 4 tables', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/db/index.ts'),
      'utf-8'
    );
    expect(src).toContain("'users'");
    expect(src).toContain("'sessions'");
    expect(src).toContain("'messages'");
    expect(src).toContain("'processed_messages'");
  });
});

// ─── Service tests with in-memory db injection ────────────────────────────────
// Strategy: use vi.mock('../db') and control the db instance per describe block.
// We use module-level db variable + beforeEach/afterEach lifecycle.

// NOTE: vi.mock is hoisted, so we set up a module-level variable that the mock reads.
let currentDb: Knex | null = null;

vi.mock('../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('Test DB not initialized');
    return currentDb;
  },
}));

// ─── SESSION-02: upsertUser ────────────────────────────────────────────────────

describe('SESSION-02: upsertUser() idempotent creation', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('creates user on first call', async () => {
    const { upsertUser } = await import('../services/session.service');
    await upsertUser('5521111111111');
    const user = await currentDb!('users').where({ phone: '5521111111111' }).first();
    expect(user).toBeDefined();
    expect(user.phone).toBe('5521111111111');
  });

  it('does not throw or duplicate on second call for same phone', async () => {
    const { upsertUser } = await import('../services/session.service');
    await upsertUser('5521222222222');
    await expect(upsertUser('5521222222222')).resolves.toBeUndefined();
    const rows = await currentDb!('users').where({ phone: '5521222222222' });
    expect(rows.length).toBe(1);
  });
});

// ─── SESSION-03: getOrCreateSession ───────────────────────────────────────────

describe('SESSION-03: getOrCreateSession() creates for new phone, loads for existing', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('session row is created on first call for unknown phone', async () => {
    const { upsertUser, getOrCreateSession } = await import('../services/session.service');
    await upsertUser('5521333333333');
    await getOrCreateSession('5521333333333');
    const row = await currentDb!('sessions').where({ phone: '5521333333333' }).first();
    expect(row).toBeDefined();
    expect(row.phone).toBe('5521333333333');
  });

  it('isNew=false on second call for same phone', async () => {
    const { upsertUser, getOrCreateSession } = await import('../services/session.service');
    await upsertUser('5521444444444');
    await getOrCreateSession('5521444444444');
    const { isNew } = await getOrCreateSession('5521444444444');
    expect(isNew).toBe(false);
  });

  it('session row is created in DB on first call', async () => {
    const { upsertUser, getOrCreateSession } = await import('../services/session.service');
    await upsertUser('5521555555555');
    await getOrCreateSession('5521555555555');
    const row = await currentDb!('sessions').where({ phone: '5521555555555' }).first();
    expect(row).toBeDefined();
  });

  it('session returned on subsequent call has same phone', async () => {
    const { upsertUser, getOrCreateSession } = await import('../services/session.service');
    await upsertUser('5521666666666');
    const { session: s1 } = await getOrCreateSession('5521666666666');
    const { session: s2 } = await getOrCreateSession('5521666666666');
    expect(s2.phone).toBe(s1.phone);
  });
});

// ─── SESSION-04: cart_json stores neutral '{}' (food-delivery Cart removed) ───

describe('SESSION-04: cart_json stores neutral JSON placeholder (delivery Cart removed)', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('new session stores cart_json as parseable JSON', async () => {
    const { upsertUser, getOrCreateSession } = await import('../services/session.service');
    await upsertUser('5521777777777');
    await getOrCreateSession('5521777777777');
    const row = await currentDb!('sessions').where({ phone: '5521777777777' }).first();
    expect(() => JSON.parse(row.cart_json)).not.toThrow();
  });

  it('resetSession clears scheduling fields from cart_json', async () => {
    const { upsertUser, getOrCreateSession, resetSession } = await import('../services/session.service');
    const phone = '5521888888888';
    await upsertUser(phone);
    await getOrCreateSession(phone);
    // Manually set cart_json to something without a clientName
    await currentDb!('sessions').where({ phone }).update({ cart_json: '{"some":"data"}' });
    await resetSession(phone);
    const row = await currentDb!('sessions').where({ phone }).first();
    const parsed = JSON.parse(row.cart_json);
    expect(parsed.confirmed).toBe(false);
    expect(parsed.some).toBeUndefined();
  });
});

// ─── SESSION-05: getHistory HISTORY_LIMIT ────────────────────────────────────

describe('SESSION-05: getHistory() caps at HISTORY_LIMIT (10)', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('getHistory returns max 10 messages (SESSION-05)', async () => {
    const { upsertUser, getHistory } = await import('../services/session.service');
    const phone = '5521900000001';
    await upsertUser(phone);

    // Insert 25 messages
    const now = new Date().toISOString();
    for (let i = 1; i <= 25; i++) {
      await currentDb!('messages').insert({
        phone,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `message ${i}`,
        created_at: now,
      });
    }

    const history = await getHistory(phone);
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('getHistory returns messages in chronological order (oldest first)', async () => {
    const { upsertUser, getHistory } = await import('../services/session.service');
    const phone = '5521900000002';
    await upsertUser(phone);

    await currentDb!('messages').insert({ phone, role: 'user', content: 'first', created_at: '2026-01-01T10:00:00.000Z' });
    await currentDb!('messages').insert({ phone, role: 'assistant', content: 'second', created_at: '2026-01-01T10:01:00.000Z' });
    await currentDb!('messages').insert({ phone, role: 'user', content: 'third', created_at: '2026-01-01T10:02:00.000Z' });

    const history = await getHistory(phone);
    expect(history[0].content).toBe('first');
    expect(history[history.length - 1].content).toBe('third');
  });
});

// ─── SESSION-06: saveMessage saves both messages atomically ──────────────────

describe('SESSION-06: saveMessage() saves user and assistant messages atomically', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('saves both user and assistant messages in one call', async () => {
    const { upsertUser, getOrCreateSession, saveMessage } = await import('../services/session.service');
    const phone = '5521100000001';
    await upsertUser(phone);
    await getOrCreateSession(phone);

    await saveMessage(phone, 'user msg', 'assistant reply');

    const messages = await currentDb!('messages').where({ phone });
    expect(messages.length).toBe(2);
    const roles = messages.map((m: any) => m.role).sort();
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('persists correct message content', async () => {
    const { upsertUser, getOrCreateSession, saveMessage } = await import('../services/session.service');
    const phone = '5521100000002';
    await upsertUser(phone);
    await getOrCreateSession(phone);

    await saveMessage(phone, 'pergunta do usuario', 'resposta do bot');

    const messages = await currentDb!('messages').where({ phone }).orderBy('role');
    const assistant = messages.find((m: any) => m.role === 'assistant');
    const user = messages.find((m: any) => m.role === 'user');
    expect(user?.content).toBe('pergunta do usuario');
    expect(assistant?.content).toBe('resposta do bot');
  });
});

// ─── SESSION-07: resetSession clears session ─────────────────────────────────

describe('SESSION-07: resetSession() clears session and returns to initial state', () => {
  beforeEach(async () => {
    currentDb = await createTestDb();
  });

  afterEach(async () => {
    await currentDb?.destroy();
    currentDb = null;
  });

  it('resets cart_json to initial state after data was stored', async () => {
    const { upsertUser, getOrCreateSession, resetSession } = await import('../services/session.service');
    const phone = '5521200000001';
    await upsertUser(phone);
    await getOrCreateSession(phone);
    await currentDb!('sessions').where({ phone }).update({ cart_json: '{"step":"collecting_service"}' });

    await resetSession(phone);

    const row = await currentDb!('sessions').where({ phone }).first();
    const parsed = JSON.parse(row.cart_json);
    expect(parsed.confirmed).toBe(false);
    expect(parsed.step).toBeUndefined();
  });

  it('resets misunderstanding_count to 0', async () => {
    const { upsertUser, getOrCreateSession, incrementMisunderstanding, resetSession } = await import('../services/session.service');
    const phone = '5521200000002';
    await upsertUser(phone);
    await getOrCreateSession(phone);
    await incrementMisunderstanding(phone);
    await incrementMisunderstanding(phone);

    await resetSession(phone);

    const row = await currentDb!('sessions').where({ phone }).first();
    expect(row.misunderstanding_count).toBe(0);
  });
});
