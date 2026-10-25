'use strict';

const config = require('./config/env');
const logger = require('./utils/logger');
require('./utils/eventBus'); // registers the operational-log listeners
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const createApp = require('./app');
const viewService = require('./services/viewService');

// Entry point of the program: connect to the database, build the app, start the view counter, then listen for requests.
async function main() {
  await connectDB();
  const app = createApp();
  viewService.start();

  // Callback: runs once the server is up and just prints the address.
  const server = app.listen(config.port, () => {
    logger.info(`The Daily Web is running on http://localhost:${config.port}`);
  });

  // Flag so that pressing Ctrl+C twice doesn't start the shutdown twice.
  let shuttingDown = false;
  // Stops the server cleanly: stop taking new requests, save buffered view counts, close the DB, close the logs, exit.
  // Important: viewService.stop() saves the page views still waiting in memory, so they are not lost on shutdown.
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received: shutting down gracefully`);
    server.close();
    try {
      await viewService.stop(); // do not lose buffered views
      await mongoose.disconnect();
    } catch (err) {
      logger.error('Error during shutdown', err);
    }
    await logger.close();
    process.exit(0);
  }
  // SIGINT = Ctrl+C in the terminal, SIGTERM = the hosting system asking us to stop. Both do the clean shutdown.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// A rejected promise nobody handled must not take the server down - log it.
// Handler: only writes the problem to the log and keeps the server running.
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
// Handler for a crash we did not expect. The program may be in a bad state, so we log it, save the buffered views,
// close the logs and exit with code 1 (a process manager can then restart us).
process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception', err);
  try {
    await viewService.stop();
  } catch {
    /* ignore */
  }
  await logger.close();
  process.exit(1);
});

// Start everything. If startup fails (for example the DB is not reachable), log it and exit with an error code.
main().catch(async (err) => {
  logger.error('Failed to start the server', err);
  await logger.close();
  process.exit(1);
});
