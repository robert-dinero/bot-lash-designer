import OpenAI from 'openai';
import { env } from '../config/env';
import { businessConfig } from '../config/business';
import type { AppointmentState, Message } from '../types';
import { deriveStep } from './appointment.service';
import { log } from '../utils/logger';

export interface ServiceRecord {
  id: number;
  name: string;
  duration_minutes: number;
}

function getBrtYmd(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function brtTomorrowLabel(currentDateTime: Date): string {
  const { year, month, day } = getBrtYmd(currentDateTime);
  const tomorrowAtNoonBrt = new Date(Date.UTC(year, month - 1, day + 1, 15, 0, 0));
  return tomorrowAtNoonBrt.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
  });
}

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 15_000,
  maxRetries: 2,
});

// ─── Scheduling prompt builder ────────────────────────────────────────────────

/**
 * Build system prompt for appointment scheduling.
 * Injects available slots and current step to guide GPT.
 */
export function buildSchedulingPrompt(
  state: AppointmentState,
  availableSlots: Date[],
  currentDateTime: Date,
  services: ServiceRecord[] = []
): string {
  const step = deriveStep(state);

  // Format available slots — times only; backend owns the date
  // Always use America/Sao_Paulo when formatting times so UTC server times display correctly
  const slotDate = availableSlots.length
    ? availableSlots[0].toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
    : null;
  const slotsText = availableSlots.length
    ? availableSlots
        .map(slot => `• ${slot.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`)
        .join('\n')
    : 'nenhum horário disponível';

  // Get services list from database — dynamic, injected by caller
  const servicesList = services.length
    ? services.map(s => `${s.id}=${s.name}`).join(', ')
    : 'nenhum serviço cadastrado';

  const servicesMenu = services.length
    ? services.map(s => s.name).join('\n')
    : 'Nenhum serviço disponível no momento';
  const stepInstructions: Record<string, string> = {
    AGUARDANDO_SERVICO:
      `Se o cliente já mencionou um serviço da lista SERVIÇOS DISPONÍVEIS, registre (emita serviceId no JSON) e pergunte a data. Se não mencionou, cumprimente e apresente as opções em lista:\n\n${servicesMenu}\n\nSó me dizer qual prefere e quando quer vir! — adapte o tom se necessário mas sempre apresente as opções disponíveis em lista.`,
    AGUARDANDO_DATA_HORA: `Confirme o serviço escolhido e pergunte data e hora. Horários disponíveis:\n${slotsText}`,
    AGUARDANDO_CONFIRMACAO_HORARIO: `O cliente ainda não escolheu um horário. Mostre os horários disponíveis abaixo e peça que escolha um:\n${slotsText}\nQuando o cliente escolher um horário da lista, emita "confirmedTime" no JSON.`,
    AGUARDANDO_CONFIRMACAO: `Confirme o agendamento com: nome do cliente (${state.clientName}), serviço, data e hora. Peça confirmação final com "sim" ou "não". Só emita "confirmed: true" se o cliente responder explicitamente "sim" ou equivalente.`,
    CONFIRMADO: `Diga apenas: "✅ Perfeito, [nome]! Agendamento confirmado, te esperamos!" — use o nome do cliente. Não mencione lembrete nem política de cancelamento (o sistema adiciona isso automaticamente). Não adicione mais nada.`,
  };

  return `Você é atendente virtual de agendamentos do ${businessConfig.businessName}. Responda em português brasileiro informal, máximo 3 frases.

SERVIÇOS DISPONÍVEIS:
${servicesList}

REGRAS ABSOLUTAS:
1. Nunca invente serviços fora da lista acima
2. Registre o serviço que o cliente mencionar (pode falar naturalmente, não precisa do menu)
3. O sistema já valida disponibilidade de horários — NUNCA questione um horário já confirmado (campo "Horário confirmado" no estado atual)
4. Na etapa AGUARDANDO_CONFIRMACAO_HORARIO: se o cliente pediu hora não disponível, ofereça os horários acima
5. SIGA A ETAPA ATUAL — não pule etapas
6. Responda com amabilidade e brevidade
7. SEMPRE que exibir horários disponíveis, use lista com um horário por linha (ex: "• 14:30\n• 15:00"). NUNCA liste horários separados por vírgula ou em linha
8. NUNCA emita "confirmed: true" sem que o cliente tenha dito "sim" explicitamente na etapa AGUARDANDO_CONFIRMACAO
9. NUNCA use horários mencionados no histórico da conversa como disponibilidade atual. Use SOMENTE o campo HORÁRIOS DISPONÍVEIS abaixo
10. Se HORÁRIOS DISPONÍVEIS for "nenhum horário disponível", NÃO mostre lista de horários
11. NUNCA mencione duração dos serviços para o cliente. Duração é dado interno do sistema

DATA/HORA ATUAL: ${currentDateTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })} (fuso: America/Sao_Paulo, UTC-3)
AMANHÃ: ${brtTomorrowLabel(currentDateTime)}
DIA DOS HORÁRIOS DISPONÍVEIS: ${slotDate ?? 'não definido'}
HORÁRIOS DISPONÍVEIS: ${slotsText}
REGRA DE DATAS: NUNCA calcule datas por conta própria. Use SEMPRE os valores acima para referencias como "amanhã", "hoje", etc.

ESTADO ATUAL:
- Serviço: ${state.service || 'não informado'}
- Nome do cliente: ${state.clientName || 'não informado'}
- Horário solicitado: ${state.requestedDateTime || 'não informado'}
- Horário confirmado: ${state.confirmedDateTime || 'não confirmado'}
- Confirmação final: ${state.confirmed ? 'sim' : 'não'}

ETAPA ATUAL: ${step}
SUA TAREFA AGORA: ${stepInstructions[step] ?? 'Guie o cliente para agendar.'}

Ao atualizar o agendamento, inclua NO FINAL da resposta um bloco JSON com os campos que mudaram:
\`\`\`json
{
  "serviceId": 1,
  "service": "Volume Russo",
  "clientName": "Maria",
  "requestedDateTime": "próxima sexta às 10h",
  "confirmedTime": "10:00",
  "confirmed": false
}
\`\`\`
REGRAS DO JSON:
- Omita campos que NÃO mudaram
- "serviceId": ID inteiro do serviço escolhido — use o número antes do "=" na lista SERVIÇOS DISPONÍVEIS (ex: 1 para Volume Russo). PREFERIDO ao campo "service"
- "service": nome do serviço — mantido para compatibilidade, mas prefira "serviceId"
- "clientName": nome do cliente quando informado
- "requestedDateTime": o que o cliente pediu (pode ser vago: "amanhã", "próxima segunda")
- "confirmedTime": APENAS o horário no formato HH:MM escolhido pelo cliente (ex: "10:00", "14:30"). NÃO inclua data — o sistema cuida disso
- "confirmed": true SOMENTE quando cliente disser "sim" na etapa AGUARDANDO_CONFIRMACAO
- Se nada mudou, omita o bloco
- O bloco JSON é INTERNO — NUNCA mencione "JSON" ou "registro" para o cliente
- A mensagem visível ao cliente TERMINA antes do bloco JSON`;
}

