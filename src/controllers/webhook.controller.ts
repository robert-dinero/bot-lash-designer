import type { Request, Response } from 'express';
import { normalizePhone, sendText, resolveLid, notifyOwner } from '../services/waha.service';
import { isDuplicateAndMark } from '../lib/dedup';
import {
  upsertUser,
  getOrCreateSession,
  incrementMisunderstanding,
  resetMisunderstanding,
  getHistory,
  saveMessage,
  saveAppointmentState,
  resetSession,
} from '../services/session.service';
import {
  getAvailableSlots,
  validateAppointmentTime,
  createAppointment,
  rescheduleAppointment,
  deriveStep,
} from '../services/appointment.service';
import {
  getAIResponse,
  detectCancelKeyword,
  detectRescheduleKeyword,
  type ServiceRecord,
} from '../services/ai.service';
import { DEFAULT_CHAIR_ID } from '../config/constants';
import {
  decideCancellation,
  cancelAppointment,
  escalateCancellation,
} from '../services/cancellation.service';
import { getDb } from '../db';
import { env } from '../config/env';
import { businessConfig } from '../config/business';
import { log, maskPhone } from '../utils/logger';
import type { AppointmentState } from '../types';
import { parseISO, format, addDays, nextDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface WahaPayload {
  event?: string;
  payload?: { id?: string; from?: string; fromMe?: boolean; body?: string; type?: string; timestamp?: number; };
  from?: string;
  body?: string;
}

// Process-start epoch (seconds) — used to discard messages older than the bot boot.
const PROCESS_START_EPOCH_S = Math.floor(Date.now() / 1000);

// Max age of a message to be accepted (seconds). Messages older than this relative to
// bot start-up are treated as queued/replayed and silently dropped.
const MAX_MESSAGE_AGE_S = 5 * 60; // 5 minutes

/**
 * Try to extract a concrete Date from a vague requestedDateTime string like
 * "sábado", "amanhã", "próxima segunda", "16/05".
 * Returns null if the string can't be reliably parsed to a future date.
 */
function parseRequestedDay(requested: string, today: Date): Date | null {
  const lower = requested.toLowerCase().trim();

  // "depois de amanhã" / "depois de amanha" — must check before "amanhã"
  if (/depois de aman[hã]/.test(lower) || /depois de amanha/.test(lower)) return addDays(today, 2);

  // "amanhã" / "amanha"
  if (/aman[hã]/.test(lower)) return addDays(today, 1);

  // "hoje"
  if (/\bhoje\b/.test(lower)) return today;

  // Day-of-week names → next occurrence
  // Find the LAST mentioned day in the message (client often says "X won't work, how about Y?")
  const weekdays: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
    domingo: 0, segunda: 1, 'segunda-feira': 1,
    terça: 2, 'terca': 2, 'terça-feira': 2, 'terca-feira': 2,
    quarta: 3, 'quarta-feira': 3,
    quinta: 4, 'quinta-feira': 4,
    sexta: 5, 'sexta-feira': 5,
    sábado: 6, sabado: 6,
  };
  let lastMatchIndex = -1;
  let lastMatchDow: (0 | 1 | 2 | 3 | 4 | 5 | 6) | null = null;
  for (const [name, dow] of Object.entries(weekdays)) {
    const idx = lower.lastIndexOf(name);
    if (idx !== -1 && idx > lastMatchIndex) {
      lastMatchIndex = idx;
      lastMatchDow = dow;
    }
  }
  if (lastMatchDow !== null) {
    return nextDay(today, lastMatchDow);
  }

  // dd/mm or dd/mm/yyyy
  const dmMatch = lower.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (dmMatch) {
    const year = dmMatch[3] ? parseInt(dmMatch[3]) : today.getFullYear();
    const candidate = new Date(year, parseInt(dmMatch[2]) - 1, parseInt(dmMatch[1]));
    if (!dmMatch[3] && !isNaN(candidate.getTime()) && candidate < today) {
      candidate.setFullYear(today.getFullYear() + 1);
    }
    if (!isNaN(candidate.getTime())) return candidate;
  }

  return null;
}

function containsTimeMention(text: string): boolean {
  return /\b(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)\b/i.test(text);
}

function isAvailabilityQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(quando|qual|quais|tem|hor[aá]rios?|dispon[ií]vel|disponibilidade|agenda|vago|livre)\b/.test(lower)
    && /\b(dispon[ií]vel|disponibilidade|hor[aá]rios?|agenda|vago|livre|tem)\b/.test(lower);
}

