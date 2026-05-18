import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { log, maskPhone } from '../utils/logger';
import { sendText } from '../services/waha.service';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DEFAULT_CHAIR_ID } from '../config';
export { requireAdmin } from '../middleware/auth';

/* ── Field mapping helpers ────────────────────────────────────────────────────
   The DB stores duration_minutes and price_cents (integers).
   The frontend sends/expects duration (minutes, float) and price (BRL, float).
   These helpers translate at the boundary.
   ─────────────────────────────────────────────────────────────────────────── */

function serviceToFrontend(row: Record<string, unknown>) {
  return {
    id: row['id'],
    name: row['name'],
    duration: row['duration_minutes'],
    price: typeof row['price_cents'] === 'number' ? (row['price_cents'] as number) / 100 : row['price_cents'],
    active: row['active'],
  };
}

/* ── Zod Schemas ─────────────────────────────────────────────────────────── */

// Frontend sends { name, duration (min), price (BRL float) }
const ServiceCreateSchema = z.object({
  name: z.string().min(1).max(100),
  duration: z.number().int().min(15).max(480),
  price: z.number().min(0),
});

const ServiceUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  duration: z.number().int().min(15).max(480).optional(),
  price: z.number().min(0).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

const WorkingHoursUpdateSchema = z.object({
  is_closed: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  open_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  close_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  opens_at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closes_at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  break_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  break_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

const AvailabilityBlockCreateSchema = z.object({
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  reason: z.string().max(200).optional(),
});

const EscalationUpdateSchema = z.object({
  action: z.enum(['approve', 'deny']),
});

const AppointmentQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled']).optional(),
});

const AppointmentPatchSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show']).optional(),
  starts_at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(500).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

/* ── Appointments ──────────────────────────────────────────────────────────── */

