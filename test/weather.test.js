'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A fake OpenWeatherMap server, so the tests never need a real API key or internet access.
// upstreamCalls counts how many times our code called the fake server; upstreamMode switches it between working and broken.
let upstreamCalls = 0;
let upstreamMode = 'ok'; // 'ok' | 'fail'
// The fake server itself: counts every request, then either answers with an error (500) or with fixed weather data.
const fake = http.createServer((req, res) => {
  upstreamCalls++;
  if (upstreamMode === 'fail') {
    res.writeHead(500);
    return res.end('boom');
  }
  res.setHeader('Content-Type', 'application/json');
  // slow answer so concurrent callers overlap
  setTimeout(
    // Sends the fake weather JSON (21.6 degrees, which our code rounds to 22).
    () =>
      res.end(
        JSON.stringify({
          name: 'Testville',
          sys: { country: 'IL' },
          main: { temp: 21.6, feels_like: 22, humidity: 40 },
          wind: { speed: 3.2 },
          weather: [{ description: 'clear sky', icon: '01d' }],
        })
      ),
    50
  );
});

// weather = the real weatherService (loaded later, after the test settings are ready).
// realNow / offset = a trick to fake time: Date.now() is replaced with "real time + offset", so tests can jump minutes ahead without waiting.
let weather;
const realNow = Date.now;
let offset = 0;

// Runs once before all tests: starts the fake server, sets fake settings, fakes the clock, then loads the weather service.
// Important: the service must be loaded AFTER the environment variables are set, because it reads them when it loads.
test.before(async () => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unused';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.WEATHER_API_KEY = 'test-key';
  process.env.WEATHER_API_URL = `http://127.0.0.1:${fake.address().port}/weather`;
  Date.now = () => realNow() + offset; // move time forward without waiting
  weather = require('../services/weatherService');
});

// Runs once after all tests: puts the real clock back and shuts the fake server down.
test.after(() => {
  Date.now = realNow;
  fake.close();
});

// One minute in milliseconds, used to jump the fake clock forward.
const MINUTE = 60 * 1000;

// Proves the in-flight sharing works: 1000 visitors asking at the same moment cause only ONE call to OpenWeatherMap.
test('1000 simultaneous users cause exactly one upstream request', async () => {
  const results = await Promise.all(Array.from({ length: 1000 }, () => weather.getWeather()));
  assert.equal(upstreamCalls, 1);
  assert.equal(results[0].temperature, 22);
  assert.equal(results[0].city, 'Testville');
});

// Proves that 9 minutes later the cached data is used and no new upstream call is made.
test('data is served from the cache for 10 minutes', async () => {
  offset += 9 * MINUTE;
  await weather.getWeather();
  assert.equal(upstreamCalls, 1);
});

// Proves that once the data is over 10 minutes old, the visitor still gets the old data instantly and a refresh runs in the background.
test('after 10 minutes the data is refreshed in the background', async () => {
  offset += 2 * MINUTE; // 11 minutes old
  const data = await weather.getWeather(); // answered immediately from the cache
  assert.equal(data.temperature, 22);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(upstreamCalls, 2);
});

// Proves that when OpenWeatherMap is down, the old data is still shown (under 15 minutes), and we don't hammer the broken server (30 second pause).
test('if the upstream fails the cached value is served while it is under 15 minutes old', async () => {
  upstreamMode = 'fail';
  offset += 11 * MINUTE; // last good value is 11 minutes old
  const data = await weather.getWeather();
  assert.equal(data.temperature, 22);
  await new Promise((r) => setTimeout(r, 100));
  const calls = upstreamCalls;
  await weather.getWeather(); // within 30s of the failure: must not hammer the upstream again
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(upstreamCalls, calls);
});

// Proves the 15 minute limit: if the data is too old and the refresh fails, we answer with a 503 error instead of showing stale data.
test('data older than 15 minutes is never shown: the widget reports "unavailable"', async () => {
  offset += 6 * MINUTE; // 17 minutes old, failure backoff has passed
  await assert.rejects(() => weather.getWeather(), (err) => err.status === 503);
});

// Proves that once OpenWeatherMap works again, the widget gets fresh data right away (age is only a few seconds).
test('the widget recovers when the upstream is back', async () => {
  upstreamMode = 'ok';
  offset += 1 * MINUTE;
  const data = await weather.getWeather();
  assert.equal(data.temperature, 22);
  assert.ok(data.ageSeconds < 5);
});
