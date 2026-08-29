import { createApp } from './app';
import { config } from './config';
import { connectDB, disconnectDB } from './db/postgres';
import { connectRedis, disconnectRedis } from './db/redis';
import { ensureIndex } from './services/searchService';

async function bootstrap(): Promise<void> {
  // ─── Connect to external services ─────────────────────────────────────────
  await connectDB();
  await connectRedis();
  await ensureIndex();

  // ─── Start HTTP server ─────────────────────────────────────────────────────
  const app = createApp();
  const server = app.listen(config.app.port, () => {
    console.log(
      `🚀  Server running on port ${config.app.port} [${config.app.nodeEnv}]`,
    );
  });

  // ─── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n⚠️   Received ${signal}. Shutting down gracefully…`);

    server.close(async () => {
      try {
        await disconnectDB();
        await disconnectRedis();
        console.log('👋  Goodbye.');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    });

    // Force-kill after 10 s if something hangs
    setTimeout(() => {
      console.error('⏱️   Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ─── Unhandled rejections / exceptions ────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
