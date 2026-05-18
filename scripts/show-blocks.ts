import { getDb, initSchema } from '../src/db/index';

async function main() {
  await initSchema();
  const db = getDb();
  const blocks = await db('availability_blocks').select('*');
  console.log('availability_blocks:', JSON.stringify(blocks, null, 2));
  await db.destroy();
}
main().catch(console.error).finally(() => process.exit(0));
