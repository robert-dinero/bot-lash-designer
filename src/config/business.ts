import * as fs from 'fs';
import * as path from 'path';
import type { BusinessConfig } from '../types';
import { log } from '../utils/logger';

function loadBusinessConfig(): BusinessConfig {
  const configPath = path.resolve(process.cwd(), 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`❌ config.json not found at ${configPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let config: any;
  try {
    config = JSON.parse(raw);
  } catch {
    console.error('❌ config.json has invalid JSON syntax');
    process.exit(1);
  }

  if (!config.businessName) {
    console.error('❌ config.json is missing required field: businessName');
    process.exit(1);
  }

  const rawServices = Array.isArray(config.services) ? config.services : [];
  const services = rawServices.map((svc: any, index: number) => {
    if (!svc || typeof svc.name !== 'string') {
      console.error(`❌ config.json services[${index}] is invalid: missing name`);
      process.exit(1);
    }

    const duration = typeof svc.duration === 'number'
      ? svc.duration
      : typeof svc.durationMinutes === 'number'
        ? svc.durationMinutes
        : undefined;

    const price = typeof svc.price === 'number'
      ? svc.price
      : typeof svc.price_cents === 'number'
        ? svc.price_cents / 100
        : undefined;

    if (duration === undefined || Number.isNaN(duration)) {
      console.error(`❌ config.json services[${index}].duration is invalid or missing`);
      process.exit(1);
    }
    if (price === undefined || Number.isNaN(price)) {
      console.error(`❌ config.json services[${index}].price is invalid or missing`);
      process.exit(1);
    }

    return {
      name: svc.name,
      duration,
      price,
    };
  });

  const businessConfig: BusinessConfig = {
    businessName: config.businessName,
    services,
    paymentMethods: Array.isArray(config.paymentMethods)
      ? config.paymentMethods.filter((p: any) => typeof p === 'string')
      : [],
    tone: typeof config.tone === 'string' ? config.tone : 'amigável',
  };

  log.info('-', 'STARTUP', `Loaded config: ${businessConfig.businessName}, services: ${businessConfig.services?.length ?? 0}`);

  return businessConfig;
}

export const businessConfig: BusinessConfig = loadBusinessConfig();
