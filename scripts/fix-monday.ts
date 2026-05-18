import { getDb, initSchema } from '../src/db/index';

async function main() {
  await initSchema();
  const db = getDb();

  const rows = await db('working_hours').where({ chair_id: 1 }).orderBy('day_of_week');
  const days = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
  console.log('=== Working Hours ===');
  rows.forEach((r: any) => console.log(`${days[r.day_of_week]} (${r.day_of_week}): ${r.open_time}-${r.close_time} | is_closed=${r.is_closed}`));

  const monday = rows.find((r: any) => r.day_of_week === 1);
  if (monday && monday.is_closed) {
    await db('working_hours').where({ chair_id: 1, day_of_week: 1 }).update({ is_closed: 0, open_time: '09:00', close_time: '19:00' });
    console.log('\nFixed: Segunda-feira agora está aberta (09:00-19:00)');
  } else {
    console.log('\nSegunda-feira já está correta.');
  }

  await db.destroy();
}

main().catch(console.error).finally(() => process.exit(0));
