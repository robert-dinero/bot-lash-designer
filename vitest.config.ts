import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['src/__tests__/setup.ts'],
    // Set required env vars for all tests to prevent process.exit(1) in env.ts
    env: {
      OPENAI_API_KEY: 'test-openai-key',
      WAHA_BASE_URL: 'http://localhost:3001',
      WAHA_API_KEY: 'test-waha-key',
      WEBHOOK_API_KEY: 'test-webhook-key',
      ADMIN_SECRET: 'test-secret-123',
      OWNER_PHONE: '5511999990000',
      DB_PATH: ':memory:',
    },
  },
});
