import { config } from './config';
import { createDashboardReader } from './lib/dashboard';

export const dashboardReader = createDashboardReader(config);
