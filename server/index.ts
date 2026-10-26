import { killAll } from './agents.ts';
import { buildApp } from './app.ts';
import { HOST, PORT } from './platform.ts';
import { store } from './store.ts';

store.load();
const app = await buildApp();

const shutdown = () => {
  killAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: HOST, port: PORT });
console.log(`\n  🏢 AI Office rodando em http://localhost:${PORT}\n`);
