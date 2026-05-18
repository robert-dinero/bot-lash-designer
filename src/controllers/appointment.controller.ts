import type { Request, Response } from 'express';
import { getDb } from '../db';
import type { Appointment } from '../types';
import { log, maskPhone } from '../utils/logger';

export async function getAppointments(req: Request, res: Response): Promise<void> {
  const { phone } = req.params;

  if (!phone) {
    res.status(400).json({ error: 'phone required' });
    return;
  }

  try {
    const db = getDb();
    const appointments = await db('appointments')
      .where({ client_phone: phone })
      .orderBy('starts_at', 'asc') as Appointment[];

    // Enrich with service names
    const enriched = await Promise.all(appointments.map(async (appt) => {
      const service = await db('services').where({ id: appt.service_id }).first();
      return {
        ...appt,
        service_name: service?.name ?? 'Unknown',
      };
    }));

    log.info(maskPhone(phone), 'ADMIN', `Fetched ${enriched.length} appointments`);
    res.json(enriched);
  } catch (err) {
    log.error(maskPhone(phone), 'ADMIN', `getAppointments failed`, err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
}

export async function getAppointmentById(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    const db = getDb();
    const appt = await db('appointments').where({ id }).first() as Appointment | undefined;

    if (!appt) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const service = await db('services').where({ id: appt.service_id }).first();

    res.json({
      ...appt,
      service_name: service?.name ?? 'Unknown',
    });
  } catch (err) {
    log.error('-', 'ADMIN', `getAppointmentById failed for id=${id}`, err);
    res.status(500).json({ error: 'Failed to fetch appointment' });
  }
}
