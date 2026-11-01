/**
 * Entry point: starts the HTTP server.   npm run dev   (auto-restart)  |  npm start
 */
const env = require('./config/env');
const app = require('./app');
const prisma = require('./utils/prisma');

const server = app.listen(env.port, () => {
  console.log(`ClearKYC API listening on http://localhost:${env.port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
