import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

type Check = {
  key: string;
  label: string;
  required: boolean;
  valid: (value: string | undefined, all: Record<string, string>) => boolean;
  hint: string;
};

const requestedEnvFile = process.argv[2] ?? '.env';
const envPath = path.resolve(process.cwd(), requestedEnvFile);
const examplePath = path.resolve(process.cwd(), '.env.example');

function readEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}

const values = readEnv(envPath);
const example = readEnv(examplePath);

function first(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

const checks: Check[] = [
  {
    key: 'PORT',
    label: 'Porta do servidor',
    required: false,
    valid: (value) => value === undefined || /^\d+$/.test(value),
    hint: 'Use um numero, ex: PORT=3000',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'Chave da OpenAI',
    required: true,
    valid: (value) => !!value && value.startsWith('sk-'),
    hint: 'Preencha OPENAI_API_KEY com uma chave que começa com sk-',
  },
  {
    key: 'WAHA_BASE_URL',
    label: 'URL do WAHA',
    required: true,
    valid: (value) => !!value && /^https?:\/\/.+/.test(value),
    hint: 'Use algo como WAHA_BASE_URL=http://localhost:3001',
  },
  {
    key: 'WAHA_WEBHOOK_URL',
    label: 'URL do webhook chamada pelo WAHA',
    required: false,
    valid: (value) => value === undefined || value.trim() === '' || /^https?:\/\/.+\/webhook\/waha$/.test(value),
    hint: 'Local: http://host.docker.internal:3000/webhook/waha | Producao: http://host.docker.internal:3002/webhook/waha',
  },
  {
    key: 'WAHA_API_KEY',
    label: 'Chave da API do WAHA',
    required: true,
    valid: (value) => !!value && value.trim().length >= 12,
    hint: 'Preencha WAHA_API_KEY com uma senha longa. Exemplo: 32 caracteres aleatorios.',
  },
  {
    key: 'WAHA_DASHBOARD_USERNAME',
    label: 'Usuario da dashboard WAHA',
    required: true,
    valid: (value) => !!value && value.trim().length > 0,
    hint: 'Preencha WAHA_DASHBOARD_USERNAME, ex: admin',
  },
  {
    key: 'WAHA_DASHBOARD_PASSWORD',
    label: 'Senha da dashboard WAHA',
    required: true,
    valid: (value) => !!value && value.trim().length >= 12,
    hint: 'Preencha WAHA_DASHBOARD_PASSWORD com uma senha longa. Se ficar vazio/fraco, o WAHA pode gerar senha aleatoria.',
  },
  {
    key: 'WEBHOOK_API_KEY',
    label: 'Chave do webhook',
    required: true,
    valid: (value) => !!value && value.trim().length >= 12,
    hint: 'Preencha WEBHOOK_API_KEY com uma senha forte de pelo menos 12 caracteres',
  },
  {
    key: 'ADMIN_SECRET',
    label: 'Senha do dashboard admin',
    required: false,
    valid: (_value, all) => !!first('ADMIN_SECRET', 'ADMIN_KEY', 'ADMIN_PASSWORD') || !all.ADMIN_SECRET,
    hint: 'Use ADMIN_SECRET. ADMIN_KEY e ADMIN_PASSWORD ainda funcionam como compatibilidade.',
  },
  {
    key: 'OWNER_PHONE',
    label: 'Telefone do dono',
    required: false,
    valid: (value) => value === undefined || value.trim() === '' || /^\d{10,15}$/.test(value.replace(/@c\.us$/i, '')),
    hint: 'Use somente numeros com DDI/DDD, ex: OWNER_PHONE=5521999999999',
  },
  {
    key: 'LOG_LEVEL',
    label: 'Nivel dos logs',
    required: false,
    valid: (value) => value === undefined || ['debug', 'info', 'warn', 'error'].includes(value),
    hint: 'Use debug, info, warn ou error',
  },
];

console.log(`Diagnostico do ${requestedEnvFile}`);
console.log('==================\n');

if (!fs.existsSync(envPath)) {
  console.log(`ERRO: arquivo ${requestedEnvFile} nao encontrado.`);
  console.log('Crie a partir do modelo: copy .env.example .env');
  process.exit(1);
}

let hasError = false;

for (const check of checks) {
  const value = check.key === 'ADMIN_SECRET'
    ? first('ADMIN_SECRET', 'ADMIN_KEY', 'ADMIN_PASSWORD')
    : values[check.key];
  const hasValue = value !== undefined && value.trim() !== '';
  const ok = check.valid(value, values);

  if (check.required && !hasValue) {
    hasError = true;
    console.log(`FALTA: ${check.key} - ${check.label}`);
    console.log(`       ${check.hint}`);
    continue;
  }

  if (hasValue && !ok) {
    hasError = true;
    console.log(`INVALIDO: ${check.key} - ${check.label}`);
    console.log(`         ${check.hint}`);
    continue;
  }

  if (hasValue) {
    console.log(`OK: ${check.key} - preenchido`);
  } else {
    console.log(`AVISO: ${check.key} - vazio/opcional`);
  }
}

const unknownKeys = Object.keys(values)
  .filter((key) => !(key in example) && !['ADMIN_KEY', 'ADMIN_PASSWORD'].includes(key));

if (unknownKeys.length > 0) {
  console.log('\nVariaveis extras no .env:');
  for (const key of unknownKeys) console.log(`- ${key}`);
}

if (!values.OWNER_PHONE) {
  console.log('\nAVISO: OWNER_PHONE nao esta preenchido.');
  console.log('Cancelamento/remarcacao dentro de 6h nao vai avisar o dono pelo WhatsApp.');
}

console.log('\nNota WAHA:');
console.log('Se a dashboard mostrar senha/API key aleatoria, recrie o container depois de corrigir o .env:');
console.log('docker compose down');
console.log('docker compose up -d');

console.log('');

if (hasError) {
  console.log('Resultado: corrija os itens acima antes de rodar o bot.');
  process.exit(1);
}

console.log('Resultado: .env parece pronto para rodar.');
