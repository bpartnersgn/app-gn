import { createDemoApp } from '@app-gn/core';
import { buildServer } from './app.ts';

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '127.0.0.1';

// Socle : données fictives et connecteurs simulés uniquement. Aucun fournisseur réel n'est appelé.
const { app } = createDemoApp();
const server = buildServer(app, { logger: true });
await server.listen({ port, host });
