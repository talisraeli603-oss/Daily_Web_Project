/*
 * Sidebar weather widget. The data comes from our own server, which gets it from OpenWeatherMap and caches it.
 * Important: the browser never calls OpenWeatherMap for data, so the API key (WEATHER_API_KEY) stays secret on the server.
 */
(function () {
  'use strict';

  // The box where the weather is shown. If the page has no such box, the script stops.
  const body = document.getElementById('weather-body');
  if (!body) return;

  // Draws the weather (icon, temperature, city, description, details) into the box, replacing what was there.
  // Important: built with DW.el (textContent), not innerHTML. The icon name is escaped with encodeURIComponent before it goes in the image URL.
  function render(data) {
    const icon = data.icon ? DW.el('img', { class: 'weather-icon', src: 'https://openweathermap.org/img/wn/' + encodeURIComponent(data.icon) + '@2x.png', alt: '', width: '64', height: '64' }) : null;
    body.replaceChildren(
      DW.el('div', { class: 'weather-main' },
        icon,
        DW.el('p', { class: 'weather-temp', text: data.temperature + '\u00B0C' })),
      DW.el('p', { class: 'weather-city', text: data.city + (data.country ? ', ' + data.country : '') }),
      DW.el('p', { class: 'weather-desc', text: data.description }),
      DW.el('ul', { class: 'weather-details' },
        DW.el('li', { text: 'Feels like ' + data.feelsLike + '\u00B0C' }),
        DW.el('li', { text: 'Humidity ' + data.humidity + '%' }),
        DW.el('li', { text: 'Wind ' + data.windSpeed + ' m/s' })),
      DW.el('p', { class: 'muted small', text: 'Updated ' + DW.formatDateTime(data.updatedAt) })
    );
  }

  // Asks our server for the weather and shows it. If it fails, shows the error and a Retry button.
  // Important: fetch (through DW.api) is used for Ajax. noRedirect means a logged-out visitor is not sent to the login page just for the widget.
  async function load() {
    try {
      render(await DW.api('GET', '/api/v1/weather', undefined, { noRedirect: true }));
    } catch (err) {
      body.replaceChildren(
        DW.el('p', { class: 'muted', text: err.message || 'Weather is unavailable right now.' }),
        DW.el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Retry', onclick: load })
      );
    }
  }

  // Load the weather once when the page opens.
  load();
  // keep the widget fresh for people who leave the page open (server data is at most 15 minutes old)
  setInterval(load, 10 * 60 * 1000);
})();
