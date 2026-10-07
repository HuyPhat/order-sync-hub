import express, {type Express} from 'express';
const app: Express = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export default app;