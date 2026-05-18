import { beforeAll, beforeEach, afterAll } from 'vitest';
import knex from 'knex';
import { _setDb, initSchema } from '../db';

let testDb: ReturnType<typeof knex>;

beforeAll(async () => {
  testDb = knex({
    client: 'sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
  _setDb(testDb);
  await initSchema();
});

beforeEach(async () => {
  await testDb('appointments').delete();
  await testDb('sessions').delete();
  await testDb('messages').delete();
  await testDb('users').delete();
  await testDb('availability_blocks').delete();
});

afterAll(async () => {
  await testDb.destroy();
  _setDb(null);
});
