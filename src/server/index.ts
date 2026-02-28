import cors from 'cors';
import express from 'express';

const app = express();
const port = 3001;

app.use(
  cors({
    origin: 'http://localhost:5173',
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.listen(port, () => {
  console.log(`ScreenClone backend listening on http://localhost:${port}`);
});