export async function getAppointments(req: Request, res: Response): Promise<void> {
  try {
    const parsed = AppointmentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid query params' });
      return;
    }
    const { start, end, status } = parsed.data;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const startDate = start ? new Date(start) : todayStart;
    const endDate = end ? new Date(end) : todayEnd;

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      res.status(400).json({ error: 'Invalid date format' });
      return;
    }

    const startMidnight = new Date(startDate);
    startMidnight.setUTCHours(0, 0, 0, 0);
    const endMidnight = new Date(endDate);
    endMidnight.setUTCHours(0, 0, 0, 0);
    const diffDays = (endMidnight.getTime() - startMidnight.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) {
      res.status(400).json({ error: 'Date range must not exceed 30 days' });
      return;
    }

    const db = getDb();
    let query = db('appointments')
      .join('services', 'appointments.service_id', 'services.id')
      .select(
        'appointments.id',
        'appointments.client_phone',
        'appointments.client_name',
        'appointments.service_id',
        'appointments.starts_at',
        'appointments.duration_minutes',
        'appointments.status',
        'appointments.notes',
        'appointments.created_at',
        'appointments.updated_at',
        'services.name as service_name',
      )
      .where('appointments.starts_at', '>=', startDate.toISOString())
      .where('appointments.starts_at', '<', endDate.toISOString())
      .orderBy('appointments.starts_at', 'asc');

    if (status) query = query.where('appointments.status', status);

    const rows = await query;
    // Map duration_minutes → duration for frontend consistency
    const mapped = rows.map((r: Record<string, unknown>) => ({
      ...r,
      duration: r['duration_minutes'],
    }));
    res.json(mapped);
  } catch (err) {
    log.error('-', 'ADMIN', 'getAppointments error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function patchAppointment(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid appointment id' });
      return;
    }

    const parsed = AppointmentPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { ...parsed.data, updated_at: now };
    if (updates['status'] === 'cancelled') updates['cancelled_at'] = now;

    const existing = await db('appointments').where({ id }).first();
    if (!existing) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const affected = await db('appointments').where({ id }).update(updates);
    if (affected === 0) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    // Notify client via WhatsApp when admin cancels appointment
    if (parsed.data.status === 'cancelled' && existing.status !== 'cancelled') {
      try {
        const apptTime = format(parseISO(existing.starts_at), "dd/MM 'às' HH:mm", { locale: ptBR });
        const msg = `⚠️ Seu agendamento de ${apptTime} foi cancelado pelo estabelecimento. Entre em contato para reagendar.`;
        sendText(existing.client_phone, msg).catch((err) => {
          log.error(maskPhone(existing.client_phone), 'ADMIN', 'Failed to notify client of cancellation', err);
        });
      } catch (err) {
        log.error('-', 'ADMIN', `Error building cancellation message for appointment ${id}`, err);
      }
    }

    const updated = await db('appointments').where({ id }).first();
    log.info('-', 'ADMIN', `Admin patched appointment ${id}`);
    res.json({ ...updated, duration: updated['duration_minutes'] });
  } catch (err) {
    log.error('-', 'ADMIN', 'patchAppointment error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Keep deleteAppointment as alias for backwards compat with any existing callers
export async function deleteAppointment(req: Request, res: Response): Promise<void> {
  req.body = { ...req.body, status: 'cancelled' };
  return patchAppointment(req, res);
}

export async function clearCustomerData(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const tables = ['sessions', 'messages', 'processed_messages', 'appointments', 'users'] as const;
    const deleted: Record<string, number> = {};

    await db.raw('PRAGMA foreign_keys = OFF');
    try {
      for (const table of tables) {
        const row = await db(table).count('* as n').first() as { n?: number | string } | undefined;
        deleted[table] = Number(row?.n ?? 0);
        await db(table).delete();
      }
    } finally {
      await db.raw('PRAGMA foreign_keys = ON');
    }

    log.info('-', 'ADMIN', `Admin cleared customer data: ${JSON.stringify(deleted)}`);
    res.json({ success: true, deleted });
  } catch (err) {
    log.error('-', 'ADMIN', 'clearCustomerData error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/* ── Services ────────────────────────────────────────────────────────────── */

export async function getServices(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const rows = await db('services')
      .where({ active: 1 })
      .select('id', 'name', 'duration_minutes', 'price_cents', 'active')
      .orderBy('name', 'asc');
    res.json(rows.map(serviceToFrontend));
  } catch (err) {
    log.error('-', 'ADMIN', 'getServices error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createService(req: Request, res: Response): Promise<void> {
  try {
    const parsed = ServiceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }
    const { name, duration, price } = parsed.data;

    const db = getDb();
    const [id] = await db('services').insert({
      name,
      duration_minutes: duration,
      price_cents: Math.round(price * 100),
      active: 1,
    });

    const created = await db('services').where({ id }).first();
    log.info('-', 'ADMIN', `Admin created service ${id}: ${name}`);
    res.status(201).json(serviceToFrontend(created));
  } catch (err) {
    log.error('-', 'ADMIN', 'createService error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateService(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid service id' });
      return;
    }

    const parsed = ServiceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }

    const dbUpdates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) dbUpdates['name'] = parsed.data.name;
    if (parsed.data.duration !== undefined) dbUpdates['duration_minutes'] = parsed.data.duration;
    if (parsed.data.price !== undefined) dbUpdates['price_cents'] = Math.round(parsed.data.price * 100);

    const db = getDb();
    const existing = await db('services').where({ id, active: 1 }).first();
    if (!existing) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

    await db('services').where({ id }).update(dbUpdates);
    const updated = await db('services').where({ id }).first();
    log.info('-', 'ADMIN', `Admin updated service ${id}`);
    res.json(serviceToFrontend(updated));
  } catch (err) {
    log.error('-', 'ADMIN', 'updateService error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteService(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid service id' });
      return;
    }

    const db = getDb();
    const activeCount = await db('appointments')
      .where({ service_id: id, status: 'confirmed' })
      .count('id as count')
      .first();

    const count = Number((activeCount as { count: number } | undefined)?.count ?? 0);
    if (count > 0) {
      res.status(400).json({
        error: `Serviço tem ${count} agendamento(s) confirmado(s). Cancele-os primeiro.`,
      });
      return;
    }

    const updated = await db('services').where({ id, active: 1 }).update({ active: 0 });
    if (updated === 0) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }

    log.info('-', 'ADMIN', `Admin soft-deleted service ${id}`);
    res.json({ id, success: true });
  } catch (err) {
    log.error('-', 'ADMIN', 'deleteService error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/* ── Working Hours ──────────────────────────────────────────────────────────── */

export async function getWorkingHours(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const rows = await db('working_hours')
      .where({ chair_id: DEFAULT_CHAIR_ID })
      .select('id', 'chair_id', 'day_of_week', 'open_time', 'close_time', 'is_closed', 'break_start', 'break_end')
      .orderBy('day_of_week', 'asc');
    res.json(rows);
  } catch (err) {
    log.error('-', 'ADMIN', 'getWorkingHours error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateWorkingHours(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid working hours id' });
      return;
    }

    const parsed = WorkingHoursUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }

    // Normalise field names: frontend may send opens_at/closes_at or open_time/close_time
    const dbUpdates: Record<string, unknown> = {};
    const d = parsed.data;
    if (d.is_closed !== undefined) dbUpdates['is_closed'] = d.is_closed ? 1 : 0;
    if (d.open_time) dbUpdates['open_time'] = d.open_time;
    if (d.close_time) dbUpdates['close_time'] = d.close_time;
    if (d.opens_at) dbUpdates['open_time'] = d.opens_at;
    if (d.closes_at) dbUpdates['close_time'] = d.closes_at;
    if ('break_start' in d) dbUpdates['break_start'] = d.break_start ?? null;
    if ('break_end' in d) dbUpdates['break_end'] = d.break_end ?? null;

    if (Object.keys(dbUpdates).length === 0) {
      res.status(400).json({ error: 'At least one field required' });
      return;
    }

    const db = getDb();
    const existing = await db('working_hours').where({ id, chair_id: DEFAULT_CHAIR_ID }).first();
    if (!existing) {
      res.status(404).json({ error: 'Working hours record not found' });
      return;
    }

    // Validate time logic against effective values (merge incoming with existing)
    const effectiveClosed = 'is_closed' in dbUpdates ? Boolean(dbUpdates['is_closed']) : Boolean(existing.is_closed);
    const effectiveOpen = (dbUpdates['open_time'] as string | undefined) ?? existing.open_time;
    const effectiveClose = (dbUpdates['close_time'] as string | undefined) ?? existing.close_time;
    if (!effectiveClosed && effectiveOpen && effectiveClose && effectiveClose <= effectiveOpen) {
      res.status(400).json({ error: 'close_time must be after open_time' });
      return;
    }

    await db('working_hours').where({ id }).update(dbUpdates);
    const updated = await db('working_hours').where({ id }).first();
    log.info('-', 'ADMIN', `Admin updated working hours ${id}`);
    res.json(updated);
  } catch (err) {
    log.error('-', 'ADMIN', 'updateWorkingHours error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/* ── Availability Blocks ────────────────────────────────────────────────────── */

export async function getAvailabilityBlocks(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    let query = db('availability_blocks')
      .where({ chair_id: DEFAULT_CHAIR_ID })
      .select('*')
      .orderBy('starts_at', 'asc');

    const { start, end } = req.query as { start?: string; end?: string };
    if (start) {
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) { res.status(400).json({ error: 'Invalid start date' }); return; }
      query = query.where('starts_at', '>=', startDate.toISOString());
    }
    if (end) {
      const endDate = new Date(end);
      if (isNaN(endDate.getTime())) { res.status(400).json({ error: 'Invalid end date' }); return; }
      query = query.where('ends_at', '<=', endDate.toISOString());
    }

    res.json(await query);
  } catch (err) {
    log.error('-', 'ADMIN', 'getAvailabilityBlocks error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createAvailabilityBlock(req: Request, res: Response): Promise<void> {
  try {
    const parsed = AvailabilityBlockCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }

    const { starts_at, ends_at, reason } = parsed.data;
    if (new Date(ends_at) <= new Date(starts_at)) {
      res.status(400).json({ error: 'ends_at must be after starts_at' });
      return;
    }

    const db = getDb();

    const overlap = await db('availability_blocks')
      .where({ chair_id: DEFAULT_CHAIR_ID })
      .where('starts_at', '<', ends_at)
      .where('ends_at', '>', starts_at)
      .first();

    if (overlap) {
      res.status(409).json({ error: 'Overlapping availability block already exists' });
      return;
    }

    const [id] = await db('availability_blocks').insert({
      chair_id: DEFAULT_CHAIR_ID,
      starts_at,
      ends_at,
      reason: reason ?? null,
    });

    const created = await db('availability_blocks').where({ id }).first();
    log.info('-', 'ADMIN', `Admin created availability block ${id}`);
    res.status(201).json(created);
  } catch (err) {
    log.error('-', 'ADMIN', 'createAvailabilityBlock error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteAvailabilityBlock(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid block id' }); return; }

    const db = getDb();
    const deleted = await db('availability_blocks').where({ id, chair_id: DEFAULT_CHAIR_ID }).delete();
    if (deleted === 0) { res.status(404).json({ error: 'Block not found' }); return; }

    log.info('-', 'ADMIN', `Admin deleted availability block ${id}`);
    res.json({ id, success: true });
  } catch (err) {
    log.error('-', 'ADMIN', 'deleteAvailabilityBlock error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/* ── Escalations ─────────────────────────────────────────────────────────────── */

export async function getEscalations(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const rows = await db('appointments')
      .join('services', 'appointments.service_id', 'services.id')
      .select(
        'appointments.id',
        'appointments.client_phone',
        'appointments.client_name',
        'services.name as service_name',
        'appointments.starts_at',
        'appointments.status',
        'appointments.escalation_status',
        'appointments.notes',
        'appointments.created_at',
      )
      .where('appointments.escalation_status', 'pending')
      .orderBy('appointments.created_at', 'asc');

    res.json(rows);
  } catch (err) {
    log.error('-', 'ADMIN', 'getEscalations error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateEscalation(req: Request, res: Response): Promise<void> {
  try {
    const appointmentId = parseInt(req.params['appointmentId'] ?? '', 10);
    if (isNaN(appointmentId)) { res.status(400).json({ error: 'Invalid appointment id' }); return; }

    const parsed = EscalationUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }

    const { action } = parsed.data;
    const db = getDb();
    const now = new Date().toISOString();

    const appointment = await db('appointments').where({ id: appointmentId }).first();
    if (!appointment) { res.status(404).json({ error: 'Appointment not found' }); return; }
    if (appointment.escalation_status !== 'pending') {
      res.status(400).json({ error: 'Appointment is not in pending escalation state' });
      return;
    }

    if (action === 'approve') {
      await db('appointments').where({ id: appointmentId }).update({
        status: 'cancelled', escalation_status: 'approved', cancelled_at: now, updated_at: now,
      });
      // Notify client that late cancellation was approved
      const apptTime = format(parseISO(appointment.starts_at), "dd/MM 'às' HH:mm", { locale: ptBR });
      sendText(appointment.client_phone, `✅ Seu pedido de cancelamento do agendamento de ${apptTime} foi aprovado. Até a próxima!`).catch((err) => {
        log.error(maskPhone(appointment.client_phone), 'ADMIN', 'Failed to notify client of escalation approval', err);
      });
    } else {
      await db('appointments').where({ id: appointmentId }).update({
        escalation_status: 'denied', updated_at: now,
      });
      // Notify client that late cancellation was denied
      const apptTime = format(parseISO(appointment.starts_at), "dd/MM 'às' HH:mm", { locale: ptBR });
      sendText(appointment.client_phone, `❌ Seu pedido de cancelamento do agendamento de ${apptTime} não foi aprovado. Seu horário segue confirmado. Em caso de dúvidas, entre em contato.`).catch((err) => {
        log.error(maskPhone(appointment.client_phone), 'ADMIN', 'Failed to notify client of escalation denial', err);
      });
    }

    const updated = await db('appointments').where({ id: appointmentId }).first();
    log.info('-', 'ADMIN', `Admin ${action}d escalation for appointment ${appointmentId}`);
    res.json(updated);
  } catch (err) {
    log.error('-', 'ADMIN', 'updateEscalation error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
}

/* ── History ─────────────────────────────────────────────────────────────────── */

export async function getHistory(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const { status } = req.query;

    const validStatuses = ['confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled'];
    const statusFilter = typeof status === 'string' && validStatuses.includes(status) ? status : null;

    let query = db('appointments')
      .join('services', 'appointments.service_id', 'services.id')
      .select(
        'appointments.id',
        'appointments.client_phone',
        'appointments.client_name',
        'services.name as service_name',
        'appointments.starts_at',
        'appointments.duration_minutes',
        'appointments.status',
        'appointments.cancelled_at',
        'appointments.created_at',
      )
      .orderBy('appointments.starts_at', 'desc');

    if (statusFilter) {
      query = query.where('appointments.status', statusFilter);
    }

    const rows = await query;
    res.json(rows);
  } catch (err) {
    log.error('-', 'ADMIN', 'getHistory error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
