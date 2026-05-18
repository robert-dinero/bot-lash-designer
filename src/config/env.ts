import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const adminSecret =
  process.env.ADMIN_SECRET ??
  process.env.ADMIN_KEY ??
  process.env.ADMIN_PASSWORD ??
  '';

const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform((v) => parseInt(v, 10)),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  WAHA_BASE_URL: z.string().url('WAHA_BASE_URL must be a valid URL'),
  WAHA_API_KEY: z.string().min(1, 'WAHA_API_KEY is required'),
  DB_PATH: z.string().default('./data/bot.sqlite'),
  WEBHOOK_API_KEY: z.string().min(1, 'WEBHOOK_API_KEY is required'),
  OWNER_PHONE: z.string().default('').transform(v => v.replace(/@c\.us$/i, '')),
  ADMIN_SECRET: z.string().default(adminSecret),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
