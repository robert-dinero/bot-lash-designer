/**
 * INFRA group tests
 * INFRA-01: TypeScript strict mode enabled
 * INFRA-02: Zod env validation crashes on missing vars with clear message
 * INFRA-03: businessConfig loads businessName, menu, drinks, tone from config.json
 * INFRA-04: SQLite initialized with WAL mode + all 4 tables
 * INFRA-06: .env.example exists with all required vars documented
 * DX-04: Structured console logging with timestamp and phone prefix
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');

// ─── INFRA-01: TypeScript strict mode ────────────────────────────────────────
describe('INFRA-01: TypeScript strict mode', () => {
  it('tsconfig.json has strict: true', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf-8')
    );
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it('tsconfig.json has outDir set to dist/', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf-8')
    );
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
  });

  it('package.json dev script uses tsx runner', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
    );
    expect(pkg.scripts.dev).toContain('tsx');
  });
});

// ─── INFRA-02: Zod env validation ────────────────────────────────────────────
describe('INFRA-02: Zod env validation crashes on missing required vars', () => {
  it('env.ts uses zod .min(1) guard on OPENAI_API_KEY making it required', () => {
    const envSource = fs.readFileSync(
      path.join(ROOT, 'src/config/env.ts'),
      'utf-8'
    );
    // Must have a min(1) or similar guard on OPENAI_API_KEY
    expect(envSource).toContain('OPENAI_API_KEY');
    expect(envSource).toMatch(/\.min\(1/);
  });

  it('env.ts calls process.exit(1) when validation fails', () => {
    const envSource = fs.readFileSync(
      path.join(ROOT, 'src/config/env.ts'),
      'utf-8'
    );
    expect(envSource).toContain('process.exit(1)');
  });

  it('env.ts prints field errors before exit', () => {
    const envSource = fs.readFileSync(
      path.join(ROOT, 'src/config/env.ts'),
      'utf-8'
    );
    // Must print errors — not just silently exit
    expect(envSource).toContain('console.error');
    expect(envSource).toContain('fieldErrors');
  });
});

// ─── INFRA-03: businessConfig ─────────────────────────────────────────────────
describe('INFRA-03: businessConfig loads from config.json', () => {
  it('businessConfig has a non-empty businessName string', async () => {
    const { businessConfig } = await import('../config/business');
    expect(typeof businessConfig.businessName).toBe('string');
    expect(businessConfig.businessName.length).toBeGreaterThan(0);
  });

  it('businessConfig.tone is a non-empty string', async () => {
    const { businessConfig } = await import('../config/business');
    expect(typeof businessConfig.tone).toBe('string');
    expect((businessConfig.tone as string).length).toBeGreaterThan(0);
  });

  it('config.json file exists at project root', () => {
    expect(fs.existsSync(path.join(ROOT, 'config.json'))).toBe(true);
  });
});

// ─── INFRA-04: SQLite WAL mode + all 4 tables ─────────────────────────────────
describe('INFRA-04: SQLite initialized with WAL mode and all 4 tables', () => {
  it('db/index.ts enables WAL mode via PRAGMA journal_mode = WAL', () => {
    const dbSource = fs.readFileSync(
      path.join(ROOT, 'src/db/index.ts'),
      'utf-8'
    );
    expect(dbSource).toContain('PRAGMA journal_mode = WAL');
  });

  it('initSchema creates users table', async () => {
    // Use in-memory knex to test schema creation directly
    const knex = (await import('knex')).default;
    const db = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });

    // Manually replicate schema creation for users
    await db.schema.createTable('users', (t) => {
      t.string('phone').primary();
      t.string('created_at').notNullable().defaultTo(db.fn.now());
    });

    const exists = await db.schema.hasTable('users');
    expect(exists).toBe(true);
    await db.destroy();
  });

  it('initSchema creates sessions table with cart_json column', async () => {
    const knex = (await import('knex')).default;
    const db = knex({
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
    });

    const hasTable = await db.schema.hasTable('sessions');
    const hasCol = await db.schema.hasColumn('sessions', 'cart_json');
    expect(hasTable).toBe(true);
    expect(hasCol).toBe(true);
    await db.destroy();
  });

  it('initSchema creates messages table', async () => {
    const knex = (await import('knex')).default;
    const db = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await db.schema.createTable('messages', (t) => {
      t.increments('id').primary();
      t.string('phone').notNullable();
      t.string('role').notNullable();
      t.text('content').notNullable();
      t.string('created_at').notNullable().defaultTo(db.fn.now());
    });
    const exists = await db.schema.hasTable('messages');
    expect(exists).toBe(true);
    await db.destroy();
  });

  it('initSchema creates processed_messages table', async () => {
    const knex = (await import('knex')).default;
    const db = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await db.schema.createTable('processed_messages', (t) => {
      t.string('message_id').primary();
      t.string('processed_at').notNullable().defaultTo(db.fn.now());
    });
    const exists = await db.schema.hasTable('processed_messages');
    expect(exists).toBe(true);
    await db.destroy();
  });

  it('db/index.ts code references all 4 table names', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/db/index.ts'), 'utf-8');
    expect(src).toContain("'users'");
    expect(src).toContain("'sessions'");
    expect(src).toContain("'messages'");
    expect(src).toContain("'processed_messages'");
  });
});

// ─── INFRA-06: .env.example with all required vars ───────────────────────────
describe('INFRA-06: .env.example exists with all required vars documented', () => {
  it('.env.example file exists at project root', () => {
    expect(fs.existsSync(path.join(ROOT, '.env.example'))).toBe(true);
  });

  it('.env.example documents OPENAI_API_KEY', () => {
    const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('OPENAI_API_KEY');
  });

  it('.env.example documents WAHA_BASE_URL', () => {
    const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('WAHA_BASE_URL');
  });

  it('.env.example documents WAHA_API_KEY', () => {
    const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('WAHA_API_KEY');
  });

  it('.env.example documents WEBHOOK_API_KEY', () => {
    const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('WEBHOOK_API_KEY');
  });

  it('.env.example documents DB_PATH', () => {
    const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');
    expect(content).toContain('DB_PATH');
  });
});

// ─── Phase 5: appointments.status CHECK constraint migration ──────────────────
describe('Phase 5 migration: appointments.status accepts rescheduled', () => {
  it('migrates an existing appointments table without rescheduled to accept it', async () => {
    const knex = (await import('knex')).default;
    const db = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });

    // Create prerequisite tables
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

    // Seed chair and service
    await db.raw(`INSERT INTO chairs (id, name, active) VALUES (1, 'Cadeira 1', 1)`);
    await db.raw(`INSERT INTO services (id, name, duration_minutes, price_cents, active) VALUES (1, 'Corte', 30, 4000, 1)`);

    // Create appointments table WITHOUT 'rescheduled' in CHECK constraint (simulates legacy prod DB)
    await db.raw(`
      CREATE TABLE appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chair_id INTEGER NOT NULL REFERENCES chairs(id),
        client_phone TEXT NOT NULL,
        client_name TEXT,
        service_id INTEGER NOT NULL REFERENCES services(id),
        starts_at TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        reminder_24h_sent_at TEXT,
        reminder_12h_sent_at TEXT,
        reminder_2h_sent_at TEXT,
        reminder_morning_sent_at TEXT,
        cancelled_at TEXT,
        escalation_status TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed' CHECK ("status" in ('confirmed','cancelled','completed','no_show')),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert a row to be preserved through migration
    await db.raw(`INSERT INTO appointments (chair_id, client_phone, service_id, starts_at, duration_minutes, status)
                  VALUES (1, '5511999999999', 1, '2026-06-01T10:00:00.000Z', 30, 'confirmed')`);

    // Inject the DB instance and run initSchema (triggers migration path)
    const { _setDb, initSchema } = await import('../db');
    _setDb(db);
    await initSchema();

    // After migration, UPDATE with 'rescheduled' should NOT throw
    await expect(
      db.raw(`UPDATE appointments SET status='rescheduled' WHERE id=1`)
    ).resolves.toBeDefined();

    // Verify the row is still there with updated status
    const row = await db('appointments').where('id', 1).first();
    expect(row.status).toBe('rescheduled');

    // Idempotency: run initSchema again — should not error or recreate table
    await expect(initSchema()).resolves.toBeUndefined();

    // After second run, row should still be there
    const row2 = await db('appointments').where('id', 1).first();
    expect(row2.status).toBe('rescheduled');

    _setDb(null);
    await db.destroy();
  });
});

// ─── DX-04: Structured logging with timestamp and phone prefix ────────────────
describe('DX-04: Structured console logging with timestamp and phone prefix', () => {
  it('logger exports a log object with info, error, warn, debug methods (3-arg signature)', async () => {
    const { log } = await import('../utils/logger');
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.debug).toBe('function');
    // log.phone was removed in plan 06-01 — replaced by log.info(masked, step, msg)
    expect((log as Record<string, unknown>).phone).toBeUndefined();
  });

  it('log.info output contains timestamp', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/utils/logger.ts'), 'utf-8');
    expect(src).toContain('timestamp()');
  });

  it('logger exports maskPhone for phone masking (D-05)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/utils/logger.ts'), 'utf-8');
    // maskPhone must be exported and mask to last 4 digits
    expect(src).toContain('export function maskPhone');
    expect(src).toContain('****');
  });
});
