import knex from 'knex';
import * as readline from 'readline';

const DB_PATH = process.env.DB_PATH ?? './data/bot.sqlite';

const args = process.argv.slice(2);
const clearSessions    = args.includes('--sessions')    || args.includes('--all');
const clearAppointments = args.includes('--appointments') || args.includes('--all');

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} [s/N] `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 's');
    });
  });
}

async function run() {
  if (!clearSessions && !clearAppointments) {
    console.log(`
Uso: npx tsx scripts/reset.ts [opções]

  --sessions       Limpa sessões, mensagens e deduplicação
  --appointments   Limpa todos os agendamentos
  --all            Limpa tudo acima
`);
    process.exit(0);
  }

  const db = knex({
    client: 'sqlite3',
    connection: { filename: DB_PATH },
    useNullAsDefault: true,
  });

  if (clearAppointments) {
    const count = await db('appointments').count('* as n').first() as any;
    const ok = await confirm(`Apagar ${count?.n} agendamento(s)?`);
    if (ok) {
      await db('appointments').del();
      console.log('✓ Agendamentos apagados');
    } else {
      console.log('Agendamentos mantidos');
    }
  }

  if (clearSessions) {
    const sessions = await db('sessions').count('* as n').first() as any;
    const msgs     = await db('messages').count('* as n').first() as any;
    const ok = await confirm(`Apagar ${sessions?.n} sessão(ões) e ${msgs?.n} mensagem(ns)?`);
    if (ok) {
      await db('sessions').del();
      await db('messages').del();
      await db('processed_messages').del();
      console.log('✓ Sessões e mensagens apagadas');
    } else {
      console.log('Sessões mantidas');
    }
  }

  await db.destroy();
}

run().catch(console.error);
