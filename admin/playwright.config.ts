import { defineConfig } from '@playwright/test';

export const RPC = 'http://127.0.0.1:8550';
const env = {
  VITE_CHAIN_ID: '31337', VITE_RPC_URL: RPC, VITE_CONTRACT: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  VITE_NATIVE_SYMBOL: 'AVAX', VITE_NETWORK_NAME: 'Anvil', VITE_EVENT_NAME: 'Sự kiện thử', VITE_EVENT_WHEN: '21/11 19:00', VITE_EVENT_VENUE: 'Sân khấu A', VITE_DEPLOY_BLOCK: '0',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:8092', channel: 'chrome', viewport: { width: 1280, height: 860 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', acceptDownloads: true },
  webServer: [
    { command: `${process.env.HOME}/.foundry/bin/anvil --port 8550 --silent`, port: 8550, reuseExistingServer: false },
    { command: 'npx vite --port 8092 --strictPort', port: 8092, reuseExistingServer: false, env },
  ],
});
