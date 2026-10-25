'use strict';

/**
 * Application-wide event bus (Node.js EventEmitter).
 * Controllers emit significant domain events; listeners below decide what to do
 * with them (currently: write them to the operational log).
 */
const EventEmitter = require('events');
const logger = require('./logger');

// The one shared event emitter. Other files call bus.emit('name', data) when something happens,
// so they don't need to know who is listening (this keeps the code loosely connected).
const bus = new EventEmitter();

// Names of the events that get written to the log file.
const LOGGED_EVENTS = [
  'auth:login',
  'auth:login_failed',
  'auth:logout',
  'article:created',
  'article:submitted',
  'article:published',
  'article:returned',
  'article:deleted',
  'article:revision_started',
  'comment:created',
  'comment:rate_limited',
  'comment:deleted',
  'user:created',
  'user:updated',
  'user:deleted',
  'weather:refreshed',
  'weather:failed',
  'permission:denied',
  'workflow:invalid_transition',
];

// For every event name above, add a listener that writes the event and its data to the log.
// Each listener (arrow function) just calls logger.event with the name and the data it got.
LOGGED_EVENTS.forEach((name) => bus.on(name, (data) => logger.event(name, data)));

module.exports = bus;
