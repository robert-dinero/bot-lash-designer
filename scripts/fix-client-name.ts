import knex from 'knex';

const db = knex({ client: 'sqlite3', connection: { filename: './data/bot.sqlite' }, useNullAsDefault: true });

const INVALID = ['cliente', 'fulano', 'nome', 'user', 'usuário', 'atendido'];

async function run() {
  const rows = await db('appointments').whereNotNull('client_name').select('id', 'client_name');
  for (const r of rows) {
    if (INVALID.includes((r.client_name as string).toLowerCase().trim())) {
      await db('appointments').where({ id: r.id }).update({ client_name: null });
      console.log(`✓ Corrigido id=${r.id} — "${r.client_name}" → null`);
    }
  }
  console.log('Pronto.');
  await db.destroy();
}

run().catch(console.error);
