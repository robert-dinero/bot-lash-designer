/**
 * Admin Dashboard E2E Tests
 *
 * Tests the complete admin API flow as consumed by the frontend dashboard.
 * Uses in-memory SQLite (same strategy as admin.integration.test.ts) to
 * exercise the full request→controller→DB→response cycle.
 *
 * Coverage:
 *  1. Auth flow (X-Admin-Secret validation)
 *  2. Appointments tab (list, filter by date/status, delete)
 *  3. Services tab (CRUD with validation)
 *  4. Working hours tab (update time fields, toggle closed)
 *  5. Availability blocks tab (create, delete)
 *  6. Escalations tab (approve, deny)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
} from '../controllers/admin.controller';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from 'express';

// ─── In-memory DB ─────────────────────────────────────────────────────────────

let db: Knex;

async function setupSchema(d: Knex) {
  await d.schema.createTable('chairs', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });
  await d.schema.createTable('services', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('duration_minutes').notNullable();
    t.integer('price_cents').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });
  await d.schema.createTable('appointments', (t) => {
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
  await d.schema.createTable('working_hours', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable();
    t.integer('day_of_week').notNullable();
    t.text('open_time').notNullable();
    t.text('close_time').notNullable();
    t.integer('is_closed').notNullable().defaultTo(0);
    t.text('break_start').nullable();
    t.text('break_end').nullable();
  });
  await d.schema.createTable('availability_blocks', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable();
    t.text('starts_at').notNullable();
    t.text('ends_at').notNullable();
    t.text('reason').nullable();
  });
}

async function seedBase(d: Knex) {
  await d('chairs').insert({ id: 1, name: 'Cadeira 1', active: 1 });
  await d('services').insert([
    { id: 1, name: 'Corte',       duration_minutes: 30, price_cents: 4000, active: 1 },
    { id: 2, name: 'Barba',       duration_minutes: 20, price_cents: 2500, active: 1 },
    { id: 3, name: 'Corte + Barba', duration_minutes: 45, price_cents: 6000, active: 1 },
  ]);
  for (let day = 0; day < 7; day++) {
    await d('working_hours').insert({
      chair_id: 1,
      day_of_week: day,
      open_time:   day === 0 ? '00:00' : '09:00',
      close_time:  day === 0 ? '00:00' : '19:00',
      is_closed:   day === 0 ? 1 : 0,
    });
  }
}

// ─── Request / Response helpers ───────────────────────────────────────────────

const VALID_SECRET = process.env['ADMIN_SECRET'] || 'test-secret-123';

function makeTestToken(): string {
  const ts = Date.now().toString();
  const mac = crypto.createHmac('sha256', VALID_SECRET).update(ts).digest('hex');
  return Buffer.from(`${ts}.${mac}`).toString('base64');
}

function req(overrides: Partial<ExpressRequest> = {}): ExpressRequest {
  return {
    headers: { authorization: `Bearer ${makeTestToken()}` },
    params: {},
    query:  {},
    body:   {},
    ...overrides,
  } as unknown as ExpressRequest;
}

type MockRes = ExpressResponse & { _body: unknown; statusCode: number };

function res(): MockRes {
  let code = 200;
  let body: unknown;
  let sent = false;

  const r = {} as MockRes;
  Object.defineProperty(r, 'statusCode', {
    get() { return code; },
    set(v: number) { code = v; },
    configurable: true,
  });
  Object.defineProperty(r, '_body', {
    get() { return body; },
    configurable: true,
  });
  Object.defineProperty(r, 'headersSent', {
    get() { return sent; },
    configurable: true,
  });
  (r as any).status = (n: number) => { code = n; return r; };
  (r as any).json   = (d: unknown) => { body = d; sent = true; return r; };
  (r as any).location = () => r;
  return r;
}

function next(): ExpressNextFunction {
  let called = false;
  const fn = () => { called = true; };
  (fn as any).wasCalled = () => called;
  return fn as unknown as ExpressNextFunction;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = knex({
    client: 'sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  _setDb(db);
  await setupSchema(db);
  await seedBase(db);
});

afterAll(async () => {
  _setDb(null);
  if (db) await db.destroy();
});

beforeEach(async () => {
  await db('appointments').delete();
  await db('availability_blocks').delete();

  await db('services').delete();
  await db('services').insert([
    { id: 1, name: 'Corte',       duration_minutes: 30, price_cents: 4000, active: 1 },
    { id: 2, name: 'Barba',       duration_minutes: 20, price_cents: 2500, active: 1 },
    { id: 3, name: 'Corte + Barba', duration_minutes: 45, price_cents: 6000, active: 1 },
  ]);

  await db('working_hours').update({ open_time: '09:00', close_time: '19:00', is_closed: 0 });
  await db('working_hours').where({ day_of_week: 0 }).update({ open_time: '00:00', close_time: '00:00', is_closed: 1 });
});

// ─── 1. Auth Flow ─────────────────────────────────────────────────────────────

describe('Auth Flow', () => {
  it('rejects request with no Authorization header', () => {
    const rq = req({ headers: {} });
    const rs = res();
    const nx = next();
    requireAdmin(rq, rs, nx);
    expect(rs.statusCode).toBe(401);
    expect((rs._body as any).error).toBe('Unauthorized');
    expect((nx as any).wasCalled()).toBe(false);
  });

  it('rejects request with invalid Bearer token', () => {
    const rq = req({ headers: { authorization: 'Bearer invalid-token' } });
    const rs = res();
    const nx = next();
    requireAdmin(rq, rs, nx);
    expect(rs.statusCode).toBe(401);
    expect((nx as any).wasCalled()).toBe(false);
  });

  it('calls next() for valid Authorization Bearer token', () => {
    const rq = req();
    const rs = res();
    const nx = next();
    requireAdmin(rq, rs, nx);
    expect(rs.statusCode).toBe(200); // untouched
    expect((nx as any).wasCalled()).toBe(true);
  });

  it('GET /admin/api/services returns 200 — used by frontend to verify credentials', async () => {
    const rq = req();
    const rs = res();
    await getServices(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect(Array.isArray(rs._body)).toBe(true);
  });

  it('returns 401 when Authorization header is empty (sessionStorage cleared)', () => {
    const rq = req({ headers: { authorization: '' } });
    const rs = res();
    const nx = next();
    requireAdmin(rq, rs, nx);
    expect(rs.statusCode).toBe(401);
  });
});

// ─── 2. Appointments Tab Flow ─────────────────────────────────────────────────

describe('Appointments Tab Flow', () => {
  const NOW = '2026-05-19T14:00:00.000Z';

  async function insertAppt(overrides: Record<string, unknown> = {}) {
    const [id] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999990001',
      service_id: 1,
      starts_at: NOW,
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    });
    return id as number;
  }

  it('Dashboard loads with Agenda tab — GET appointments returns array', async () => {
    const rq = req({ query: { start: '2026-05-19T00:00:00.000Z', end: '2026-05-20T00:00:00.000Z' } });
    const rs = res();
    await getAppointments(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect(Array.isArray(rs._body)).toBe(true);
  });

  it('Appointments render — response includes all required fields', async () => {
    await insertAppt();
    const rq = req({ query: { start: '2026-05-19T00:00:00.000Z', end: '2026-05-20T00:00:00.000Z' } });
    const rs = res();
    await getAppointments(rq, rs);
    const rows = rs._body as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('client_phone');
    expect(row).toHaveProperty('service_name');
    expect(row).toHaveProperty('starts_at');
    expect(row).toHaveProperty('duration_minutes');
    expect(row).toHaveProperty('status');
    expect(row?.service_name).toBe('Corte');
  });

  it('Date filter — fetches only appointments in date range', async () => {
    await insertAppt({ starts_at: '2026-05-19T14:00:00.000Z' });
    await insertAppt({ starts_at: '2026-05-25T10:00:00.000Z', client_phone: '5511999990002' });

    const rq = req({ query: { start: '2026-05-19T00:00:00.000Z', end: '2026-05-20T00:00:00.000Z' } });
    const rs = res();
    await getAppointments(rq, rs);
    const rows = rs._body as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect((rows[0]?.starts_at as string).startsWith('2026-05-19')).toBe(true);
  });

  it('Status filter — returns only confirmed appointments', async () => {
    await insertAppt({ status: 'confirmed', client_phone: '5511000000001' });
    await insertAppt({ status: 'cancelled', client_phone: '5511000000002' });

    const rq = req({ query: { start: '2026-05-19T00:00:00.000Z', end: '2026-05-20T00:00:00.000Z', status: 'confirmed' } });
    const rs = res();
    await getAppointments(rq, rs);
    const rows = rs._body as Array<Record<string, unknown>>;
    expect(rows.every(r => r.status === 'confirmed')).toBe(true);
  });

  it('Status filter — returns only cancelled appointments', async () => {
    await insertAppt({ status: 'confirmed', client_phone: '5511000000003' });
    await insertAppt({ status: 'cancelled', client_phone: '5511000000004' });

    const rq = req({ query: { start: '2026-05-19T00:00:00.000Z', end: '2026-05-20T00:00:00.000Z', status: 'cancelled' } });
    const rs = res();
    await getAppointments(rq, rs);
    const rows = rs._body as Array<Record<string, unknown>>;
    expect(rows.every(r => r.status === 'cancelled')).toBe(true);
    expect(rows.length).toBe(1);
  });

  it('Delete appointment — marks as cancelled and returns success', async () => {
    const id = await insertAppt();
    const rq = req({ params: { id: String(id) } });
    const rs = res();
    await deleteAppointment(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).status).toBe('cancelled');
    expect((rs._body as any).cancelled_at).toBeTruthy();
    // deleteAppointment cancels the appointment (soft delete)
    const appt = await db('appointments').where({ id }).first();
    expect(appt.status).toBe('cancelled');
  });

  it('Delete non-existent appointment returns 404', async () => {
    const rq = req({ params: { id: '999999' } });
    const rs = res();
    await deleteAppointment(rq, rs);
    expect(rs.statusCode).toBe(404);
  });

  it('Returns 400 for invalid date format', async () => {
    const rq = req({ query: { start: 'not-a-date', end: '2026-05-19' } });
    const rs = res();
    await getAppointments(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('Returns 400 for date range exceeding 30 days', async () => {
    const rq = req({ query: { start: '2026-01-01', end: '2026-03-01' } });
    const rs = res();
    await getAppointments(rq, rs);
    expect(rs.statusCode).toBe(400);
  });
});

// ─── 3. Services Tab Flow ─────────────────────────────────────────────────────

describe('Services Tab Flow', () => {
  it('Services.init — GET /admin/api/services returns seeded services', async () => {
    const rq = req();
    const rs = res();
    await getServices(rq, rs);
    expect(rs.statusCode).toBe(200);
    const svcs = rs._body as Array<Record<string, unknown>>;
    expect(svcs.length).toBe(3);
    const names = svcs.map(s => s.name);
    expect(names).toContain('Corte');
    expect(names).toContain('Barba');
    expect(names).toContain('Corte + Barba');
  });

  it('Each service row has required fields for table rendering', async () => {
    const rq = req();
    const rs = res();
    await getServices(rq, rs);
    const svcs = rs._body as Array<Record<string, unknown>>;
    svcs.forEach(s => {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('duration');
      expect(s).toHaveProperty('price');
    });
  });

  it('Add Service modal — POST creates new service', async () => {
    const rq = req({ body: { name: 'Decoloracao', duration: 45, price: 65.00 } });
    const rs = res();
    await createService(rq, rs);
    expect(rs.statusCode).toBe(201);
    const created = rs._body as Record<string, unknown>;
    expect(created.name).toBe('Decoloracao');
    expect(created.duration).toBe(45);
    expect(created.price).toBe(65.00);
  });

  it('Edit Service — PATCH updates existing service', async () => {
    const rq = req({ params: { id: '1' }, body: { price: 45.00 } });
    const rs = res();
    await updateService(rq, rs);
    expect(rs.statusCode).toBe(200);
    const updated = rs._body as Record<string, unknown>;
    expect(updated.price).toBe(45.00);
    expect(updated.name).toBe('Corte'); // unchanged
  });

  it('Edit Service — PATCH with all fields', async () => {
    const rq = req({
      params: { id: '2' },
      body: { name: 'Barba Premium', duration: 25, price: 30.00 },
    });
    const rs = res();
    await updateService(rq, rs);
    expect(rs.statusCode).toBe(200);
    const updated = rs._body as Record<string, unknown>;
    expect(updated.name).toBe('Barba Premium');
    expect(updated.duration).toBe(25);
    expect(updated.price).toBe(30.00);
  });

  it('Delete Service — soft-deletes (active=0) and returns success', async () => {
    const rq = req({ params: { id: '3' } });
    const rs = res();
    await deleteService(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).success).toBe(true);
    // Service is soft-deleted: row exists but active=0
    const svc = await db('services').where({ id: 3 }).first();
    expect(svc.active).toBe(0);
  });

  it('Form validation — POST rejects empty name', async () => {
    const rq = req({ body: { name: '', duration: 30, price: 40.00 } });
    const rs = res();
    await createService(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('Form validation — POST rejects duration < 15', async () => {
    const rq = req({ body: { name: 'Mini Corte', duration: 5, price: 10.00 } });
    const rs = res();
    await createService(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('Form validation — POST rejects duration > 480', async () => {
    const rq = req({ body: { name: 'Mega Corte', duration: 999, price: 10.00 } });
    const rs = res();
    await createService(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('Form validation — POST rejects negative price', async () => {
    const rq = req({ body: { name: 'Free Cut', duration: 30, price: -1 } });
    const rs = res();
    await createService(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('PATCH returns 404 for non-existent service', async () => {
    const rq = req({ params: { id: '99999' }, body: { name: 'Ghost' } });
    const rs = res();
    await updateService(rq, rs);
    expect(rs.statusCode).toBe(404);
  });

  it('DELETE returns 404 for non-existent service', async () => {
    const rq = req({ params: { id: '99999' } });
    const rs = res();
    await deleteService(rq, rs);
    expect(rs.statusCode).toBe(404);
  });
});

// ─── 4. Working Hours Tab Flow ────────────────────────────────────────────────

describe('Working Hours Tab Flow', () => {
  it('WorkingHours.init — GET returns 7 records (all days)', async () => {
    const rq = req();
    const rs = res();
    await getWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(200);
    const hours = rs._body as Array<Record<string, unknown>>;
    expect(hours.length).toBe(7);
  });

  it('All 7 days have required fields for table rendering', async () => {
    const rq = req();
    const rs = res();
    await getWorkingHours(rq, rs);
    const hours = rs._body as Array<Record<string, unknown>>;
    hours.forEach(h => {
      expect(h).toHaveProperty('id');
      expect(h).toHaveProperty('day_of_week');
      expect(h).toHaveProperty('open_time');
      expect(h).toHaveProperty('close_time');
      expect(h).toHaveProperty('is_closed');
    });
  });

  it('Sunday is closed by default (is_closed=1)', async () => {
    const rq = req();
    const rs = res();
    await getWorkingHours(rq, rs);
    const hours = rs._body as Array<Record<string, unknown>>;
    const sunday = hours.find(h => h.day_of_week === 0);
    expect(sunday?.is_closed).toBe(1);
  });

  it('Monday is open by default (is_closed=0)', async () => {
    const rq = req();
    const rs = res();
    await getWorkingHours(rq, rs);
    const hours = rs._body as Array<Record<string, unknown>>;
    const monday = hours.find(h => h.day_of_week === 1);
    expect(monday?.is_closed).toBe(0);
    expect(monday?.open_time).toBe('09:00');
    expect(monday?.close_time).toBe('19:00');
  });

  it('Toggle closed — PATCH updates is_closed to 1', async () => {
    const mondayRow = await db('working_hours').where({ day_of_week: 1 }).first();
    const rq = req({ params: { id: String(mondayRow.id) }, body: { is_closed: 1 } });
    const rs = res();
    await updateWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).is_closed).toBe(1);
  });

  it('Change open time — PATCH updates open_time', async () => {
    const mondayRow = await db('working_hours').where({ day_of_week: 1 }).first();
    const rq = req({ params: { id: String(mondayRow.id) }, body: { open_time: '10:00' } });
    const rs = res();
    await updateWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).open_time).toBe('10:00');
    const persisted = await db('working_hours').where({ id: mondayRow.id }).first();
    expect(persisted.open_time).toBe('10:00');
  });

  it('Change close time — PATCH updates close_time', async () => {
    const fridayRow = await db('working_hours').where({ day_of_week: 5 }).first();
    const rq = req({ params: { id: String(fridayRow.id) }, body: { close_time: '18:00' } });
    const rs = res();
    await updateWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).close_time).toBe('18:00');
  });

  it('PATCH rejects invalid time format', async () => {
    const row = await db('working_hours').where({ day_of_week: 1 }).first();
    const rq = req({ params: { id: String(row.id) }, body: { open_time: '9am' } });
    const rs = res();
    await updateWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('PATCH returns 404 for non-existent working hour row', async () => {
    const rq = req({ params: { id: '99999' }, body: { open_time: '10:00' } });
    const rs = res();
    await updateWorkingHours(rq, rs);
    expect(rs.statusCode).toBe(404);
  });
});

// ─── 5. Availability Blocks Tab Flow ─────────────────────────────────────────

describe('Availability Blocks Tab Flow', () => {
  const START = '2026-05-19T12:00:00.000Z';
  const END   = '2026-05-19T13:00:00.000Z';

  it('AvailabilityBlocks.init — empty state for no blocks', async () => {
    const rq = req({ query: { start: '2026-05-19', end: '2026-06-18' } });
    const rs = res();
    await getAvailabilityBlocks(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as unknown[]).length).toBe(0);
  });

  it('Create block modal — POST creates new block', async () => {
    const rq = req({ body: { starts_at: START, ends_at: END, reason: 'Almoco' } });
    const rs = res();
    await createAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(201);
    const block = rs._body as Record<string, unknown>;
    expect(block).toHaveProperty('id');
    expect(block.reason).toBe('Almoco');
    expect(block.starts_at).toBe(START);
    expect(block.ends_at).toBe(END);
    expect(block.chair_id).toBe(1);
  });

  it('Block list renders after create', async () => {
    // Create block first
    const createRq = req({ body: { starts_at: START, ends_at: END, reason: 'Folga' } });
    const createRs = res();
    await createAvailabilityBlock(createRq, createRs);
    expect(createRs.statusCode).toBe(201);

    // Fetch blocks
    const listRq = req({ query: { start: '2026-05-19', end: '2026-06-18' } });
    const listRs = res();
    await getAvailabilityBlocks(listRq, listRs);
    const blocks = listRs._body as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.reason).toBe('Folga');
  });

  it('Block row has all fields needed for table rendering', async () => {
    const createRq = req({ body: { starts_at: START, ends_at: END, reason: 'Almoco' } });
    const createRs = res();
    await createAvailabilityBlock(createRq, createRs);

    const listRq = req({ query: { start: '2026-05-19', end: '2026-06-18' } });
    const listRs = res();
    await getAvailabilityBlocks(listRq, listRs);
    const blocks = listRs._body as Array<Record<string, unknown>>;
    const block = blocks[0];
    expect(block).toHaveProperty('id');
    expect(block).toHaveProperty('starts_at');
    expect(block).toHaveProperty('ends_at');
    expect(block).toHaveProperty('reason');
    expect(block).toHaveProperty('chair_id');
  });

  it('Delete block — removes from DB', async () => {
    const [id] = await db('availability_blocks').insert({
      chair_id: 1, starts_at: START, ends_at: END, reason: 'Test',
    });
    const rq = req({ params: { id: String(id) } });
    const rs = res();
    await deleteAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as any).success).toBe(true);
    const remaining = await db('availability_blocks').where({ id });
    expect(remaining.length).toBe(0);
  });

  it('Delete non-existent block returns 404', async () => {
    const rq = req({ params: { id: '99999' } });
    const rs = res();
    await deleteAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(404);
  });

  it('POST rejects missing starts_at', async () => {
    const rq = req({ body: { ends_at: END, reason: 'Test' } });
    const rs = res();
    await createAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('POST rejects missing ends_at', async () => {
    const rq = req({ body: { starts_at: START, reason: 'Test' } });
    const rs = res();
    await createAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('POST creates block without optional reason', async () => {
    const rq = req({ body: { starts_at: START, ends_at: END } });
    const rs = res();
    await createAvailabilityBlock(rq, rs);
    expect(rs.statusCode).toBe(201);
    const block = rs._body as Record<string, unknown>;
    expect(block.reason == null || block.reason === '').toBe(true);
  });
});

// ─── 6. Escalations Tab Flow ──────────────────────────────────────────────────

describe('Escalations Tab Flow', () => {
  async function insertEscalation() {
    const [id] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999990099',
      service_id: 1,
      starts_at: '2026-05-19T14:00:00.000Z',
      duration_minutes: 30,
      status: 'confirmed',
      escalation_status: 'pending',
      notes: 'Personal emergency',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return id as number;
  }

  it('Escalations.init — GET returns pending escalations', async () => {
    await insertEscalation();
    const rq = req();
    const rs = res();
    await getEscalations(rq, rs);
    expect(rs.statusCode).toBe(200);
    const escs = rs._body as Array<Record<string, unknown>>;
    expect(escs.length).toBe(1);
  });

  it('Escalation row has required fields for table rendering', async () => {
    await insertEscalation();
    const rq = req();
    const rs = res();
    await getEscalations(rq, rs);
    const escs = rs._body as Array<Record<string, unknown>>;
    const esc = escs[0];
    // The controller selects appointments.id (may be mapped to appointmentId or id)
    expect(esc).toHaveProperty('client_phone');
    expect(esc).toHaveProperty('service_name');
    expect(esc).toHaveProperty('starts_at');
    expect(esc).toHaveProperty('escalation_status');
    expect(esc?.escalation_status).toBe('pending');
    expect(esc?.service_name).toBe('Corte');
  });

  it('GET returns empty array when no pending escalations', async () => {
    const rq = req();
    const rs = res();
    await getEscalations(rq, rs);
    expect(rs.statusCode).toBe(200);
    expect((rs._body as unknown[]).length).toBe(0);
  });

  it('Approve escalation — PATCH with action=approve', async () => {
    const id = await insertEscalation();
    const rq = req({ params: { appointmentId: String(id) }, body: { action: 'approve' } });
    const rs = res();
    await updateEscalation(rq, rs);
    expect(rs.statusCode).toBe(200);
    const updated = rs._body as Record<string, unknown>;
    expect(updated.escalation_status).toBe('approved');
    // Appointment should be cancelled when cancellation is approved
    const appt = await db('appointments').where({ id }).first();
    expect(appt.status).toBe('cancelled');
  });

  it('Deny escalation — PATCH with action=deny', async () => {
    const id = await insertEscalation();
    const rq = req({ params: { appointmentId: String(id) }, body: { action: 'deny' } });
    const rs = res();
    await updateEscalation(rq, rs);
    expect(rs.statusCode).toBe(200);
    const updated = rs._body as Record<string, unknown>;
    expect(updated.escalation_status).toBe('denied');
    // Appointment status should remain confirmed when cancellation is denied
    const appt = await db('appointments').where({ id }).first();
    expect(appt.status).toBe('confirmed');
  });

  it('Approve removes escalation from pending list', async () => {
    const id = await insertEscalation();

    // Approve it
    const patchRq = req({ params: { appointmentId: String(id) }, body: { action: 'approve' } });
    const patchRs = res();
    await updateEscalation(patchRq, patchRs);

    // Fetch escalations — should be empty (approved ones excluded)
    const listRq = req();
    const listRs = res();
    await getEscalations(listRq, listRs);
    expect((listRs._body as unknown[]).length).toBe(0);
  });

  it('Deny removes escalation from pending list', async () => {
    const id = await insertEscalation();

    const patchRq = req({ params: { appointmentId: String(id) }, body: { action: 'deny' } });
    const patchRs = res();
    await updateEscalation(patchRq, patchRs);

    const listRq = req();
    const listRs = res();
    await getEscalations(listRq, listRs);
    expect((listRs._body as unknown[]).length).toBe(0);
  });

  it('PATCH returns 400 for invalid action value', async () => {
    const id = await insertEscalation();
    const rq = req({ params: { appointmentId: String(id) }, body: { action: 'delete' } });
    const rs = res();
    await updateEscalation(rq, rs);
    expect(rs.statusCode).toBe(400);
  });

  it('PATCH returns 404 for non-existent escalation', async () => {
    const rq = req({ params: { appointmentId: '99999' }, body: { action: 'approve' } });
    const rs = res();
    await updateEscalation(rq, rs);
    expect(rs.statusCode).toBe(404);
  });
});