// ─── Appointment extraction ───────────────────────────────────────────────────

interface AppointmentUpdate {
  service?: string;
  serviceId?: number;
  clientName?: string;
  requestedDateTime?: string;
  confirmedTime?: string;   // HH:MM — backend combines with slotDay
  confirmed?: boolean;
}

/**
 * Extract appointment state from GPT response markdown JSON block.
 * Handles missing fields (omitted = not changed).
 * Validates confirmedDateTime format.
 */
export function extractAppointmentUpdate(
  text: string,
  context?: { masked: string; step: string }
): { clean: string; patch: Partial<AppointmentState> | null } {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return { clean: text, patch: null };

  const clean = text.replace(/```json[\s\S]*?```/g, '').trim();

  try {
    const update = JSON.parse(match[1]) as AppointmentUpdate;
    const patch: Partial<AppointmentState> = {};

    if (update.service !== undefined) {
      patch.service = update.service;
    }

    if (update.serviceId !== undefined) {
      if (Number.isInteger(update.serviceId)) {
        patch.serviceId = update.serviceId;
      } else {
        log.warn(context?.masked ?? '', context?.step ?? 'PARSE', `Invalid serviceId: ${update.serviceId}`);
      }
    }

    if (update.clientName !== undefined) {
      patch.clientName = update.clientName;
    }

    if (update.requestedDateTime !== undefined) {
      patch.requestedDateTime = update.requestedDateTime;
    }

    if (update.confirmedTime !== undefined) {
      if (update.confirmedTime && /^\d{1,2}:\d{2}$/.test(update.confirmedTime)) {
        patch.confirmedTime = update.confirmedTime;
      } else if (!update.confirmedTime) {
        patch.confirmedTime = undefined;
      } else {
        log.warn(context?.masked ?? '', context?.step ?? 'PARSE', `Invalid confirmedTime format: ${update.confirmedTime}`);
      }
    }

    if (update.confirmed !== undefined) {
      patch.confirmed = update.confirmed;
    }

    return { clean, patch };
  } catch (err) {
    const snippet = match[1].length > 200 ? match[1].slice(0, 200) + '...' : match[1];
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(
      context?.masked ?? '',
      context?.step ?? 'PARSE',
      `JSON parse falhou: ${errMsg} — trecho: ${snippet}`
    );
    return { clean, patch: null };
  }
}