function formatSlotList(slots: Date[]): string {
  return slots
    .map(s => `• ${s.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`)
    .join('\n');
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function formatSlotGridList(day: Date, slots: Date[], durationMinutes: number): Promise<string> {
  if (slots.length === 0) return '';

  const workingHours = await getDb()('working_hours')
    .where({ chair_id: DEFAULT_CHAIR_ID, day_of_week: day.getDay() })
    .first() as {
      open_time: string;
      close_time: string;
      break_start?: string | null;
      break_end?: string | null;
      is_closed?: boolean;
    } | undefined;

  if (!workingHours || workingHours.is_closed) {
    return slots.map(s => `• ${formatTimeLabel(s)}`).join('\n');
  }

  const [openHour, openMin] = workingHours.open_time.split(':').map(Number);
  const [closeHour, closeMin] = workingHours.close_time.split(':').map(Number);
  const breakStartMinutes = workingHours.break_start
    ? (() => {
        const [hour, minute] = workingHours.break_start!.split(':').map(Number);
        return hour * 60 + minute;
      })()
    : null;
  const breakEndMinutes = workingHours.break_end
    ? (() => {
        const [hour, minute] = workingHours.break_end!.split(':').map(Number);
        return hour * 60 + minute;
      })()
    : null;

  const availableLabels = new Set(slots.map(formatTimeLabel));
  const lines: string[] = [];
  let currentMinutes = openHour * 60 + openMin;
  const closeMinutes = closeHour * 60 + closeMin;

  while (currentMinutes + durationMinutes <= closeMinutes) {
    const slotEndMinutes = currentMinutes + durationMinutes;
    const overlapsBreak = breakStartMinutes !== null
      && breakEndMinutes !== null
      && currentMinutes < breakEndMinutes
      && slotEndMinutes > breakStartMinutes;

    if (!overlapsBreak) {
      const hour = Math.floor(currentMinutes / 60);
      const minute = currentMinutes % 60;
      const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      lines.push(`• ${availableLabels.has(label) ? label : '--:--'}`);
    }

    currentMinutes += 30;
  }

  return lines.join('\n');
}

function formatDayLabel(day: Date): string {
  return day.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  });
}

function formatPendingConfirmationReply(state: AppointmentState, services: ServiceRecord[]): string {
  const dt = new Date(state.confirmedDateTime ?? '');
  const dateStr = dt.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  });
  const timeStr = dt.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
  const serviceName = services.find(s => s.id === state.serviceId)?.name ?? state.service ?? 'servico';
  const name = state.clientName ? `, ${state.clientName}` : '';
  return `Perfeito${name}. Seu horario de ${serviceName} ficou para ${dateStr}, as ${timeStr}. Pode confirmar com "sim" ou "nao"?`;
}

async function ensureDateForSlotReply(reply: string, day: Date, slots: Date[], durationMinutes: number): Promise<string> {
  if (slots.length === 0 || !containsTimeMention(reply)) return reply;
  if (/\b\d{1,2}\/\d{1,2}\b/.test(reply)) return reply;
  const dateStr = formatDayLabel(day);
  return `Para ${dateStr}, tenho estes horários:\n\n${await formatSlotGridList(day, slots, durationMinutes)}\n\nQual funciona melhor pra você?`;
}

function noSlotsFallbackReply(state: AppointmentState, services: ServiceRecord[]): string {
  if (!state.service && !state.serviceId) {
    const menu = services.length
      ? services.map(s => `${s.name}`).join('\n')
      : 'Volume Brasileiro\nVolume Russo\nLifting de Cílios\nManutenção\nRemoção';
    return `Sem problemas! Qual serviço você quer?\n\n${menu}`;
  }
  return 'Sem problemas! Para qual dia você quer marcar?';
}

function serviceMenu(services: ServiceRecord[]): string {
  return services.length
    ? services.map(s => s.name).join('\n')
    : 'Volume Brasileiro\nVolume Russo\nLifting de Cílios\nManutenção\nRemoção';
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function findMentionedService(text: string, services: ServiceRecord[]): ServiceRecord | null {
  const lower = normalizeText(text);
  if (/\b(pe|pezinho|acabamento)\b/.test(lower)) {
    const acabamento = services.find(service => normalizeText(service.name).includes('acabamento'));
    if (acabamento) return acabamento;
  }
  const sorted = [...services].sort((a, b) => b.name.length - a.name.length);
  return sorted.find(service => lower.includes(normalizeText(service.name))) ?? null;
}

async function findNextAvailableDay(
  from: Date,
  duration: number,
  excludeAppointmentId?: number
): Promise<{ day: Date; slots: Date[] } | null> {
  for (let offset = 0; offset < 14; offset += 1) {
    const day = addDays(from, offset);
    const allSlots = await getAvailableSlots(DEFAULT_CHAIR_ID, day, duration, excludeAppointmentId);
    const slots = day.toDateString() === from.toDateString()
      ? allSlots.filter(s => s >= from)
      : allSlots;
    if (slots.length > 0) return { day, slots };
  }
  return null;
}

async function isClosedDay(day: Date): Promise<boolean> {
  const row = await getDb()('working_hours')
    .where({ chair_id: DEFAULT_CHAIR_ID, day_of_week: day.getDay() })
    .first();
  return !row || !!row.is_closed;
}

async function nextAvailabilityIntro(today: Date, nextDay: Date): Promise<string> {
  if (nextDay.toDateString() === today.toDateString()) return 'Tenho estes horários para hoje';
  if (await isClosedDay(today)) {
    return `Hoje não atendemos. O próximo dia aberto com horários é ${formatDayLabel(nextDay)}`;
  }
  return `O próximo dia com horários é ${formatDayLabel(nextDay)}`;
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });
  processMessage(req.body as WahaPayload).catch((err) => {
    log.error('-', 'ENTRY', 'Webhook processing error', err);
  });
}

