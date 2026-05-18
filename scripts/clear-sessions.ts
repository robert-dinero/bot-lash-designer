import { getDb } from '../src/db';

async function main() {
  const db = getDb();
  await db('sessions').delete();
  await db('messages').delete();
  await db('processed_messages').delete();
  console.log('Sessões limpas!');
  await db.destroy();
}

main().catch(console.error);
