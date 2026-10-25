'use strict';

/**
 * Tiny file logger built on Node streams (no external logging library).
 *  - logs/app.log   : every entry (info, warn, error, events)
 *  - logs/error.log : warnings and errors only
 * Each line is a JSON object so it is easy to grep / parse.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const appStream = fs.createWriteStream(path.join(LOG_DIR, 'app.log'), { flags: 'a' });
const errorStream = fs.createWriteStream(path.join(LOG_DIR, 'error.log'), { flags: 'a' });

// The logs folder is created if missing. Both files are opened in append mode ('a'), so old logs are kept after a restart.
// Important: streams write in the background, so logging doesn't block the server.
// A failing log stream must never crash the server (an empty error listener also prevents an unhandled 'error' event).
appStream.on('error', () => {});
errorStream.on('error', () => {});

// Turns an Error into a plain object (name, message, stack), because JSON.stringify would otherwise lose those fields.
function serialize(err) {
  if (!err) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

// Builds one log line (JSON with time, level, message and extra info) and writes it to app.log.
// Warnings and errors also go to error.log. It also prints to the console, except when running tests.
function write(level, message, meta) {
  const entry = { time: new Date().toISOString(), level, message };
  if (meta !== undefined) entry.meta = meta instanceof Error ? serialize(meta) : meta;
  const line = JSON.stringify(entry) + '\n';
  appStream.write(line);
  if (level === 'warn' || level === 'error') errorStream.write(line);
  if (process.env.NODE_ENV !== 'test') {
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    out(`[${level.toUpperCase()}] ${message}`, meta instanceof Error ? meta.message : meta || '');
  }
}

// The public logger: one small function per level. 'event' is used by the event bus for business events (login, publish...).
module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  event: (name, meta) => write('event', name, meta),
  /** Flush and close streams (used on graceful shutdown). Waits until both files have finished writing. */
  close() {
    return Promise.all(
      [appStream, errorStream].map((s) => new Promise((resolve) => s.end(resolve)))
    );
  },
};
