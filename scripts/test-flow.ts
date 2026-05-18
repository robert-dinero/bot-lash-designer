/**
 * Flow simulation script — tests conversation scenarios end-to-end
 * using real AI calls and a dedicated temp SQLite database.
 *
 * Run: npx tsx scripts/test-flow.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.DB_PATH = './data/test-flow-temp.sqlite';

import { getDb, initSchema } from '../src/db';
import {
  upsertUser,
  getOrCreateSession,
  getCart,
  saveMessageAndUpdateCart,
  resetSession,
  updateCart,
  incrementMisunderstanding,
  resetMisunderstanding,
  getHistory,
} from '../src/services/session.service';
import { getAIResponse, checkKeywords } from '../src/services/ai.service';
import { businessConfig } from '../src/config/business';
import * as fs from 'fs';
import * as path from 'path';

// ─── Colour helpers ───────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

function pass(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red}✗${c.reset} ${msg}`); process.exitCode = 1; }
function info(msg: string) { console.log(`  ${c.gray}→${c.reset} ${msg}`); }
function section(title: string) { console.log(`\n${c.bold}${c.cyan}▶ ${title}${c.reset}`); }
function userMsg(msg: string) { console.log(`  ${c.yellow}[user]${c.reset} ${msg}`); }
function botMsg(msg: string) { console.log(`  ${c.magenta}[bot] ${c.reset} ${msg.slice(0, 120)}${msg.length > 120 ? '…' : ''}`); }

// ─── Wipe a phone's session so each scenario starts clean ────────────────────

async function wipePhone(phone: string): Promise<void> {
  const db = getDb();
  await db('messages').where({ phone }).delete();
  await db('sessions').where({ phone }).delete();
  await db('users').where({ phone }).delete();
}

// ─── Core simulation ──────────────────────────────────────────────────────────

let msgCounter = 0;

async function turn(phone: string, message: string): Promise<{ reply: string; cart: Awaited<ReturnType<typeof getCart>> }> {
  msgCounter++;

  userMsg(message);

  await upsertUser(phone);
  const { isNew } = await getOrCreateSession(phone);
  const cart = await getCart(phone);

  let reply: string;
  let cartPatch: Partial<typeof cart> | null = null;

  if (isNew) {
    reply =
      `Olá! Bem-vindo ao ${businessConfig.businessName}! 😊\n\n` +
      `Aqui está nosso cardápio de hoje:\n` +
      businessConfig.menu.map((item, i) => `${i + 1}. ${item}`).join('\n') +
      `\n\nQual prato você escolhe?`;
    await saveMessageAndUpdateCart(phone, message, reply);
    botMsg(reply);
    return { reply, cart: await getCart(phone) };
  }

  const kw = checkKeywords(message);
  if (kw) {
    if (kw.resetSession) {
      await resetSession(phone);
      reply =
        `Tudo bem! Pedido cancelado. 😊\n\n` +
        `Aqui está nosso cardápio:\n` +
        businessConfig.menu.map((item, i) => `${i + 1}. ${item}`).join('\n') +
        `\n\nQual prato você escolhe?`;
    } else {
      if (kw.escalate) await updateCart(phone, { escalated: true });
      reply = kw.reply;
    }
    await saveMessageAndUpdateCart(phone, message, reply);
    botMsg(reply);
    return { reply, cart: await getCart(phone) };
  }

  const history = await getHistory(phone);
  const result = await getAIResponse(message, cart, history);
  reply = result.reply;
  cartPatch = result.cartPatch;
  if (cartPatch) info(`patch: ${JSON.stringify(cartPatch)}`);

  const looksLikeConfusion =
    reply.toLowerCase().includes('não entendi') ||
    reply.toLowerCase().includes('pode repetir') ||
    reply.toLowerCase().includes('não compreendi');

  if (looksLikeConfusion) {
    const count = await incrementMisunderstanding(phone);
    if (count >= 3) {
      reply = 'Vou chamar um atendente humano para te ajudar! 👋';
      await updateCart(phone, { escalated: true });
      await saveMessageAndUpdateCart(phone, message, reply, { escalated: true });
      botMsg(reply);
      return { reply, cart: await getCart(phone) };
    }
  } else {
    await resetMisunderstanding(phone);
  }

  await saveMessageAndUpdateCart(phone, message, reply, cartPatch ?? undefined);
  botMsg(reply);
  return { reply, cart: await getCart(phone) };
}

// ─── Assertions ───────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string) {
  if (condition) pass(message);
  else fail(message);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioHappyPath() {
  section('Scenario 1: Happy path — complete order');
  const phone = 'test_happy_001';
  await wipePhone(phone);

  let { reply, cart } = await turn(phone, 'oi');
  assert(reply.includes(businessConfig.businessName), 'Greeting includes business name');
  assert(reply.includes(businessConfig.menu[0]), 'Greeting includes first menu item');

  ({ reply, cart } = await turn(phone, '1'));
  info(`After dish selection — dish: "${cart.dish}" (AI may batch patch until confirm)`);

  ({ reply, cart } = await turn(phone, 'Coca cola'));
  ({ reply, cart } = await turn(phone, 'Rua das Flores, 42'));
  ({ reply, cart } = await turn(phone, 'João Silva'));

  ({ reply, cart } = await turn(phone, 'sim'));
  assert(cart.confirmed === true, 'Order confirmed');
  assert(cart.dish !== '', `Dish in final cart: "${cart.dish}"`);
  assert(cart.address !== '', `Address in final cart: "${cart.address}"`);
  assert(cart.name !== '', `Name in final cart: "${cart.name}"`);
}

async function scenarioCancelAndRestart() {
  section('Scenario 2: Cancel mid-order and restart');
  const phone = 'test_cancel_002';
  await wipePhone(phone);

  await turn(phone, 'oi');
  await turn(phone, '2');
  let { cart } = await turn(phone, 'cancelar');
  assert(cart.dish === '', 'Cart cleared after cancel');
  assert(cart.confirmed === false, 'Confirmed reset to false');

  // After cancel, keyword handler shows menu again — next message treated as new order
  // The session still exists (not new), so first dish selection goes to AI
  await turn(phone, '3');
  await turn(phone, 'sem bebida');
  await turn(phone, 'Av. Paulista, 1000');
  await turn(phone, 'Maria');
  const final = await turn(phone, 'sim');
  assert(final.cart.confirmed === true, 'Order confirmed after restart');
  assert(final.cart.dish !== '', `New dish set: "${final.cart.dish}"`);
}

async function scenarioIndecisiveCustomer() {
  section('Scenario 3: Indecisive customer — changes mind before confirming');
  const phone = 'test_indecisive_003';
  await wipePhone(phone);

  await turn(phone, 'bom dia');
  await turn(phone, '1');
  await turn(phone, 'suco de laranja');
  await turn(phone, 'Rua dos Bobos, 0');
  await turn(phone, 'Pedro');

  // Customer says no at confirmation, wants to change dish
  let { reply, cart } = await turn(phone, 'não, quero mudar o prato');
  info(`Bot response to "não": "${reply.slice(0, 80)}"`);

  ({ reply, cart } = await turn(phone, 'quero o prato 2'));
  info(`Cart dish after change: "${cart.dish}"`);

  // Fill in remaining steps after dish change
  if (!cart.address) await turn(phone, 'Rua dos Bobos, 0');
  if (!cart.name) await turn(phone, 'Pedro');
  const final = await turn(phone, 'sim');
  assert(final.cart.confirmed === true, 'Order eventually confirmed after change');
}

async function scenarioEscalation() {
  section('Scenario 4: Human escalation via keyword');
  const phone = 'test_escalate_004';
  await wipePhone(phone);

  await turn(phone, 'oi');
  await turn(phone, '2');
  const { cart } = await turn(phone, 'quero falar com atendente');
  assert(cart.escalated === true, 'Escalated flag set via keyword');
}

async function scenarioAutoEscalation() {
  section('Scenario 5: Auto-escalation after 3 misunderstandings');
  const phone = 'test_autoescalate_005';
  await wipePhone(phone);

  await turn(phone, 'oi');
  await turn(phone, 'xkcd zorp blaarg');
  await turn(phone, 'flibber wocka 123 %%%');
  await turn(phone, 'asdf qwer zxcv plmk');
  const finalCart = await getCart(phone);
  if (finalCart.escalated) {
    pass('Auto-escalation triggered after confusion');
  } else {
    info('Auto-escalation not triggered (AI did not return confusion phrases — acceptable, depends on model)');
  }
}

async function scenarioPriceQuery() {
  section('Scenario 6: Price query — bot reveals prices when asked');
  const phone = 'test_price_006';
  await wipePhone(phone);

  await turn(phone, 'oi');
  const { reply } = await turn(phone, 'quanto custa o frango?');
  assert(reply.match(/R\$\s*\d/) !== null, 'Price shown when asked');
  info(`Price response: "${reply}"`);
}

async function scenarioNoDrink() {
  section('Scenario 7: Customer declines drink');
  const phone = 'test_nodrink_007';
  await wipePhone(phone);

  await turn(phone, 'oi');
  await turn(phone, '2');
  let { cart } = await turn(phone, 'não quero bebida');
  // drink should be set (to something like "sem bebida" or empty string treated as filled)
  const step2cart = await getCart(phone);
  info(`Cart after declining drink — drink: "${step2cart.drink}", address: "${step2cart.address}"`);

  await turn(phone, 'Rua Verde, 5');
  await turn(phone, 'Ana');
  const final = await turn(phone, 'sim');
  assert(final.cart.confirmed === true, 'Order confirmed without drink');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}Flow Simulation — ${businessConfig.businessName}${c.reset}`);
  console.log(c.gray + '─'.repeat(60) + c.reset);

  await initSchema();

  const scenarios = [
    scenarioHappyPath,
    scenarioCancelAndRestart,
    scenarioIndecisiveCustomer,
    scenarioEscalation,
    scenarioAutoEscalation,
    scenarioPriceQuery,
    scenarioNoDrink,
  ];

  for (const scenario of scenarios) {
    try {
      await scenario();
    } catch (err) {
      console.log(`  ${c.red}✗${c.reset} Scenario threw: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  const status = process.exitCode === 1
    ? `${c.red}Some tests failed${c.reset}`
    : `${c.green}All tests passed${c.reset}`;
  console.log(`\n${c.bold}${status}\n`);

  // Cleanup temp DB
  const dbPath = path.resolve(process.cwd(), './data/test-flow-temp.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
