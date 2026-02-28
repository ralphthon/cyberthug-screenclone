import cors from 'cors';
import express, { type Request, type Response } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(
  cors({
    origin: 'http://localhost:5173',
  }),
);
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '1.0.0' });
});

app.listen(port, () => {
  console.log(`ScreenClone backend listening on http://localhost:${port}`);
});
