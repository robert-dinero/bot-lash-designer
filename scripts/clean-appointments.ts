import knex from 'knex';

async function run() {
  const db = knex({ client: 'sqlite3', connection: { filename: './data/bot.sqlite' }, useNullAsDefault: true });
  const count = await db('appointments').del();
  console.log(`Deletados ${count} agendamentos`);
  const remaining = await db('appointments').count('* as n').first() as any;
  console.log(`Restante: ${remaining?.n}`);
  await db.destroy();
}
run().catch(console.error);
