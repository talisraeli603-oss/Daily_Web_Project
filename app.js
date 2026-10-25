'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const mongoose = require('mongoose');

const config = require('./config/env');
const device = require('./middleware/device');
const { attachUser } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const { STATUS_LABELS, CATEGORIES } = require('./config/constants');
const pagesRouter = require('./routes/pages');
const apiRouter = require('./routes/api');

/**
 * Builds the Express app and plugs in all middleware and routes in order.
 * Call it only after the Mongoose connection is open (the session store needs it).
 */
function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');

  /* ---- security headers ---- */
  // Middleware: adds safety headers to every response, then moves on.
  // Important: the Content-Security-Policy only allows scripts from our own site, which blocks injected scripts (XSS).
  // Important: X-Frame-Options DENY stops other sites from showing our pages in an iframe (clickjacking).
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  /* ---- template defaults + helpers (set early so even error pages have every variable) ---- */
  // Date formatters are created once here and reused, so we don't rebuild them on every request.
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
  const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  // Middleware: puts default variables into res.locals so every EJS page can use them (user, categories, date helpers...).
  app.use((req, res, next) => {
    res.locals.user = null;
    res.locals.currentPath = req.path;
    res.locals.STATUS_LABELS = STATUS_LABELS;
    res.locals.allCategories = CATEGORIES;
    // Template helper: turns a date into text like "24 Oct 2026" (empty string if no date).
    res.locals.fmtDate = (d) => (d ? dateFormat.format(new Date(d)) : '');
    // Template helper: same as above but also shows the time.
    res.locals.fmtDateTime = (d) => (d ? dateTimeFormat.format(new Date(d)) : '');
    res.locals.description = '';
    res.locals.ogImage = '';
    next();
  });

  /* ---- static files (before sessions: no session lookups for CSS/JS/images) ---- */
  // Files are cached by the browser for 1 day in production (no cache while developing). Chart.js is served from node_modules.
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProduction ? '1d' : 0 }));
  app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' }));

  /* ---- body parsing ---- */
  // Important: body size limits (200kb JSON, 50kb forms) stop people from sending huge requests.
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  /* ---- device cookie + server-side sessions (stored in MongoDB, so they survive a server restart) ---- */
  // Important: sessions are saved in MongoDB (connect-mongo), not in memory, so logins survive a restart.
  // Important: the cookie is httpOnly (JavaScript can't read it) and sameSite 'lax' (helps against CSRF). Sessions last 7 days.
  // resave/saveUninitialized are false so we don't save sessions for visitors who never logged in.
  // touchAfter means a session is refreshed in the DB at most once an hour.
  app.use(device);
  app.use(
    session({
      name: 'dw.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60,
        touchAfter: 60 * 60,
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction ? 'auto' : false,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );
  // Middleware: if someone is logged in, loads their user and makes it available to the request and the views.
  app.use(attachUser);

  /* ---- routes ---- */
  // JSON API lives under /api/v1; normal pages (EJS) are on /. Anything not matched goes to the 404 handler,
  // and the error handler must be last so it catches errors from everything above.
  app.use('/api/v1', apiRouter);
  app.use('/', pagesRouter);

  app.use(errorHandler.notFound);
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
