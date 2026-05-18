import knex from 'knex';

const DB_PATH = process.env.DB_PATH ?? './data/bot.sqlite';

async function run() {
  const db = knex({ client: 'sqlite3', connection: { filename: DB_PATH }, useNullAsDefault: true });

  const phone = '5511999990001';
  const now = new Date().toISOString();
  const startsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // daqui 2h

  await db.raw(`INSERT OR IGNORE INTO users (phone, created_at) VALUES (?, ?)`, [phone, now]);

  const [id] = await db('appointments').insert({
    chair_id: 1,
    client_phone: phone,
    client_name: 'Carlos Silva',
    service_id: 2,
    starts_at: startsAt,
    duration_minutes: 30,
    status: 'confirmed',
    escalation_status: 'pending',
    notes: 'Pediu cancelamento com menos de 6h',
    created_at: now,
    updated_at: now,
  });

  console.log(`✓ Escalação de exemplo criada (id=${id}) — Carlos Silva, Barba, daqui 2h`);
  await db.destroy();
}

run().catch(console.error);
