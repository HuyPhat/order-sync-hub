import app from './app.js';
import {config} from "./config.js";

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port} (${config.nodeEnv})`);
});