import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import * as path from 'path';
import { webhookRouter } from './routes/webhook';
import { adminRouter } from './routes/admin';
import appointmentsRouter from './routes/appointments';
import { log } from './utils/logger';

const app = express();

// Trust Nginx proxy (needed for rate limiting by real IP)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));

// Rate limits
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Serve admin static files at /admin (index.html, style.css, app.js)
app.use('/admin', express.static(path.join(process.cwd(), 'public/admin')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Appointments API (before admin and webhook so /appointments/:phone is matched correctly)
app.use('/appointments', express.json({ limit: '64kb' }), appointmentsRouter);

// Admin API — mounted at /api/admin to match frontend's BASE_URL = '/api/admin'
app.use('/api/admin', adminLimiter, adminRouter);

// Webhook routes
app.use('/webhook', webhookLimiter, express.json({ limit: '64kb' }), webhookRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error('-', 'STARTUP', 'Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };