import { getDb, initSchema } from '../src/db/index';

async function main() {
  await initSchema();
  const db = getDb();
  const rows = await db('working_hours').where({ chair_id: 1 }).select('day_of_week', 'break_start', 'break_end').orderBy('day_of_week');
  console.log('break columns:', JSON.stringify(rows, null, 2));
  await db.destroy();
}
main().catch(console.error).finally(() => process.exit(0));
