import { getDb, initSchema } from '../src/db/index';

async function main() {
  await initSchema();
  const db = getDb();
  await db('working_hours').where({ chair_id: 1, day_of_week: 1 }).update({ is_closed: 1 });
  console.log('Segunda-feira fechada novamente.');
  await db.destroy();
}

main().catch(console.error).finally(() => process.exit(0));