async function processMessage(data: WahaPayload): Promise<void> {
  const from = data.payload?.from ?? data.from ?? '';
  const body = (data.payload?.body ?? data.body ?? '').trim();
  const fromMe = data.payload?.fromMe ?? false;
  const messageId = data.payload?.id;
  const msgType = data.payload?.type ?? 'chat';
  const msgTimestampS = data.payload?.timestamp;

  if (!messageId) return;
  if (fromMe) return;
  if (from.endsWith('@g.us')) return;
  if (msgType !== 'chat' && data.payload?.type !== undefined) return;
  if (!body || !from) return;

  // Flood protection: drop messages from before the bot started (WAHA queue replay).
  // Accept messages from up to MAX_MESSAGE_AGE_S seconds before boot to avoid
  // dropping messages that arrived during a brief restart.
  if (msgTimestampS !== undefined) {
    const ageRelativeToBoot = PROCESS_START_EPOCH_S - msgTimestampS;
    if (ageRelativeToBoot > MAX_MESSAGE_AGE_S) {
      log.info(maskPhone(from), 'ENTRY', `Dropped stale message (age ${ageRelativeToBoot}s before boot): ${messageId}`);
      return;
    }
  }

  let resolvedFrom = from;
  if (from.endsWith('@lid')) {
    const real = await resolveLid(from);
    if (!real) { log.warn(maskPhone(from), 'ENTRY', `Could not resolve @lid ${from}`); return; }
    resolvedFrom = real;
  }

  const phone = normalizePhone(resolvedFrom);
  if (await isDuplicateAndMark(messageId, phone, body)) return;

  // D-06: webhook entry log with masked phone + ENTRY step (before state load)
  log.info(maskPhone(phone), 'ENTRY', `← "${body}"`);

  try {
    // 1. Upsert user and session
    await upsertUser(phone);
    const { session } = await getOrCreateSession(phone);

    // 2. Restore appointment state from session.cart_json
    let state: AppointmentState;
    try {
      state = session.cart_json ? JSON.parse(session.cart_json) : { confirmed: false };
    } catch {
      log.warn(maskPhone(phone), 'ENTRY', `Could not parse cart_json for ${maskPhone(phone)}, using empty state`);
      state = { confirmed: false };
    }

    // Compute once — reuse throughout processMessage (D-06)
    const masked = maskPhone(phone);
    const step = deriveStep(state);

    // If session still has confirmed=true (shouldn't happen after fix, but guard anyway)
    if (state.confirmed) {
      state = { clientName: state.clientName, nameAsked: true, confirmed: false };
      await saveAppointmentState(phone, state);
      log.info(masked, step, 'Stale confirmed=true cleared — keeping client name');
    }

    // If session has an incomplete booking older than 4 hours, discard it — client abandoned flow.
    // resetSession now preserves clientName/nameAsked so the name gate won't re-fire.
    const hasIncompleteBooking = !!(state.service || state.serviceId || state.requestedDateTime || state.resolvedDay || state.confirmedDateTime);
    if (hasIncompleteBooking && session.updated_at) {
      const sessionAge = Date.now() - new Date(session.updated_at).getTime();
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      if (sessionAge > FOUR_HOURS_MS) {
        await resetSession(phone);
        // Reload state after reset so clientName/nameAsked are retained
        state = { clientName: state.clientName, nameAsked: !!state.clientName, confirmed: false };
        log.info(masked, step, `Stale incomplete session (${Math.round(sessionAge / 60000)}min) cleared — starting fresh`);
      }
    }

    // Fetch active services from DB once per message — list drives AI prompt and duration lookup
    const services: ServiceRecord[] = await getDb()('services')
      .where({ active: 1 })
      .select('id', 'name', 'duration_minutes')
      .orderBy('id');

    const mentionedService = findMentionedService(body, services);
    const bodyMentionsDay = parseRequestedDay(body, new Date()) !== null;
    const bodyMentionsTime = containsTimeMention(body);
    if (mentionedService) {
      state = {
        ...state,
        serviceId: mentionedService.id,
        service: mentionedService.name,
        ...(bodyMentionsDay || bodyMentionsTime ? {} : {
          requestedDateTime: undefined,
          resolvedDay: undefined,
          confirmedTime: undefined,
          confirmedDateTime: undefined,
        }),
      };
      await saveAppointmentState(phone, state);
      log.info(masked, deriveStep(state), `→ service selected by code: ${mentionedService.name}`);
    }

    // CANCELAR keyword — always checked before name gate so "cancelar" is never treated as a name
    if (detectCancelKeyword(body)) {
      const hasActiveSession = !!(state.service || state.serviceId || state.requestedDateTime || state.confirmedDateTime);
      if (hasActiveSession) {
        await resetSession(phone);
        const reply = 'Tudo bem! Cancelei o agendamento em andamento. Quando quiser marcar de novo, é só me chamar! 😊';
        await sendText(phone, reply);
        await saveMessage(phone, body, reply);
        log.info(masked, step, '→ in-progress session cancelled by client');
        return;
      }
      const cancelResult = await handleCancelKeyword(phone);
      await sendText(phone, cancelResult.message);
      if (cancelResult.resetSession) {
        await resetSession(phone);
      }
      await saveMessage(phone, body, cancelResult.message);
      log.info(masked, step, '→ cancellation handled');
      return;
    }

    // REMARCAR keyword — checked before name gate, same pattern as CANCELAR
    if (detectRescheduleKeyword(body)) {
      const hasActiveSession = !!(state.service || state.serviceId || state.requestedDateTime || state.confirmedDateTime);
      if (hasActiveSession && !state.reschedulingAppointmentId) {
        await resetSession(phone);
        const reply = 'Tudo bem! Cancelei o agendamento em andamento. Quando quiser remarcar, é só me chamar! 😊';
        await sendText(phone, reply);
        await saveMessage(phone, body, reply);
        log.info(masked, step, '→ in-progress session cancelled (reschedule trigger)');
        return;
      }
      const result = await handleRescheduleKeyword(phone, state);
      await sendText(phone, result.message);
      if (result.resetSession) {
        await resetSession(phone);
      } else if (result.newState) {
        await saveAppointmentState(phone, result.newState);
      }
      await saveMessage(phone, body, result.message);
      log.info(masked, step, '→ reschedule handled');
      return;
    }

    // NAME COLLECTION GATE — happens before any AI call, no LLM involved.
    // Flow: first message → AI sends greeting → system sets nameAsked=true
    //       second message → system saves name and continues to scheduling flow
    const history = await getHistory(phone);
    if (!state.clientName) {
      if (!state.nameAsked) {
        // First contact: send fixed greeting and ask for name immediately
        const greeting = `Olá! Bem-vindo ao ${businessConfig.businessName}! Qual é o seu nome?`;
        const newState: AppointmentState = { ...state, nameAsked: true };
        await sendText(phone, greeting);
        await saveAppointmentState(phone, newState);
        await saveMessage(phone, body, greeting);
        log.info(masked, step, '→ greeting sent, waiting for name');
        return;
      } else {
        // Client replied after greeting — extract the name, stripping common prefixes
        let rawName = body.trim();
        const namePrefixRe = /^(?:meu\s+nome\s+[eé]\s+|me\s+chamo\s+|pode\s+(?:me\s+)?chamar\s+(?:de\s+)?|sou\s+[oa]?\s*|me\s+chama\s+(?:de\s+)?)/i;
        rawName = rawName.replace(namePrefixRe, '').trim();
        const clientName = rawName
          .split(/\s+/)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
        const newState: AppointmentState = { ...state, clientName };
        const nameReply = `Prazer, ${clientName}! 😊 Qual serviço você quer?\n\n${serviceMenu(services)}`;
        await sendText(phone, nameReply);
        await saveAppointmentState(phone, newState);
        await saveMessage(phone, body, nameReply);
        log.info(masked, step, `→ name collected by system: "${clientName}"`);
        return;
      }
    }

    // 4. Get available slots for the relevant day (today by default, or requested date)
    const today = new Date();
    // Derive duration from known service by ID lookup; default to 30 (shortest) so slot list is most permissive
    const svc = services.find(s => s.id === state.serviceId);
    const duration = svc?.duration_minutes ?? 30; // 30 = serviço mais curto, fallback seguro
    // Determine the target day: confirmedDateTime > resolvedDay (persisted) > requestedDateTime > body (current msg) > today
    let slotDay = today;
    let daySourceText: string | null = null;
    if (state.confirmedDateTime) {
      const d = new Date(state.confirmedDateTime);
      if (!isNaN(d.getTime())) slotDay = d;
    } else if (state.resolvedDay) {
      // Check if current message mentions a different day — if so, override the persisted day
      const newDayFromBody = parseRequestedDay(body, today);
      const [ry, rmo, rday] = state.resolvedDay.split('-').map(Number);
      const resolvedDate = new Date(ry, rmo - 1, rday);
      if (newDayFromBody && newDayFromBody.toDateString() !== resolvedDate.toDateString()) {
        // Client changed their mind — use the new day and clear the old resolvedDay
        slotDay = newDayFromBody;
        daySourceText = body;
        state = { ...state, resolvedDay: undefined, requestedDateTime: undefined };
      } else {
        // Use the already-resolved day persisted from a previous turn
        // Parse as local date (YYYY-MM-DD) to avoid UTC midnight shift
        if (!isNaN(resolvedDate.getTime())) { slotDay = resolvedDate; daySourceText = state.resolvedDay; }
      }
    } else if (state.requestedDateTime) {
      const d = parseRequestedDay(state.requestedDateTime, today);
      if (d) { slotDay = d; daySourceText = state.requestedDateTime; }
    } else {
      // Try to extract a day reference from the current message before calling AI
      const d = parseRequestedDay(body, today);
      if (d) { slotDay = d; daySourceText = body; }
    }

    if (!state.confirmedDateTime && !daySourceText && !state.resolvedDay) {
      log.warn(masked, step, `no day reference found in "${body.slice(0, 60)}" — defaulting to today`);
    }

    // Persist the resolved day so it survives across turns (e.g. "terça" then "9h pode ser")
    if (!state.confirmedDateTime && daySourceText && !state.resolvedDay) {
      const iso = `${slotDay.getFullYear()}-${String(slotDay.getMonth()+1).padStart(2,'0')}-${String(slotDay.getDate()).padStart(2,'0')}`;
      state = { ...state, resolvedDay: iso };
    }

    // Se o cliente não mencionou nenhum dia, não buscar slots — deixar a IA perguntar quando quer vir
    if (!daySourceText && !state.confirmedDateTime && !state.resolvedDay) {
      if ((state.service || state.serviceId) && mentionedService) {
        const next = await findNextAvailableDay(today, duration, state.reschedulingAppointmentId);
        if (!next) {
          const reply = `Boa escolha. No momento não encontrei horários disponíveis nos próximos dias.`;
          await sendText(phone, reply);
          await saveAppointmentState(phone, state);
          await saveMessage(phone, body, reply);
          log.info(masked, step, '→ service selected, no availability found');
          return;
        }

        const iso = `${next.day.getFullYear()}-${String(next.day.getMonth()+1).padStart(2,'0')}-${String(next.day.getDate()).padStart(2,'0')}`;
        const intro = await nextAvailabilityIntro(today, next.day);
        const reply = `Boa escolha. ${intro}:\n\n${await formatSlotGridList(next.day, next.slots, duration)}\n\nQual funciona melhor pra você?`;
        state = { ...state, resolvedDay: iso };
        await sendText(phone, reply);
        await saveAppointmentState(phone, state);
        await saveMessage(phone, body, reply);
        log.info(masked, step, `→ service selected, next availability offered for ${iso}`);
        return;
      }

      if (isAvailabilityQuestion(body) && !state.service && !state.serviceId) {
        const reply = `Claro. Qual serviço você quer?\n\n${serviceMenu(services)}`;
        await sendText(phone, reply);
        await saveMessage(phone, body, reply);
        log.info(masked, step, '→ availability question without service');
        return;
      }

      if (isAvailabilityQuestion(body) && (state.service || state.serviceId)) {
        const next = await findNextAvailableDay(today, duration, state.reschedulingAppointmentId);
        if (!next) {
          const reply = 'No momento não encontrei horários disponíveis nos próximos dias. Pode falar com o estúdio para encaixe?';
          await sendText(phone, reply);
          await saveMessage(phone, body, reply);
          log.info(masked, step, '→ no availability found');
          return;
        }

        const iso = `${next.day.getFullYear()}-${String(next.day.getMonth()+1).padStart(2,'0')}-${String(next.day.getDate()).padStart(2,'0')}`;
        const intro = await nextAvailabilityIntro(today, next.day);
        const reply = `${intro}:\n\n${await formatSlotGridList(next.day, next.slots, duration)}\n\nQual funciona melhor pra você?`;
        state = { ...state, resolvedDay: iso };
        await sendText(phone, reply);
        await saveAppointmentState(phone, state);
        await saveMessage(phone, body, reply);
        log.info(masked, step, `→ next availability offered for ${iso}`);
        return;
      }

      const aiResult = await getAIResponse(body, state, [], history, services);
      const newState = { ...state, ...aiResult.appointmentPatch };
      const reply = containsTimeMention(aiResult.reply)
        ? noSlotsFallbackReply(state, services)
        : aiResult.reply;
      await saveAppointmentState(phone, newState);
      await sendText(phone, reply);
      await saveMessage(phone, body, reply);
      log.info(masked, step, '→ reply sent');
      return;
    }

    // If the resolved day has no slots (closed/no availability), reject before calling AI
    // During rescheduling, exclude the old appointment so its slot is shown as available
    const allSlots = await getAvailableSlots(DEFAULT_CHAIR_ID, slotDay, duration, state.reschedulingAppointmentId);
    if (allSlots.length === 0 && daySourceText && !state.confirmedDateTime) {
      const reply = `Desculpe, não atendemos nesse dia. Pode escolher outro dia?`;
      await sendText(phone, reply);
      state = { ...state, requestedDateTime: undefined, resolvedDay: undefined };
      await saveAppointmentState(phone, state);
      await saveMessage(phone, body, reply);
      log.info(masked, step, '→ requested day closed');
      return;
    }

    const isToday = slotDay.toDateString() === today.toDateString();
    const slots = isToday ? allSlots.filter(s => s >= today) : allSlots;

    // Extract a requested time (HH:MM) from natural text.
    // Strips JSON blocks first to avoid capturing injected values.
    function extractRequestedTime(text: string): string | null {
      const clean = text.replace(/```[\s\S]*?```/g, '').trim();
      const m = clean.match(/\b(\d{1,2})[h:](\d{2})?\b/i);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2] ?? '0');
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }

    // If the client already mentioned a time and we don't have confirmedTime yet,
    // verify it against the slot list in code — don't leave this to the AI.
    // Build confirmedDateTime immediately so deriveStep moves to AGUARDANDO_NOME,
    // preventing the AI from second-guessing a slot that is clearly available.
    if (!state.confirmedTime && !state.confirmedDateTime) {
      const candidateTime = extractRequestedTime(body) ?? extractRequestedTime(state.requestedDateTime ?? '');
      if (candidateTime) {
        const matchingSlot = slots.find(s => {
          const slotBRT = s.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          return slotBRT === candidateTime;
        });
        if (matchingSlot) {
          const [hh, mm] = candidateTime.split(':').map(Number);
          const y = slotDay.getFullYear();
          const mo = slotDay.getMonth() + 1;
          const d = slotDay.getDate();
          const confirmedDateTime = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00-03:00`;
          state = { ...state, confirmedTime: candidateTime, confirmedDateTime };
          log.info(masked, deriveStep(state), `→ slot pre-confirmed by code: ${candidateTime} → ${confirmedDateTime}`);
        }
      }
    }

    // 5. Call AI with state + slots + services
    const aiResult = await getAIResponse(body, state, slots, history, services);

    // 6. Apply patch to state
    const newState = { ...state, ...aiResult.appointmentPatch };
    if (state.serviceId) {
      newState.serviceId = state.serviceId;
      newState.service = state.service;
    }

    // 7. Handle slot change: if client requests a different time after confirmedTime was already set,
    // allow the change (clear old confirmedDateTime so the new time can be applied).
    const aiSetNewTime = newState.confirmedTime && newState.confirmedTime !== state.confirmedTime;
    if (aiSetNewTime && state.confirmedDateTime) {
      newState.confirmedDateTime = undefined;
      log.info(masked, step, `→ slot change detected: ${state.confirmedTime} → ${newState.confirmedTime}`);
    }

    // Protect confirmedDateTime/confirmedTime from being cleared by AI when already set
    // (but only if no slot change was requested above)
    if (!aiSetNewTime) {
      if (state.confirmedDateTime && !newState.confirmedDateTime) {
        newState.confirmedDateTime = state.confirmedDateTime;
      }
      if (state.confirmedTime && !newState.confirmedTime) {
        newState.confirmedTime = state.confirmedTime;
      }
    }

    // Build confirmedDateTime when confirmedTime was just set (by code pre-confirm or by AI).
    if (newState.confirmedTime && !newState.confirmedDateTime) {
      const [hh, mm] = newState.confirmedTime.split(':').map(Number);
      // slotDay was built from local date strings (YYYY-MM-DD), so year/month/date are correct locally
      const y = slotDay.getFullYear();
      const mo = slotDay.getMonth() + 1;
      const d = slotDay.getDate();
      newState.confirmedDateTime = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00-03:00`;
    }

    // 8. If confirmedDateTime is newly set, validate the slot (but do not create yet — wait for name + final confirmation)
    if (newState.confirmedDateTime && !state.confirmedDateTime) {
      const dt = new Date(newState.confirmedDateTime);
      const apptDuration = services.find(s => s.id === newState.serviceId)?.duration_minutes ?? 30;
      // During rescheduling, exclude the old appointment so its slot validates as available
      const valid = await validateAppointmentTime(DEFAULT_CHAIR_ID, dt, apptDuration, newState.reschedulingAppointmentId);

      if (!valid) {
        // Use all slots for the day (already fetched) to suggest nearby times
        const slotsForDay = await getAvailableSlots(DEFAULT_CHAIR_ID, dt, apptDuration, newState.reschedulingAppointmentId);
        const nearby = slotsForDay
          .sort((a, b) => Math.abs(a.getTime() - dt.getTime()) - Math.abs(b.getTime() - dt.getTime()))
          .slice(0, 3)
          .map(s => `• ${s.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`)
          .join('\n');
        const suggestion = nearby ? `\nHorários disponíveis:\n${nearby}` : '';
        const reply = `❌ Esse horário não está disponível.${suggestion}\nQual você prefere?`;
        await sendText(phone, reply);
        newState.confirmedDateTime = undefined;
        newState.confirmedTime = undefined;
        await saveAppointmentState(phone, newState);
        await saveMessage(phone, body, reply);
        log.info(masked, step, '→ slot unavailable');
        return;
      }
      // Slot is valid — persist state and let the flow continue to collect name + confirmation
    }

    // Guard: never accept confirmed=true without a client name
    if (newState.confirmed && !newState.clientName) {
      newState.confirmed = false;
    }

    // 9. If client just confirmed (confirmed: true), create the appointment in the database
    if (newState.confirmed && !state.confirmed && newState.confirmedDateTime) {
      const dt = new Date(newState.confirmedDateTime);

      // Resolve serviceId: prefer newState.serviceId (set by AI via JSON), fallback to name lookup (legacy state)
      let resolvedServiceId = newState.serviceId;
      if (!resolvedServiceId && newState.service) {
        const serviceMatch = findMentionedService(newState.service, services);
        const serviceRow = serviceMatch ?? await getDb()('services').where({ name: newState.service, active: 1 }).first();
        resolvedServiceId = serviceRow?.id;
      }
      if (!resolvedServiceId) resolvedServiceId = services[0]?.id ?? 1; // fallback seguro

      const apptDuration = services.find(s => s.id === resolvedServiceId)?.duration_minutes ?? 30;

      try {
        let appt;
        if (state.reschedulingAppointmentId) {
          appt = await rescheduleAppointment(
            state.reschedulingAppointmentId,
            phone,
            DEFAULT_CHAIR_ID,
            resolvedServiceId,
            dt,
            apptDuration,
            newState.clientName
          );
        } else {
          appt = await createAppointment(DEFAULT_CHAIR_ID, phone, resolvedServiceId, dt, apptDuration, newState.clientName);
        }

        // Format confirmation details cleanly in pt-BR / BRT
        const dateStr = dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
        const timeStr = dt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        const serviceName = services.find(s => s.id === resolvedServiceId)?.name ?? newState.service ?? 'Serviço';
        const finalReply =
          `✅ Agendamento confirmado, ${newState.clientName ?? 'tudo certo'}!\n\n` +
          `📋 Serviço: ${serviceName}\n` +
          `📅 Data: ${dateStr}\n` +
          `🕒 Horário: ${timeStr}\n\n` +
          `Você recebe lembrete 24h antes. Cancelamentos só com 6h de antecedência.`;

        await sendText(phone, finalReply);
        await saveMessage(phone, body, finalReply);
        // Keep client name after confirmation so bot remembers who they are
        // reschedulingAppointmentId is intentionally omitted from the reset state (flow complete)
        await saveAppointmentState(phone, { clientName: newState.clientName, nameAsked: true, confirmed: false });
        // D-09: appointment confirmed log with masked phone, service name, and confirmed datetime
        log.info(masked, deriveStep(newState), `→ appointment confirmed id=${appt.id} service="${serviceName}" ${dateStr} às ${timeStr}`);
        return;
      } catch (err) {
        log.error(masked, deriveStep(newState), 'Failed to create appointment', err);
        const reply = 'Desculpe, erro ao salvar agendamento. Tente novamente.';
        await sendText(phone, reply);
        newState.confirmed = false;
        await saveAppointmentState(phone, newState);
        await saveMessage(phone, body, reply);
        return;
      }
    }

    if (newState.confirmedDateTime && !newState.confirmed) {
      const reply = formatPendingConfirmationReply(newState, services);
      await sendText(phone, reply);
      await saveAppointmentState(phone, newState);
      await saveMessage(phone, body, reply);
      log.info(masked, deriveStep(newState), '→ deterministic confirmation reply sent');
      return;
    }

    // 8. Send AI reply + save state (no appointment yet)
    let reply = slots.length === 0 && containsTimeMention(aiResult.reply)
      ? noSlotsFallbackReply(newState, services)
      : aiResult.reply;
    reply = await ensureDateForSlotReply(reply, slotDay, slots, duration);
    await sendText(phone, reply);
    await saveAppointmentState(phone, newState);
    await saveMessage(phone, body, reply);
    log.info(masked, step, '→ reply sent');
  } catch (err) {
    log.error(maskPhone(phone), 'ENTRY', 'Error processing message', err);
    try {
      await sendText(phone, 'Desculpe, tive um probleminha. Pode tentar de novo?');
    } catch {
      // Silently fail on fallback send error
    }
  }
}

