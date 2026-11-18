import { defineConfig } from '@playwright/test';

export const RPC = 'http://127.0.0.1:8550';
export const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const BOX = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const env = {
  VITE_CHAIN_ID: '31337', VITE_RPC_URL: RPC, VITE_CONTRACT: BOX, VITE_USDC: USDC, VITE_VAULT: VAULT,
  VITE_NATIVE_SYMBOL: 'ETH', VITE_NETWORK_NAME: 'Anvil', VITE_DEPLOY_BLOCK: '0', VITE_LOG_CHUNK: '50',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:8092', channel: 'chrome', viewport: { width: 1280, height: 860 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', acceptDownloads: true },
  webServer: [
    { command: `${process.env.HOME}/.foundry/bin/anvil --port 8550 --silent`, port: 8550, reuseExistingServer: false },
    { command: 'npx vite --port 8092 --strictPort', port: 8092, reuseExistingServer: false, env },
  ],
});
