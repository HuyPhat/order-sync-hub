import { sequelize } from './sequelize.js';

// authenticate() gives up on an unreachable host after the 3s connectTimeout set in sequelize.ts.
export async function checkDatabase(): Promise<boolean> {
  try {
    await sequelize.authenticate();
    return true;
  } catch (error) {
    console.error('database health check failed:', error);
    return false;
  }
}
