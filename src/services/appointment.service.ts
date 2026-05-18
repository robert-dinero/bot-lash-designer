import { getDb } from '../db';
import type { Appointment, AppointmentState, WorkingHours } from '../types';
import { log, maskPhone } from '../utils/logger';

// ─── Availability queries ────────────────────────────────────────────────────

/**
 * Get available 30-minute slots for a chair on a specific date.
 * Respects working_hours, existing appointments, and availability_blocks.
 * Returns the next 5-8 slots for the day.
 */
export async function getAvailableSlots(
  chairId: number,
  date: Date,
  durationMinutes: number = 30,
  excludeAppointmentId?: number
): Promise<Date[]> {
  const db = getDb();

  // Verify chair exists
  const chair = await db('chairs').where({ id: chairId }).first();
  if (!chair) {
    throw new Error(`Chair not found: ${chairId}`);
  }

  // Get working hours for the day of week
  const dayOfWeek = date.getDay();
  const workingHours = await db('working_hours')
    .where({ chair_id: chairId, day_of_week: dayOfWeek })
    .first() as WorkingHours | undefined;

  if (!workingHours || workingHours.is_closed) {
    return [];
  }

  // Parse open/close times
  // Build UTC Date objects for open/close by treating the working_hours strings
  // as America/Sao_Paulo (UTC-3) times, then converting to UTC for comparison.
  const [openHour, openMin] = workingHours.open_time.split(':').map(Number);
  const [closeHour, closeMin] = workingHours.close_time.split(':').map(Number);

  const BRT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3
  const y = date.getFullYear(), mo = date.getMonth(), d = date.getDate();
  // Construct as UTC midnight of the local date, then add BRT hour offset
  const dayUtcMidnight = Date.UTC(y, mo, d);

  const openTime  = new Date(dayUtcMidnight + (openHour  * 60 + openMin)  * 60000 + BRT_OFFSET_MS);
  const closeTime = new Date(dayUtcMidnight + (closeHour * 60 + closeMin) * 60000 + BRT_OFFSET_MS);

  // Fetch existing appointments and availability blocks for this date
  // Use local date to avoid UTC day boundary mismatch
  const localDateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const nextDay = new Date(date); nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth()+1).padStart(2,'0')}-${String(nextDay.getDate()).padStart(2,'0')}`;
  const dateStr = localDateStr;

  const appointmentsQuery = db('appointments')
    .where({ chair_id: chairId })
    .whereNot({ status: 'cancelled' })
    .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`]);
  if (excludeAppointmentId !== undefined) {
    appointmentsQuery.andWhereNot({ id: excludeAppointmentId });
  }
  const appointments = await appointmentsQuery.select('starts_at', 'duration_minutes');

  const blocks = await db('availability_blocks')
    .where({ chair_id: chairId })
    .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`])
    .select('starts_at', 'ends_at');

  // Build break window from working_hours if configured (same BRT→UTC conversion)
  let breakStart: Date | null = null;
  let breakEnd: Date | null = null;
  if (workingHours.break_start && workingHours.break_end) {
    const [bsh, bsm] = workingHours.break_start.split(':').map(Number);
    const [beh, bem] = workingHours.break_end.split(':').map(Number);
    breakStart = new Date(dayUtcMidnight + (bsh * 60 + bsm) * 60000 + BRT_OFFSET_MS);
    breakEnd   = new Date(dayUtcMidnight + (beh * 60 + bem) * 60000 + BRT_OFFSET_MS);
  }

  // Generate slots between open and close times
  const slots: Date[] = [];
  let current = new Date(openTime);

  while (current < closeTime) {
    const slotEnd = new Date(current.getTime() + durationMinutes * 60000);

    // Skip slots that overlap the lunch break
    if (breakStart && breakEnd && current < breakEnd && slotEnd > breakStart) {
      current = new Date(current.getTime() + 30 * 60000);
      continue;
    }

    // Check for conflicts with appointments
    let conflicted = false;
    for (const appt of appointments) {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(apptStart.getTime() + appt.duration_minutes * 60000);
      if (current < apptEnd && slotEnd > apptStart) {
        conflicted = true;
        break;
      }
    }

    // Check for conflicts with availability blocks
    if (!conflicted) {
      for (const block of blocks) {
        const blockStart = new Date(block.starts_at);
        const blockEnd = new Date(block.ends_at);
        if (current < blockEnd && slotEnd > blockStart) {
          conflicted = true;
          break;
        }
      }
    }

    if (!conflicted) {
      slots.push(new Date(current));
    }

    current = new Date(current.getTime() + 30 * 60000);
  }

  return slots;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that a proposed appointment time is available.
 * Checks working hours, existing appointments, and availability blocks.
 * Uses transaction (IMMEDIATE) to prevent race conditions.
 */
export async function validateAppointmentTime(
  chairId: number,
  startDateTime: Date,
  durationMinutes: number,
  excludeAppointmentId?: number
): Promise<boolean> {
  const db = getDb();

  try {
    // Reject dates strictly in the past — compare ISO date strings in BRT (UTC-3)
    const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
    const todayBRT = new Date(Date.now() - BRT_OFFSET_MS).toISOString().slice(0, 10);
    const slotBRT  = new Date(startDateTime.getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
    if (slotBRT < todayBRT) {
      return false;
    }

    // Use IMMEDIATE transaction to lock the appointments table
    // and prevent concurrent double-booking
    const result = await db.transaction(async (trx) => {
      // Get working hours for the day of week
      const dayOfWeek = startDateTime.getDay();
      const workingHours = await trx('working_hours')
        .where({ chair_id: chairId, day_of_week: dayOfWeek })
        .first() as WorkingHours | undefined;

      if (!workingHours || workingHours.is_closed) {
        return false; // Chair closed that day
      }

      // Check if time is within working hours (BRT = UTC-3)
      const [openHour, openMin] = workingHours.open_time.split(':').map(Number);
      const [closeHour, closeMin] = workingHours.close_time.split(':').map(Number);

      const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
      const sy = startDateTime.getUTCFullYear(), smo = startDateTime.getUTCMonth(), sd = startDateTime.getUTCDate();
      // Reconstruct local BRT date midnight in UTC
      const dayUtcMidnight = Date.UTC(sy, smo, sd);

      const openTime  = new Date(dayUtcMidnight + (openHour  * 60 + openMin)  * 60000 + BRT_OFFSET_MS);
      const closeTime = new Date(dayUtcMidnight + (closeHour * 60 + closeMin) * 60000 + BRT_OFFSET_MS);

      const endDateTime = new Date(startDateTime.getTime() + durationMinutes * 60000);

      if (startDateTime < openTime || endDateTime > closeTime) {
        return false; // Outside working hours
      }

      // Check lunch break
      if (workingHours.break_start && workingHours.break_end) {
        const [bsh, bsm] = workingHours.break_start.split(':').map(Number);
        const [beh, bem] = workingHours.break_end.split(':').map(Number);
        const bStart = new Date(dayUtcMidnight + (bsh * 60 + bsm) * 60000 + BRT_OFFSET_MS);
        const bEnd   = new Date(dayUtcMidnight + (beh * 60 + bem) * 60000 + BRT_OFFSET_MS);
        if (startDateTime < bEnd && endDateTime > bStart) {
          return false; // Overlaps lunch break
        }
      }

      // Check for appointment conflicts — use local date to avoid UTC day boundary mismatch
      const dateStr = `${startDateTime.getFullYear()}-${String(startDateTime.getMonth()+1).padStart(2,'0')}-${String(startDateTime.getDate()).padStart(2,'0')}`;
      const nd = new Date(startDateTime); nd.setDate(nd.getDate() + 1);
      const nextDayStr = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}`;

      const appointmentsQuery = trx('appointments')
        .where({ chair_id: chairId })
        .whereNot({ status: 'cancelled' })
        .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`]);
      if (excludeAppointmentId !== undefined) {
        appointmentsQuery.andWhereNot({ id: excludeAppointmentId });
      }
      const appointments = await appointmentsQuery.select('starts_at', 'duration_minutes');

      for (const appt of appointments) {
        const apptStart = new Date(appt.starts_at);
        const apptEnd = new Date(apptStart.getTime() + appt.duration_minutes * 60000);

        if (startDateTime < apptEnd && endDateTime > apptStart) {
          return false; // Overlaps with existing appointment
        }
      }

      // Check for availability block conflicts
      const blocks = await trx('availability_blocks')
        .where({ chair_id: chairId })
        .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`])
        .select('starts_at', 'ends_at');

      for (const block of blocks) {
        const blockStart = new Date(block.starts_at);
        const blockEnd = new Date(block.ends_at);

        if (startDateTime < blockEnd && endDateTime > blockStart) {
          return false; // Overlaps with availability block
        }
      }

      return true; // All checks passed
    }, { isolationLevel: 'read uncommitted' }); // Use IMMEDIATE in actual SQLite

    return result;
  } catch (err) {
    log.error('-', 'SCHEDULER', `Validation error for chair ${chairId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Appointment creation ─────────────────────────────────────────────────────

/**
 * Create a new appointment after validating availability.
 * Performs validation again inside transaction before INSERT (re-validation guard).
 * Returns the created Appointment record.
 */
export async function createAppointment(
  chairId: number,
  clientPhone: string,
  serviceId: number,
  startsAt: Date,
  durationMinutes: number,
  clientName?: string,
  excludeAppointmentId?: number
): Promise<Appointment> {
  const db = getDb();

  // Pre-check validation before transaction
  const isValid = await validateAppointmentTime(chairId, startsAt, durationMinutes);
  if (!isValid) {
    throw new Error('Time slot not available');
  }

  // Create appointment in transaction with re-validation
  const appointment = await db.transaction(async (trx) => {
    // Re-validate before INSERT (catch concurrent modifications)
    const dayOfWeek = startsAt.getDay();
    const workingHours = await trx('working_hours')
      .where({ chair_id: chairId, day_of_week: dayOfWeek })
      .first() as WorkingHours | undefined;

    if (!workingHours || workingHours.is_closed) {
      throw new Error('Time slot not available');
    }

    const [openHour, openMin] = workingHours.open_time.split(':').map(Number);
    const [closeHour, closeMin] = workingHours.close_time.split(':').map(Number);

    const BRT_OFFSET_MS_C = 3 * 60 * 60 * 1000;
    const cy = startsAt.getUTCFullYear(), cmo = startsAt.getUTCMonth(), cd = startsAt.getUTCDate();
    const cDayUtcMidnight = Date.UTC(cy, cmo, cd);

    const openTime  = new Date(cDayUtcMidnight + (openHour  * 60 + openMin)  * 60000 + BRT_OFFSET_MS_C);
    const closeTime = new Date(cDayUtcMidnight + (closeHour * 60 + closeMin) * 60000 + BRT_OFFSET_MS_C);

    const endDateTime = new Date(startsAt.getTime() + durationMinutes * 60000);

    if (startsAt < openTime || endDateTime > closeTime) {
      throw new Error('Time slot not available');
    }

    // Re-check appointments for race condition catch
    const dateStr = startsAt.toISOString().split('T')[0];
    const nextDayStr = new Date(startsAt.getTime() + 86400000).toISOString().split('T')[0];

    let appointmentsQuery = trx('appointments')
      .where({ chair_id: chairId })
      .whereNot({ status: 'cancelled' })
      .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`]);

    if (excludeAppointmentId !== undefined) {
      appointmentsQuery = appointmentsQuery.whereNot('id', excludeAppointmentId);
    }

    const appointments = await appointmentsQuery.select('starts_at', 'duration_minutes');

    for (const appt of appointments) {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(apptStart.getTime() + appt.duration_minutes * 60000);

      if (startsAt < apptEnd && endDateTime > apptStart) {
        throw new Error('Time slot not available');
      }
    }

    const now = new Date().toISOString();
    const startsAtStr = startsAt.toISOString();

    // Insert appointment
    const [id] = await trx('appointments').insert({
      chair_id: chairId,
      client_phone: clientPhone,
      client_name: clientName ?? null,
      service_id: serviceId,
      starts_at: startsAtStr,
      duration_minutes: durationMinutes,
      status: 'confirmed',
      notes: null,
      created_at: now,
      updated_at: now,
    });

    // Retrieve the created record
    return trx('appointments').where({ id }).first() as Promise<Appointment>;
  });

  log.info(maskPhone(clientPhone), 'SCHEDULER', `Appointment created: service_id=${serviceId} at ${startsAt.toISOString()}`);
  return appointment;
}

