import knex, { type Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { log } from '../utils/logger';

let _db: Knex | null = null;

/** For testing only: replace the singleton DB instance. */
export function _setDb(db: Knex | null): void {
  _db = db;
}

export function getDb(): Knex {
  if (_db) return _db;

  const isMemory = env.DB_PATH === ':memory:';
  const dbPath = isMemory ? ':memory:' : path.resolve(process.cwd(), env.DB_PATH);

  if (!isMemory) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  _db = knex({
    client: 'sqlite3',
    connection: isMemory ? ':memory:' : { filename: dbPath },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,  // SQLite is single-writer; pool > 1 causes SQLITE_BUSY contention
      acquireTimeoutMillis: 10_000,
      afterCreate(conn: any, done: (err: Error | null) => void) {
        conn.run('PRAGMA journal_mode = WAL', (err: Error | null) => {
          if (err) return done(err);
          conn.run('PRAGMA busy_timeout = 5000', (err2: Error | null) => {
            if (err2) return done(err2);
            conn.run('PRAGMA foreign_keys = ON', done);
          });
        });
      },
    },
  });

  log.info('-', 'STARTUP', `Database initialized at ${dbPath}`);
  return _db;
}

async function createIfNotExists(
  db: Knex,
  table: string,
  builder: (t: Knex.CreateTableBuilder) => void
): Promise<void> {
  const exists = await db.schema.hasTable(table);
  if (!exists) await db.schema.createTable(table, builder);
}

