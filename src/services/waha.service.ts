import { env } from '../config/env';
import { log, maskPhone } from '../utils/logger';

export function normalizePhone(from: string): string {
  return from.replace(/@(c\.us|s\.whatsapp\.net|lid)$/i, '');
}

export function toChatId(phone: string): string {
  const clean = normalizePhone(phone);
  return `${clean}@c.us`;
}

export async function notifyOwner(message: string): Promise<void> {
  if (!env.OWNER_PHONE) return;
  await sendText(env.OWNER_PHONE, message);
}

// Resolves a @lid contact ID to a real phone number via WAHA contacts API
export async function resolveLid(lidId: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const resolved = await resolveLidOnce(lidId);
    if (resolved) return resolved;
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
    }
  }
  return null;
}

async function resolveLidOnce(lidId: string): Promise<string | null> {
  try {
    const headers = { 'X-Api-Key': env.WAHA_API_KEY };
    const encoded = encodeURIComponent(lidId);
    const contactRes = await fetch(
      `${env.WAHA_BASE_URL}/api/contacts?contactId=${encoded}&session=default`,
      { headers }
    );
    if (contactRes.ok) {
      const data = (await contactRes.json()) as { id?: string; number?: string };
      if (data?.id && !data.id.endsWith('@lid')) return normalizePhone(data.id);
      if (data?.number) return normalizePhone(data.number);
    }

    const lidsRes = await fetch(`${env.WAHA_BASE_URL}/api/default/lids`, { headers });
    if (!lidsRes.ok) return null;
    const lids = (await lidsRes.json()) as Array<{ lid?: string; pn?: string }>;
    const match = lids.find(item => item.lid === lidId);
    return match?.pn ? normalizePhone(match.pn) : null;
  } catch {
    return null;
  }
}

export async function sendText(phone: string, text: string): Promise<void> {
  const chatId = toChatId(phone);
  try {
    const res = await fetch(`${env.WAHA_BASE_URL}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': env.WAHA_API_KEY,
      },
      body: JSON.stringify({ chatId, text, session: 'default' }),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(maskPhone(phone), 'WAHA', `WAHA sendText failed [${res.status}]: ${body}`);
    } else {
      log.info(maskPhone(phone), 'WAHA', `→ sent (${text.length} chars)`);
    }
  } catch (err) {
    // Never crash the bot on send failure — just log
    log.error(maskPhone(phone), 'WAHA', `WAHA sendText error`, err);
  }
}
