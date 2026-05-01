// ==UserScript==
// @name         COMO Batcher Timer
// @namespace    https://github.com/uny2-ops
// @version      4.7.0
// @description  Floating panel with live timers, daily history, weekly staffing data
// @author       Eitan Wiernik
// @match        https://como-operations-dashboard-iad.iad.proxy.amazon.com/store/*/dash*
// @match        https://como-operations-dashboard-iad.iad.proxy.amazon.com/store/*/tasks*
// @match        https://como-operations-dashboard-iad.iad.proxy.amazon.com/store/*/jobs*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ── Configuration ─────────────────────────────────────────────── */
  var POLL_MS  = 4000;
  var TICK_MS  = 1000;
  var WARN_ELAPSED_MIN  = 15;
  var ALERT_ELAPSED_MIN = 25;
  var WARN_RATE  = 2.1;
  var ALERT_RATE = 1.5;

  var COMO_BASE   = 'https://como-operations-dashboard-iad.iad.proxy.amazon.com';
  var STORAGE_KEY = 'cbt_history';
  var DATE_KEY    = 'cbt_history_date';
  var WEEKLY_KEY  = 'cbt_weekly_history';
  var WEEKLY_DAYS = 7;

  /* ── State ─────────────────────────────────────────────────────── */
  var taskCache        = new Map();
  var activeTab        = 'live';
  var weeklySortKey    = 'avgRate';
  var weeklySortAsc    = false;
  var weeklySearchTerm = '';
  var liveSortKey      = 'elapsed';
  var liveSortAsc      = false;
  var historySortKey   = 'avgRate';
  var historySortAsc   = false;
  var historySearchTerm = '';

  /* ── Helpers ───────────────────────────────────────────────────── */
  function todayStr() {
    return new Date().toLocaleDateString('en-US');
  }

  function fmt(s) {
    if (s == null || isNaN(s) || s < 0) return '--:--';
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' +
           String(Math.floor(s % 60)).padStart(2, '0');
  }

  function fmtHours(s) {
    if (!s) return '0h';
    var h = s / 3600;
    return h >= 1 ? h.toFixed(1) + 'h' : Math.round(s / 60) + 'm';
  }

  function getStoreId() {
    var m = window.location.pathname.match(/\/store\/([^/]+)/);
    return m ? m[1] : null;
  }

  /* ── Weekly Storage ────────────────────────────────────────────── */
  function loadWeekly() {
    try { return JSON.parse(localStorage.getItem(WEEKLY_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function saveWeekly(w) {
    try { localStorage.setItem(WEEKLY_KEY, JSON.stringify(w)); }
    catch (e) { /* ignore */ }
  }

  function pruneWeeklyOlderThan(days) {
    var w = loadWeekly();
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    var changed = false;
    for (var dk of Object.keys(w)) {
      if (new Date(dk) < cutoff) { delete w[dk]; changed = true; }
    }
    if (changed) saveWeekly(w);
    return w;
  }

  function rollDailyIntoWeekly() {
    try {
      var sd = localStorage.getItem(DATE_KEY);
      if (!sd) return;
      var daily = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (!Object.keys(daily).length) return;
      var w = loadWeekly();
      if (!w[sd]) w[sd] = {};
      for (var a of Object.keys(daily)) {
        var d = daily[a];
        w[sd][a] = {
          totalPkgs:     d.totalPkgs,
          totalSec:      d.totalSec,
          runs:          d.runs,
          avgRate:       d.avgRate,
          totalMissing:  d.totalMissing  || 0,
          totalExpected: d.totalExpected || 0
        };
      }
      saveWeekly(w);
    } catch (e) { /* ignore */ }
  }

  /* ── Daily History Storage ─────────────────────────────────────── */
  function loadHistory() {
    try {
      var sd = localStorage.getItem(DATE_KEY);
      if (sd !== todayStr()) {
        rollDailyIntoWeekly();
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(DATE_KEY, todayStr());
        return {};
      }
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (e) { return {}; }
  }

  function saveHistory(h) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
      localStorage.setItem(DATE_KEY, todayStr());
    } catch (e) { /* ignore */ }
  }

  /* ── Record a completed batch into daily history ────────────────── */
  function recordCompletedBatch(data, elapsedSec) {
    if (!data.associateId && !data.associate) return;
    var pkgs = data.packagesBatched || 0;
    if (pkgs === 0 || !elapsedSec) return;
    if (elapsedSec < 30) return;

    var assoc = data.associateId || data.associate;
    var rate  = pkgs / (elapsedSec / 60);

    var expected = data.totalExpectedPackages || 0;
    var collected = data.packagesCollected || data.packagesBatched || 0;
    var missing = expected > collected ? expected - collected : 0;

    var history = loadHistory();
    if (history[assoc]) {
      var e  = history[assoc];
      var tp = e.totalPkgs + pkgs;
      var ts = e.totalSec + elapsedSec;
      history[assoc] = {
        assoc:         assoc,
        totalPkgs:     tp,
        totalSec:      ts,
        runs:          e.runs + 1,
        avgRate:       tp / (ts / 60),
        lastRate:      rate,
        totalMissing:  (e.totalMissing  || 0) + missing,
        totalExpected: (e.totalExpected || 0) + expected
      };
    } else {
      history[assoc] = {
        assoc:         assoc,
        totalPkgs:     pkgs,
        totalSec:      elapsedSec,
        runs:          1,
        avgRate:       rate,
        lastRate:      rate,
        totalMissing:  missing,
        totalExpected: expected
      };
    }
    saveHistory(history);
    if (activeTab === 'history') renderHistory();
  }

  /* ── Compute live row metrics ──────────────────────────────────── */
  function computeRow(data) {
    var op = (data.operationDetails || []).find(function (o) {
      return o.name === 'BATCHING';
    });
    var startMs = op && op.start
      ? op.start * 1000
      : data.created ? data.created * 1000 : null;
    var inProgress = (op && op.state === 'IN_PROGRESS') || data.state === 'BATCHING';
    var batchedN   = data.packagesBatched || 0;
    var elapsedSec = startMs ? (Date.now() - startMs) / 1000 : null;
    var scanRate   = (batchedN > 0 && elapsedSec > 30)
      ? batchedN / (elapsedSec / 60)
      : null;
    return { startMs: startMs, elapsedSec: elapsedSec, scanRate: scanRate, inProgress: inProgress };
  }

  /* ── Data ingestion ────────────────────────────────────────────── */
  function ingestItem(item) {
    if (!item || typeof item !== 'object') return false;
    var ref = item.shortClientRef;
    if (!ref) return false;

    var existing = taskCache.get(ref);
    if (existing && existing.state === 'BATCHING' &&
        item.state !== 'BATCHING' && item.state !== undefined) {
      existing._recording = true;
      taskCache.set(ref, existing);
      var merged = Object.assign({}, existing, item);
      var r = computeRow(merged);
      recordCompletedBatch(merged, r.elapsedSec);
      taskCache.delete(ref);
      return true;
    }

    if (item.state !== 'BATCHING' && item.operationState !== 'IN_PROGRESS') return false;
    taskCache.set(ref, item);
    return true;
  }

  function ingestData(d) {
    if (!d) return;
    var changed = false;
    if (Array.isArray(d)) {
      d.forEach(function (i) { if (ingestItem(i)) changed = true; });
    } else if (d.shortClientRef) {
      if (ingestItem(d)) changed = true;
    } else {
      for (var k of ['summaries', 'tasks', 'results', 'items', 'jobs', 'data']) {
        if (Array.isArray(d[k])) {
          d[k].forEach(function (i) { if (ingestItem(i)) changed = true; });
          if (changed) break;
        }
      }
    }
    if (changed) renderPanel();
  }

  /* ── Prune stale cache entries ─────────────────────────────────── */
  async function pruneCache(storeId) {
    for (var entry of taskCache.entries()) {
      var ref  = entry[0];
      var data = entry[1];
      if (data.state !== 'BATCHING' && !data._recording) {
        var finalData = data;
        if (data.jobId && storeId) {
          try {
            var res = await _origFetch(
              COMO_BASE + '/store/' + storeId + '/task/' + encodeURIComponent(data.jobId),
              { credentials: 'include', headers: { Accept: 'application/json' } }
            );
            if (res.ok) {
              var fresh = await res.json();
              var fi = fresh && fresh.shortClientRef
                ? fresh
                : ((fresh && (fresh.tasks || fresh.items || fresh.data)) || [fresh])
                    .find(function (t) { return t && t.shortClientRef === ref; });
              if (fi) finalData = Object.assign({}, data, fi);
            }
          } catch (e) { /* ignore */ }
        }
        var r = computeRow(finalData);
        recordCompletedBatch(finalData, r.elapsedSec);
        taskCache.delete(ref);
      }
    }
  }

  /* ── XHR / Fetch interception ──────────────────────────────────── */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, url) {
    this._cbtUrl = url;
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (!(this.getResponseHeader('content-type') || '').includes('json')) return;
        ingestData(JSON.parse(this.responseText));
      } catch (e) { /* ignore */ }
    });
    return _xhrSend.apply(this, arguments);
  };

  var _origFetch = window.fetch;
  window.fetch = async function () {
    var resp;
    try { resp = await _origFetch.apply(this, arguments); }
    catch (e) { throw e; }
    try {
      if ((resp.headers.get('content-type') || '').includes('json')) {
        resp.clone().json().then(function (d) { ingestData(d); }).catch(function () {});
      }
    } catch (e) { /* ignore */ }
    return resp;
  };

  /* ── Polling ───────────────────────────────────────────────────── */
  async function pollActiveTasks() {
    var storeId = getStoreId();
    if (!storeId) return;
    try {
      var res = await _origFetch(
        COMO_BASE + '/store/' + storeId + '/activeJobsWithSiteSummary',
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (res.ok) ingestData(await res.json());
    } catch (e) { /* ignore */ }

    for (var entry of taskCache.entries()) {
      var data = entry[1];
      if (!data.jobId) continue;
      try {
        var res2 = await _origFetch(
          COMO_BASE + '/store/' + storeId + '/task/' + encodeURIComponent(data.jobId),
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res2.ok) ingestData(await res2.json());
      } catch (e) { /* ignore */ }
    }
    await pruneCache(storeId);
    renderPanel();
  }

  /* ── Fetch historical jobs (weekly) ────────────────────────────── */
  async function fetchHistoricalJobs() {
    var storeId = getStoreId();
    if (!storeId) return;
    var now = new Date();

    for (var d = 0; d < 7; d++) {
      var dayStart = new Date(now);
      dayStart.setDate(dayStart.getDate() - d);
      dayStart.setHours(0, 0, 0, 0);
      var dayStartTs = dayStart.getTime();
      var dayEndTs = d === 0 ? Date.now() : (function () {
        var de = new Date(dayStart);
        de.setDate(de.getDate() + 1);
        return de.getTime();
      })();
      var dayKey = dayStart.toLocaleDateString('en-US');

      try {
        var res = await _origFetch(
          COMO_BASE + '/api/store/' + storeId + '/jobSummary/' + dayStartTs + '/' + dayEndTs,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (!res.ok) continue;
        var data = await res.json();
        var arr  = Array.isArray(data) ? data : [];
        var dayData = {};

        for (var i = 0; i < arr.length; i++) {
          var job = arr[i];
          if (job.state !== 'COMPLETED' && job.state !== 'DROPPING_COMPLETED') continue;
          var assoc = job.associateId || job.associate;
          if (!assoc) continue;
          var pkgs = job.packagesCollected || job.totalExpectedPackages || job.packagesBatched || 0;
          if (pkgs === 0) continue;

          var op = (job.operationDetails || []).find(function (o) { return o.name === 'BATCHING'; });
          var elSec = null;
          if (op && op.start && op.end) {
            elSec = op.start > 1e12 ? (op.end - op.start) / 1000 : (op.end - op.start);
          } else if (job.batchingTime && typeof job.batchingTime === 'number') {
            elSec = job.batchingTime;
          }
          if (!elSec || elSec < 30 || elSec > 7200) continue;

          if (!dayData[assoc]) {
            dayData[assoc] = { totalPkgs: 0, totalSec: 0, runs: 0, totalMissing: 0, totalExpected: 0 };
          }
          dayData[assoc].totalPkgs += pkgs;
          dayData[assoc].totalSec  += elSec;
          dayData[assoc].runs      += 1;

          var exp = job.totalExpectedPackages || 0;
          var col = job.packagesCollected || 0;
          dayData[assoc].totalMissing  += (exp > col ? exp - col : 0);
          dayData[assoc].totalExpected += exp;
        }

        for (var a in dayData) {
          dayData[a].avgRate = dayData[a].totalPkgs / (dayData[a].totalSec / 60);
        }

        var w = loadWeekly();
        w[dayKey] = dayData;
        saveWeekly(w);
      } catch (e) { /* ignore */ }
    }

    pruneWeeklyOlderThan(WEEKLY_DAYS);
    if (activeTab === 'weekly') renderWeekly();
  }

  /* ── Fetch today's completed jobs ──────────────────────────────── */
  async function fetchTodayJobs() {
    var storeId = getStoreId();
    if (!storeId) return;
    var dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    try {
      var res = await _origFetch(
        COMO_BASE + '/api/store/' + storeId + '/jobSummary/' + dayStart.getTime() + '/' + Date.now(),
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!res.ok) return;
      var data = await res.json();
      var arr  = Array.isArray(data) ? data : [];
      var history = loadHistory();
      var changed = false;

      for (var i = 0; i < arr.length; i++) {
        var job = arr[i];
        if (job.state !== 'COMPLETED' && job.state !== 'DROPPING_COMPLETED') continue;
        var assoc = job.associateId || job.associate;
        if (!assoc) continue;
        var pkgs = job.packagesCollected || job.totalExpectedPackages || 0;
        if (pkgs === 0) continue;

        var op = (job.operationDetails || []).find(function (o) { return o.name === 'BATCHING'; });
        var elSec = null;
        if (op && op.start && op.end) {
          elSec = op.start > 1e12 ? (op.end - op.start) / 1000 : (op.end - op.start);
        } else if (job.batchingTime && typeof job.batchingTime === 'number') {
          elSec = job.batchingTime;
        }
        if (!elSec || elSec < 30 || elSec > 7200) continue;

        var rate     = pkgs / (elSec / 60);
        var expected = job.totalExpectedPackages || 0;
        var collected = job.packagesCollected || 0;
        var missing  = expected > collected ? expected - collected : 0;

        if (history[assoc]) {
          var e  = history[assoc];
          var tp = e.totalPkgs + pkgs;
          var ts = e.totalSec + elSec;
          history[assoc] = {
            assoc:         assoc,
            totalPkgs:     tp,
            totalSec:      ts,
            runs:          e.runs + 1,
            avgRate:       tp / (ts / 60),
            lastRate:      rate,
            totalMissing:  (e.totalMissing  || 0) + missing,
            totalExpected: (e.totalExpected || 0) + expected
          };
        } else {
          history[assoc] = {
            assoc:         assoc,
            totalPkgs:     pkgs,
            totalSec:      elSec,
            runs:          1,
            avgRate:       rate,
            lastRate:      rate,
            totalMissing:  missing,
            totalExpected: expected
          };
        }
        changed = true;
      }

      if (changed) {
        saveHistory(history);
        if (activeTab === 'history') renderHistory();
      }
    } catch (e) { /* ignore */ }
  }

  /* ── Build the panel DOM ───────────────────────────────────────── */
  var panel = document.createElement('div');
  panel.id = 'cbt-panel';
  panel.innerHTML =
    '<div id="cbt-header">' +
      '<span id="cbt-title">\u23F1 Batcher Timers</span>' +
      '<div id="cbt-controls">' +
        '<span id="cbt-copy" class="cbt-copy-btn" title="Copy Table">\u2398</span>' +
        '<span id="cbt-minimize" title="Minimize">\u2500</span>' +
        '<span id="cbt-close" title="Hide">\u2715</span>' +
      '</div>' +
    '</div>' +

    '<div id="cbt-tabs">' +
      '<span class="cbt-tab active" data-tab="live">Live</span>' +
      '<span class="cbt-tab" data-tab="history">Today</span>' +
      '<span class="cbt-tab" data-tab="weekly">Weekly</span>' +
    '</div>' +

    '<div id="cbt-body">' +
      /* ── Live view ── */
      '<div id="cbt-live-view">' +
        '<table id="cbt-table"><thead><tr>' +
          '<th class="cbt-sortable-live" data-sort="assoc">Associate</th>' +
          '<th class="cbt-sortable-live" data-sort="elapsed">Elapsed \u25BC</th>' +
          '<th class="cbt-sortable-live" data-sort="rate">Bags/min</th>' +
        '</tr></thead><tbody id="cbt-tbody"></tbody></table>' +
        '<div id="cbt-empty">No active batching tasks</div>' +
        '<div id="cbt-updated"></div>' +
      '</div>' +

      /* ── Today / History view ── */
      '<div id="cbt-history-view" style="display:none">' +
        '<div id="cbt-hist-search">' +
          '<input id="cbt-hist-search-input" type="text" placeholder="Search associate..." />' +
        '</div>' +
        '<div id="cbt-hist-summary"></div>' +
        '<table id="cbt-hist-table"><thead><tr>' +
          '<th class="cbt-sortable-hist" data-sort="assoc">Associate</th>' +
          '<th class="cbt-sortable-hist" data-sort="runs">Runs</th>' +
          '<th class="cbt-sortable-hist" data-sort="pkgs">Pkgs</th>' +
          '<th class="cbt-sortable-hist" data-sort="avgRate">Avg Rate \u25BC</th>' +
        '</tr></thead><tbody id="cbt-hist-tbody"></tbody></table>' +
        '<div id="cbt-hist-empty">No history yet today</div>' +
      '</div>' +

      /* ── Weekly view ── */
      '<div id="cbt-weekly-view" style="display:none">' +
        '<div id="cbt-weekly-search">' +
          '<input id="cbt-search-input" type="text" placeholder="Search associate..." />' +
        '</div>' +
        '<div id="cbt-weekly-summary"></div>' +
        '<table id="cbt-weekly-table"><thead><tr>' +
          '<th class="cbt-sortable" data-sort="assoc">Associate</th>' +
          '<th class="cbt-sortable" data-sort="days">Days</th>' +
          '<th class="cbt-sortable" data-sort="runs">Runs</th>' +
          '<th class="cbt-sortable" data-sort="pkgs">Pkgs</th>' +
          '<th class="cbt-sortable" data-sort="avgRate">Avg Rate \u25BC</th>' +
          '<th class="cbt-sortable" data-sort="hrs">Hrs</th>' +
        '</tr></thead><tbody id="cbt-weekly-tbody"></tbody></table>' +
        '<div id="cbt-weekly-empty">No weekly data yet</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(panel);

  /* ── Styles ────────────────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent =
    '#cbt-panel{position:fixed;bottom:auto;right:auto;width:430px;background:#0d1117;' +
      'border:1px solid #30363d;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);' +
      'z-index:99999;font-family:"Segoe UI",system-ui,sans-serif;color:#e6edf3;' +
      'user-select:none;min-width:320px;resize:horizontal;overflow:hidden}' +
    '#cbt-panel.minimized #cbt-body{display:none}' +
    '#cbt-panel.minimized #cbt-tabs{display:none}' +

    '#cbt-header{display:flex;align-items:center;justify-content:center;padding:10px 12px;' +
      'background:#161b22;border-bottom:1px solid #30363d;border-radius:10px 10px 0 0;cursor:move}' +
    '#cbt-title{font-weight:700;font-size:15px;color:#58a6ff;letter-spacing:0.05em}' +
    '#cbt-controls{display:flex;gap:10px}' +
    '#cbt-controls span{color:#8b949e;cursor:pointer;font-size:15px;line-height:1}' +
    '#cbt-controls span:hover{color:#e6edf3}' +

    '#cbt-tabs{display:flex;justify-content:center;border-bottom:1px solid #30363d;' +
      'background:#161b22;padding:0 10px}' +
    '.cbt-tab{flex:1;text-align:center;padding:8px 0;font-size:13px;font-weight:600;' +
      'color:#e6edf3;cursor:pointer;letter-spacing:0.07em;text-transform:uppercase}' +
    '.cbt-tab:hover{color:#fff}' +
    '.cbt-tab.active{color:#58a6ff;border-bottom:2px solid #58a6ff}' +

    '#cbt-body{padding:8px 10px 10px;max-height:600px;overflow-y:auto}' +

    '#cbt-table,#cbt-hist-table,#cbt-weekly-table{width:100%;border-collapse:collapse}' +
    '#cbt-table thead tr,#cbt-hist-table thead tr,#cbt-weekly-table thead tr{' +
      'border-bottom:1px solid #21262d}' +
    '#cbt-table th,#cbt-hist-table th,#cbt-weekly-table th{color:#fff;font-weight:600;' +
      'font-size:14px;text-transform:uppercase;letter-spacing:0.07em;padding:4px 5px 7px;' +
      'text-align:left;background:#0d1117}' +
    '#cbt-table th:not(:first-child),#cbt-hist-table th:not(:first-child),' +
      '#cbt-weekly-table th:not(:first-child){text-align:center}' +
    '#cbt-table td,#cbt-hist-table td,#cbt-weekly-table td{padding:7px 5px;' +
      'border-bottom:1px solid #161b22;vertical-align:middle;text-align:center}' +
    '#cbt-table td:first-child,#cbt-hist-table td:first-child,' +
      '#cbt-weekly-table td:first-child{text-align:left}' +
    '#cbt-table tbody tr:last-child td,#cbt-hist-table tbody tr:last-child td,' +
      '#cbt-weekly-table tbody tr:last-child td{border-bottom:none}' +
    '#cbt-table tbody tr:hover td,#cbt-hist-table tbody tr:hover td,' +
      '#cbt-weekly-table tbody tr:hover td{background:#161b22}' +

    '.cbt-assoc{font-size:16px;font-weight:700;color:#e6edf3;user-select:text;cursor:pointer}' +
    '.cbt-assoc:hover{color:#58a6ff}' +
    '.cbt-ref{display:block;font-size:10px;color:#484f58;font-family:monospace;margin-top:1px}' +

    '.cbt-elapsed{font-family:"Courier New",monospace;font-size:18px;font-weight:700;' +
      'color:#3fb950;text-align:center;display:inline}' +
    '.cbt-elapsed.warn{color:#e3b341}.cbt-elapsed.alert{color:#f85149}' +

    '.cbt-rate{font-family:"Courier New",monospace;font-size:18px;font-weight:700;' +
      'color:#3fb950;text-align:center;display:inline}' +
    '.cbt-rate.warn{color:#e3b341}.cbt-rate.alert{color:#f85149}' +
    '.cbt-rate.pending{color:#484f58;font-style:italic;font-size:13px}' +

    '.cbt-hist-rate{font-family:"Courier New",monospace;font-size:18px;font-weight:700;' +
      'text-align:center;display:inline}' +
    '.cbt-hist-rate.good{color:#3fb950}.cbt-hist-rate.warn{color:#e3b341}' +
    '.cbt-hist-rate.alert{color:#f85149}' +

    '.cbt-hist-meta{font-size:17px;color:#e6edf3;text-align:center;display:inline}' +

    '.cbt-rank{display:inline-block;width:20px;height:20px;line-height:20px;border-radius:50%;' +
      'font-size:11px;font-weight:700;text-align:center;margin-right:6px;' +
      'background:#21262d;color:#8b949e}' +
    '.cbt-rank.gold{background:#b8860b;color:#fff}' +
    '.cbt-rank.silver{background:#555e6a;color:#fff}' +
    '.cbt-rank.bronze{background:#7d4a1e;color:#fff}' +

    '#cbt-empty,#cbt-hist-empty,#cbt-weekly-empty{display:none;text-align:center;' +
      'color:#484f58;padding:14px 0 6px;font-style:italic;font-size:13px}' +
    '#cbt-updated{text-align:right;color:#30363d;font-size:10px;margin-top:6px}' +

    '#cbt-weekly-summary,#cbt-hist-summary{display:flex;justify-content:space-around;' +
      'padding:8px 4px 10px;border-bottom:1px solid #21262d;margin-bottom:6px}' +
    '.cbt-ws-stat{text-align:center}' +
    '.cbt-ws-val{font-family:"Courier New",monospace;font-size:22px;font-weight:700;' +
      'color:#e6edf3;display:block}' +
    '.cbt-ws-label{font-size:12px;color:#ffffff;text-transform:uppercase;letter-spacing:0.08em}' +

    '#cbt-weekly-search,#cbt-hist-search{padding:8px 4px 4px;text-align:center}' +
    '#cbt-search-input,#cbt-hist-search-input{width:95%;padding:6px 10px;background:#161b22;' +
      'border:1px solid #30363d;border-radius:6px;color:#ffffff;font-size:15px;outline:none}' +
    '#cbt-search-input:focus,#cbt-hist-search-input:focus{border-color:#58a6ff}' +
    '#cbt-search-input::placeholder,#cbt-hist-search-input::placeholder{color:#8b949e}' +

    '.cbt-sortable,.cbt-sortable-live,.cbt-sortable-hist{cursor:pointer;user-select:none}' +
    '.cbt-sortable:hover,.cbt-sortable-live:hover,.cbt-sortable-hist:hover{color:#58a6ff}' +

    '.cbt-miss-good{color:#3fb950}.cbt-miss-warn{color:#e3b341}.cbt-miss-alert{color:#f85149}' +
    '.cbt-miss-dot{margin-left:6px;font-size:18px;vertical-align:middle}' +
    '.cbt-miss-dot.warn{color:#e3b341}.cbt-miss-dot.alert{color:#f85149}' +

    '.cbt-copy-btn{font-size:18px!important;padding:0 2px}';

  document.head.appendChild(css);

  /* ── Dragging ──────────────────────────────────────────────────── */
  var dragging = false, dragOffX = 0, dragOffY = 0;

  panel.querySelector('#cbt-header').addEventListener('mousedown', function (e) {
    if (e.target.closest('#cbt-controls')) return;
    dragging = true;
    dragOffX = e.clientX - panel.getBoundingClientRect().left;
    dragOffY = e.clientY - panel.getBoundingClientRect().top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - dragOffX));
    var y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - dragOffY));
    panel.style.right = panel.style.bottom = 'auto';
    panel.style.left = x + 'px';
    panel.style.top  = y + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (dragging) {
      localStorage.setItem('cbt_pos', JSON.stringify({ left: panel.style.left, top: panel.style.top }));
    }
    dragging = false;
  });

  /* ── Minimize / Close ──────────────────────────────────────────── */
  panel.querySelector('#cbt-minimize').addEventListener('click', function () {
    panel.classList.toggle('minimized');
    panel.querySelector('#cbt-minimize').textContent =
      panel.classList.contains('minimized') ? '\u25A1' : '\u2500';
  });

  panel.querySelector('#cbt-close').addEventListener('click', function () {
    panel.style.display = 'none';
  });

  /* ── Tab switching ─────────────────────────────────────────────── */
  panel.querySelectorAll('.cbt-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      panel.querySelectorAll('.cbt-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      document.getElementById('cbt-live-view').style.display    = activeTab === 'live'    ? '' : 'none';
      document.getElementById('cbt-history-view').style.display = activeTab === 'history' ? '' : 'none';
      document.getElementById('cbt-weekly-view').style.display  = activeTab === 'weekly'  ? '' : 'none';
      if (activeTab === 'history') renderHistory();
      if (activeTab === 'weekly')  renderWeekly();
    });
  });

  /* ── Search inputs ─────────────────────────────────────────────── */
  document.addEventListener('input', function (e) {
    if (e.target.id === 'cbt-search-input') {
      weeklySearchTerm = e.target.value;
      renderWeekly();
    }
    if (e.target.id === 'cbt-hist-search-input') {
      historySearchTerm = e.target.value;
      renderHistory();
    }
  });

  /* ── Sort handlers ─────────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var th = e.target.closest('.cbt-sortable');
    if (!th || !document.getElementById('cbt-weekly-table').contains(th)) return;
    var key = th.dataset.sort;
    if (weeklySortKey === key) { weeklySortAsc = !weeklySortAsc; }
    else { weeklySortKey = key; weeklySortAsc = false; }
    renderWeekly();
  });

  document.addEventListener('click', function (e) {
    var th = e.target.closest('.cbt-sortable-live');
    if (!th || !document.getElementById('cbt-table').contains(th)) return;
    var key = th.dataset.sort;
    if (liveSortKey === key) { liveSortAsc = !liveSortAsc; }
    else { liveSortKey = key; liveSortAsc = false; }
    renderPanel();
  });

  document.addEventListener('click', function (e) {
    var th = e.target.closest('.cbt-sortable-hist');
    if (!th || !document.getElementById('cbt-hist-table').contains(th)) return;
    var key = th.dataset.sort;
    if (historySortKey === key) { historySortAsc = !historySortAsc; }
    else { historySortKey = key; historySortAsc = false; }
    renderHistory();
  });

  /* ── Copy associate name on click ──────────────────────────────── */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('.cbt-assoc');
    if (!el || !panel.contains(el)) return;
    var text = el.textContent.replace(/^\d+/, '').trim();
    navigator.clipboard.writeText(text).then(function () {
      el.style.color = '#3fb950';
      setTimeout(function () { el.style.color = ''; }, 500);
    });
  });

  /* ── Copy table to clipboard ───────────────────────────────────── */
  function copyTable(tableId) {
    var table = document.getElementById(tableId);
    if (!table) return;
    var txt = '';
    table.querySelectorAll('tr').forEach(function (tr) {
      var cells = [];
      tr.querySelectorAll('th,td').forEach(function (c, ci) {
        var val = c.textContent.trim();
        if (ci === 0) val = val.replace(/^\d+\s*/, '').replace(/\u25CF/g, '').trim();
        cells.push(val);
      });
      txt += cells.join('\t') + '\n';
    });
    var btn = panel.querySelector('#cbt-copy');
    navigator.clipboard.writeText(txt).then(function () {
      btn.textContent = '\u2714';
      btn.style.color = '#3fb950';
      setTimeout(function () { btn.textContent = '\u2398'; btn.style.color = ''; }, 1000);
    });
  }

  panel.querySelector('#cbt-copy').addEventListener('click', function () {
    if (activeTab === 'live')         copyTable('cbt-table');
    else if (activeTab === 'history') copyTable('cbt-hist-table');
    else if (activeTab === 'weekly')  copyTable('cbt-weekly-table');
  });

  /* ── Render: Live tab ──────────────────────────────────────────── */
  function renderPanel() {
    if (activeTab !== 'live') return;
    var tbody = document.querySelector('#cbt-tbody');
    var empty = document.querySelector('#cbt-empty');
    if (!tbody || !empty) return;

    var rows = [];
    taskCache.forEach(function (d) { if (d.state === 'BATCHING') rows.push(d); });

    rows.sort(function (a, b) {
      var ra = computeRow(a), rb = computeRow(b);
      var va, vb;
      if (liveSortKey === 'assoc') {
        va = (a.associateId || a.associate || a.shortClientRef || '').toLowerCase();
        vb = (b.associateId || b.associate || b.shortClientRef || '').toLowerCase();
        return liveSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      } else if (liveSortKey === 'rate') {
        va = ra.scanRate || 0;
        vb = rb.scanRate || 0;
      } else {
        va = ra.elapsedSec || 0;
        vb = rb.elapsedSec || 0;
      }
      return liveSortAsc ? va - vb : vb - va;
    });

    if (rows.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var data = rows[i];
      var assoc    = data.associateId || data.associate || data.shortClientRef;
      var shortRef = data.shortClientRef;
      var r = computeRow(data);

      var elMin = r.elapsedSec != null ? r.elapsedSec / 60 : 0;
      var elCls = r.elapsedSec != null
        ? (elMin >= ALERT_ELAPSED_MIN ? 'alert' : elMin >= WARN_ELAPSED_MIN ? 'warn' : '')
        : '';
      var elTxt = r.elapsedSec != null ? fmt(r.elapsedSec) : '--:--';

      var rateCls = r.scanRate != null
        ? (r.scanRate < ALERT_RATE ? 'alert' : r.scanRate < WARN_RATE ? 'warn' : '')
        : 'pending';
      var rateTxt = r.scanRate != null ? r.scanRate.toFixed(1) : '\u2014';

      html += '<tr data-ref="' + shortRef + '">';
      html += '<td><span class="cbt-assoc">' + assoc + '</span>' +
              '<span class="cbt-ref">' + shortRef + '</span></td>';
      html += '<td><span class="cbt-elapsed ' + elCls + '"' +
              ' data-start="' + (r.startMs || '') + '"' +
              ' data-live="' + (r.inProgress ? '1' : '0') + '">' + elTxt + '</span></td>';
      html += '<td><span class="cbt-rate ' + rateCls + '">' + rateTxt + '</span></td></tr>';
    }
    tbody.innerHTML = html;

    document.querySelector('#cbt-updated').textContent =
      'updated ' + new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

    var ths = document.querySelectorAll('#cbt-table .cbt-sortable-live');
    ths.forEach(function (th) {
      var ar = th.dataset.sort === liveSortKey ? (liveSortAsc ? ' \u25B2' : ' \u25BC') : '';
      var lb = th.textContent.replace(/ [\u25B2\u25BC]/g, '');
      th.textContent = lb + ar;
    });
  }

  /* ── Render: Today / History tab ───────────────────────────────── */
  function renderHistory() {
    var tbody   = document.querySelector('#cbt-hist-tbody');
    var empty   = document.querySelector('#cbt-hist-empty');
    var summary = document.querySelector('#cbt-hist-summary');
    if (!tbody || !empty) return;

    var history = loadHistory();
    var entries = Object.values(history);

    if (entries.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      if (summary) summary.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    /* ── Summary: Batchers | Avg Rate | Avg Miss % ── */
    if (summary) {
      var tA = entries.length;
      var tS = entries.reduce(function (s, e) { return s + e.totalSec; }, 0);
      var oR = entries.reduce(function (s, e) { return s + e.totalPkgs; }, 0) / (tS / 60);

      var tMissing  = entries.reduce(function (s, e) { return s + (e.totalMissing  || 0); }, 0);
      var tExpected = entries.reduce(function (s, e) { return s + (e.totalExpected || 0); }, 0);
      var avgMissPct = tExpected > 0 ? (tMissing / tExpected * 100) : 0;
      var mC = avgMissPct <= 1 ? 'cbt-miss-good' : avgMissPct <= 3 ? 'cbt-miss-warn' : 'cbt-miss-alert';

      summary.innerHTML =
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val">' + tA + '</span>' +
          '<span class="cbt-ws-label">Batchers</span>' +
        '</div>' +
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val">' + oR.toFixed(1) + '</span>' +
          '<span class="cbt-ws-label">Avg Rate</span>' +
        '</div>' +
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val ' + mC + '">' + avgMissPct.toFixed(1) + '%</span>' +
          '<span class="cbt-ws-label">Avg Miss %</span>' +
        '</div>';
    }

    /* ── Filter & sort ── */
    var filtered = entries;
    if (historySearchTerm) {
      var term = historySearchTerm.toLowerCase();
      filtered = entries.filter(function (e) {
        return e.assoc.toLowerCase().indexOf(term) !== -1;
      });
    }

    filtered.sort(function (a, b) {
      var va, vb;
      if (historySortKey === 'assoc') {
        va = a.assoc.toLowerCase();
        vb = b.assoc.toLowerCase();
        return historySortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      } else if (historySortKey === 'runs') {
        va = a.runs; vb = b.runs;
      } else if (historySortKey === 'pkgs') {
        va = a.totalPkgs; vb = b.totalPkgs;
      } else {
        va = a.avgRate; vb = b.avgRate;
      }
      return historySortAsc ? va - vb : vb - va;
    });

    /* ── Rows ── */
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      var rateCls = e.avgRate >= WARN_RATE ? 'good' : e.avgRate >= ALERT_RATE ? 'warn' : 'alert';
      var rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

      var missPct = (e.totalExpected || 0) > 0
        ? ((e.totalMissing || 0) / e.totalExpected * 100)
        : 0;
      var missDot = missPct > 3
        ? '<span class="cbt-miss-dot alert" title="' + missPct.toFixed(1) + '% missing">\u25CF</span>'
        : missPct > 1
          ? '<span class="cbt-miss-dot warn" title="' + missPct.toFixed(1) + '% missing">\u25CF</span>'
          : '';

      html += '<tr>';
      html += '<td><span class="cbt-assoc">' +
              '<span class="cbt-rank ' + rankCls + '">' + (i + 1) + '</span>' +
              e.assoc + missDot + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + e.runs + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + e.totalPkgs + '</span></td>';
      html += '<td><span class="cbt-hist-rate ' + rateCls + '">' + e.avgRate.toFixed(1) + '</span></td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;

    /* ── Update sort arrows ── */
    var ths = document.querySelectorAll('#cbt-hist-table .cbt-sortable-hist');
    ths.forEach(function (th) {
      var ar = th.dataset.sort === historySortKey ? (historySortAsc ? ' \u25B2' : ' \u25BC') : '';
      var lb = th.textContent.replace(/ [\u25B2\u25BC]/g, '');
      th.textContent = lb + ar;
    });
  }

  /* ── Render: Weekly tab ────────────────────────────────────────── */
  function renderWeekly() {
    var tbody   = document.querySelector('#cbt-weekly-tbody');
    var empty   = document.querySelector('#cbt-weekly-empty');
    var summary = document.querySelector('#cbt-weekly-summary');
    if (!tbody || !empty) return;

    var weekly = pruneWeeklyOlderThan(WEEKLY_DAYS);
    var agg = {};

    for (var dayKey of Object.keys(weekly)) {
      for (var assoc of Object.keys(weekly[dayKey])) {
        var d = weekly[dayKey][assoc];
        if (!agg[assoc]) {
          agg[assoc] = {
            assoc: assoc, totalPkgs: 0, totalSec: 0, runs: 0,
            totalMissing: 0, totalExpected: 0, daysSet: new Set()
          };
        }
        agg[assoc].totalPkgs     += d.totalPkgs;
        agg[assoc].totalSec      += d.totalSec;
        agg[assoc].runs          += d.runs;
        agg[assoc].totalMissing  += (d.totalMissing  || 0);
        agg[assoc].totalExpected += (d.totalExpected || 0);
        agg[assoc].daysSet.add(dayKey);
      }
    }

    var all = Object.values(agg).map(function (a) {
      return {
        assoc:    a.assoc,
        totalPkgs: a.totalPkgs,
        totalSec:  a.totalSec,
        runs:      a.runs,
        days:      a.daysSet.size,
        avgRate:   a.totalPkgs / (a.totalSec / 60),
        hrs:       a.totalSec,
        missPct:   a.totalExpected > 0 ? (a.totalMissing / a.totalExpected * 100) : 0
      };
    });

    if (all.length === 0) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
      if (summary) summary.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    /* ── Summary ── */
    if (summary) {
      var tA = all.length;
      var tS = all.reduce(function (s, e) { return s + e.totalSec; }, 0);
      var oR = all.reduce(function (s, e) { return s + e.totalPkgs; }, 0) / (tS / 60);
      var tM = all.reduce(function (s, e) { return s + e.missPct; }, 0) / tA;
      var mC = tM <= 1 ? 'cbt-miss-good' : tM <= 3 ? 'cbt-miss-warn' : 'cbt-miss-alert';

      summary.innerHTML =
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val">' + tA + '</span>' +
          '<span class="cbt-ws-label">Batchers</span>' +
        '</div>' +
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val">' + oR.toFixed(1) + '</span>' +
          '<span class="cbt-ws-label">Avg Rate</span>' +
        '</div>' +
        '<div class="cbt-ws-stat">' +
          '<span class="cbt-ws-val ' + mC + '">' + tM.toFixed(1) + '%</span>' +
          '<span class="cbt-ws-label">Avg Miss %</span>' +
        '</div>';
    }

    /* ── Filter & sort ── */
    var filtered = all;
    if (weeklySearchTerm) {
      var term = weeklySearchTerm.toLowerCase();
      filtered = all.filter(function (e) {
        return e.assoc.toLowerCase().indexOf(term) !== -1;
      });
    }

    filtered.sort(function (a, b) {
      var va, vb;
      if (weeklySortKey === 'assoc') {
        va = a.assoc.toLowerCase(); vb = b.assoc.toLowerCase();
        return weeklySortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      } else if (weeklySortKey === 'days')    { va = a.days;     vb = b.days; }
        else if (weeklySortKey === 'runs')    { va = a.runs;     vb = b.runs; }
        else if (weeklySortKey === 'pkgs')    { va = a.totalPkgs; vb = b.totalPkgs; }
        else if (weeklySortKey === 'avgRate') { va = a.avgRate;  vb = b.avgRate; }
        else if (weeklySortKey === 'hrs')     { va = a.hrs;      vb = b.hrs; }
        else                                  { va = a.avgRate;  vb = b.avgRate; }
      return weeklySortAsc ? va - vb : vb - va;
    });

    /* ── Rows ── */
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      var rateCls = e.avgRate >= WARN_RATE ? 'good' : e.avgRate >= ALERT_RATE ? 'warn' : 'alert';
      var rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      var missDot = e.missPct > 3
        ? '<span class="cbt-miss-dot alert" title="' + e.missPct.toFixed(1) + '% missing">\u25CF</span>'
        : e.missPct > 1
          ? '<span class="cbt-miss-dot warn" title="' + e.missPct.toFixed(1) + '% missing">\u25CF</span>'
          : '';

      html += '<tr>';
      html += '<td><span class="cbt-assoc">' +
              '<span class="cbt-rank ' + rankCls + '">' + (i + 1) + '</span>' +
              e.assoc + missDot + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + e.days + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + e.runs + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + e.totalPkgs + '</span></td>';
      html += '<td><span class="cbt-hist-rate ' + rateCls + '">' + e.avgRate.toFixed(1) + '</span></td>';
      html += '<td><span class="cbt-hist-meta">' + fmtHours(e.totalSec) + '</span></td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;

    /* ── Update sort arrows ── */
    var ths = document.querySelectorAll('#cbt-weekly-table .cbt-sortable');
    ths.forEach(function (th) {
      var ar = th.dataset.sort === weeklySortKey ? (weeklySortAsc ? ' \u25B2' : ' \u25BC') : '';
      var lb = th.textContent.replace(/ [\u25B2\u25BC]/g, '');
      th.textContent = lb + ar;
    });
  }

  /* ── Live elapsed tick ─────────────────────────────────────────── */
  function tick() {
    document.querySelectorAll('.cbt-elapsed[data-live="1"]').forEach(function (el) {
      var startMs = parseFloat(el.dataset.start);
      if (!startMs) return;
      var sec = (Date.now() - startMs) / 1000;
      var min = sec / 60;
      el.className = 'cbt-elapsed ' +
        (min >= ALERT_ELAPSED_MIN ? 'alert' : min >= WARN_ELAPSED_MIN ? 'warn' : '');
      el.textContent = fmt(sec);
    });
  }

  /* ── Debounced DOM-mutation poll ───────────────────────────────── */
  var scanTimer = null;
  function debouncedPoll() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(pollActiveTasks, 500);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var m of mutations) {
      if (panel.contains(m.target) || m.target === panel) return;
    }
    debouncedPoll();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  /* ── Restore saved position ────────────────────────────────────── */
  var savedPos = JSON.parse(localStorage.getItem('cbt_pos') || 'null');
  if (savedPos) {
    panel.style.left = savedPos.left;
    panel.style.top  = savedPos.top;
  } else {
    panel.style.top   = '100px';
    panel.style.right = '18px';
  }

  /* ── Start intervals & initial fetches ─────────────────────────── */
  setInterval(pollActiveTasks, POLL_MS);
  setInterval(tick, TICK_MS);
  setTimeout(pollActiveTasks,      1500);
  setTimeout(fetchHistoricalJobs,  3000);
  setTimeout(fetchTodayJobs,       4000);

  console.log('[COMO Batcher Timer] v4.7.0 loaded \u2713');
})();