export async function initSchema(): Promise<void> {
  const db = getDb();

  await createIfNotExists(db, 'users', (t) => {
    t.string('phone').primary();
    t.string('created_at').notNullable().defaultTo(db.fn.now());
  });

  await createIfNotExists(db, 'sessions', (t) => {
    t.string('phone').primary();
    t.text('cart_json').notNullable().defaultTo('{}');
    t.integer('misunderstanding_count').notNullable().defaultTo(0);
    t.string('created_at').notNullable().defaultTo(db.fn.now());
    t.string('updated_at').notNullable().defaultTo(db.fn.now());
    t.foreign('phone').references('users.phone');
  });

  await createIfNotExists(db, 'messages', (t) => {
    t.increments('id').primary();
    t.string('phone').notNullable();
    t.string('role').notNullable();
    t.text('content').notNullable();
    t.string('created_at').notNullable().defaultTo(db.fn.now());
    t.foreign('phone').references('users.phone');
  });

  await createIfNotExists(db, 'processed_messages', (t) => {
    t.string('message_id').primary();
    t.string('processed_at').notNullable().defaultTo(db.fn.now());
  });

  // Add status column to sessions if not exists (admin dashboard migration)
  const hasStatus = await db.schema.hasColumn('sessions', 'status');
  if (!hasStatus) {
    await db.schema.table('sessions', (t) => {
      t.string('status').defaultTo('pending');
    });
    log.info('-', 'STARTUP', 'Migrated sessions table: added status column');
  }

  await createIfNotExists(db, 'chairs', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });

  await createIfNotExists(db, 'services', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.integer('duration_minutes').notNullable();
    t.integer('price_cents').notNullable();
    t.integer('active').notNullable().defaultTo(1);
  });

  await createIfNotExists(db, 'appointments', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable().references('id').inTable('chairs');
    t.text('client_phone').notNullable();
    t.text('client_name').nullable();
    t.integer('service_id').notNullable().references('id').inTable('services');
    t.text('starts_at').notNullable();
    t.integer('duration_minutes').notNullable();
    t.text('reminder_24h_sent_at').nullable();
    t.text('reminder_12h_sent_at').nullable();
    t.text('reminder_2h_sent_at').nullable();
    t.text('reminder_morning_sent_at').nullable();
    t.text('cancelled_at').nullable();
    t.text('escalation_status').nullable();
    t.text('status').notNullable().defaultTo('confirmed')
      .checkIn(['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled']);
    t.text('notes').nullable();
    t.text('created_at').notNullable().defaultTo(db.fn.now());
    t.text('updated_at').notNullable().defaultTo(db.fn.now());
  });

  await createIfNotExists(db, 'working_hours', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable().references('id').inTable('chairs');
    t.integer('day_of_week').notNullable();
    t.text('open_time').notNullable();
    t.text('close_time').notNullable();
    t.integer('is_closed').notNullable().defaultTo(0);
    t.unique(['chair_id', 'day_of_week']);
  });

  // Add client_name column to appointments if not exists
  const hasClientName = await db.schema.hasColumn('appointments', 'client_name');
  if (!hasClientName) {
    await db.schema.table('appointments', (t) => {
      t.text('client_name').nullable();
    });
    log.info('-', 'STARTUP', 'Migrated appointments table: added client_name column');
  }

  // Add reminder tracking columns to appointments if not exists (Phase 3 migration)
  const hasReminder24h = await db.schema.hasColumn('appointments', 'reminder_24h_sent_at');
  if (!hasReminder24h) {
    await db.schema.table('appointments', (t) => {
      t.text('reminder_24h_sent_at').nullable();
      t.text('reminder_12h_sent_at').nullable();
      t.text('reminder_2h_sent_at').nullable();
      t.text('reminder_morning_sent_at').nullable();
      t.text('cancelled_at').nullable();
      t.text('escalation_status').nullable();
    });
    log.info('-', 'STARTUP', 'Migrated appointments table: added reminder tracking columns');
  }

  // Add morning reminder column if not exists (post-Phase 3 migration)
  const hasMorningReminder = await db.schema.hasColumn('appointments', 'reminder_morning_sent_at');
  if (!hasMorningReminder) {
    await db.schema.table('appointments', (t) => {
      t.text('reminder_morning_sent_at').nullable();
    });
    log.info('-', 'STARTUP', 'Migrated appointments: added reminder_morning_sent_at');
  }

  // Add break columns to working_hours if not exists
  const hasBreakStart = await db.schema.hasColumn('working_hours', 'break_start');
  if (!hasBreakStart) {
    await db.schema.table('working_hours', (t) => {
      t.text('break_start').nullable();
      t.text('break_end').nullable();
    });
    log.info('-', 'STARTUP', 'Migrated working_hours: added break_start/break_end');
  }

  await createIfNotExists(db, 'availability_blocks', (t) => {
    t.increments('id').primary();
    t.integer('chair_id').notNullable().references('id').inTable('chairs');
    t.text('starts_at').notNullable();
    t.text('ends_at').notNullable();
    t.text('reason').nullable();
  });

  // Seed: maca id=1
  await db.raw(`INSERT OR IGNORE INTO chairs (id, name, active) VALUES (1, 'Maca 1', 1)`);

  // Seed: services
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (1, 'Volume Brasileiro', 120, 18000, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (2, 'Volume Russo', 150, 22000, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (3, 'Lifting de Cílios', 60, 12000, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (4, 'Manutenção', 90, 11000, 1)`);
  await db.raw(`INSERT OR IGNORE INTO services (id, name, duration_minutes, price_cents, active) VALUES (5, 'Remoção', 30, 4000, 1)`);

  // Seed: working_hours for chair_id=1 (Sunday=0 closed, Mon-Sat open 09:00-19:00)
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 0, '00:00', '00:00', 1)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 1, '09:00', '19:00', 0)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 2, '09:00', '19:00', 0)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 3, '09:00', '19:00', 0)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 4, '09:00', '19:00', 0)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 5, '09:00', '19:00', 0)`);
  await db.raw(`INSERT OR IGNORE INTO working_hours (chair_id, day_of_week, open_time, close_time, is_closed) VALUES (1, 6, '09:00', '19:00', 0)`);

  // Migrate appointments.status CHECK constraint to include 'rescheduled' (Phase 5).
  // SQLite cannot ALTER a CHECK constraint — must recreate the table.
  const apptDdlRow = await db.raw(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='appointments'`
  );
  const apptDdl: string = (Array.isArray(apptDdlRow) ? apptDdlRow[0]?.sql : apptDdlRow?.sql) ?? '';
  const hasCheckConstraint = /check\s*\(/i.test(apptDdl);
  const alreadyHasRescheduled = apptDdl.includes("'rescheduled'");
  if (hasCheckConstraint && !alreadyHasRescheduled) {
    log.info('-', 'STARTUP', 'Migrating appointments.status CHECK constraint to include rescheduled...');
    await db.raw('PRAGMA foreign_keys = OFF');
    try {
      await db.transaction(async (trx) => {
        await trx.schema.createTable('appointments_new', (t) => {
          t.increments('id').primary();
          t.integer('chair_id').notNullable().references('id').inTable('chairs');
          t.text('client_phone').notNullable();
          t.text('client_name').nullable();
          t.integer('service_id').notNullable().references('id').inTable('services');
          t.text('starts_at').notNullable();
          t.integer('duration_minutes').notNullable();
          t.text('reminder_24h_sent_at').nullable();
          t.text('reminder_12h_sent_at').nullable();
          t.text('reminder_2h_sent_at').nullable();
          t.text('reminder_morning_sent_at').nullable();
          t.text('cancelled_at').nullable();
          t.text('escalation_status').nullable();
          t.text('status').notNullable().defaultTo('confirmed')
            .checkIn(['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled']);
          t.text('notes').nullable();
          t.text('created_at').notNullable().defaultTo(db.fn.now());
          t.text('updated_at').notNullable().defaultTo(db.fn.now());
        });
        await trx.raw(
          `INSERT INTO appointments_new
           (id, chair_id, client_phone, client_name, service_id, starts_at, duration_minutes,
            reminder_24h_sent_at, reminder_12h_sent_at, reminder_2h_sent_at, reminder_morning_sent_at,
            cancelled_at, escalation_status, status, notes, created_at, updated_at)
           SELECT
            id, chair_id, client_phone, client_name, service_id, starts_at, duration_minutes,
            reminder_24h_sent_at, reminder_12h_sent_at, reminder_2h_sent_at, reminder_morning_sent_at,
            cancelled_at, escalation_status, status, notes, created_at, updated_at
           FROM appointments`
        );
        await trx.raw('DROP TABLE appointments');
        await trx.raw('ALTER TABLE appointments_new RENAME TO appointments');
      });
    } finally {
      await db.raw('PRAGMA foreign_keys = ON');
    }
    log.info('-', 'STARTUP', 'Migrated appointments.status: added rescheduled value');
  }

  log.info('-', 'STARTUP', 'Database schema initialized');
}
