'use strict';

const weatherService = require('../services/weatherService');
const { asyncHandler } = require('../utils/helpers');

// GET /weather (public) - returns the current weather as JSON, from the weather service.
// Important: the Cache-Control header lets browsers reuse the answer for 60 seconds, so we make fewer requests.
exports.current = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60'); // browsers/proxies may reuse it for a minute
  res.json(await weatherService.getWeather());
});
