import { Router } from 'express';
import { getAppointments, getAppointmentById } from '../controllers/appointment.controller';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.use(requireAdmin);

router.get('/:phone', getAppointments);
router.get('/id/:id', getAppointmentById);

export default router;
