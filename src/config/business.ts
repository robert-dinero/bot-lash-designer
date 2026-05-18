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

  const businessConfig: BusinessConfig = {
    businessName: config.businessName,
    services: config.services || [],
    tone: config.tone || 'amigável',
  };

  log.info('-', 'STARTUP', `Loaded config: ${businessConfig.businessName}, services: ${businessConfig.services?.length ?? 0}`);

  return businessConfig;
}

export const businessConfig: BusinessConfig = loadBusinessConfig();
