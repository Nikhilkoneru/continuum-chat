import express from 'express';
import cors from 'cors';

import attachmentRoutes from './routes/attachments';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import healthRoutes from './routes/health';
import modelRoutes from './routes/models';
import projectRoutes from './routes/projects';
import { env } from './config';

const app = express();

app.use(
  cors({
    origin: env.clientOrigin === '*' ? true : env.clientOrigin,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.use(healthRoutes);
app.use(authRoutes);
app.use(attachmentRoutes);
app.use(modelRoutes);
app.use(projectRoutes);
app.use(chatRoutes);

app.listen(env.port, () => {
  console.log(`Github Personal Assistant API listening on http://localhost:${env.port}`);
});
