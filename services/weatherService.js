'use strict';

/**
 * Weather widget backend (OpenWeatherMap "current weather" - free plan, no credit card).
 *
 * The browser never talks to OpenWeatherMap (so the API key stays secret). It calls our
 * /api/v1/weather endpoint, which serves a cached value:
 *   - refreshed at most every 10 minutes  -> thousands of users cause ONE upstream call per refresh
 *   - concurrent requests share the same in-flight upstream call (no stampede)
 *   - if the upstream fails, the cached value is still served while it is younger than 15 minutes
 *     (the maximum staleness allowed); after that the widget reports "unavailable"
 *   - after a failure we wait a short time before trying again so a broken upstream is not hammered
 */
const config = require('../config/env');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');

// After a failed call to OpenWeatherMap, wait 30 seconds before trying again.
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
// Give up on OpenWeatherMap if it doesn't answer within 6 seconds.
const REQUEST_TIMEOUT_MS = 6000;

// Cache: the last good weather data and the time we got it. Lives in server memory, shared by all visitors.
let cache = null; // { data, fetchedAt }
// The call to OpenWeatherMap that is running right now (null if none). Everyone who asks meanwhile waits for this same call.
let inFlight = null;
// When the last failure happened (0 = no recent failure). Used for the 30 second pause.
let lastFailureAt = 0;

// Takes the big answer from OpenWeatherMap and keeps only the few fields the widget needs (with safe defaults if a field is missing).
function normalize(raw) {
  const weather = Array.isArray(raw.weather) && raw.weather[0] ? raw.weather[0] : {};
  return {
    city: raw.name || config.weather.city,
    country: raw.sys && raw.sys.country,
    temperature: raw.main ? Math.round(raw.main.temp) : null,
    feelsLike: raw.main ? Math.round(raw.main.feels_like) : null,
    humidity: raw.main ? raw.main.humidity : null,
    windSpeed: raw.wind ? raw.wind.speed : null,
    description: weather.description || '',
    icon: weather.icon || '',
  };
}

// Makes one real HTTP call to OpenWeatherMap and returns the cleaned-up data.
// Important: the API key is only used here on the server, so the browser never sees it.
async function fetchFromUpstream() {
  const { apiKey, city, apiUrl } = config.weather;
  const url = new URL(apiUrl);
  url.searchParams.set('q', city);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('appid', apiKey);

  // Timeout trick: if the call takes longer than REQUEST_TIMEOUT_MS, the controller cancels it, so a slow API can't hang us.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`OpenWeatherMap responded with status ${response.status}`);
    const raw = await response.json();
    if (!raw || !raw.main) throw new Error('Unexpected response from OpenWeatherMap');
    return normalize(raw);
  } finally {
    // Always stop the timer, whether the call worked or failed.
    clearTimeout(timeout);
  }
}

// Refreshes the cache from OpenWeatherMap. It never throws: on failure it returns null and remembers the failure time.
// Important: if a refresh is already running, everyone gets that same one. So 1000 visitors at once cause only ONE call to OpenWeatherMap.
async function refresh() {
  if (inFlight) return inFlight;
  // Small function that runs right away, to do the real work and store its promise in inFlight.
  inFlight = (async () => {
    try {
      const data = await fetchFromUpstream();
      cache = { data, fetchedAt: Date.now() };
      lastFailureAt = 0;
      bus.emit('weather:refreshed', { city: data.city });
      return cache;
    } catch (err) {
      lastFailureAt = Date.now();
      bus.emit('weather:failed', { message: err.name === 'AbortError' ? 'timeout' : err.message });
      return null;
    } finally {
      // Done (good or bad): clear the marker so the next refresh can start.
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Returns { ...weather, updatedAt, ageSeconds } or throws a 503 AppError. */
// This is what the /api/v1/weather route calls. It answers from the cache and decides when to refresh.
// Important: the cache is refreshed after 10 minutes, and data older than 15 minutes is never shown (503 "unavailable" instead).
// If the refresh fails, the old data is still used while it is under 15 minutes old.
async function getWeather() {
  if (!config.weather.apiKey) {
    throw new AppError(503, 'Weather is not configured (missing WEATHER_API_KEY).');
  }

  const now = Date.now();
  // How old the cached data is (Infinity if we have nothing yet), and whether the 30 second pause after a failure is over.
  const age = cache ? now - cache.fetchedAt : Infinity;
  const retryAllowed = now - lastFailureAt >= RETRY_AFTER_FAILURE_MS;

  // Data is old enough to refresh (and we are not in the pause after a failure).
  if (age >= config.weather.cacheMs && retryAllowed) {
    if (cache && age < config.weather.maxAgeMs) {
      // Cache is usable: refresh in the background and answer immediately.
      refresh();
    } else {
      await refresh(); // nothing usable cached: wait for the upstream
    }
  }

  // Final check: only answer with data that is younger than the maximum allowed age.
  const usable = cache && Date.now() - cache.fetchedAt < config.weather.maxAgeMs;
  if (!usable) throw new AppError(503, 'Weather is temporarily unavailable.');

  return {
    ...cache.data,
    updatedAt: new Date(cache.fetchedAt).toISOString(),
    ageSeconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
  };
}

/** Test helper. */
// Clears the cache and state so each test can start fresh. Only meant for tests.
function _reset() {
  cache = null;
  inFlight = null;
  lastFailureAt = 0;
}

module.exports = { getWeather, _reset };
