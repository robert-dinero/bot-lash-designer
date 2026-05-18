/**
 * Seed script: inserts test appointments for dashboard visualization.
 * Run with: npx tsx scripts/seed-test-appointments.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { getDb } from '../src/db';

async function seed() {
  const db = getDb();

  // Minimal schema bootstrap (avoids migration-order bug in initSchema)
  await db.schema.createTableIfNotExists('chairs', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });
  await db.schema.createTableIfNotExists('services', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('duration_minutes').notNullable();
    t.integer('price_cents').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });
  await db.schema.createTableIfNotExists('appointments', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable();
    t.text('client_phone').notNullable();
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

  await db.raw(`INSERT OR IGNORE INTO chairs (id, name, active) VALUES (1, 'Cadeira 1', 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (1, 'Corte', 30, 4000, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (2, 'Barba', 20, 2500, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (3, 'Corte + Barba', 45, 6000, 1)`);

  // Use today as anchor so appointments always appear in the current week
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  function dayOffset(days: number, hour: number, minute = 0): string {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  }

  const appointments = [
    // Hoje
    { client_phone: '5511991110001', service_id: 1, starts_at: dayOffset(0, 9, 0),  duration_minutes: 30,  status: 'confirmed',  notes: null },
    { client_phone: '5511991110002', service_id: 2, starts_at: dayOffset(0, 10, 30), duration_minutes: 20,  status: 'confirmed',  notes: 'Cliente novo' },
    { client_phone: '5511991110003', service_id: 3, starts_at: dayOffset(0, 14, 0),  duration_minutes: 45,  status: 'confirmed',  notes: null },
    { client_phone: '5511991110004', service_id: 1, starts_at: dayOffset(0, 11, 0),  duration_minutes: 30,  status: 'cancelled',  notes: 'Cancelou por mensagem' },
    // Amanhã
    { client_phone: '5511991110005', service_id: 2, starts_at: dayOffset(1, 9, 30),  duration_minutes: 20,  status: 'confirmed',  notes: null },
    { client_phone: '5511991110006', service_id: 3, starts_at: dayOffset(1, 11, 0),  duration_minutes: 45,  status: 'confirmed',  notes: null },
    { client_phone: '5511991110007', service_id: 1, starts_at: dayOffset(1, 15, 0),  duration_minutes: 30,  status: 'confirmed',  notes: null },
    // Depois de amanhã
    { client_phone: '5511991110008', service_id: 1, starts_at: dayOffset(2, 10, 0),  duration_minutes: 30,  status: 'confirmed',  notes: null },
    { client_phone: '5511991110009', service_id: 2, starts_at: dayOffset(2, 13, 0),  duration_minutes: 20,  status: 'confirmed',  notes: null },
    // Ontem (completed + no_show)
    { client_phone: '5511991110010', service_id: 1, starts_at: dayOffset(-1, 9, 0),  duration_minutes: 30,  status: 'completed',  notes: null },
    { client_phone: '5511991110011', service_id: 3, starts_at: dayOffset(-1, 11, 0), duration_minutes: 45,  status: 'no_show',    notes: null },
    // Escalação pendente (cancelamento dentro de 6h solicitado)
    { client_phone: '5511991110012', service_id: 2, starts_at: dayOffset(0, 16, 0),  duration_minutes: 20,  status: 'confirmed',  notes: null, escalation_status: 'pending' },
  ];

  let inserted = 0;
  for (const appt of appointments) {
    await db('appointments').insert({
      chair_id: 1,
      ...appt,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    inserted++;
  }

  console.log(`✓ ${inserted} agendamentos de teste inseridos`);
  await db.destroy();
}

seed().catch((err) => {
  console.error('Erro ao inserir seeds:', err);
  process.exit(1);
});