/**
 * Handle cancellation keyword.
 * Find the most recent confirmed appointment for the phone,
 * decide if cancellation is allowed or must be escalated.
 */
async function handleCancelKeyword(phone: string): Promise<{
  message: string;
  resetSession: boolean;
}> {
  const db = getDb();

  // Find the most recent confirmed appointment for this phone
  const appointment = await db('appointments')
    .where('client_phone', phone)
    .andWhere('status', 'confirmed')
    .orderBy('starts_at', 'desc')
    .first();

  if (!appointment) {
    return {
      message: 'Você não tem nenhum agendamento confirmado para cancelar.',
      resetSession: false,
    };
  }

  // Decide if cancellation is allowed
  const decision = await decideCancellation(appointment.id, phone);

  if (decision.allowed) {
    // Cancel immediately (> 6 hours) — pass phone as second arg (D-10)
    await cancelAppointment(appointment.id, phone);
    return {
      message: decision.clientMessage,
      resetSession: true,
    };
  } else {
    // Escalate to owner (<= 6 hours)
    await escalateCancellation(appointment.id, phone);

    // Notify owner asynchronously (fire-and-forget)
    if (env.OWNER_PHONE) {
      notifyOwner(
        `🔔 Pedido de cancelamento < 6h:\n` +
        `Cliente: ${phone}\n` +
        `Agendamento: ${format(parseISO(appointment.starts_at), 'dd/MM HH:mm', { locale: ptBR })}\n` +
        `Motivo: Dentro da janela de 6 horas`
      ).catch((err) => {
        log.error(maskPhone(phone), 'CANCEL', 'Failed to notify owner', err);
      });
    }

    return {
      message: decision.clientMessage,
      resetSession: true,
    };
  }
}

