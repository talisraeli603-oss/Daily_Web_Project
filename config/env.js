'use strict';

// Loads variables from the ".env" file (if there is one) and exposes one config object for the whole project.
// Important: secrets like the DB address and session secret live in .env, not in the code.
require('dotenv').config({ quiet: true });

// Names of required variables that are not set.
const missing = ['MONGODB_URI', 'SESSION_SECRET'].filter((name) => !process.env[name]);
if (missing.length) {
  // Fail fast with a clear message instead of crashing later in a confusing way.
  console.error(
    `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      'Copy ".env.example" to ".env" and fill in the values.'
  );
  process.exit(1);
}

// The settings object. Optional ones have a default value (port 3000, city Tel Aviv, etc.).
const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI,
  sessionSecret: process.env.SESSION_SECRET,
  weather: {
    apiKey: process.env.WEATHER_API_KEY || '',
    city: process.env.WEATHER_CITY || 'Tel Aviv',
    apiUrl: process.env.WEATHER_API_URL || 'https://api.openweathermap.org/data/2.5/weather',
    cacheMs: 10 * 60 * 1000, // refresh every 10 minutes
    maxAgeMs: 15 * 60 * 1000, // never show data older than 15 minutes
  },
  seedPassword: process.env.SEED_PASSWORD || '',
};

// Handy true/false flag used elsewhere (for example for caching and secure cookies).
config.isProduction = config.env === 'production';

module.exports = config;
