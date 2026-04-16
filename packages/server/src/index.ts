import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db/index.js';
import { sessionsRouter } from './routes/sessions.js';
import { screenshotsRouter } from './routes/screenshots.js';
import { exportRouter } from './routes/export.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGES_DIR = path.resolve(__dirname, '..', '..');
const EDITOR_DIR = path.resolve(PACKAGES_DIR, 'editor');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api/sessions', sessionsRouter);
app.use('/api/screenshots', screenshotsRouter);
app.use('/api/sessions', exportRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const isDev = process.env.NODE_ENV !== 'production';

async function start() {
  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    const vite = await createViteServer({
      configFile: false,
      root: EDITOR_DIR,
      plugins: [react()],
      resolve: {
        alias: { '@docext/shared': path.resolve(PACKAGES_DIR, 'shared', 'src') },
      },
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api/')) return next();
      try {
        const fs = await import('fs');
        const template = fs.readFileSync(path.join(EDITOR_DIR, 'index.html'), 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    const editorDist = path.join(EDITOR_DIR, 'dist');
    app.use(express.static(editorDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(editorDist, 'index.html'));
    });
  }

  const server = app.listen(PORT, () => {
    console.log(`DocExt running at http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(console.error);

export { app, db };
