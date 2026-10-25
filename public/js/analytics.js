/*
 * Impact Analytics: views over time for one article, with clear markers for every moment an editor
 * approved and published (or updated) it, and average views/hour before vs. after each update.
 * Important: Chart.js draws the line chart (allowed by the assignment); our own small plugin
 * draws the vertical lines and labels at the moments an update was published.
 */
(function () {
  'use strict';

  // Grab the page elements. If the page or the Chart.js library is missing, show an error and stop.
  const root = document.getElementById('analytics');
  if (!root || typeof Chart === 'undefined') {
    if (root) root.insertAdjacentElement('afterbegin', DW.el('p', { class: 'form-error', role: 'alert', text: 'The chart library could not be loaded.' }));
    return;
  }

  const HOUR = 3600 * 1000; // one hour in milliseconds
  const search = document.getElementById('a-q');
  const results = document.getElementById('a-results');
  const pagerBox = document.getElementById('a-pager');
  const rangeSel = document.getElementById('a-range');
  const windowSel = document.getElementById('a-window');
  const canvas = document.getElementById('views-chart');
  const statusEl = document.getElementById('chart-status');
  const titleEl = document.getElementById('chart-article');
  const markersList = document.getElementById('markers-list');

  // Module-level state: the chosen article, the current page of the picker list, the chart object,
  // and the controller used to cancel an old request.
  const state = { articleId: '', page: 1, chart: null, controller: null };

  /* ------------------------------ chart plugin ------------------------------ */
  // Colours: green for the first publish, pink for updates, purple for the views line.
  const COLORS = { initial: '#12935a', update: '#e8336f', line: '#5236e0' };

  /** Draws a vertical line + label for every publish event, and dotted before/after average lines. */
  // Important: Chart.js has no built-in "publish marker", so this is our own plugin.
  // Chart.js calls afterDatasetsDraw each time the chart is drawn, and we paint on top of it using the canvas.
  const markerPlugin = {
    id: 'publishMarkers',
    // Chart.js calls this after it drew the line; here we draw the marker lines and labels on the canvas.
    afterDatasetsDraw(chart, args, opts) {
      const markers = (opts && opts.markers) || [];
      const { ctx, chartArea, scales } = chart;
      if (!markers.length) return;
      ctx.save();
      const rowEnds = []; // right edge of the last label in each row, so labels never overlap
      markers.forEach((m) => {
        const t = new Date(m.at).getTime();
        // Skip markers that are outside the time range we are showing.
        if (t < scales.x.min || t > scales.x.max) return;
        const x = scales.x.getPixelForValue(t);
        const color = COLORS[m.kind] || COLORS.update;

        // average views/hour before and after (dotted horizontal segments)
        const cmp = m.comparison || {};
        const boundary = Math.floor(t / HOUR) * HOUR;
        // Draws one dotted horizontal line at the average height, between two moments in time.
        const seg = (avg, fromT, toT) => {
          if (!avg) return;
          const x1 = scales.x.getPixelForValue(Math.max(fromT, scales.x.min));
          const x2 = scales.x.getPixelForValue(Math.min(toT, scales.x.max));
          const y = scales.y.getPixelForValue(avg.avgPerHour);
          ctx.beginPath();
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.65;
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        };
        if (m.kind === 'update') {
          seg(cmp.before, boundary - cmp.before?.hours * HOUR, boundary);
          seg(cmp.after, boundary + HOUR, boundary + HOUR + (cmp.after ? cmp.after.hours : 0) * HOUR);
        }

        // vertical marker
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();

        // label: placed in the first row where it does not overlap the previous label
        ctx.setLineDash([]);
        const text = (m.kind === 'initial' ? 'Published ' : 'Updated ') + new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        ctx.font = '600 12px Arial, sans-serif';
        const w = ctx.measureText(text).width + 10;
        const labelX = Math.min(Math.max(x - w / 2, chartArea.left), chartArea.right - w);
        let row = rowEnds.findIndex((end) => labelX > end + 4);
        if (row === -1) row = rowEnds.length;
        rowEnds[row] = labelX + w;
        const labelY = chartArea.top + 4 + row * 20;
        ctx.fillStyle = color;
        ctx.fillRect(labelX, labelY, w, 18);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, labelX + 5, labelY + 9);
      });
      ctx.restore();
    },
  };

  /* ------------------------------ data ------------------------------ */
  // Builds the query string for the stats API from the two dropdowns:
  // how many hours to compare before/after, and where the time range starts.
  function rangeParams() {
    const params = new URLSearchParams({ windowHours: windowSel.value });
    if (rangeSel.value === 'all') {
      params.set('from', 'first');
    } else {
      params.set('from', new Date(Date.now() - Number(rangeSel.value) * HOUR).toISOString());
    }
    return params;
  }

  // Loads the hourly views of the chosen article and redraws the chart and the list of markers.
  // Important: if the user changes something quickly, the old request is cancelled (AbortController)
  // so an old slow answer can't overwrite the newer one.
  async function loadSeries() {
    if (!state.articleId) return;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    statusEl.textContent = 'Loading...';
    try {
      const data = await DW.api('GET', '/api/v1/stats/articles/' + encodeURIComponent(state.articleId) + '?' + rangeParams(), undefined, { signal: controller.signal });
      titleEl.replaceChildren(DW.el('strong', { text: data.article.title }), ' - ' + data.article.totalViews + ' views in total');
      drawChart(data);
      renderMarkers(data);
      statusEl.textContent = data.totalInRange + ' views in the selected range.';
    } catch (err) {
      // A cancelled request is not a real error, so we ignore it.
      if (err.name === 'AbortError') return;
      statusEl.textContent = err.message;
      statusEl.className = 'form-error';
    }
  }

  // Makes the text for the time axis. For short ranges (3 days or less) it includes the hour, otherwise only the date.
  function tickLabel(value, spanHours) {
    const d = new Date(value);
    return spanHours <= 72
      ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  // Creates the Chart.js line chart from the data we got, and hands the publish markers to our plugin.
  function drawChart(data) {
    statusEl.className = 'muted';
    // Each point is: x = time, y = number of views in that hour.
    const pts = data.points.map((p) => ({ x: p.t, y: p.count }));
    const min = pts.length ? pts[0].x : 0;
    const max = pts.length ? pts[pts.length - 1].x : 1;
    const spanHours = (max - min) / HOUR;

    // Remove the old chart first, otherwise Chart.js complains that the canvas is already used.
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: 'Views per hour',
          data: pts,
          borderColor: COLORS.line,
          backgroundColor: 'rgba(82, 54, 224, 0.14)',
          fill: true,
          borderWidth: 2,
          pointRadius: spanHours <= 72 ? 2 : 0,
          pointHoverRadius: 4,
          tension: 0.25,
        }],
      },
      plugins: [markerPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min,
            max,
            title: { display: true, text: 'Time' },
            ticks: { maxTicksLimit: 8, callback: (v) => tickLabel(v, spanHours) },
          },
          y: { beginAtZero: true, title: { display: true, text: 'Views per hour' }, ticks: { precision: 0 } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Tooltip title = the time of the point, tooltip line = number of views.
              title: (items) => DW.formatDateTime(items[0].parsed.x),
              label: (item) => item.parsed.y + ' views',
            },
          },
          // These are the options our plugin reads (opts.markers in afterDatasetsDraw).
          publishMarkers: { markers: data.markers },
        },
      },
    });
  }

  // Turns the before/after comparison into one readable sentence, e.g. "Before: 5 views/hour -> After: 9 views/hour (+80%)".
  function describe(cmp) {
    if (!cmp || (!cmp.before && !cmp.after)) return 'Not enough data to compare.';
    const before = cmp.before ? cmp.before.avgPerHour + ' views/hour' : 'no earlier data';
    const after = cmp.after ? cmp.after.avgPerHour + ' views/hour' : 'not enough time has passed yet';
    let change = '';
    if (cmp.changePct !== null && cmp.changePct !== undefined) change = ' (' + (cmp.changePct > 0 ? '+' : '') + cmp.changePct + '%)';
    return 'Before: ' + before + '  ->  After: ' + after + change;
  }

  // Fills the "Published updates" list under the chart, one line per publish event with its before/after numbers.
  function renderMarkers(data) {
    markersList.replaceChildren();
    if (!data.markers.length) {
      markersList.append(DW.el('li', { class: 'muted', text: 'No publish events in the selected range.' }));
      return;
    }
    // One list item per marker. The "trend" class (up / down) lets the CSS colour the text.
    data.markers.forEach((m) => {
      const cmp = m.comparison;
      const trend = cmp && cmp.changePct > 0 ? 'up' : cmp && cmp.changePct < 0 ? 'down' : '';
      markersList.append(
        DW.el('li', { class: 'marker marker-' + m.kind },
          DW.el('span', { class: 'swatch', 'aria-hidden': 'true' }),
          DW.el('div', {},
            DW.el('strong', { text: (m.kind === 'initial' ? 'First published' : 'Update published') + ' - ' + DW.formatDateTime(m.at) }),
            DW.el('p', { class: 'trend ' + trend, text: m.kind === 'initial' ? 'The article was not visible to readers before this moment.' : describe(cmp) })))
      );
    });
  }

  /* ------------------------------ picker ------------------------------ */
  // Called when an article is chosen from the list: remembers it, highlights its button,
  // puts its id in the address bar (so the link can be shared) and loads its chart.
  function select(id, title) {
    state.articleId = id;
    results.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b.getAttribute('data-id') === id));
    if (title) titleEl.textContent = title;
    history.replaceState(null, '', '/editor/analytics?article=' + encodeURIComponent(id));
    loadSeries();
  }

  // Loads one page of published articles (optionally filtered by the search box) and shows them as buttons to pick from.
  async function loadResults() {
    const params = new URLSearchParams({ status: 'live', page: String(state.page), limit: '10' });
    if (search.value.trim()) params.set('q', search.value.trim());
    try {
      const data = await DW.api('GET', '/api/v1/manage/articles?' + params);
      results.replaceChildren();
      if (!data.items.length) results.append(DW.el('li', { class: 'muted', text: 'No published articles found.' }));
      data.items.forEach((item) => {
        results.append(DW.el('li', {},
          DW.el('button', {
            type: 'button', class: 'pick' + (item.id === state.articleId ? ' selected' : ''), 'data-id': item.id,
            // Click: choose this article for the chart.
            onclick: () => select(item.id, item.title),
          },
          DW.el('span', { class: 'pick-title', text: item.title }),
          DW.el('span', { class: 'muted small', text: item.category + ' - ' + item.viewCount + ' views' }))));
      });
      // Page buttons: when one is clicked, go to that page and reload the list.
      DW.pager(pagerBox, data.page, data.pages, (p) => {
        state.page = p;
        loadResults();
      });
    } catch (err) {
      results.replaceChildren(DW.el('li', { class: 'form-error', text: err.message }));
    }
  }

  // Search while typing, but wait 300 ms after the last key so we don't send a request on every letter (debounce).
  const debouncedSearch = DW.debounce(() => {
    state.page = 1;
    loadResults();
  }, 300);
  search.addEventListener('input', debouncedSearch);
  // Changing the time range or the before/after window redraws the chart.
  rangeSel.addEventListener('change', loadSeries);
  windowSel.addEventListener('change', loadSeries);

  loadResults();
  // If the page was opened with ?article=<id>, the server put it in data-preselect: open that chart straight away.
  // The regex only lets a 24-character hex id through (a MongoDB id).
  const pre = root.getAttribute('data-preselect');
  if (pre && /^[a-f0-9]{24}$/i.test(pre)) select(pre, '');
})();
