'use strict';

/**
 * Generates a colourful SVG placeholder image for demo articles, so the project works offline
 * and does not depend on (or copy) third-party images.
 *   GET /placeholder/:category/:seed.svg
 */
const { CATEGORIES } = require('../config/constants');

// The base colour (hue, 0-360) for each category, so every category has its own colour.
const HUES = { Politics: 355, World: 205, Business: 150, Technology: 265, Science: 185, Health: 120, Sports: 28, Culture: 320 };

// Turns a text into a number (a simple hash, FNV-1a style). The same text always gives the same number,
// so the same seed always makes the same picture, but different seeds look different.
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Builds the SVG picture: a gradient background, 6 random-looking circles and the category name.
// Important: the category is printed inside the SVG, so it must be in the allowed list (else 'World'),
// which stops strange text from the URL getting into the image. The seed is cut to 40 characters.
// The Cache-Control header at the end lets browsers keep the image for one day.
exports.svg = (req, res) => {
  const category = CATEGORIES.includes(req.params.category) ? req.params.category : 'World';
  const seed = String(req.params.seed || '0').slice(0, 40);
  const h = hash(`${category}:${seed}`);
  const hue = (HUES[category] + (h % 40) - 20 + 360) % 360;
  const shapes = [];
  for (let i = 0; i < 6; i++) {
    const r = hash(`${seed}:${i}`);
    const cx = r % 800;
    const cy = (r >> 8) % 450;
    const size = 60 + ((r >> 16) % 160);
    const light = 45 + ((r >> 4) % 25);
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${size}" fill="hsl(${(hue + i * 14) % 360} 70% ${light}%)" opacity="0.35"/>`);
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" role="img" aria-label="${category}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 65% 28%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 70% 48%)"/></linearGradient></defs>` +
    `<rect width="800" height="450" fill="url(#g)"/>${shapes.join('')}` +
    // centred, so the label stays visible however the image is cropped by the page layout
    `<text x="400" y="240" text-anchor="middle" font-family="Arial, sans-serif" font-size="56" font-weight="700" fill="#fff" opacity="0.9">${category.toUpperCase()}</text></svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
};
