import { Router } from 'express';
import express from 'express';
import { adminLogin, requireAdmin } from '../middleware/auth';
import {
  getAppointments,
  patchAppointment,
  getServices,
  createService,
  updateService,
  deleteService,
  getWorkingHours,
  updateWorkingHours,
  getAvailabilityBlocks,
  createAvailabilityBlock,
  deleteAvailabilityBlock,
  getEscalations,
  updateEscalation,
  getHistory,
  clearCustomerData,
} from '../controllers/admin.controller';

const router = Router();
export { router as adminRouter };

// JSON body parser for all admin routes
router.use(express.json({ limit: '64kb' }));

// ─── Auth (public) ────────────────────────────────────────────────────────────
router.post('/auth/login', adminLogin);

// ─── All routes below require Bearer token ────────────────────────────────────
router.use(requireAdmin);

// ─── Appointments ─────────────────────────────────────────────────────────────
router.get('/appointments', getAppointments);
router.patch('/appointments/:id', patchAppointment);
router.delete('/customer-data', clearCustomerData);

// ─── Services ─────────────────────────────────────────────────────────────────
router.get('/services', getServices);
router.post('/services', createService);
router.put('/services/:id', updateService);
router.patch('/services/:id', updateService);
router.delete('/services/:id', deleteService);

// ─── Working Hours ────────────────────────────────────────────────────────────
router.get('/working-hours', getWorkingHours);
router.put('/working-hours/:id', updateWorkingHours);
router.patch('/working-hours/:id', updateWorkingHours);

// ─── Availability Blocks ──────────────────────────────────────────────────────
router.get('/blocks', getAvailabilityBlocks);
router.post('/blocks', createAvailabilityBlock);
router.delete('/blocks/:id', deleteAvailabilityBlock);

// ─── Escalations ─────────────────────────────────────────────────────────────
router.get('/escalations', getEscalations);
router.patch('/escalations/:appointmentId', updateEscalation);

// ─── History ──────────────────────────────────────────────────────────────────
router.get('/history', getHistory);
