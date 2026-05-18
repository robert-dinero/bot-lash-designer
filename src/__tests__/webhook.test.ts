import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';

// Setup in-memory test database before importing modules that use getDb
let testDb: Knex | null = null;

vi.mock('../db', async () => {
  if (!testDb) {
    testDb = knex({
      client: 'sqlite3',
      connection: ':memory:',
      useNullAsDefault: true,
    });
  }
  return {
    getDb: () => testDb,
    initSchema: async () => {
      const db = testDb!;

      await db.schema.createTable('users', (t) => {
        t.string('phone').primary();
        t.string('created_at').notNullable();
      });

      await db.schema.createTable('sessions', (t) => {
        t.string('phone').primary();
        t.text('cart_json').notNullable().defaultTo('{}');
        t.integer('misunderstanding_count').notNullable().defaultTo(0);
        t.string('created_at').notNullable();
        t.string('updated_at').notNullable();
        t.foreign('phone').references('users.phone');
      });

      await db.schema.createTable('messages', (t) => {
        t.increments('id').primary();
        t.string('phone').notNullable();
        t.string('role').notNullable();
        t.text('content').notNullable();
        t.string('created_at').notNullable();
        t.foreign('phone').references('users.phone');
      });

      await db.schema.createTable('processed_messages', (t) => {
        t.string('message_id').primary();
        t.string('processed_at').notNullable();
      });

      await db.schema.createTable('chairs', (t) => {
        t.increments('id').primary();
        t.text('name').notNullable();
        t.integer('active').notNullable().defaultTo(1);
      });

      await db.schema.createTable('services', (t) => {
        t.increments('id').primary();
        t.text('name').notNullable();
        t.integer('duration_minutes').notNullable();
        t.integer('price_cents').notNullable();
        t.integer('active').notNullable().defaultTo(1);
      });

      await db.schema.createTable('appointments', (t) => {
        t.increments('id').primary();
        t.integer('chair_id').notNullable();
        t.text('client_phone').notNullable();
        t.integer('service_id').notNullable();
        t.text('starts_at').notNullable();
        t.integer('duration_minutes').notNullable();
        t.text('status').notNullable().defaultTo('confirmed');
        t.text('notes').nullable();
        t.text('created_at').notNullable();
        t.text('updated_at').notNullable();
      });

      await db.schema.createTable('working_hours', (t) => {
        t.increments('id').primary();
        t.integer('chair_id').notNullable();
        t.integer('day_of_week').notNullable();
        t.text('open_time').notNullable();
        t.text('close_time').notNullable();
        t.integer('is_closed').notNullable().defaultTo(0);
      });

      await db.schema.createTable('availability_blocks', (t) => {
        t.increments('id').primary();
        t.integer('chair_id').notNullable();
        t.text('starts_at').notNullable();
        t.text('ends_at').notNullable();
        t.text('reason').nullable();
      });

      // Seed data
      await db('chairs').insert({ id: 1, name: 'Cadeira 1', active: 1 });
      await db('services').insert({ id: 1, name: 'Corte', duration_minutes: 30, price_cents: 4000, active: 1 });
      await db('services').insert({ id: 2, name: 'Barba', duration_minutes: 20, price_cents: 2500, active: 1 });
      await db('services').insert({ id: 3, name: 'Corte + Barba', duration_minutes: 45, price_cents: 6000, active: 1 });

      // Seed working hours for chair 1 (closed Sunday, open Mon-Sat 09:00-19:00)
      for (let day = 0; day < 7; day++) {
        await db('working_hours').insert({
          chair_id: 1,
          day_of_week: day,
          open_time: day === 0 ? '00:00' : '09:00',
          close_time: day === 0 ? '00:00' : '19:00',
          is_closed: day === 0 ? 1 : 0,
        });
      }
    },
  };
});

// Mock waha service
const sendTextMock = vi.fn();
vi.mock('../services/waha.service', () => ({
  normalizePhone: (from: string) => from.replace(/@.*$/, ''),
  sendText: sendTextMock,
  resolveLid: vi.fn(() => Promise.resolve(null)),
  notifyOwner: vi.fn(),
  toChatId: (phone: string) => `${phone}@c.us`,
}));