// ─── State machine ───────────────────────────────────────────────────────────

/**
 * Derive the current step of the appointment state machine.
 * Used to guide GPT on what to ask next.
 */
export function deriveStep(state: AppointmentState): string {
  if (state.confirmed === true) return 'CONFIRMADO';
  if (state.confirmedDateTime) return 'AGUARDANDO_CONFIRMACAO';
  if (state.requestedDateTime || state.resolvedDay) return 'AGUARDANDO_CONFIRMACAO_HORARIO';
  if (state.service) return 'AGUARDANDO_DATA_HORA';
  return 'AGUARDANDO_SERVICO';
}

// ─── Rescheduling ─────────────────────────────────────────────────────────────

/**
 * Reschedule an appointment: mark the old one as 'rescheduled' and create a new
 * 'confirmed' appointment, atomically. Preserves history for future reports.
 *
 * The caller is responsible for validating the new slot's availability (via
 * validateAppointmentTime with excludeAppointmentId) before calling this function.
 */
export async function rescheduleAppointment(
  oldAppointmentId: number,
  clientPhone: string,
  chairId: number,
  serviceId: number,
  newStartsAt: Date,
  durationMinutes: number,
  clientName?: string
): Promise<Appointment> {
  const db = getDb();

  const newAppointment = await db.transaction(async (trx: any) => {
    // 1. Verify that the old appointment belongs to the client and is confirmed
    const old = await trx('appointments')
      .where('id', oldAppointmentId)
      .andWhere('client_phone', clientPhone)
      .first();

    if (!old || old.status !== 'confirmed') {
      throw new Error(`Appointment ${oldAppointmentId} not found or not confirmed for phone ${clientPhone}`);
    }

    const now = new Date().toISOString();

    // 2. Re-validate the new slot for conflicts (catch concurrent modifications)
    const dateStr = newStartsAt.toISOString().split('T')[0];
    const nextDayStr = new Date(newStartsAt.getTime() + 86400000).toISOString().split('T')[0];
    const endDateTime = new Date(newStartsAt.getTime() + durationMinutes * 60000);

    const conflictingAppts = await trx('appointments')
      .where({ chair_id: chairId })
      .whereNot({ status: 'cancelled' })
      .whereNot({ status: 'rescheduled' })
      .whereNot('id', oldAppointmentId)
      .whereBetween('starts_at', [`${dateStr}T00:00:00Z`, `${nextDayStr}T00:00:00Z`])
      .select('starts_at', 'duration_minutes');

    for (const appt of conflictingAppts) {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(apptStart.getTime() + appt.duration_minutes * 60000);
      if (newStartsAt < apptEnd && endDateTime > apptStart) {
        throw new Error('Time slot not available');
      }
    }

    // 3. Mark old appointment as rescheduled
    await trx('appointments').where('id', oldAppointmentId).update({
      status: 'rescheduled',
      updated_at: now,
    });

    // 4. Insert new appointment as confirmed
    const [newId] = await trx('appointments').insert({
      chair_id: chairId,
      client_phone: clientPhone,
      client_name: clientName ?? null,
      service_id: serviceId,
      starts_at: newStartsAt.toISOString(),
      duration_minutes: durationMinutes,
      status: 'confirmed',
      notes: null,
      created_at: now,
      updated_at: now,
    });

    return trx('appointments').where({ id: newId }).first() as Promise<Appointment>;
  });

  log.info(maskPhone(clientPhone), 'SCHEDULER', `Appointment rescheduled: old=${oldAppointmentId} new=${newAppointment.id}`);
  return newAppointment;
}