/**
 * Handle the REMARCAR keyword. Finds the client's most recent confirmed
 * appointment, reuses decideCancellation for the 6h rule, and either opens
 * the reschedule flow (> 6h) or escalates to the owner (<= 6h).
 */
async function handleRescheduleKeyword(
  phone: string,
  state: AppointmentState
): Promise<{ message: string; resetSession: boolean; newState?: AppointmentState }> {
  const db = getDb();

  const appointment = await db('appointments')
    .where('client_phone', phone)
    .andWhere('status', 'confirmed')
    .orderBy('starts_at', 'desc')
    .first();

  if (!appointment) {
    return {
      message: 'Você não tem nenhum agendamento confirmado para remarcar.',
      resetSession: false,
    };
  }

  const decision = await decideCancellation(appointment.id, phone); // reuse da regra de 6h

  if (decision.allowed) {
    // > 6h: open the reschedule flow
    const dt = parseISO(appointment.starts_at);
    const dateStr = dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' });
    const timeStr = dt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const message = `Seu agendamento atual: ${dateStr} às ${timeStr}.\n\nPara qual nova data e horário você quer remarcar?`;
    const newState: AppointmentState = {
      clientName: state.clientName,
      nameAsked: true,
      serviceId: appointment.service_id,
      reschedulingAppointmentId: appointment.id,
      confirmed: false,
      // day/time fields intentionally cleared so client chooses a new slot
    };
    return { message, resetSession: false, newState };
  } else {
    // <= 6h: escalate to owner (same logic as cancellation — D-11)
    if (appointment.escalation_status !== 'pending') {
      await escalateCancellation(appointment.id, phone);
      if (env.OWNER_PHONE) {
        notifyOwner(
          `🔔 Pedido de remarcação < 6h:\n` +
          `Cliente: ${phone}\n` +
          `Agendamento: ${format(parseISO(appointment.starts_at), 'dd/MM HH:mm', { locale: ptBR })}`
        ).catch((err) => {
          log.error(maskPhone(phone), 'RESCHEDULING', 'Failed to notify owner for reschedule', err);
        });
      }
    }
    return {
      message: decision.clientMessage, // reuses the 6h deadline message
      resetSession: true,
    };
  }
}