// Mock dedup
vi.mock('../lib/dedup', () => ({
  isDuplicateAndMark: vi.fn(() => Promise.resolve(false)),
}));

// Setup AI mock
const mockAIResponse = vi.fn();
vi.mock('../services/ai.service', () => ({
  detectCancelKeyword: (body: string) => /cancelar/i.test(body.trim()),
  detectRescheduleKeyword: (body: string) => /remarcar/i.test(body.trim()),
  getAIResponse: mockAIResponse,
}));

describe('Webhook Scheduling Integration Tests', () => {
  beforeAll(async () => {
    const { initSchema } = await import('../db');
    await initSchema();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = testDb!;

    // Clear all data
    await db('appointments').delete();
    await db('messages').delete();
    await db('processed_messages').delete();
    await db('sessions').delete();
    await db('users').delete();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should handle client requesting service and respond with available slots', async () => {
    const { handleWebhook } = await import('../controllers/webhook.controller');
    sendTextMock.mockReset();

    mockAIResponse.mockResolvedValueOnce({
      reply: 'Ótimo! Um corte. Temos horários disponíveis: 14:00, 14:30, 15:00, 15:30',
      appointmentPatch: { service: 'Corte' },
    });

    const payload = {
      payload: {
        id: 'msg-001',
        from: '5511999999999@c.us',
        body: 'Quero um corte amanhã',
        type: 'chat',
        fromMe: false,
      },
    };

    const req = { body: payload } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Wait for async processing
    await new Promise(r => setTimeout(r, 100));

    expect(sendTextMock).toHaveBeenCalled();
  });

  it('should validate and prevent double-booking', async () => {
    const { handleWebhook } = await import('../controllers/webhook.controller');
    const { getAppointments } = await import('../controllers/appointment.controller');
    const db = testDb!;
    sendTextMock.mockReset();

    // Pre-insert an appointment at 14:00 BRT (UTC-3) = 17:00 UTC
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const slotTime = new Date(tomorrow);
    slotTime.setHours(17, 0, 0, 0); // 14:00 BRT

    await db('users').insert({ phone: '5511888888888', created_at: new Date().toISOString() });
    await db('sessions').insert({
      phone: '5511888888888',
      cart_json: '{}',
      misunderstanding_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511888888888',
      service_id: 1,
      starts_at: slotTime.toISOString(),
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Pre-seed client name for second client so name gate is bypassed
    await db('users').insert({ phone: '5511999999999', created_at: new Date().toISOString() }).onConflict('phone').ignore();
    await db('sessions').insert({
      phone: '5511999999999',
      cart_json: JSON.stringify({ clientName: 'TestClient', nameAsked: true, confirmed: false }),
      misunderstanding_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).onConflict('phone').merge();

    // Try to book same slot with different client
    const payload = {
      payload: {
        id: 'msg-002',
        from: '5511999999999@c.us',
        body: 'Quero às 14:00 amanhã',
        type: 'chat',
        fromMe: false,
      },
    };

    const req = { body: payload } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    mockAIResponse.mockResolvedValueOnce({
      reply: 'Perfeito, confirmando para 14:00',
      appointmentPatch: { service: 'Corte', requestedDateTime: 'amanhã', confirmedTime: '14:00' },
    });

    await handleWebhook(req, res);
    await new Promise(r => setTimeout(r, 100));

    // Bot should have responded (either rejected the slot or shown available slots)
    expect(sendTextMock).toHaveBeenCalled();
    // No appointment should have been created for the second client
    const appts2 = await db('appointments').where({ client_phone: '5511999999999' }).select();
    expect(appts2).toHaveLength(0);
  });

  it('should handle appointment state persistence in cart_json', async () => {
    const { handleWebhook } = await import('../controllers/webhook.controller');
    const db = testDb!;
    sendTextMock.mockReset();

    const phone = '5511999999999';

    // Pre-seed client name so name gate is bypassed
    await db('users').insert({ phone, created_at: new Date().toISOString() }).onConflict('phone').ignore();
    await db('sessions').insert({
      phone,
      cart_json: JSON.stringify({ clientName: 'TestClient', nameAsked: true, confirmed: false }),
      misunderstanding_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).onConflict('phone').merge();

    mockAIResponse.mockResolvedValueOnce({
      reply: 'Ótimo, um corte',
      appointmentPatch: { service: 'Corte' },
    });

    const payload = {
      payload: {
        id: 'msg-001',
        from: `${phone}@c.us`,
        body: 'Quero um corte',
        type: 'chat',
        fromMe: false,
      },
    };

    const req = { body: payload } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handleWebhook(req, res);
    await new Promise(r => setTimeout(r, 100));

    const session = await db('sessions').where({ phone }).first();
    expect(session).toBeDefined();
    expect(session.cart_json).toBeDefined();
    expect(session.cart_json).not.toBe('{}');

    const state = JSON.parse(session.cart_json);
    expect(state.service).toBe('Corte');
  });

  it('GET /appointments/:phone should return client appointments', async () => {
    const { getAppointments } = await import('../controllers/appointment.controller');
    const db = testDb!;

    const phone = '5511999999999';

    // Insert user and session first
    await db('users').insert({ phone, created_at: new Date().toISOString() });
    await db('sessions').insert({
      phone,
      cart_json: '{}',
      misunderstanding_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Insert appointment
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const slotTime = new Date(tomorrow);
    slotTime.setHours(14, 0, 0, 0);

    await db('appointments').insert({
      chair_id: 1,
      client_phone: phone,
      service_id: 1,
      starts_at: slotTime.toISOString(),
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jsonFn = vi.fn();
    const req = { params: { phone } } as unknown as Request;
    const res = {
      json: jsonFn,
      status: vi.fn().mockReturnThis(),
    } as unknown as Response;

    await getAppointments(req, res);

    expect(jsonFn).toHaveBeenCalled();
    const appointments = jsonFn.mock.calls[0][0];
    expect(Array.isArray(appointments)).toBe(true);
    expect(appointments.length).toBe(1);
    expect(appointments[0].client_phone).toBe(phone);
    expect(appointments[0].service_name).toBe('Corte');
  });

  it('should fetch services from DB and pass them as 5th arg to getAIResponse', async () => {
    const { handleWebhook } = await import('../controllers/webhook.controller');
    const db = testDb!;
    sendTextMock.mockReset();
    mockAIResponse.mockReset();

    const phone = '5511777777777';

    // Pre-seed client name so name gate is bypassed
    await db('users').insert({ phone, created_at: new Date().toISOString() }).onConflict('phone').ignore();
    await db('sessions').insert({
      phone,
      cart_json: JSON.stringify({ clientName: 'TestClient', nameAsked: true, confirmed: false }),
      misunderstanding_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).onConflict('phone').merge();

    mockAIResponse.mockResolvedValueOnce({
      reply: 'Qual serviço você quer?',
      appointmentPatch: null,
    });

    const payload = {
      payload: {
        id: 'msg-services-001',
        from: `${phone}@c.us`,
        body: 'oi',
        type: 'chat',
        fromMe: false,
      },
    };

    const req = { body: payload } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handleWebhook(req, res);
    await new Promise(r => setTimeout(r, 100));

    expect(mockAIResponse).toHaveBeenCalled();
    // 5th arg should be an array of services from DB
    const callArgs = mockAIResponse.mock.calls[0];
    const servicesArg = callArgs[4];
    expect(Array.isArray(servicesArg)).toBe(true);
    expect(servicesArg.length).toBeGreaterThan(0);
    expect(servicesArg[0]).toMatchObject({ id: expect.any(Number), name: expect.any(String), duration_minutes: expect.any(Number) });
  });

  it('should handle invalid GPT JSON gracefully', async () => {
    const { handleWebhook } = await import('../controllers/webhook.controller');
    sendTextMock.mockReset();

    mockAIResponse.mockResolvedValueOnce({
      reply: 'Some response without valid appointment patch',
      appointmentPatch: null,
    });

    const payload = {
      payload: {
        id: 'msg-001',
        from: '5511999999999@c.us',
        body: 'Teste',
        type: 'chat',
        fromMe: false,
      },
    };

    const req = { body: payload } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    await handleWebhook(req, res);
    await new Promise(r => setTimeout(r, 100));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendTextMock).toHaveBeenCalled();
  });
});
