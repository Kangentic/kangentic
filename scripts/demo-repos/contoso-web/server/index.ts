import express from 'express';
import { router } from './routes.ts';

const app = express();
app.use(express.json());
app.use('/api', router);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`contoso-web api listening on http://localhost:${port}`);
});