// ─── Main AI call ─────────────────────────────────────────────────────────────

function classifyOpenAIError(err: unknown, durationMs: number): string {
  if (durationMs >= 15_000) return 'timeout';
  if (err instanceof Error) {
    const e = err as { status?: number; code?: string };
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return 'timeout';
    if (e.status) return String(e.status);
  }
  return 'unknown';
}

export interface AIResult {
  reply: string;
  appointmentPatch: Partial<AppointmentState> | null;
}

/**
 * Get AI response for appointment scheduling.
 * Builds scheduling prompt, calls GPT, extracts appointment state.
 */
export async function getAIResponse(
  userMessage: string,
  state: AppointmentState,
  availableSlots: Date[],
  history: Message[],
  services: ServiceRecord[] = []
): Promise<AIResult> {
  const systemPrompt = buildSchedulingPrompt(state, availableSlots, new Date(), services);
  const masked = '-'; // phone not available in AI service scope; webhook controller logs with masked phone
  const step = deriveStep(state);

  // State is the only reliable memory for scheduling decisions. Old chat history
  // may contain stale services/slots and must not steer current availability.
  void history;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const t0 = Date.now();
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    const durationMs = Date.now() - t0;
    const raw = response.choices[0]?.message?.content ?? '';

    log.info(masked, step, `IA respondeu em ${durationMs}ms (${response.usage?.total_tokens ?? '?'} tokens)`);
    // D-04/D-07: raw output only at debug level — LOG_LEVEL=debug off by default in production
    log.debug(masked, step, `raw: ${raw.length > 500 ? raw.slice(0, 500) + '...' : raw}`);

    const { clean, patch } = extractAppointmentUpdate(raw, { masked, step });
    return { reply: clean, appointmentPatch: patch };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errLabel = classifyOpenAIError(err, durationMs);
    log.error(masked, step, `OpenAI ${errLabel} após ${durationMs}ms (tentativa 1/1)`, err);
    return {
      reply: 'Desculpe, tive um probleminha aqui. Pode repetir? 😅',
      appointmentPatch: null,
    };
  }
}

// ─── Cancellation keyword detection ───────────────────────────────────────────

export function detectCancelKeyword(body: string): boolean {
  return /cancelar/i.test(body.trim());
}

export function detectRescheduleKeyword(body: string): boolean {
  return /\b(remarcar|remarca[rç]|re-marcar)\b/i.test(body.trim());
}
