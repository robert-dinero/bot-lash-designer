import { getDb } from '../db';
import { log, maskPhone } from '../utils/logger';
import { parseISO, differenceInHours, subHours, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { CancellationDecision, Appointment } from '../types';

const CANCELLATION_DEADLINE_HOURS = 6;

/**
 * Decide whether cancellation is allowed or must be escalated.
 *
 * Returns:
 * - allowed=true if > 6 hours before appointment (immediate cancellation)
 * - allowed=false if <= 6 hours (escalation to owner)
 */
export async function decideCancellation(
  appointmentId: number,
  clientPhone: string
): Promise<CancellationDecision> {
  const db = getDb();

  const appointment = await db('appointments')
    .where('id', appointmentId)
    .andWhere('client_phone', clientPhone)
    .first() as Appointment | undefined;

  if (!appointment) {
    return {
      allowed: false,
      hoursUntilAppointment: 0,
      clientMessage: 'Agendamento não encontrado.',
      shouldNotifyOwner: false,
    };
  }

  if (appointment.status !== 'confirmed') {
    return {
      allowed: false,
      hoursUntilAppointment: 0,
      clientMessage: `Este agendamento já foi ${appointment.status}.`,
      shouldNotifyOwner: false,
    };
  }

  const now = new Date();
  const appointmentTime = parseISO(appointment.starts_at);
  const hoursUntilAppointment = differenceInHours(appointmentTime, now);

  if (hoursUntilAppointment > CANCELLATION_DEADLINE_HOURS) {
    return {
      allowed: true,
      hoursUntilAppointment,
      clientMessage: `✅ Seu agendamento para ${formatAppointmentTime(appointment.starts_at)} foi cancelado. Se precisar de outra data, é só chamar!`,
      shouldNotifyOwner: false,
    };
  } else {
    const deadlineTime = subHours(appointmentTime, CANCELLATION_DEADLINE_HOURS);
    // appointmentTime is stored as UTC ISO string — derive deadline hour in UTC
    const deadlineHour = deadlineTime.getUTCHours();

    return {
      allowed: false,
      hoursUntilAppointment,
      deadlineHour,
      clientMessage: `O prazo para cancelar este agendamento era até as ${deadlineHour.toString().padStart(2, '0')}h. Enviaremos sua solicitação para a designer e ela decidirá. 😊`,
      shouldNotifyOwner: true,
      escalationReason: 'within 6-hour window',
    };
  }
}

/**
 * Cancel an appointment immediately.
 * Uses SQLite IMMEDIATE transaction for race-condition safety.
 * Idempotent: calling multiple times with same ID is safe.
 */
export async function cancelAppointment(appointmentId: number, phone?: string): Promise<void> {
  const db = getDb();

  await db.transaction(async (trx) => {
    const appt = await trx('appointments')
      .where('id', appointmentId)
      .first();

    if (!appt) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }

    if (appt.status === 'cancelled') {
      return; // Idempotent: already cancelled
    }

    await trx('appointments')
      .where('id', appointmentId)
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        escalation_status: null,
      });

    const masked = phone ? maskPhone(phone) : '****';
    log.info(masked, 'CANCEL', `appointment id=${appointmentId} cancelled`);
  }, {
    isolationLevel: 'serializable',
  });
}

/**
 * Escalate a cancellation to the owner for decision.
 * Sets escalation_status='pending' and keeps status='confirmed' until owner decides.
 * Uses SQLite IMMEDIATE transaction for race-condition safety.
 */
export async function escalateCancellation(
  appointmentId: number,
  clientPhone: string
): Promise<void> {
  const db = getDb();

  await db.transaction(async (trx) => {
    const appt = await trx('appointments')
      .where('id', appointmentId)
      .andWhere('client_phone', clientPhone)
      .first();

    if (!appt || appt.status !== 'confirmed') {
      return; // Idempotent: can't escalate non-confirmed
    }

    await trx('appointments')
      .where('id', appointmentId)
      .update({
        escalation_status: 'pending',
        cancelled_at: new Date().toISOString(),
      });

    log.info(maskPhone(clientPhone), 'CANCEL', `appointment id=${appointmentId} escalated — pending owner decision`);
  }, {
    isolationLevel: 'serializable',
  });
}

/**
 * Format a cancellation decision into a user-facing message.
 */
export function formatCancellationMessage(
  decision: CancellationDecision,
  appointment: Appointment
): string {
  if (decision.allowed) {
    return `✅ Seu agendamento para ${formatAppointmentTime(appointment.starts_at)} foi cancelado. Se precisar de outra data, é só chamar!`;
  } else {
    const deadlineHour = decision.deadlineHour?.toString().padStart(2, '0') ?? '??';
    return `O prazo para cancelar este agendamento era até as ${deadlineHour}h. Enviaremos sua solicitação para a designer e ela decidirá. 😊`;
  }
}

/**
 * Format an ISO datetime string as readable PT-BR text.
 * Example: "2026-05-12T14:30:00Z" → "12 de maio, 14h30"
 */
function formatAppointmentTime(isoTime: string): string {
  return format(parseISO(isoTime), "d 'de' MMMM', 'HH'h'mm", { locale: ptBR });
}
