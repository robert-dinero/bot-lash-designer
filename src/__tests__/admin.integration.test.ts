/**
 * Admin API Integration Tests
 * Tests all 13 admin endpoints using in-memory SQLite.
 * Auth: X-Admin-Secret header required on all routes.
 *
 * Strategy: Uses _setDb() to inject an in-memory Knex instance into the db
 * singleton, bypassing the module mock issue on this platform.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import knex, { type Knex } from 'knex';
import crypto from 'crypto';
import { _setDb } from '../db';
import {
  requireAdmin,
  getAppointments,
  deleteAppointment,
  getServices,
  createService,
  updateService,
  deleteService,
  getWorkingHours,
  updateWorkingHours,
  getAvailabilityBlocks,
  createAvailabilityBlock,
  deleteAvailabilityBlock,
  getEscalations,
  updateEscalation,
  clearCustomerData,
} from '../controllers/admin.controller';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction as ExpressNextFunction } from 'express';


// ─── In-memory DB ─────────────────────────────────────────────────────────────

let testDb: Knex;

async function setupSchema(db: Knex) {
  await db.schema.createTable('users', (t) => {
    t.text('phone').primary();
    t.text('created_at').notNullable();
  });

  await db.schema.createTable('sessions', (t) => {
    t.text('phone').primary();
    t.text('cart_json').notNullable().defaultTo('{}');
    t.integer('misunderstanding_count').notNullable().defaultTo(0);
    t.text('created_at').notNullable();
    t.text('updated_at').notNullable();
  });

  await db.schema.createTable('messages', (t) => {
    t.increments('id').primary();
    t.text('phone').notNullable();
    t.text('role').notNullable();
    t.text('content').notNullable();
    t.text('created_at').notNullable();
  });

  await db.schema.createTable('processed_messages', (t) => {
    t.text('message_id').primary();
    t.text('processed_at').notNullable();
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
    t.text('client_name').nullable();
    t.integer('service_id').notNullable();
    t.text('starts_at').notNullable();
    t.integer('duration_minutes').notNullable();
    t.text('reminder_24h_sent_at').nullable();
    t.text('reminder_12h_sent_at').nullable();
    t.text('reminder_2h_sent_at').nullable();
    t.text('cancelled_at').nullable();
    t.text('escalation_status').nullable();
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
    t.text('break_start').nullable();
    t.text('break_end').nullable();
  });

  await db.schema.createTable('availability_blocks', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable();
    t.text('starts_at').notNullable();
    t.text('ends_at').notNullable();
    t.text('reason').nullable();
  });
}

async function seedData(db: Knex) {
  await db('chairs').insert({ id: 1, name: 'Cadeira 1', active: 1 });
  await db('services').insert([
    { id: 1, name: 'Corte', duration_minutes: 30, price_cents: 4000, active: 1 },
    { id: 2, name: 'Barba', duration_minutes: 20, price_cents: 2500, active: 1 },
    { id: 3, name: 'Corte + Barba', duration_minutes: 45, price_cents: 6000, active: 1 },
  ]);
  for (let day = 0; day < 7; day++) {
    await db('working_hours').insert({
      chair_id: 1,
      day_of_week: day,
      open_time: day === 0 ? '00:00' : '09:00',
      close_time: day === 0 ? '00:00' : '19:00',
      is_closed: day === 0 ? 1 : 0,
    });
  }
}

// ─── Mock request/response helpers ───────────────────────────────────────────

const TEST_SECRET = process.env['ADMIN_SECRET'] || 'test-secret-123';

function makeTestToken(): string {
  const ts = Date.now().toString();
  const mac = crypto.createHmac('sha256', TEST_SECRET).update(ts).digest('hex');
  return Buffer.from(`${ts}.${mac}`).toString('base64');
}

function makeReq(overrides: Partial<ExpressRequest> = {}): ExpressRequest {
  return {
    headers: { authorization: `Bearer ${makeTestToken()}` },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as ExpressRequest;
}

type MockRes = ExpressResponse & { _body: unknown; _location: string; statusCode: number };

function makeRes(): MockRes {
  let _statusCode = 200;
  let _body: unknown;
  let _location = '';
  let _sent = false;

  const res = {} as MockRes;
  Object.defineProperty(res, 'statusCode', {
    get() { return _statusCode; },
    set(v: number) { _statusCode = v; },
    configurable: true,
  });
  Object.defineProperty(res, '_body', {
    get() { return _body; },
    set(v: unknown) { _body = v; },
    configurable: true,
  });
  Object.defineProperty(res, '_location', {
    get() { return _location; },
    configurable: true,
  });
  Object.defineProperty(res, 'headersSent', {
    get() { return _sent; },
    configurable: true,
  });

  (res as ExpressResponse & { status: (n: number) => MockRes }).status = (code: number) => {
    _statusCode = code;
    return res;
  };
  (res as ExpressResponse & { json: (data: unknown) => MockRes }).json = (data: unknown) => {
    _body = data;
    _sent = true;
    return res;
  };
  (res as ExpressResponse & { location: (loc: string) => MockRes }).location = (loc: string) => {
    _location = loc;
    return res;
  };

  return res;
}

function makeNext(): ExpressNextFunction {
  return vi.fn() as unknown as ExpressNextFunction;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  testDb = knex({
    client: 'sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  // Inject test DB into singleton
  _setDb(testDb);
  await setupSchema(testDb);
  await seedData(testDb);
});

afterAll(async () => {
  _setDb(null);
  if (testDb) await testDb.destroy();
});

beforeEach(async () => {
  await testDb('sessions').delete();
  await testDb('messages').delete();
  await testDb('processed_messages').delete();
  await testDb('users').delete();
  await testDb('appointments').delete();
  await testDb('availability_blocks').delete();

  // Reset services to original state
  await testDb('services').delete();
  await testDb('services').insert([
    { id: 1, name: 'Corte', duration_minutes: 30, price_cents: 4000, active: 1 },
    { id: 2, name: 'Barba', duration_minutes: 20, price_cents: 2500, active: 1 },
    { id: 3, name: 'Corte + Barba', duration_minutes: 45, price_cents: 6000, active: 1 },
  ]);

  // Reset working_hours to original state
  await testDb('working_hours').update({ open_time: '09:00', close_time: '19:00', is_closed: 0 });
  await testDb('working_hours').where({ day_of_week: 0 }).update({ open_time: '00:00', close_time: '00:00', is_closed: 1 });
});

// ─── Auth Tests ───────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(res.statusCode).toBe(401);
    expect((res._body as { error: string }).error).toBe('Unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization Bearer token is invalid', () => {
    const req = makeReq({ headers: { authorization: 'Bearer wrong-token' } });
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when Authorization Bearer token is valid', () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._body).toBeUndefined();
  });
});

// ─── Appointments Tests ───────────────────────────────────────────────────────

describe('GET /admin/api/appointments', () => {
  it('returns empty array when no appointments exist', async () => {
    const req = makeReq({ query: { start: '2026-01-01', end: '2026-01-31' } });
    const res = makeRes();

    await getAppointments(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
    expect((res._body as unknown[]).length).toBe(0);
  });

  it('returns appointments in date range with service_name', async () => {
    await testDb('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999001',
      service_id: 1,
      starts_at: '2026-05-15T10:00:00.000Z',
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const req = makeReq({ query: { start: '2026-05-15', end: '2026-05-16' } });
    const res = makeRes();

    await getAppointments(req, res);

    expect(res.statusCode).toBe(200);
    const rows = res._body as Array<{ service_name: string; client_phone: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.service_name).toBe('Corte');
    expect(rows[0]?.client_phone).toBe('5511999999001');
  });

  it('filters by status param', async () => {
    await testDb('appointments').insert([
      {
        chair_id: 1, client_phone: '5511999999002', service_id: 1,
        starts_at: '2026-05-16T10:00:00.000Z', duration_minutes: 30,
        status: 'confirmed', notes: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      {
        chair_id: 1, client_phone: '5511999999003', service_id: 2,
        starts_at: '2026-05-16T11:00:00.000Z', duration_minutes: 20,
        status: 'cancelled', notes: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    ]);

    const req = makeReq({ query: { start: '2026-05-16', end: '2026-05-17', status: 'confirmed' } });
    const res = makeRes();

    await getAppointments(req, res);

    const rows = res._body as Array<{ status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('confirmed');
  });

  it('returns 400 for date range exceeding 30 days', async () => {
    const req = makeReq({ query: { start: '2026-01-01', end: '2026-03-01' } });
    const res = makeRes();

    await getAppointments(req, res);

    expect(res.statusCode).toBe(400);
    expect((res._body as { error: string }).error).toContain('30 days');
  });

  it('returns 400 for invalid date format', async () => {
    const req = makeReq({ query: { start: 'not-a-date', end: '2026-01-31' } });
    const res = makeRes();

    await getAppointments(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('does not leak next-day appointments into current day (date boundary fix)', async () => {
    // Day 14 appointment at 09:00 BRT = 12:00 UTC
    await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511000000014', service_id: 1,
      starts_at: '2026-05-14T12:00:00.000Z', duration_minutes: 30,
      status: 'confirmed', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // Day 15 appointment at 14:00 BRT = 17:00 UTC
    await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511000000015', service_id: 3,
      starts_at: '2026-05-15T17:00:00.000Z', duration_minutes: 45,
      status: 'confirmed', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    // Frontend query for day 14: start=2026-05-14, end=2026-05-15 (exclusive next day)
    const req14 = makeReq({ query: { start: '2026-05-14', end: '2026-05-15' } });
    const res14 = makeRes();
    await getAppointments(req14, res14);
    const rows14 = res14._body as Array<{ client_phone: string }>;
    expect(rows14.length).toBe(1);
    expect(rows14[0]?.client_phone).toBe('5511000000014');

    // Frontend query for day 15: start=2026-05-15, end=2026-05-16 (exclusive next day)
    const req15 = makeReq({ query: { start: '2026-05-15', end: '2026-05-16' } });
    const res15 = makeRes();
    await getAppointments(req15, res15);
    const rows15 = res15._body as Array<{ client_phone: string }>;
    expect(rows15.length).toBe(1);
    expect(rows15[0]?.client_phone).toBe('5511000000015');
  });
});

describe('DELETE /admin/api/appointments/:id', () => {
  it('soft-cancels an appointment', async () => {
    const [id] = await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999010', service_id: 1,
      starts_at: '2026-05-20T10:00:00.000Z', duration_minutes: 30,
      status: 'confirmed', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { id: String(id) } });
    const res = makeRes();

    await deleteAppointment(req, res);

    expect(res.statusCode).toBe(200);
    expect((res._body as { status: string }).status).toBe('cancelled');
    expect((res._body as { cancelled_at: string }).cancelled_at).toBeTruthy();

    const appt = await testDb('appointments').where({ id }).first();
    expect(appt.status).toBe('cancelled');
    expect(appt.cancelled_at).toBeTruthy();
  });

  it('returns 404 for non-existent appointment', async () => {
    const req = makeReq({ params: { id: '99999' } });
    const res = makeRes();

    await deleteAppointment(req, res);

    expect(res.statusCode).toBe(404);
  });
});

// ─── Services Tests ───────────────────────────────────────────────────────────

describe('DELETE /admin/api/customer-data', () => {
  it('clears customer records and keeps operational configuration', async () => {
    const now = new Date().toISOString();
    await testDb('users').insert({ phone: '5511999999999', created_at: now });
    await testDb('sessions').insert({
      phone: '5511999999999',
      cart_json: '{}',
      misunderstanding_count: 0,
      created_at: now,
      updated_at: now,
    });
    await testDb('messages').insert({
      phone: '5511999999999',
      role: 'user',
      content: 'oi',
      created_at: now,
    });
    await testDb('processed_messages').insert({ message_id: 'msg-1', processed_at: now });
    await testDb('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      client_name: 'Cliente Demo',
      service_id: 1,
      starts_at: now,
      duration_minutes: 30,
      status: 'confirmed',
      created_at: now,
      updated_at: now,
    });

    const res = makeRes();
    await clearCustomerData(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res._body).toMatchObject({
      success: true,
      deleted: {
        sessions: 1,
        messages: 1,
        processed_messages: 1,
        appointments: 1,
        users: 1,
      },
    });
    await expect(testDb('users').count('* as n').first()).resolves.toMatchObject({ n: 0 });
    await expect(testDb('appointments').count('* as n').first()).resolves.toMatchObject({ n: 0 });
    await expect(testDb('services').count('* as n').first()).resolves.toMatchObject({ n: 3 });
    await expect(testDb('working_hours').count('* as n').first()).resolves.toMatchObject({ n: 7 });
  });
});

describe('GET /admin/api/services', () => {
  it('returns all active services sorted by name', async () => {
    const req = makeReq();
    const res = makeRes();

    await getServices(req, res);

    expect(res.statusCode).toBe(200);
    const rows = res._body as Array<{ name: string; active: number }>;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.active === 1)).toBe(true);
    expect(rows[0]?.name).toBe('Barba');
  });
});

describe('POST /admin/api/services', () => {
  it('creates a new service', async () => {
    const req = makeReq({ body: { name: 'Relaxamento', duration: 60, price: 80.00 } });
    const res = makeRes();

    await createService(req, res);

    expect(res.statusCode).toBe(201);
    const created = res._body as { name: string; duration: number; price: number; active: number };
    expect(created.name).toBe('Relaxamento');
    expect(created.duration).toBe(60);
    expect(created.price).toBe(80.00);
    expect(created.active).toBe(1);
  });

  it('returns 400 for duration < 15', async () => {
    const req = makeReq({ body: { name: 'Test', duration: 5, price: 10.00 } });
    const res = makeRes();

    await createService(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for duration > 480', async () => {
    const req = makeReq({ body: { name: 'Test', duration: 999, price: 10.00 } });
    const res = makeRes();

    await createService(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing name', async () => {
    const req = makeReq({ body: { duration: 30, price: 10.00 } });
    const res = makeRes();

    await createService(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for negative price', async () => {
    const req = makeReq({ body: { name: 'Test', duration: 30, price: -1 } });
    const res = makeRes();

    await createService(req, res);

    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /admin/api/services/:id', () => {
  it('updates service name', async () => {
    const req = makeReq({ params: { id: '1' }, body: { name: 'Corte Novo' } });
    const res = makeRes();

    await updateService(req, res);

    expect(res.statusCode).toBe(200);
    const updated = res._body as { name: string };
    expect(updated.name).toBe('Corte Novo');
  });

  it('returns 404 for non-existent service', async () => {
    const req = makeReq({ params: { id: '99999' }, body: { name: 'X' } });
    const res = makeRes();

    await updateService(req, res);

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /admin/api/services/:id', () => {
  it('soft-deletes a service (sets active=0)', async () => {
    const [id] = await testDb('services').insert({
      name: 'To Delete', duration_minutes: 30, price_cents: 1000, active: 1,
    });

    const req = makeReq({ params: { id: String(id) } });
    const res = makeRes();

    await deleteService(req, res);

    expect(res.statusCode).toBe(200);
    expect((res._body as { success: boolean }).success).toBe(true);

    const svc = await testDb('services').where({ id }).first();
    expect(svc.active).toBe(0);
  });

  it('returns 400 when service has active appointments', async () => {
    await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999020', service_id: 1,
      starts_at: '2026-05-25T10:00:00.000Z', duration_minutes: 30,
      status: 'confirmed', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { id: '1' } });
    const res = makeRes();

    await deleteService(req, res);

    expect(res.statusCode).toBe(400);
    expect((res._body as { error: string }).error).toContain('agendamento');
  });

  it('returns 404 for non-existent service', async () => {
    const req = makeReq({ params: { id: '99999' } });
    const res = makeRes();

    await deleteService(req, res);

    expect(res.statusCode).toBe(404);
  });
});

// ─── Working Hours Tests ──────────────────────────────────────────────────────

describe('GET /admin/api/working-hours', () => {
  it('returns all 7 days for chair_id=1 sorted by day_of_week', async () => {
    const req = makeReq();
    const res = makeRes();

    await getWorkingHours(req, res);

    expect(res.statusCode).toBe(200);
    const rows = res._body as Array<{ day_of_week: number; chair_id: number }>;
    expect(rows.length).toBe(7);
    expect(rows[0]?.day_of_week).toBe(0);
    expect(rows[6]?.day_of_week).toBe(6);
    expect(rows.every((r) => r.chair_id === 1)).toBe(true);
  });
});

describe('PATCH /admin/api/working-hours/:id', () => {
  it('updates open_time and close_time', async () => {
    const wh = await testDb('working_hours').where({ chair_id: 1, day_of_week: 1 }).first();

    const req = makeReq({ params: { id: String(wh.id) }, body: { open_time: '08:00', close_time: '18:00' } });
    const res = makeRes();

    await updateWorkingHours(req, res);

    expect(res.statusCode).toBe(200);
    const updated = res._body as { open_time: string; close_time: string };
    expect(updated.open_time).toBe('08:00');
    expect(updated.close_time).toBe('18:00');
  });

  it('updates is_closed to 1 (close a day)', async () => {
    const wh = await testDb('working_hours').where({ chair_id: 1, day_of_week: 6 }).first();

    const req = makeReq({ params: { id: String(wh.id) }, body: { is_closed: 1 } });
    const res = makeRes();

    await updateWorkingHours(req, res);

    expect(res.statusCode).toBe(200);
    const updated = res._body as { is_closed: number };
    expect(updated.is_closed).toBe(1);
  });

  it('returns 400 when close_time <= open_time', async () => {
    const wh = await testDb('working_hours').where({ chair_id: 1, day_of_week: 2 }).first();

    const req = makeReq({ params: { id: String(wh.id) }, body: { open_time: '18:00', close_time: '09:00' } });
    const res = makeRes();

    await updateWorkingHours(req, res);

    expect(res.statusCode).toBe(400);
    expect((res._body as { error: string }).error).toContain('close_time');
  });

  it('returns 404 for non-existent record', async () => {
    const req = makeReq({ params: { id: '99999' }, body: { is_closed: 1 } });
    const res = makeRes();

    await updateWorkingHours(req, res);

    expect(res.statusCode).toBe(404);
  });
});

// ─── Availability Blocks Tests ────────────────────────────────────────────────

describe('GET /admin/api/availability-blocks', () => {
  it('returns empty array when no blocks exist', async () => {
    const req = makeReq();
    const res = makeRes();

    await getAvailabilityBlocks(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
    expect((res._body as unknown[]).length).toBe(0);
  });

  it('filters by date range', async () => {
    await testDb('availability_blocks').insert([
      { chair_id: 1, starts_at: '2026-06-01T12:00:00.000Z', ends_at: '2026-06-01T13:00:00.000Z', reason: 'Almoço' },
      { chair_id: 1, starts_at: '2026-07-01T12:00:00.000Z', ends_at: '2026-07-01T13:00:00.000Z', reason: 'Folga' },
    ]);

    const req = makeReq({ query: { start: '2026-06-01', end: '2026-06-30T23:59:59.000Z' } });
    const res = makeRes();

    await getAvailabilityBlocks(req, res);

    const rows = res._body as Array<{ reason: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.reason).toBe('Almoço');
  });
});

describe('POST /admin/api/availability-blocks', () => {
  it('creates a new availability block', async () => {
    const req = makeReq({
      body: {
        starts_at: '2026-06-10T12:00:00.000Z',
        ends_at: '2026-06-10T13:00:00.000Z',
        reason: 'Almoço',
      },
    });
    const res = makeRes();

    await createAvailabilityBlock(req, res);

    expect(res.statusCode).toBe(201);
    const created = res._body as { starts_at: string; ends_at: string; reason: string; chair_id: number };
    expect(created.reason).toBe('Almoço');
    expect(created.chair_id).toBe(1);
  });

  it('returns 409 when block overlaps with existing one', async () => {
    await testDb('availability_blocks').insert({
      chair_id: 1,
      starts_at: '2026-06-15T12:00:00.000Z',
      ends_at: '2026-06-15T13:00:00.000Z',
      reason: 'Existing',
    });

    const req = makeReq({
      body: {
        starts_at: '2026-06-15T12:30:00.000Z',
        ends_at: '2026-06-15T13:30:00.000Z',
        reason: 'Overlap',
      },
    });
    const res = makeRes();

    await createAvailabilityBlock(req, res);

    expect(res.statusCode).toBe(409);
    expect((res._body as { error: string }).error).toContain('Overlapping');
  });

  it('returns 400 when ends_at <= starts_at', async () => {
    const req = makeReq({
      body: {
        starts_at: '2026-06-20T13:00:00.000Z',
        ends_at: '2026-06-20T12:00:00.000Z',
      },
    });
    const res = makeRes();

    await createAvailabilityBlock(req, res);

    expect(res.statusCode).toBe(400);
    expect((res._body as { error: string }).error).toContain('ends_at');
  });
});

describe('DELETE /admin/api/availability-blocks/:id', () => {
  it('deletes an availability block', async () => {
    const [id] = await testDb('availability_blocks').insert({
      chair_id: 1,
      starts_at: '2026-06-25T12:00:00.000Z',
      ends_at: '2026-06-25T13:00:00.000Z',
      reason: 'Folga',
    });

    const req = makeReq({ params: { id: String(id) } });
    const res = makeRes();

    await deleteAvailabilityBlock(req, res);

    expect(res.statusCode).toBe(200);
    expect((res._body as { success: boolean }).success).toBe(true);

    const block = await testDb('availability_blocks').where({ id }).first();
    expect(block).toBeUndefined();
  });

  it('returns 404 for non-existent block', async () => {
    const req = makeReq({ params: { id: '99999' } });
    const res = makeRes();

    await deleteAvailabilityBlock(req, res);

    expect(res.statusCode).toBe(404);
  });
});

// ─── Escalations Tests ────────────────────────────────────────────────────────

describe('GET /admin/api/escalations', () => {
  it('returns empty array when no pending escalations', async () => {
    const req = makeReq();
    const res = makeRes();

    await getEscalations(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
    expect((res._body as unknown[]).length).toBe(0);
  });

  it('returns pending escalations with service_name', async () => {
    await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999030', service_id: 1,
      starts_at: '2026-05-30T10:00:00.000Z', duration_minutes: 30,
      status: 'confirmed', escalation_status: 'pending', notes: 'Cancel please',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq();
    const res = makeRes();

    await getEscalations(req, res);

    const rows = res._body as Array<{ escalation_status: string; service_name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.escalation_status).toBe('pending');
    expect(rows[0]?.service_name).toBe('Corte');
  });
});

describe('PATCH /admin/api/escalations/:appointmentId', () => {
  it('approves escalation: sets status=cancelled, escalation_status=approved', async () => {
    const [id] = await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999040', service_id: 2,
      starts_at: '2026-06-01T10:00:00.000Z', duration_minutes: 20,
      status: 'confirmed', escalation_status: 'pending', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { appointmentId: String(id) }, body: { action: 'approve' } });
    const res = makeRes();

    await updateEscalation(req, res);

    expect(res.statusCode).toBe(200);
    const updated = res._body as { status: string; escalation_status: string; cancelled_at: string };
    expect(updated.status).toBe('cancelled');
    expect(updated.escalation_status).toBe('approved');
    expect(updated.cancelled_at).toBeTruthy();
  });

  it('denies escalation: sets escalation_status=denied, keeps status', async () => {
    const [id] = await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999041', service_id: 3,
      starts_at: '2026-06-02T14:00:00.000Z', duration_minutes: 45,
      status: 'confirmed', escalation_status: 'pending', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { appointmentId: String(id) }, body: { action: 'deny' } });
    const res = makeRes();

    await updateEscalation(req, res);

    expect(res.statusCode).toBe(200);
    const updated = res._body as { status: string; escalation_status: string };
    expect(updated.status).toBe('confirmed');
    expect(updated.escalation_status).toBe('denied');
  });

  it('returns 400 for invalid action', async () => {
    const [id] = await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999042', service_id: 1,
      starts_at: '2026-06-03T10:00:00.000Z', duration_minutes: 30,
      status: 'confirmed', escalation_status: 'pending', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { appointmentId: String(id) }, body: { action: 'delete' } });
    const res = makeRes();

    await updateEscalation(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for non-existent appointment', async () => {
    const req = makeReq({ params: { appointmentId: '99999' }, body: { action: 'approve' } });
    const res = makeRes();

    await updateEscalation(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when escalation_status is not pending', async () => {
    const [id] = await testDb('appointments').insert({
      chair_id: 1, client_phone: '5511999999043', service_id: 1,
      starts_at: '2026-06-04T10:00:00.000Z', duration_minutes: 30,
      status: 'cancelled', escalation_status: 'approved', notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const req = makeReq({ params: { appointmentId: String(id) }, body: { action: 'deny' } });
    const res = makeRes();

    await updateEscalation(req, res);

    expect(res.statusCode).toBe(400);
    expect((res._body as { error: string }).error).toContain('pending');
  });
});
