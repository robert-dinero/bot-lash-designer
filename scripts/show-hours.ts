import { getDb } from '../src/db';

async function main() {
  const db = getDb();
  const rows = await db('working_hours').orderBy('day_of_week').select('day_of_week', 'open_time', 'close_time', 'is_closed');
  console.log(JSON.stringify(rows, null, 2));
  await db.destroy();
}

main().catch(console.error);
