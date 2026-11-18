import { defineConfig } from '@playwright/test';

const env = {
  EXPO_PUBLIC_CHAIN_ID: '31337',
  EXPO_PUBLIC_RPC_URL: 'http://127.0.0.1:8546',
  EXPO_PUBLIC_CONTRACT: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  EXPO_PUBLIC_USDC: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  EXPO_PUBLIC_NATIVE_SYMBOL: 'AVAX',
  EXPO_PUBLIC_NETWORK_NAME: 'Anvil',
  // anvil's public default accounts 1-3: guest A, guest B, gate. The organizer (#0) uses the admin console.
  EXPO_PUBLIC_DEV_KEYS: [
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  ].join(','),
  CI: '1',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:8188',
    channel: 'chrome',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: [
    { command: `${process.env.HOME}/.foundry/bin/anvil --port 8546 --silent`, port: 8546, reuseExistingServer: false },
    { command: 'npx expo start --web --port 8188 --clear', port: 8188, timeout: 180_000, reuseExistingServer: false, env },
  ],
});
