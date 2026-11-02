import { Sequelize } from 'sequelize';
import { config } from '../config.js';

export const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  logging: false,
  // mysql2 waits ~10s for an unreachable host by default. Fail in 3s so the 503 reaches the
  // client while it is still listening.
  dialectOptions: { connectTimeout: 3000 },
});
