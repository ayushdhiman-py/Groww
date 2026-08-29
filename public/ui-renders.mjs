// ============================================================
// PHASE 5: RENDER FUNCTIONS
// ============================================================

// ── Utility Functions ────────────────────────────────────────

/**
 * Save both scroll positions that matter here before a wholesale
 * tbody.innerHTML replacement, and return a function that restores them.
 * `.tw` has no max-height, so in practice the page (body/window) is usually
 * the element that's actually scrolling, not `.tw` itself — replacing many
 * rows' worth of DOM at once can still shift/clamp either one, so both are
 * captured. (renderStocks avoids this entirely via in-place row patching
 * instead of wholesale replacement; renderIntraday/renderCritical don't do
 * that, hence needing this.)
 */
function captureScroll() {
  const tableContainer = document.querySelector('.tw');
  const tableScrollPos = tableContainer ? tableContainer.scrollTop : 0;
  const pageScrollPos = window.scrollY;
  return () => {
    if (tableContainer) tableContainer.scrollTop = tableScrollPos;
    window.scrollTo(window.scrollX, pageScrollPos);
  };
}

// Paints the ↑/↓ (and multi-sort position number) onto whichever #tableHeader
// <th> elements have a sort onclick handler matching a column currently in
// sortStack — shared by renderStocks and renderIntraday so both tables'
// clickable headers show the same feedback.
function updateSortIndicators(sortStack) {
  document.querySelectorAll('#tableHeader th').forEach(th => {
    const onClick = th.getAttribute('onclick');
    if (!onClick) return;
    const colMatch = onClick.match(/'([^']+)'/);
    if (!colMatch) return;
    const col = colMatch[1];
    const idx = sortStack?.findIndex(s => s.col === col);

    th.querySelectorAll('.sort-meta').forEach(m => m.remove());
    if (idx !== -1 && idx != null) {
      const s = sortStack[idx];
      const span = document.createElement('span');
      span.className = 'sort-meta';
      span.innerHTML = (sortStack.length > 1 ? (idx + 1) + ' ' : '') + (s.asc ? '↑' : '↓');
      th.appendChild(span);
    }
  });
}

// Short, always-visible label per data_quality.mjs SOURCE value — no hover
// needed to know what it means.
const FRESHNESS_LABEL = { live: 'LIVE', delayed: 'DLY', estimated: 'EST', unavailable: 'N/A' };

/**
 * A small colored, LABELED tag next to any live-data value so a genuinely
 * live price is never visually indistinguishable from a delayed/historical/
 * estimated/unavailable one — the label and age are printed directly, not
 * hidden behind a hover. `source` is one of the data_quality.mjs SOURCE
 * values; `ts` (epoch ms, may be null) renders as the real age; `extraText`
 * (from candleFreshnessNote below) appends a second, visible clause instead
 * of a tooltip.
 */
function freshnessDot(source, ts, extraText = '') {
  const cls = (source || 'UNAVAILABLE').toLowerCase();
  const label = FRESHNESS_LABEL[cls] || cls.slice(0, 3).toUpperCase();
  const ageTxt = ts ? ` ${Math.round((Date.now() - ts) / 1000)}s` : '';
  return `<span class="freshness-tag freshness-${cls}">${label}${ageTxt}</span>${extraText}`;
}

/**
 * A row's `price`/`priceTs` refresh on a fast WS-driven cadence, but its
 * technical fields (EMA/MACD/RSI/VWAP/day-high-low/Opportunity Score — every
 * scoreXxx() input in entry_score.mjs) only refresh when that symbol is
 * actually Stage-2-analyzed this cycle (see scanner.mjs's persistent `_ALL`
 * buckets under the two-stage scan). A row can legitimately show a 2-second-
 * old price next to several-minutes-old indicators with no visible sign of
 * it — this makes that honestly visible as its own small printed clause
 * rather than inventing a separate color-coded staleness threshold, and
 * rather than hiding it behind a hover.
 */
function candleFreshnessNote(r) {
  if (r.candleTs == null) return '';
  const ageS = Math.round((Date.now() - r.candleTs) / 1000);
  return `<span class="muted-xl" style="font-size:8px;opacity:0.7;"> · ind ${ageS}s</span>`;
}

// Stocks-tab Score column — labeled so each pill is self-explanatory without
// a hover or a separate legend.
const CHECK_DEFS = [
  { key: 'Golden Cross (EMA 21>50)', alt: 'EMA 21 above 50', label: 'EMA' },
  { key: 'MACD Bull cross', alt: 'MACD above signal', label: 'MACD' },
  { key: 'Vol spike + price up', label: 'VOL' },
  { key: 'RSI healthy (45-75)', label: 'RSI' },
  { key: 'Price > VWAP', label: 'VWAP' },
];

// Opportunity Score buckets (entry_score.mjs computeOpportunityScore) —
// each bucket's raw sub-score is out of its own DEFAULT_WEIGHTS max
// (model_registry.mjs), used here purely to normalize the visual bar.
const BREAKDOWN_MAX = { priceAction: 20, openingStrength: 15, vwap: 15, orb: 15, volume: 15, relativeStrength: 15, confirmation: 10, orderFlow: 8 };
const BREAKDOWN_LABELS = { priceAction: 'PA', openingStrength: 'OPEN', vwap: 'VWAP', orb: 'ORB', volume: 'VOL', relativeStrength: 'RS', confirmation: 'CONF', orderFlow: 'FLOW' };

// A compact, always-visible segmented bar turning the Opportunity Score's
// component buckets (previously computed server-side but never shown) into
// a scannable visual instead of a single opaque number.
function renderBreakdownBar(breakdown) {
  if (!breakdown) return '';
  const segs = Object.entries(breakdown).map(([key, b]) => {
    const max = BREAKDOWN_MAX[key] || 20;
    const pct = Math.max(0, Math.min(100, Math.round(((b?.score || 0) / max) * 100)));
    const color = pct >= 66 ? 'var(--green)' : pct >= 33 ? 'var(--yellow)' : 'var(--red)';
    return `<div class="bd-seg">
      <div class="bd-seg-track"><div class="bd-seg-fill" style="width:${pct}%;background:${color};"></div></div>
      <div class="bd-seg-label">${BREAKDOWN_LABELS[key] || key}</div>
    </div>`;
  }).join('');
  return `<div class="bd-bar">${segs}</div>`;
}

function formatVolume(v) {
  if (!v) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 10000000) return sign + (abs / 10000000).toFixed(1) + 'Cr';
  if (abs >= 100000) return sign + (abs / 100000).toFixed(1) + 'L';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(0) + 'K';
  return String(v);
}

function generateSparkline(priceHist, ema21Hist, ema50Hist) {
  if (!priceHist || !ema21Hist || !ema50Hist || priceHist.length < 2) return '';

  const w = 150, h = 45;
  // Filter to finite values only — a symbol near its EMA50 warm-up point can
  // carry leading nulls in ema50Hist, and Math.min/max would otherwise treat
  // null as 0 and silently corrupt the whole chart's vertical scale.
  const all = [...priceHist, ...ema21Hist, ...ema50Hist].filter(Number.isFinite);
  const min = Math.min(...all), max = Math.max(...all), range = max - min || 1;

  const getX = i => (i / (priceHist.length - 1)) * w;
  const getY = v => h - ((v - min) / range) * h;

  // A period-N EMA is null for its first N-1 points by definition (not
  // enough history yet to average) — plotting those anyway (the old
  // behavior) fed `null` straight into getY, which type-coerces it to 0 and
  // draws a line jumping to a garbage y-position instead of just not being
  // there yet. Skip straight to the first real value and only draw through
  // finite ones — a shorter-but-correct line instead of a longer-but-broken
  // one, and correct for the price line too even though it's never null.
  const mkPath = (arr, cls) => {
    const startIdx = arr.findIndex(Number.isFinite);
    if (startIdx === -1) return '';
    let d = `M ${getX(startIdx)} ${getY(arr[startIdx])}`;
    for (let i = startIdx + 1; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      d += ` L ${getX(i)} ${getY(arr[i])}`;
    }
    return `<path class='${cls}' d='${d}' />`;
  };

  // Cross markers — a white dot wherever EMA21 (short) actually crosses
  // EMA50 (long) within the visible window, interpolated to the true
  // crossing point between the two candles rather than snapped to one of
  // them.
  let crossMarkers = '';
  for (let i = 1; i < ema21Hist.length; i++) {
    const p21 = ema21Hist[i - 1], p50 = ema50Hist[i - 1], c21 = ema21Hist[i], c50 = ema50Hist[i];
    if (![p21, p50, c21, c50].every(Number.isFinite)) continue;
    const prevDiff = p21 - p50, currDiff = c21 - c50;
    if (prevDiff === 0 || currDiff === 0 || (prevDiff > 0) === (currDiff > 0)) continue;
    const t = prevDiff / (prevDiff - currDiff);
    const x = getX(i - 1) + t * (getX(i) - getX(i - 1));
    const y = getY(p21 + t * (c21 - p21));
    crossMarkers += `<circle class='spark-cross' cx='${x.toFixed(2)}' cy='${y.toFixed(2)}' r='2.2' />`;
  }

  return `<svg class='sparkline' viewBox='0 0 ${w} ${h}'>`
    + mkPath(priceHist, 'spark-p')
    + mkPath(ema50Hist, 'spark-50')
    + mkPath(ema21Hist, 'spark-21')
    + crossMarkers
    + `</svg>`;
}

function generateRangeBar(low, high, current) {
  if (!low || !high || !current || low >= high) {
    return `<span class="rng-val">${low ? low.toFixed(1) : '—'} / ${high ? high.toFixed(1) : '—'}</span>`;
  }

  let pct = ((current - low) / (high - low)) * 100;
  pct = Math.max(0, Math.min(100, pct));

  return `<div class="rng-wrap">
    <span class="rng-val" style="text-align:right;">${low.toFixed(1)}</span>
    <div class="rng-bar"><div class="rng-marker" style="left:${pct.toFixed(1)}%"></div></div>
    <span class="rng-val" style="text-align:left;">${high.toFixed(1)}</span>
  </div>`;
}

// ── VIRTUALIZED RENDERING: "All" chip's ~500-row table ──────────────────
// content-visibility (index.html) skips paint for vertically off-screen
// rows, but rows currently in the vertical viewport still get fully
// painted regardless of horizontal scroll position — with 500 rows in the
// DOM, that's still a lot of paint surface. This keeps only the rows
// actually on screen (+ a small buffer) in the DOM at all, using two
// spacer <tr>s to hold the correct total scrollable height — the standard
// technique for virtualizing a native <table> without breaking column
// alignment. Row height is measured from the first real row actually
// painted rather than hardcoded, so the spacer math can't silently drift
// out of sync with whatever the browser actually rendered.
let virtRows = [];
let virtMaxVolume = 1;
let virtRowHeight = 52; // seed estimate; replaced by a real measurement after first paint
let virtSortCol = null;
let virtSortAsc = false;

// Column -> field on the cheap snapshot row. 'symbol' sorts alphabetically;
// everything else is numeric, missing values always sort last regardless
// of direction (a "—" cell isn't meaningfully "0").
const VIRT_SORT_COLS = {
  symbol: 'symbol', price: 'price', change: 'chgPctCheap',
  volume: 'volumeCheap', ema: 'emaGapCheap', score: 'score',
};

function applyVirtSort(rows) {
  if (!virtSortCol) return rows;
  const field = VIRT_SORT_COLS[virtSortCol];
  const asc = virtSortAsc;
  return rows.slice().sort((a, b) => {
    if (virtSortCol === 'symbol') {
      const r = (a.symbol || '').localeCompare(b.symbol || '');
      return asc ? r : -r;
    }
    const va = a[field], vb = b[field];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;  // missing always last
    if (vb == null) return -1;
    return asc ? va - vb : vb - va;
  });
}

// Click a "All" chip header to sort by it — same column again reverses
// direction. Self-contained (not the shared SortManager other chips use):
// that manager re-renders from dataManager.cache, which this view never
// populates, so it would've silently re-fetched the heavy Stage-2 endpoint
// on every sort click instead of just re-sorting what's already in memory.
window.sortAllStocks = function (col) {
  if (virtSortCol === col) { virtSortAsc = !virtSortAsc; } else { virtSortCol = col; virtSortAsc = col !== 'symbol'; }
  renderStocksAllVirtualized(window.universeSnapshotCache || []);
};
let virtRowHeightMeasured = false;
let virtScrollBound = false;
let virtTicking = false;

// "ALL" timeframe only makes sense once search has narrowed to exactly one
// stock (see stage1_filter.mjs's computeSymbolAllTimeframes for why a
// universe-wide "ALL" isn't offered at all — ~7x the background cost for a
// feature only useful on one stock at a time). Same search-matching logic
// as SearchFilter.filterRows (ui-managers.mjs), just scoped to symbol/sector
// since universeSnapshotCache rows don't carry signal/rating.
function getSingleStockMatch() {
  const query = (window.stateManager?.get('searchQuery') || '').trim().toUpperCase();
  if (!query) return null;
  const terms = query.split(',').map(t => t.replace(/\s+/g, '').trim()).filter(Boolean);
  if (!terms.length) return null;

  const matches = (window.universeSnapshotCache || []).filter(r => {
    if (r.sector === 'INDEX') return false;
    const sym = (r.symbol || '').toUpperCase().replace(/\s+/g, '');
    const sec = (r.sector || '').toUpperCase().replace(/\s+/g, '');
    return terms.some(t => sym.includes(t) || sec.includes(t));
  });
  return matches.length === 1 ? matches[0].symbol : null;
}
window.getSingleStockMatch = getSingleStockMatch;

// Greys out (and functionally disables — see TimeframeManager.selectTimeframe
// in ui-core.mjs) the "ALL" dropdown option unless search currently matches
// exactly one stock; auto-reverts away from ALL if it's selected but the
// condition stops holding (search cleared, or now matches more than one).
function updateAllTfAvailability() {
  const allOption = document.querySelector('#tfOptions .option[data-value="ALL"]');
  if (!allOption) return;
  const singleMatch = getSingleStockMatch();
  allOption.classList.toggle('option-disabled', !singleMatch);

  if (!singleMatch && window.stateManager?.get('timeframe') === 'ALL') {
    const fallbackEl = document.querySelector('#tfOptions .option[data-value="5m"]');
    window.timeframeManager?.selectTimeframe('5m', fallbackEl);
  }
}
window.updateAllTfAvailability = updateAllTfAvailability;

// Renders exactly what /api/universe-snapshot returns for one symbol — no
// merging with any other data source, no derived/synthesized fields.
function buildAllStocksRowHtml(r, maxVolume) {
  const chg = r.chgPctCheap;
  const cc = chg == null ? '' : chg >= 0 ? 'up' : 'dn';
  const chgTxt = chg == null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
  const priceTxt = r.price == null ? '—' : `₹${r.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol.toUpperCase())}`;
  // '5m' — the candle timeframe stage1_filter.mjs's cheap snapshot actually
  // uses for priceHist/ema21Hist/ema50Hist (in ALL mode too — the blend only
  // applies to the EMA-status/Score reading, not the visual chart, since a
  // line chart needs one continuous series); openModalChart falls back to
  // this same data (see ui-renders.mjs) when no Stage-2 row exists yet.
  const rawTf = window.stateManager?.get('timeframe');
  const chartTf = rawTf && rawTf !== 'ALL' ? rawTf : '5m';
  const chartTxt = `<div style='cursor:pointer; opacity:0.85;' onclick="window.openModalChart('${r.symbol}', '${chartTf}')">${generateSparkline(r.priceHist, r.ema21Hist, r.ema50Hist)}</div>`;

  const volBarPct = r.volumeCheap == null ? 0 : Math.round((r.volumeCheap / maxVolume) * 100);
  const volTxt = r.volumeCheap == null ? '—' : formatVolume(r.volumeCheap);

  let emaTxt;
  if (r.ema21aboveCheap == null) {
    emaTxt = `<span class="muted-xl">—</span>`;
  } else {
    const emaCls = r.ema21aboveCheap ? 'ea' : 'eb';
    const emaColor = r.ema21aboveCheap ? 'var(--green)' : 'var(--red)';
    emaTxt = `<div class='${emaCls} muted-xl' style='font-weight:600; color:${emaColor}'>EMA 21 ${r.ema21aboveCheap ? '>' : '<'} 50</div>
      <div class="muted-xl ${cc}" style="font-weight:600;">Gap ${Math.abs(r.emaGapCheap || 0).toFixed(2)}%</div>`;
  }

  // Score/Why — same 8-factor engine as the Intraday tab (see
  // stage1_filter.mjs's computeMoverScore), tf-aware; reuses moverScoreColor
  // defined above for the Intraday row.
  let scoreTxt;
  if (r.score == null) {
    scoreTxt = `<span class="muted-xl">—</span>`;
  } else {
    const color = moverScoreColor(r.score);
    const whyTxt = (r.reasons || []).join(' · ') || 'No standout factor';
    scoreTxt = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        <span style="font-weight:800;font-size:14px;font-family:var(--mono);color:${color};">${r.score}</span>
        <span class="muted-xl why-line" style="opacity:1;max-width:140px;">${whyTxt}</span>
      </div>`;
  }

  return `<tr class='main-row virt-row' id="row-${r.symbol}">
    <td style="text-align:left;">
      <div style="display:flex; align-items:baseline; gap:8px;">
        <span class='sym'><a href="${nseUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:none;">${r.symbol}</a></span>
        <span class="price-bold">${priceTxt}</span>
      </div>
      <span class='muted-xl' style="text-transform:uppercase;">${r.sector || ''} <span class="${cc}">(${chgTxt})</span></span>
    </td>
    <td data-label="Chart"><div style="display:flex; justify-content:center;">${chartTxt}</div></td>
    <td data-label="Volume">
      <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
        <div style="font-size:13px; font-weight:700; font-family:var(--mono);">${volTxt}</div>
        <div style="width:60px; height:7px; background:rgba(255,255,255,0.07); border-radius:6px; overflow:hidden;">
          <div class="vb-normal" style="width:${volBarPct}%; height:100%; border-radius:6px; background:var(--accent);"></div>
        </div>
      </div>
    </td>
    <td data-label="EMA">
      <div style="display:flex; flex-direction:column; align-items:center; gap:3px;">${emaTxt}</div>
    </td>
    <td data-label="Score">${scoreTxt}</td>
  </tr>`;
}

function renderStocksAllVirtualized(rows) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const tableHeader = document.getElementById('tableHeader');
  if (!tbody) return;

  // Indices (NIFTY/BANKNIFTY/etc) have their own capsule strip above the
  // table — they aren't individual stocks, so they don't belong mixed in
  // with 500 actual symbols here.
  rows = rows.filter(r => r.sector !== 'INDEX');
  const totalCount = rows.length;
  rows = window.searchFilter?.filterRows(rows) || rows;

  if (tableHeader) {
    const arrow = col => virtSortCol === col ? `<span class="sort-meta">${virtSortAsc ? '↑' : '↓'}</span>` : '';
    const th = (col, label) => `<th onclick="window.sortAllStocks('${col}')" style="cursor:pointer;">${label}${arrow(col)}</th>`;
    tableHeader.innerHTML = `<tr>
      ${th('symbol', 'Stock')}
      <th>Chart</th>
      ${th('volume', 'Volume')}
      ${th('ema', 'EMA')}
      ${th('score', 'Score')}
    </tr>`;
  }

  rows = applyVirtSort(rows);
  virtRows = rows;
  virtMaxVolume = Math.max(...rows.map(x => x.volumeCheap || 0), 1);

  const rcEl = document.getElementById('rowCount');
  if (rcEl) rcEl.textContent = `Stocks: ${rows.length} of ${totalCount}`;

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) { empty.classList.remove('loading'); empty.style.display = 'block'; empty.textContent = totalCount ? 'No stocks match your search.' : 'No data yet.'; }
    return;
  }
  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  if (!virtScrollBound) {
    virtScrollBound = true;
    const onScroll = () => {
      if (virtTicking) return;
      virtTicking = true;
      requestAnimationFrame(() => {
        virtTicking = false;
        const st = window.stateManager?.get();
        // Single-symbol "ALL" timeframe mode (see renderSingleSymbolAllTimeframes)
        // renders a plain, non-virtualized 7-row table into the same #tbody —
        // without this check, this handler would still fire on scroll and
        // clobber it with paintVirtualWindow()'s stale virtRows from the last
        // normal 500-row render, visibly collapsing it down to whatever
        // fraction of virtRows the current scroll position happened to window
        // into.
        if (st?.activeTab === 'STOCKS' && (st.stockFilter || 'ALL') === 'ALL' && st.timeframe !== 'ALL') paintVirtualWindow();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    document.querySelector('.tw')?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  paintVirtualWindow();
}

function paintVirtualWindow() {
  const tbody = document.getElementById('tbody');
  const anchor = tbody?.closest('table');
  if (!tbody || !anchor || !virtRows.length) return;

  const total = virtRows.length;
  const scrolledPast = Math.max(0, -anchor.getBoundingClientRect().top);
  const buffer = 12;
  let startIdx = Math.floor(scrolledPast / virtRowHeight) - buffer;
  startIdx = Math.max(0, Math.min(startIdx, total - 1));
  const visibleSlots = Math.ceil(window.innerHeight / virtRowHeight) + buffer * 2;
  const endIdx = Math.min(total, startIdx + visibleSlots);

  const topH = startIdx * virtRowHeight;
  const bottomH = (total - endIdx) * virtRowHeight;
  const blankTd = `<td colspan="5" style="padding:0;border:none;"></td>`;

  tbody.innerHTML =
    `<tr aria-hidden="true" style="height:${topH}px;">${blankTd}</tr>` +
    virtRows.slice(startIdx, endIdx).map(r => buildAllStocksRowHtml(r, virtMaxVolume)).join('') +
    `<tr aria-hidden="true" style="height:${bottomH}px;">${blankTd}</tr>`;

  // Self-correct the row-height estimate from what the browser actually
  // rendered ONCE, so spacer heights stay accurate instead of drifting from
  // a hardcoded guess — but only once, not every repaint: reading
  // getBoundingClientRect right after an innerHTML write forces a
  // synchronous layout flush, which is fine a single time but would add
  // real cost done on every scroll-driven repaint (up to 60/sec).
  if (!virtRowHeightMeasured) {
    const measured = tbody.querySelector('tr.virt-row')?.getBoundingClientRect().height;
    if (measured) {
      virtRowHeightMeasured = true;
      if (Math.abs(measured - virtRowHeight) > 1) { virtRowHeight = measured; paintVirtualWindow(); return; }
    }
  }
}

// ── "ALL" timeframe, single symbol only ─────────────────────────────────────
// See stage1_filter.mjs's computeSymbolAllTimeframes: 7 real timeframes for
// ONE stock (never the whole universe — that would be ~7x the background
// cost for a feature only useful on one stock at a time). Price/sector come
// from the already-loaded universeSnapshotCache (tf-agnostic, canonical);
// only the chart/EMA/Score per row are genuinely per-timeframe.
function buildSymbolTfRowHtml(symbol, r) {
  const chartTxt = `<div style='cursor:pointer; opacity:0.85;' onclick="window.openModalChart('${symbol}', '${r.tf}')">${generateSparkline(r.priceHist, r.ema21Hist, r.ema50Hist)}</div>`;

  let emaTxt;
  if (r.ema21aboveCheap == null) {
    emaTxt = `<span class="muted-xl">—</span>`;
  } else {
    const emaColor = r.ema21aboveCheap ? 'var(--green)' : 'var(--red)';
    emaTxt = `<div class='muted-xl' style='font-weight:600; color:${emaColor}'>EMA 21 ${r.ema21aboveCheap ? '>' : '<'} 50</div>
      <div class="muted-xl" style="font-weight:600;">Gap ${Math.abs(r.emaGapCheap || 0).toFixed(2)}%</div>`;
  }

  let scoreTxt;
  if (r.score == null) {
    scoreTxt = `<span class="muted-xl">—</span>`;
  } else {
    const color = moverScoreColor(r.score);
    const whyTxt = (r.reasons || []).join(' · ') || 'No standout factor';
    scoreTxt = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        <span style="font-weight:800;font-size:14px;font-family:var(--mono);color:${color};">${r.score}</span>
        <span class="muted-xl why-line" style="opacity:1;max-width:200px;">${whyTxt}</span>
      </div>`;
  }

  return `<tr class="main-row">
      <td style="text-align:left;"><span class="sym" style="font-weight:700;">${r.tf}</span></td>
      <td data-label="Chart"><div style="display:flex; justify-content:center;">${chartTxt}</div></td>
      <td data-label="EMA"><div style="display:flex; flex-direction:column; align-items:center; gap:3px;">${emaTxt}</div></td>
      <td data-label="Score">${scoreTxt}</td>
    </tr>`;
}

function renderSingleSymbolAllTimeframes(payload) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const tableHeader = document.getElementById('tableHeader');
  if (!tbody) return;

  const symbol = payload?.symbol;
  const rows = payload?.rows || [];
  const canonical = (window.universeSnapshotCache || []).find(x => x.symbol === symbol);

  if (tableHeader) {
    tableHeader.innerHTML = `<tr>
      <th style="text-align:left;">Timeframe</th>
      <th>Chart</th>
      <th>EMA</th>
      <th>Score</th>
    </tr>`;
  }

  const rcEl = document.getElementById('rowCount');
  if (rcEl) {
    const priceTxt = canonical?.price == null ? '' : ` · ₹${canonical.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    rcEl.textContent = symbol ? `${symbol}${priceTxt} — all ${rows.length} timeframes` : 'No stock selected';
  }

  if (!symbol || !rows.length) {
    tbody.innerHTML = '';
    if (empty) { empty.classList.remove('loading'); empty.style.display = 'block'; empty.textContent = 'No data yet.'; }
    return;
  }
  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  tbody.innerHTML = rows.map(r => buildSymbolTfRowHtml(symbol, r)).join('');
}

// ── MAIN RENDER: STOCKS TAB — filter chips: All / Golden Cross / Buy / Sell / F&O ──
function renderStocks(data) {
  const state = window.stateManager.get();
  const activeTab = state.activeTab;
  const stockFilter = state.stockFilter || 'ALL';
  const timeframe = state.timeframe;
  const sortStack = state.sortStack;
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  // GUARD: Don't render stocks when on tabs with their own dedicated render
  // function / different table shape.
  if (activeTab !== 'STOCKS') {
    return;
  }

  // "All" chip + "ALL" timeframe together: single-symbol, 7-real-timeframes
  // view (see stage1_filter.mjs's computeSymbolAllTimeframes) — only ever
  // reachable once search has narrowed to exactly one stock (TimeframeManager
  // guards the selection itself), a completely different data shape from the
  // universe-wide table below.
  if (stockFilter === 'ALL' && timeframe === 'ALL') {
    renderSingleSymbolAllTimeframes(window.symbolAllTimeframesCache);
    return;
  }

  // "All" chip: one API (/api/universe-snapshot, via ui-main.mjs's poll into
  // window.universeSnapshotCache), shown directly — every Nifty-500 symbol
  // it returns, unfiltered, unsorted, not merged with any other data source.
  // Fully self-contained; skips all the Stage-2-data plumbing below.
  if (stockFilter === 'ALL') {
    renderStocksAllVirtualized(window.universeSnapshotCache || []);
    return;
  }

  // patchTable() below clears and reappends tbody's rows (stale-row cleanup
  // + fragment swap) even in the "in-place patch" path — on a tall ALL/
  // filter-chip view where the page itself (not just `.tw`) is what's
  // actually scrolled, that reset/reappend can clamp window.scrollY to 0
  // for a moment, and nothing was restoring it back. Same fix already
  // applied to Intraday/Critical/Screeners (see captureScroll's own
  // comment) — capture up front, restore on every exit path below.
  const restoreScroll = captureScroll();

  if (!data?.data) {
    console.warn('[Render] ❌ No data.data available');
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = 'No data available';
    }
    restoreScroll();
    return;
  }

  // Show default table header
  const tableHeader = document.getElementById('tableHeader');
  if (tableHeader) {
    tableHeader.innerHTML = `<tr>
      <th onclick="window.sortManager.handleSort('symbol', event)">Stock / Sector</th>
      <th onclick="window.sortManager.handleSort('price', event)">CMP</th>
      <th>Chart</th>
      <th onclick="window.sortManager.handleSort('emaGap', event)">EMA</th>
      <th onclick="window.sortManager.handleSort('volume', event)">Volume</th>
      <th onclick="window.sortManager.handleSort('macdVal', event)">MACD</th>
      <th class="range-col" onclick="window.sortManager.handleSort('dayH', event)">Day Range</th>
      <th class="range-col" onclick="window.sortManager.handleSort('w52H', event)">52W Range</th>
      <th onclick="window.sortManager.handleSort('techScore', event)">Score</th>
      <th onclick="window.sortManager.handleSort('rating', event)">Rating</th>
    </tr>`;
  }

  // Collect rows based on the active filter chip and timeframe. GOLDEN/BUY/
  // SELL buckets are pre-filtered server-side from ALL (scanner.mjs); F&O
  // re-sorts the ALL bucket by |volumeChange| instead of reading a bucket.
  let rows = [];

  if (stockFilter === 'FO') {
    const key = timeframe === 'ALL' ? '5m_ALL' : `${timeframe}_ALL`;
    const rawRows = data.data[key] || [];
    const sorted = rawRows.slice().sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange));
    rows = sorted.slice(0, 30);
  } else if (timeframe === 'ALL') {
    const allTfs = ['1m', '5m', '10m', '15m', '30m', '1h', '1d'];
    allTfs.forEach(t => {
      const key = `${t}_${stockFilter}`;
      const tfRows = data.data[key] || [];
      rows.push(...tfRows);
    });
  } else {
    const key = `${timeframe}_${stockFilter}`;
    rows = (data.data[key] || []).slice();
  }

  // Apply filters
  const rowsBeforeFilter = rows.length;
  rows = window.searchFilter?.filterRows(rows) || rows;

  // Apply sorting. NOTE: this must always honor the user's clicked column —
  // an earlier version hardcoded a symbol+timeframe grouping whenever
  // timeframe==='ALL', which silently discarded every sort click on that
  // view (rows always regrouped by symbol regardless of which header was
  // clicked). Ties fall back to symbol then timeframe order purely for
  // stable, readable grouping, never overriding the actual requested sort.
  if (sortStack?.length > 0) {
    const tfOrder = { '1m': 1, '5m': 2, '10m': 3, '15m': 4, '30m': 5, '1h': 6, '1d': 7 };

    rows.sort((a, b) => {
      const primary = window.sortManager?.compare(a, b, sortStack) || 0;
      if (primary !== 0 || timeframe !== 'ALL') return primary;
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      return (tfOrder[a.tf] || 0) - (tfOrder[b.tf] || 0);
    });
  }


  // Update row count
  const uniqueStocks = new Set(rows.map(r => r.symbol)).size;
  const totalStocks = data.universe || 0;
  const rcEl = document.getElementById('rowCount');
  if (rcEl) {
    if (stockFilter === 'FO') {
      const foMgr = window.foManager;
      const mm = Math.floor(foMgr?.countdown || 300 / 60);
      const ss = String((foMgr?.countdown || 300) % 60).padStart(2, '0');
      rcEl.textContent = `F&O: ${uniqueStocks} stocks · Next refresh: ${mm}m ${ss}s`;
    } else if (timeframe === 'ALL') {
      rcEl.textContent = `Stocks: ${uniqueStocks} of ${totalStocks} (${rows.length} signals)`;
    } else {
      rcEl.textContent = `Stocks: ${rows.length} of ${totalStocks}`;
    }
  }

  updateSortIndicators(sortStack);

  // Handle empty state. If the scan actually produced rows but a client-side
  // filter (search box, indices toggle, dividend toggle) stripped all of
  // them, say so specifically — otherwise this looks identical to "the
  // scanner is broken" when it's really just a stuck filter from a previous
  // session (these persist in localStorage).
  if (!rows.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      if (rowsBeforeFilter > 0) {
        const st = window.stateManager?.get() || {};
        const reasons = [];
        if (st.searchQuery?.trim()) reasons.push(`search "${st.searchQuery.trim()}"`);
        if (st.showDividend) reasons.push('the Dividend filter (no dividend data is currently available)');
        if (!st.showIndices && stockFilter !== 'FO') reasons.push('the Indices toggle being off');
        empty.textContent = reasons.length
          ? `${rowsBeforeFilter} stock(s) found, but hidden by: ${reasons.join(', ')}.`
          : `${rowsBeforeFilter} stock(s) found, but all were filtered out.`;
      } else {
        empty.textContent = 'No results for current filter.';
      }
    }
    restoreScroll();
    return;
  }

  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  // Row/sub-row DOM id. FO always shows one row per symbol (single timeframe
  // slice), so symbol alone is unique there. Every other tab can show the
  // SAME symbol once per timeframe when timeframe==='ALL', so the id must
  // include tf too — otherwise rows for the same symbol collide on one DOM
  // node and later timeframes silently overwrite/clobber earlier ones.
  const rowKeyFor = (r) => stockFilter === 'FO' ? r.symbol : `${r.symbol}::${r.tf}`;

  // Computed once per render, not per row — this used to be
  // `Math.max(...rows.map(...))` inline inside both renderRow and
  // patchTable's per-row loop below, making the whole render O(n²). Went
  // unnoticed while "All" only ever held Stage-2's ~100-row rotation subset;
  // at the full ~500-symbol universe it was 250k+ ops per render, on a table
  // that now re-renders every 2s — the direct cause of the reported lag.
  const maxVolume = Math.max(...rows.map(x => x.volume || 0), 1);

  // Render row function
  const renderRow = (r) => {
    const rowKey = rowKeyFor(r);
    const cc = r.chgPct >= 0 ? 'up' : 'dn';
    const chgP = (r.priceChange >= 0 ? '+' : '') + r.priceChange.toFixed(2);
    const chg = (r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%';
    const fullChg = `${chgP} (${chg})`;

    // EMA status
    let statusTxt = '';
    if (r.goldenCross) {
      statusTxt = `<div class='ea muted-xl' style='font-weight:700; color:var(--green)'>EMA 21 > 50</div>`;
    } else if (r.deathCross) {
      statusTxt = `<div class='eb muted-xl' style='font-weight:700; color:var(--red)'>EMA 21 < 50</div>`;
    } else {
      statusTxt = r.ema21above
        ? `<div class='ea muted-xl' style='font-weight:600; color:var(--green)'>EMA 21 > 50</div>`
        : `<div class='eb muted-xl' style='font-weight:600; color:var(--red)'>EMA 21 < 50</div>`;
    }

    // Chart sparkline
    const chartTxt = `<div style='cursor:pointer; opacity:0.85;' onclick="window.openModalChart('${r.symbol}', '${r.tf}')">`
      + generateSparkline(r.priceHist, r.ema21Hist, r.ema50Hist) + `</div>`;

    const volBarPct = Math.round((Math.abs(r.volume || 0) / maxVolume) * 100);
    const macdVal = r.macdVal !== null ? r.macdVal.toFixed(2) : '—';
    const macdTxt = r.macdAbove
      ? `<div><span class='up' style='font-size:12px;font-weight:600;'>▲ Bull <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`
      : `<div><span class='dn' style='font-size:12px;font-weight:600;'>▼ Bear <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`;

    const gcBadge = r.goldenCross ? `<span class='bgc'>🟣GC</span>` : '';
    const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol.toUpperCase())}`;

    const symLink = `<a href="${nseUrl}" target="_blank" rel="noopener noreferrer"
      style="color:inherit; text-decoration:none; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"
      onmouseover="this.style.color='var(--accent)'"
      onmouseout="this.style.color='inherit'">
      ${r.symbol}<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;

    // Technical check pills — labeled directly (no hover needed to know
    // which signal is which).
    const boxes = CHECK_DEFS.map(c => {
      const isOn = r.checks?.[c.key] || (c.alt && r.checks?.[c.alt]);
      return `<span class='ck-pill ${isOn ? 'on' : 'off'}'>${c.label}</span>`;
    }).join('');

    const ratCls = r.rating === 'STRONG BUY' ? 'rat-sb' : r.rating === 'MODERATE' ? 'rat-wl' : 'rat-sk';

    // F&O expand toggle
    const isExpanded = stockFilter === 'FO' && window.foManager?.expandedSymbol === r.symbol;
    const expandToggle = stockFilter === 'FO'
      ? `<span class="exp-btn ${isExpanded ? 'active' : ''}" onclick="window.foManager.toggleRow('${r.symbol}', this, event)">▼</span> `
      : '';
    const subRowClass = isExpanded ? 'sub-row active' : 'sub-row';

    return `<tr class='main-row ${(r.goldenCross ? 'gc-row' : '')}' id="row-${rowKey}">
      <td style="text-align:left;">
        <div style="display:flex; align-items:baseline; gap:8px; flex-wrap:nowrap;">
          <div class='sym'>${expandToggle}${symLink} <span class="tf-purple">(${r.tf})</span>${gcBadge}</div>
          <span class='muted-xl' style="text-transform:uppercase; white-space:nowrap;">${r.sector} · <span class='${cc}'>${fullChg}</span></span>
          ${r.dividend ? `<span class='dividend-info' style="font-family:var(--mono); white-space:nowrap;">💰 <span class="${r.dividend.colorClass}">${r.dividend.displayText}</span></span>` : ''}
        </div>
      </td>
      <td data-label="CMP">
        <div style="display:flex; flex-direction:row; align-items:center; justify-content:center; gap:8px;">
          <span><span class="price-bold">₹${r.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>${freshnessDot(r.priceSource, r.priceTs, candleFreshnessNote(r))}</span>
          <span class="muted-xl vwap-line">VWAP <span class="${r.aboveVwap ? 'up' : 'dn'}">${r.aboveVwap ? '▲' : '▼'}</span> ₹${(r.vwap || r.price).toFixed(1)}</span>
        </div>
      </td>
      <td data-label="Chart"><div style="display:flex; justify-content:center;">${chartTxt}</div></td>
      <td data-label="EMA">
        <div style="display:flex; flex-direction:row; align-items:center; justify-content:center; gap:8px;">
          <div>${statusTxt}</div>
          <div class="muted-xl ${cc}" style="font-weight:600;">Gap ${Math.abs(r.emaGap || 0).toFixed(2)}%</div>
        </div>
      </td>
      <td data-label="Volume">
        <div style="display:flex; flex-direction:row; align-items:center; justify-content:center; gap:8px;">
          <div class="${r.volSpike ? 'vol-spike-⚡' : ''}" style="font-size:13px; font-weight:700; font-family:var(--mono); color:${r.volSpike ? 'var(--yellow)' : 'var(--text)'};">${r.volSpike ? '⚡ ' : ''}${formatVolume(r.volume)}</div>
          <div style="width:60px; height:7px; background:rgba(255,255,255,0.07); border-radius:6px; overflow:hidden;">
            <div class="vol-bar-fill ${r.volSpike ? 'vb-spike' : 'vb-normal'}" style="width:${volBarPct}%; height:100%; border-radius:6px; transition:width 0.4s ease;"></div>
          </div>
          <div class="${(r.volumeChange || 0) >= 0 ? 'up' : 'dn'}" style="font-size:10px; font-family:var(--mono);">${(r.volumeChange || 0) >= 0 ? '+' : ''}${formatVolume(r.volumeChange)} ${(r.volumeChange || 0) >= 0 ? '↑' : '↓'}</div>
        </div>
      </td>
      <td data-label="MACD"><div style="display:flex; justify-content:center;">${macdTxt}</div></td>
      <td class="range-col" data-label="Day Range"><div>${generateRangeBar(r.dayL, r.dayH, r.price)}</div></td>
      <td class="range-col" data-label="52W Range"><div>${generateRangeBar((r.w52L || r.weekL || 0), (r.w52H || r.weekH || 0), r.price)}</div></td>
      <td data-label="Score">
        <div style="display:flex; flex-direction:column; align-items:center; gap:3px;">
          <span style="font-weight:800; font-family:var(--mono); font-size:15px; color:var(--text);">${r.techScore}<span style="color:var(--muted); font-weight:400; font-size:10px;">/7</span></span>
          <div class="checks">${boxes}</div>
        </div>
      </td>
      <td data-label="Rating">
        <div style="display:flex; flex-direction:row; align-items:center; justify-content:center; gap:8px;">
          <div class="rat-badge ${ratCls}">${r.rating}</div>
          <div class="flag-group">
            <span class="up" style="font-weight:700; font-size:11px;">⚑${r.techScore}</span>
            <span style="color:var(--muted); font-size:9px; margin:0 3px;">/</span>
            <span class="dn" style="font-weight:700; font-size:11px;">⚑${r.redCount || 0}</span>
          </div>
        </div>
      </td>
    </tr>
    <tr class="${subRowClass}" id="sub-${rowKey}">
      <td colspan="10"><div class="sub-wrap" id="wrap-${r.symbol}">${isExpanded ? '<div style="color:var(--muted);text-align:center;padding:20px">⏳ Reloading Option Chain...</div>' : 'Loading...'}</div></td>
    </tr>`;
  };

  // In-place update: patch existing rows, add new ones, remove stale ones.
  // Wrapped so any unexpected DOM/data shape here can never leave the table
  // silently stuck — a full rebuild always wins over a half-applied patch.
  try {
    patchTable();
  } catch (e) {
    console.error('[Render] In-place patch failed, falling back to full rebuild:', e);
    tbody.innerHTML = rows.map(renderRow).join('');
  }

  function patchTable() {
    const existingRows = new Map();
    tbody.querySelectorAll('tr.main-row').forEach(tr => existingRows.set(tr.id, tr));

    const fragment = document.createDocumentFragment();
    const subRowsToAppend = [];
    const seenIds = new Set();

    rows.forEach(r => {
      const rowId = `row-${rowKeyFor(r)}`;
      seenIds.add(rowId);

      const cc = r.chgPct >= 0 ? 'up' : 'dn';
      const chgP = (r.priceChange >= 0 ? '+' : '') + r.priceChange.toFixed(2);
      const chg = (r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%';
      const fullChg = `${chgP} (${chg})`;
      const volBarPct = Math.round((Math.abs(r.volume || 0) / maxVolume) * 100);
      const macdVal = r.macdVal !== null ? r.macdVal.toFixed(2) : '—';

      if (existingRows.has(rowId)) {
        // Row exists — patch only changed cells
        const tr = existingRows.get(rowId);
        const cells = tr.cells;

        // Cell 0: symbol/sector/change
        const chgEl = cells[0]?.querySelector('.muted-xl span');
        if (chgEl && chgEl.textContent !== fullChg) {
          chgEl.className = cc;
          chgEl.textContent = fullChg;
        }

        // Cell 1: price + vwap
        const priceEl = cells[1]?.querySelector('.price-bold');
        const newPrice = `₹${r.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        if (priceEl && priceEl.textContent !== newPrice) {
          priceEl.textContent = newPrice;
          const prevNum = parseFloat(tr.dataset.price);
          if (priceEl && Number.isFinite(prevNum) && prevNum !== r.price) {
            priceEl.classList.remove('price-flash-up', 'price-flash-down');
            void priceEl.offsetWidth; // restart animation even if the same direction fires again quickly
            priceEl.classList.add(r.price > prevNum ? 'price-flash-up' : 'price-flash-down');
          }
        }
        tr.dataset.price = r.price;
        const tagEl = cells[1]?.querySelector('.freshness-tag');
        if (tagEl) {
          const cls = (r.priceSource || 'UNAVAILABLE').toLowerCase();
          const label = FRESHNESS_LABEL[cls] || cls.slice(0, 3).toUpperCase();
          const ageTxt = r.priceTs ? ` ${Math.round((Date.now() - r.priceTs) / 1000)}s` : '';
          tagEl.className = `freshness-tag freshness-${cls}`;
          tagEl.textContent = `${label}${ageTxt}`;
        }
        const vwapEl = cells[1]?.querySelector('.vwap-line');
        if (vwapEl) {
          const vwapArrow = r.aboveVwap ? '▲' : '▼';
          const vwapPrice = `₹${(r.vwap || r.price).toFixed(1)}`;
          vwapEl.innerHTML = `VWAP <span class="${r.aboveVwap ? 'up' : 'dn'}">${vwapArrow}</span> ${vwapPrice}`;
        }

        // Cell 3: EMA
        // NOTE: `:first-child`/`:last-child` are relative to EACH element's
        // OWN parent, not to the cell being queried — since this cell has a
        // single flex wrapper <div> holding two sibling <div>s, the wrapper
        // itself is simultaneously the first AND last child (it's the only
        // child of the <td>), so `querySelector('div:first-child')` matched
        // the WRAPPER, not the intended inner div. Both "updates" then landed
        // on the same element, with the later write silently clobbering the
        // earlier one (e.g. "Gap x%" overwriting "EMA 21 > 50" entirely).
        // Navigate by child index instead, which is unambiguous.
        let statusTxt = '';
        if (r.goldenCross) statusTxt = `<div class='ea muted-xl' style='font-weight:700; color:var(--green)'>EMA 21 > 50</div>`;
        else if (r.deathCross) statusTxt = `<div class='eb muted-xl' style='font-weight:700; color:var(--red)'>EMA 21 < 50</div>`;
        else statusTxt = r.ema21above
          ? `<div class='ea muted-xl' style='font-weight:600; color:var(--green)'>EMA 21 > 50</div>`
          : `<div class='eb muted-xl' style='font-weight:600; color:var(--red)'>EMA 21 < 50</div>`;
        const emaWrap = cells[3]?.firstElementChild;
        if (emaWrap && emaWrap.children.length >= 2) {
          emaWrap.children[0].innerHTML = statusTxt;
          const emaGapEl = emaWrap.children[1];
          emaGapEl.className = `muted-xl ${cc}`;
          emaGapEl.textContent = `Gap ${Math.abs(r.emaGap || 0).toFixed(2)}%`;
        }

        // Cell 4: volume — same ambiguous-selector issue as Cell 3 above;
        // navigate by child index (number / bar / change, in that order).
        const volWrap = cells[4]?.firstElementChild;
        if (volWrap && volWrap.children.length >= 3) {
          const volEl = volWrap.children[0];
          volEl.className = r.volSpike ? 'vol-spike-⚡' : '';
          volEl.style.color = r.volSpike ? 'var(--yellow)' : 'var(--text)';
          volEl.textContent = (r.volSpike ? '⚡ ' : '') + formatVolume(r.volume);

          const volBarEl = volWrap.children[1]?.querySelector('.vol-bar-fill');
          if (volBarEl) volBarEl.style.width = `${volBarPct}%`;

          const volChgEl = volWrap.children[2];
          volChgEl.className = (r.volumeChange || 0) >= 0 ? 'up' : 'dn';
          volChgEl.style.cssText = 'font-size:10px; font-family:var(--mono);';
          volChgEl.textContent = `${(r.volumeChange || 0) >= 0 ? '+' : ''}${formatVolume(r.volumeChange)} ${(r.volumeChange || 0) >= 0 ? '↑' : '↓'}`;
        }

        // Cell 5: MACD
        const macdCell = cells[5]?.querySelector('div');
        if (macdCell) {
          macdCell.innerHTML = r.macdAbove
            ? `<div><span class='up' style='font-size:12px;font-weight:600;'>▲ Bull <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`
            : `<div><span class='dn' style='font-size:12px;font-weight:600;'>▼ Bear <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`;
        }

        fragment.appendChild(tr);
        const subRow = document.getElementById(`sub-${rowKeyFor(r)}`);
        if (subRow) subRowsToAppend.push(subRow);
      } else {
        // New row — full render
        const tmp = document.createElement('tbody');
        tmp.innerHTML = renderRow(r);
        Array.from(tmp.children).forEach(child => {
          if (child.classList.contains('main-row')) {
            child.dataset.price = r.price;
            fragment.appendChild(child);
          } else subRowsToAppend.push(child);
        });
      }
    });

    // Remove stale rows
    existingRows.forEach((tr, id) => {
      if (!seenIds.has(id)) {
        const subRow = document.getElementById(`sub-${id.replace('row-', '')}`);
        subRow?.remove();
      }
    });

    // Append all main rows then sub rows
    subRowsToAppend.forEach(sr => fragment.appendChild(sr));
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  } // end patchTable()

  restoreScroll();

  // Reload expanded F&O row if exists
  if (stockFilter === 'FO' && window.foManager?.expandedSymbol) {
    const wrap = document.getElementById(`wrap-${window.foManager.expandedSymbol}`);
    if (wrap) window.foManager.loadOptionChain(window.foManager.expandedSymbol, wrap);
  }
}

// ── INTRADAY: 15-MIN MOMENTUM MOVERS ──────────────────────────
// Fully independent of Stage-2/entry_score.mjs/actionable_score.mjs — see
// src/intraday_movers.mjs for the scoring design (six weighted technical
// factors: volatility expansion, relative volume, multi-timeframe EMA
// alignment, breakout structure, VWAP position, F&O confirmation). Reads
// /api/intraday-movers directly (ui-core.mjs's fetchIntradayMovers), never
// state.intradayOpportunities/intradayActionable/fastMovers — this tab
// shares no data or computation with anything else in the app.
const INTRADAY_TABLE_HEADER = `<tr>
    <th style="text-align:left;">Stock</th>
    <th>Score</th>
    <th style="text-align:left;">Why</th>
  </tr>`;

function moverScoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 55) return 'var(--yellow)';
  return 'var(--muted)';
}

function renderIntradayMoverRowHtml(m, rank) {
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(m.symbol.toUpperCase())}`;
  const color = moverScoreColor(m.score);
  // The volume multiplier already shows in the subtitle line below — skip
  // its reason string here so Why isn't repeating the same fact twice.
  const whyTxt = (m.reasons || []).filter(r => !/^Volume .*average$/.test(r)).join(' · ')
    || 'Ranked on overall composite — no single standout factor';
  return `<tr class="main-row">
      <td style="text-align:left;">
        <div style="display:flex; align-items:baseline; gap:6px; flex-wrap:nowrap;">
          <span style="color:var(--muted); font-size:10px; font-family:var(--mono); min-width:14px;">${rank}</span>
          <span class="sym"><a href="${nseUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;">${m.symbol}</a></span>
          <span class="price-bold">₹${(m.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>${freshnessDot(m.priceSource, m.priceTs)}
        </div>
        <span class="muted-xl" style="text-transform:uppercase;">${m.sector || ''}${m.relVolX ? ` · ${m.relVolX}x vol` : ''}</span>
      </td>
      <td data-label="Score">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <span style="font-weight:800;font-size:15px;font-family:var(--mono);color:${color};">${m.score}</span>
          <div style="width:34px;height:5px;background:rgba(255,255,255,0.07);border-radius:5px;overflow:hidden;flex-shrink:0;">
            <div style="width:${Math.round(m.score)}%;height:100%;background:${color};border-radius:5px;"></div>
          </div>
        </div>
      </td>
      <td data-label="Why" style="text-align:left;"><span class="muted-xl why-line" style="opacity:1;">${whyTxt}</span></td>
    </tr>`;
}

// ── RENDER: AI TAB — 7-layer 20-minute move pipeline (src/ai_scanner.mjs) ──
// Layers 4-5 show BLOCKED on every candidate until a Layer-6-validated model
// version exists (spec Rule 8) — see that file's header for the full
// rationale. Rendered as one rich card per candidate rather than a flat
// table row, since each candidate carries far more structured fields than a
// row can hold; reuses the same #tbody/#tableHeader elements every other
// tab does (one wide <td> per row instead of several narrow ones).
const AI_TABLE_HEADER = `<tr><th style="text-align:left;">AI Scan — 20-Minute Move Pipeline</th></tr>`;

// Full spec-format block for a qualifying opportunity (any candidate that
// cleared the validated Layer-4 EV threshold — NOT capped at 3). `tag`
// distinguishes the separate 0-3 position-sizing/execution constraint
// (POSITION) from the remaining qualifying opportunities shown for
// visibility only (WATCHLIST) — both are equally real "TRADE" opportunities
// per Layer 4/5; only the position slot count differs. Only ever rendered
// when payload.decision === 'TRADE', which requires a validated model
// (never true today, but the code is ready the moment one exists).
function aiSpecFormatBlockHtml(c, rank, tag) {
  const l4 = c.layer4 || {};
  const l5 = c.layer5 || {};
  const dirColor = c.direction === 'LONG' ? 'var(--green)' : 'var(--red)';
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(c.symbol.toUpperCase())}`;
  const rr = (window.AI_TARGET_PCT / window.AI_SL_PCT).toFixed(1);
  const slPrice = l5.dynamicSl?.dynamicSl ?? (c.direction === 'LONG' ? c.price * (1 - window.AI_SL_PCT / 100) : c.price * (1 + window.AI_SL_PCT / 100));
  const targetPrice = l5.dynamicTarget?.dynamicTarget ?? (c.direction === 'LONG' ? c.price * (1 + window.AI_TARGET_PCT / 100) : c.price * (1 - window.AI_TARGET_PCT / 100));
  const tagHtml = tag === 'POSITION'
    ? `<span style="margin-left:8px; font-size:9px; padding:2px 6px; border-radius:3px; background:rgba(74,222,128,0.15); color:var(--green); font-weight:700;">POSITION</span>`
    : `<span style="margin-left:8px; font-size:9px; padding:2px 6px; border-radius:3px; background:rgba(148,163,184,0.15); color:var(--muted); font-weight:700;">WATCHLIST</span>`;

  return `<div style="padding:14px 16px; border-bottom:1px solid rgba(255,255,255,0.06); font-family:var(--mono); font-size:12px; line-height:1.7;">
    <div><span class="muted-xl">#${rank}</span> <a href="${nseUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;font-weight:800;">${c.symbol}</a> — <span style="color:${dirColor};font-weight:700;">${c.direction}</span>${tagHtml}</div>
    <div>Model version: v${l4.modelVersion ?? '—'}</div>
    <div>Setup Score: ${c.setupScore}/100 (Tier ${c.dataTier || 'B'} — order-flow proxy)</div>
    <div>Regime bias: ${c.regimeBias}</div>
    <div>P(Target before SL, 20min): ${l4.pTargetBeforeSl}% [target: +${window.AI_TARGET_PCT}% | SL: -${window.AI_SL_PCT}%]</div>
    <div class="muted-xl">&nbsp;&nbsp;*N=${l4.n}, regime: ${l4.calibrationRegime}, model v${l4.modelVersion}</div>
    <div>Expected MFE: ${l4.expectedMfe != null ? l4.expectedMfe.toFixed(2) + '%' : '—'}  Expected MAE: ${l4.expectedMae != null ? l4.expectedMae.toFixed(2) + '%' : '—'}  Expected time-to-resolution: ${l4.expectedTimeToResolutionMin ?? '—'} min</div>
    <div>Entry: ₹${c.price?.toFixed(2)}  SL: ₹${slPrice?.toFixed(2)}  Target: ₹${targetPrice?.toFixed(2)}  R:R: ${rr}</div>
    <div>Expected Net Return: ${l4.expectedNetReturnPct != null ? (l4.expectedNetReturnPct >= 0 ? '+' : '') + l4.expectedNetReturnPct.toFixed(2) + '%' : '—'}   Execution Quality: ${l4.executionQuality ?? '—'}</div>
    <div>Rank Score: ${l4.rankScore ?? '—'}</div>
    <div>Time-stop: ${l5.timeStopMin ?? 20} min</div>
    <div style="font-weight:700; color:var(--green);">Decision: TRADE</div>
  </div>`;
}

// Diagnostic view of what Layers 0-3 actually found this cycle — explicitly
// labeled as diagnostic, NOT a trade decision (the spec's decision/NO-TRADE/
// BLOCKED block above this is the one and only decision output).
function aiDiagnosticRowHtml(c, rank) {
  const l4 = c.layer4 || {};
  const dirColor = c.direction === 'LONG' ? 'var(--green)' : 'var(--red)';
  const scoreColor = c.setupScore >= 80 ? 'var(--green)' : c.setupScore >= 60 ? 'var(--yellow)' : 'var(--muted)';
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(c.symbol.toUpperCase())}`;
  const pBlock = l4.status === 'BLOCKED'
    ? `<span style="color:var(--yellow);">BLOCKED</span> <span class="muted-xl">— ${l4.reason}</span>`
    : `${l4.pTargetBeforeSl}% <span class="muted-xl">N=${l4.n}</span>`;

  return `<div style="padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.06);">
    <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
      <span style="color:var(--muted); font-family:var(--mono); font-size:11px;">#${rank}</span>
      <a href="${nseUrl}" target="_blank" rel="noopener noreferrer" class="sym" style="color:inherit; text-decoration:none; font-weight:800; font-size:14px;">${c.symbol}</a>
      <span style="font-weight:700; color:${dirColor};">${c.direction}</span>
      <span style="margin-left:auto; font-family:var(--mono); font-size:9px; color:var(--muted);">Tier ${c.dataTier || 'B'} · order-flow proxy</span>
    </div>
    <div class="muted-xl" style="margin-top:4px;">${(c.reasons || []).join(' · ') || 'No standout factor'}</div>
    <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px,1fr)); gap:8px; margin-top:8px; font-size:11px;">
      <div><span class="muted-xl">Setup Score</span><br><span style="font-weight:800; font-family:var(--mono); color:${scoreColor};">${c.setupScore}/100</span></div>
      <div><span class="muted-xl">Regime bias</span><br><span>${c.regimeBias || '—'}</span></div>
      <div><span class="muted-xl">P(Target before SL)</span><br>${pBlock}</div>
      <div><span class="muted-xl">Entry</span><br><span class="price-bold">₹${(c.price || 0).toFixed(2)}</span></div>
      <div><span class="muted-xl">Execution Quality</span><br><span>${l4.executionQuality ?? '—'}</span></div>
    </div>
  </div>`;
}

function renderAIScan(payload) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const tableHeader = document.getElementById('tableHeader');
  const restoreScroll = captureScroll();
  if (!tbody) return;

  if (tableHeader) tableHeader.innerHTML = AI_TABLE_HEADER;
  const badgeEl = document.getElementById('badge-AI');

  if (!payload) {
    tbody.innerHTML = '';
    if (empty) { empty.classList.remove('loading'); empty.style.display = 'block'; empty.textContent = "AI scan hasn't run yet — check back shortly."; }
    if (badgeEl) badgeEl.textContent = '—';
    restoreScroll();
    return;
  }

  window.AI_TARGET_PCT = payload.targetPct;
  window.AI_SL_PCT = payload.slPct;

  let candidates = payload.candidates || [];
  candidates = window.searchFilter?.filterRows(candidates) || candidates;

  const rcEl = document.getElementById('rowCount');
  if (rcEl) {
    const ageTxt = payload.updatedAt ? ` · updated ${Math.max(0, Math.round((Date.now() - payload.updatedAt) / 1000))}s ago` : '';
    rcEl.textContent = `Tier ${payload.dataTier} · target +${payload.targetPct}% / SL -${payload.slPct}% / ${payload.horizonMin}min horizon${ageTxt}`;
  }
  if (badgeEl) badgeEl.textContent = (payload.opportunitySymbols || []).length || '0';

  const l6 = payload.layer6 || {};
  const mr = payload.marketRegime;
  const lv = l6.latestModelVersion;
  const statusBannerHtml = `<div style="padding:10px 16px; background:rgba(129,140,248,0.08); border-bottom:1px solid rgba(129,140,248,0.15); font-size:11px;">
    <span style="color:#818cf8; font-weight:700;">Layer 6 (Validation):</span>
    <span class="muted-xl">${l6.candidatesLogged ?? 0} candidates logged · ${l6.outcomesResolved ?? 0} outcomes resolved (need ${l6.minRequiredForValidation ?? '—'} to fit a model) · ${l6.status || 'UNKNOWN'}</span>
    ${lv ? `<div class="muted-xl" style="margin-top:2px;">Latest model version: v${lv.version_id} (${lv.status}, train=${lv.training_sample_count ?? '—'}, validation=${lv.validation_sample_count ?? '—'})</div>` : ''}
    ${l6.currentValidatedModel ? `<div class="muted-xl" style="margin-top:2px;">Currently validated: v${l6.currentValidatedModel.versionId} (validated ${new Date(l6.currentValidatedModel.validatedAt).toLocaleDateString('en-IN')})</div>` : `<div style="margin-top:4px; color:var(--yellow);">No validated model yet — live inference stays BLOCKED per spec Rule 8.</div>`}
    ${mr ? `<div style="margin-top:4px;" class="muted-xl">Market regime: ${mr.indexRegime} · VIX ${mr.vixValue != null ? mr.vixValue.toFixed(1) : '—'} (${mr.vixMode || '—'})</div>` : ''}
  </div>`;

  const inv = payload.invalid || {};
  const invalidBannerHtml = inv.total ? `<div style="padding:8px 16px; background:rgba(239,68,68,0.06); border-bottom:1px solid rgba(239,68,68,0.12); font-size:10px;">
    <span style="color:var(--red); font-weight:700;">INVALID — insufficient data:</span>
    <span class="muted-xl">${inv.total} symbol(s) this cycle — ${(inv.byReason || []).map(r => `${r.reason} (${r.layer}): ${r.n}`).join(' · ')}</span>
  </div>` : '';

  // The spec's ONE decision output — TRADE (with the full spec-format block
  // for EVERY qualifying opportunity, uncapped, ranked by Rank Score — the
  // top MAX_SIMULTANEOUS_POSITIONS tagged POSITION, the rest WATCHLIST),
  // NO-TRADE, or BLOCKED. This is never mixed with the diagnostic list below it.
  const decision = payload.decision || 'BLOCKED: No current Layer-6-validated model version. Live inference not permitted.';
  const isTrade = decision === 'TRADE';
  const positionSymbols = payload.positionSymbols || [];
  const opportunitySymbols = payload.opportunitySymbols || [];
  const opportunityCandidates = opportunitySymbols
    .map(sym => candidates.find(c => c.symbol === sym))
    .filter(Boolean);
  const decisionHtml = isTrade
    ? opportunityCandidates.map((c, i) => aiSpecFormatBlockHtml(c, i + 1, positionSymbols.includes(c.symbol) ? 'POSITION' : 'WATCHLIST')).join('')
    : `<div style="padding:16px; text-align:center; font-family:var(--mono); font-size:12px; color:${decision.startsWith('NO-TRADE') ? 'var(--muted)' : 'var(--yellow)'};">${decision}</div>`;

  const diagnosticHeaderHtml = `<div style="padding:8px 16px; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em;">Diagnostic — Layers 0-3 candidate list (not a trade decision)</div>`;

  if (empty) empty.style.display = 'none';

  if (!candidates.length) {
    tbody.innerHTML = `<tr><td style="padding:0;">${statusBannerHtml}${invalidBannerHtml}${decisionHtml}<div style="padding:20px; text-align:center; color:var(--muted);">No candidates cleared Layer 3 this cycle.</div></td></tr>`;
    restoreScroll();
    return;
  }

  tbody.innerHTML = `<tr><td style="padding:0;">${statusBannerHtml}${invalidBannerHtml}${decisionHtml}${diagnosticHeaderHtml}</td></tr>` +
    candidates.map((c, i) => `<tr><td style="padding:0;">${aiDiagnosticRowHtml(c, i + 1)}</td></tr>`).join('');
  restoreScroll();
}
window.renderAIScan = renderAIScan;

function renderIntraday(payload) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const restoreScroll = captureScroll();

  document.getElementById('tableHeader').innerHTML = INTRADAY_TABLE_HEADER;
  hideTopPicks();
  const regimeBanner = document.getElementById('regimeBanner');
  if (regimeBanner) regimeBanner.style.display = 'none';

  const movers = payload?.movers || [];
  const badgeEl = document.getElementById('badge-INTRADAY');
  if (badgeEl) badgeEl.textContent = movers.length || '—';
  const rcEl = document.getElementById('rowCount');
  const ageTxt = payload?.updatedAt ? ` · updated ${Math.max(0, Math.round((Date.now() - payload.updatedAt) / 1000))}s ago` : '';
  if (rcEl) rcEl.textContent = `${movers.length} stock(s) scoring 75+ (of ${payload?.universeSize || 0} scanned)${ageTxt}`;

  if (!movers.length) {
    tbody.innerHTML = '';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = payload?.universeSize
        ? 'No stocks are currently scoring 75+ — check back shortly.'
        : 'Warming up — waiting for enough candle history to start scoring (usually under a minute after the app starts).';
    }
    restoreScroll();
    return;
  }
  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  tbody.innerHTML = movers.map((m, i) => renderIntradayMoverRowHtml(m, i + 1)).join('');
  restoreScroll();
}

// topPicksBanner is the old flagship's banner element — nothing here uses
// it, but leaving it hidden (rather than assuming it's already hidden)
// keeps this render correct even if a future change brings that element
// back for a different purpose.
function hideTopPicks() {
  const el = document.getElementById('topPicksBanner');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// ── MARKET REGIME BANNER ──────────────────────────────────────
function renderRegimeBanner(regime) {
  const el = document.getElementById('regimeBanner');
  if (!el) return;
  if (!regime || !regime.regime || regime.regime === 'UNKNOWN') { el.style.display = 'none'; return; }

  el.style.display = 'flex';
  el.className = 'regime-banner ' + (regime.regime === 'BULLISH' ? 'regime-bullish' : regime.regime === 'BEARISH' ? 'regime-bearish' : 'regime-sideways');
  const icon = regime.regime === 'BULLISH' ? '📈' : regime.regime === 'BEARISH' ? '📉' : '➖';
  el.innerHTML = `<span>${icon} MARKET REGIME: ${regime.regime}</span>` +
    (regime.noTrade ? `<span class="no-trade-flag">NO TRADE</span>` : '') +
    `<span class="regime-notes">${(regime.notes || []).join(' · ')}</span>`;
}

// ── RENDER: TOP 50 QUALITY SCREENER ───────────────────────────
// A separate, independent funnel from the Intraday tab (src/quality_filter.mjs)
// — reject invalid, penalize imperfect. Server has already hard-gated,
// scored, percentile-ranked, regime-adjusted, and deduped this list; this
// just displays it, best-first.
const QUALITY_TABLE_HEADER = `<tr>
    <th style="text-align:left;">Rank / Stock</th>
    <th>Price</th>
    <th>Chart</th>
    <th>Score <div class="th-sub">weighted evidence</div></th>
    <th>Percentile <div class="th-sub">vs today's pool</div></th>
    <th>Evidence Breadth</th>
  </tr>`;

function renderQualityRowHtml(c, rank) {
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(c.symbol.toUpperCase())}`;
  const cc = c.chgPct >= 0 ? 'up' : 'dn';
  const breadth = c.evidenceBreadth || {};
  const scoreColor = c.compositeScore >= 80 ? '#22c55e' : c.compositeScore >= 65 ? '#4ade80' : '#f59e0b';
  return `<tr class="main-row">
      <td style="text-align:left;">
        <div class="sym"><span class="muted-xl" style="font-family:var(--mono);margin-right:4px;">#${rank}</span><a href="${nseUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;">${c.symbol}</a>${c.volSpike ? " <span style='color:var(--yellow)'>⚡</span>" : ''}</div>
        <div class="muted-xl" style="text-transform:uppercase;font-size:9px;margin-top:3px;">${c.sector} · <span class="${cc}">${c.chgPct >= 0 ? '+' : ''}${c.chgPct.toFixed(2)}%</span></div>
      </td>
      <td data-label="Price"><span class="price-bold">₹${(c.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>${freshnessDot(c.priceSource, c.priceTs)}</td>
      <td data-label="Chart"><div style="cursor:pointer;" onclick="window.openModalChart('${c.symbol}', '5m')">${generateSparkline(c.priceHist, c.ema21Hist, c.ema50Hist)}</div></td>
      <td data-label="Score"><span style="font-weight:700;color:${scoreColor};">${c.compositeScore}</span></td>
      <td data-label="Percentile"><span style="font-weight:600;">${c.percentile}th</span></td>
      <td data-label="Evidence Breadth"><span style="font-weight:600;">${breadth.positive}/${breadth.available}</span><span class="muted-xl" style="font-size:8px;display:block;">of ${breadth.total} tracked</span></td>
    </tr>`;
}

function renderQuality(data) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const horizonBar = document.getElementById('intradayHorizons');
  const restoreScroll = captureScroll();

  document.getElementById('tableHeader').innerHTML = QUALITY_TABLE_HEADER;
  if (horizonBar) horizonBar.style.display = 'none';
  updateSortIndicators(null);

  if (!data?.qualityList) {
    tbody.innerHTML = '';
    if (empty) { empty.classList.remove('loading'); empty.style.display = 'block'; empty.textContent = 'No data available'; }
    restoreScroll();
    return;
  }

  renderRegimeBanner(data.marketRegime);

  const { list, meta } = data.qualityList;
  const rcEl = document.getElementById('rowCount');
  const marketOpen = window.stateManager?.get('marketOpen');
  const closedSuffix = marketOpen ? '' : ' (last scan — market closed)';

  if (rcEl) {
    rcEl.textContent = meta
      ? `Top 50 Quality: ${list.length} of ${meta.qualifyingCount} qualifying (${meta.survivorCount} passed validity, ${meta.universeSize} scanned) · ${meta.regime} regime, min percentile ${meta.minPercentile}${closedSuffix}`
      : `Top 50 Quality: ${list.length}${closedSuffix}`;
  }

  if (!list.length) {
    tbody.innerHTML = '';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = meta?.error
        ? `Quality screener unavailable this cycle: ${meta.error}`
        : 'No stocks currently clear the validity gate + regime-scaled percentile bar. This is expected most of the time — quality setups are rare by design.';
    }
    restoreScroll();
    return;
  }
  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  tbody.innerHTML = list.map((c, i) => renderQualityRowHtml(c, i + 1)).join('');
  restoreScroll();
}

// ── RENDER: MARKET SCREENERS (Nifty 500) ─────────────────────
// Card-based layout (Groww/Upstox-style) rather than a single sortable
// table — each category is its own scannable list. Reuses the same
// sparkline chart component as every other tab, since these rows carry the
// exact same buildSignal() output.
// `byTfGroup: true` — Gainers/Losers: NOT dropdown-driven, shows all four
// timeframe groupings (GAINER_LOSER_TFS) at once.
// `byTf: true` — dropdown-driven: server precomputed every real timeframe
// (src/screener.mjs), pick whichever the timeframe dropdown is currently on.
// Neither flag (52W High/Low) — flat array, daily-only, unaffected by the
// dropdown (a 52-week extreme isn't a chart-timeframe concept).
const SCREENER_SECTIONS = [
  { key: 'gainers', title: 'Top Gainers', icon: '📈', color: '#22c55e', byTfGroup: true, meta: r => ({ label: 'Chg', value: `${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(2)}%`, cls: r.chgPct >= 0 ? 'up' : 'dn' }) },
  { key: 'losers', title: 'Top Losers', icon: '📉', color: '#ef4444', byTfGroup: true, meta: r => ({ label: 'Chg', value: `${r.chgPct.toFixed(2)}%`, cls: 'dn' }) },
  // Ranked by |volumeChange| (the latest-candle-vs-previous-candle volume
  // jump — the actual "shock"), not raw cumulative volume — a heavily
  // traded large-cap can have huge raw volume with nothing unusual
  // happening. Must SHOW that same number, not raw volume, or the list
  // looks visibly out of order against whatever's actually displayed.
  { key: 'volumeShockers', title: 'Volume Shockers', icon: '⚡', color: '#f59e0b', byTf: true, meta: r => ({ label: 'Vol Δ', value: `${r.volumeChange >= 0 ? '+' : ''}${formatVolume(r.volumeChange)}`, cls: r.volumeChange >= 0 ? 'up' : 'dn' }) },
  { key: 'high52w', title: '52-Week High', icon: '🚀', color: '#22c55e', meta: r => ({ label: '52W H', value: `₹${(r.w52H || 0).toFixed(1)}`, cls: 'up' }) },
  { key: 'low52w', title: '52-Week Low', icon: '🔻', color: '#ef4444', meta: r => ({ label: '52W L', value: `₹${(r.w52L || 0).toFixed(1)}`, cls: 'dn' }) },
  { key: 'bullishCrossover', title: 'Bullish Crossover', icon: '✦', color: '#a78bfa', byTf: true, meta: r => ({ label: 'EMA Gap', value: `${(r.emaGap || 0).toFixed(2)}%`, cls: 'up' }) },
  { key: 'momentumBurst', title: 'Momentum Burst', icon: '🔥', color: '#fb923c', byTf: true, meta: r => ({ label: 'MACD', value: (r.macdVal ?? 0).toFixed(2), cls: 'up' }) },
  { key: 'rsiOversold', title: 'RSI Oversold', icon: '🔄', color: '#38bdf8', byTf: true, meta: r => ({ label: 'RSI', value: (r.rsi ?? 0).toFixed(1), cls: '' }) },
  { key: 'rsiOverbought', title: 'RSI Overbought', icon: '🔺', color: '#ef4444', byTf: true, meta: r => ({ label: 'RSI', value: (r.rsi ?? 0).toFixed(1), cls: '' }) },
];

const GAINER_LOSER_TFS = ['5m', '10m', '15m', '1d'];

// Each screener tab shows one or two SCREENER_SECTIONS entries as its full
// content — 52 Week High/Low and RSI Oversold/Overbought are pairs shown
// as two stacked labeled groups on one page (not a click-to-switch chip;
// both are always visible, matching "no subtabs").
const SCREENER_TAB_MAP = {
  GAINERS: ['gainers'],
  LOSERS: ['losers'],
  VOLSHOCK: ['volumeShockers'],
  RANGE52W: ['high52w', 'low52w'],
  BULLCROSS: ['bullishCrossover'],
  MOMENTUM: ['momentumBurst'],
  RSI: ['rsiOversold', 'rsiOverbought'],
};

const SCREENER_TABLE_HEADER = `<tr>
  <th style="text-align:left;">Stock</th>
  <th>Price</th>
  <th>Chart</th>
  <th>Value</th>
</tr>`;

function screenerRowHtml(r, meta) {
  const nseUrl = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol.toUpperCase())}`;
  const m = meta(r);
  return `<tr class="main-row">
    <td style="text-align:left;"><div class="sym"><a href="${nseUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:none;">${r.symbol}</a></div></td>
    <td><span class="price-bold">₹${r.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>${freshnessDot(r.priceSource, r.priceTs, candleFreshnessNote(r))}</td>
    <td><div style="cursor:pointer; display:flex; justify-content:center;" onclick="window.openModalChart('${r.symbol}', '${r.tf}')">${generateSparkline(r.priceHist, r.ema21Hist, r.ema50Hist)}</div></td>
    <td class="${m.cls}" style="font-weight:700;">${m.value}</td>
  </tr>`;
}

// Combined tabs (52W High/Low, RSI Oversold/Overbought) show both halves
// as one continuous table under a shared header, separated by a labeled
// divider row — not a click-to-switch chip, both stay always visible.
function screenerDividerRow(section, count, label) {
  const titleTxt = label ? `${section.title} · ${label}` : section.title;
  return `<tr class="screener-divider"><td colspan="4"><span style="font-size:14px;">${section.icon}</span> <span style="color:${section.color}; font-weight:700;">${titleTxt}</span> <span class="muted-xl">(${count})</span></td></tr>`;
}

const SCREENER_EMPTY_ROW = `<tr><td colspan="4" style="text-align:center; color:var(--muted);">No stocks currently match.</td></tr>`;

// Which timeframe a byTf: true section's precomputed data should read —
// same fallback as effectiveChartTf (ui-core.mjs): 'ALL' is a single-symbol
// All Stocks-only feature, meaningless here.
function currentScreenerTf() {
  const raw = window.stateManager?.get('timeframe');
  return raw && raw !== 'ALL' ? raw : '5m';
}

function screenerSectionRows(section, data) {
  const raw = section.byTf ? (data[section.key]?.[currentScreenerTf()] || []) : (data[section.key] || []);
  return window.searchFilter?.filterRows(raw) || raw;
}

// Renders one screener tab's full content — Top Gainers/Losers/Volume
// Shockers/52W High-Low/Bullish Crossover/Momentum Burst/RSI Oversold-
// Overbought all share this, differing only in SCREENER_TAB_MAP[tab].
function renderScreenerCategory(tab, data) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  document.getElementById('tableHeader').innerHTML = SCREENER_TABLE_HEADER;
  const restoreScroll = captureScroll();

  if (!data) {
    if (tbody) tbody.innerHTML = '';
    if (empty) { empty.classList.remove('loading'); empty.style.display = 'block'; empty.textContent = 'No screener data available yet — the first market-wide scan can take a few minutes.'; }
    restoreScroll();
    return;
  }

  const rcEl = document.getElementById('rowCount');
  if (rcEl) {
    // `lastUpdated` is when this refresh cycle ran, not how fresh every row
    // actually is (rows can be reused from up to ~30s-old main-scan data, or
    // up to 15min old for symbols outside the main universe) — show the
    // real oldest-price timestamp (`dataAsOf`) instead of implying the
    // whole set is as fresh as the cycle time.
    const asOfTs = data.dataAsOf ?? (data.lastUpdated ? Date.parse(data.lastUpdated) : null);
    const updated = asOfTs ? new Date(asOfTs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';
    rcEl.textContent = `Nifty ${data.universeSize || 500} · data as of ${updated} · refreshes ~every 15 min`;
  }

  if (empty) empty.style.display = 'none';

  const keys = SCREENER_TAB_MAP[tab] || [];
  const sections = keys.map(k => SCREENER_SECTIONS.find(s => s.key === k)).filter(Boolean);

  let rowsHtml;
  if (sections.length === 1 && sections[0].byTfGroup) {
    // Gainers/Losers — always show all four timeframe groupings together,
    // not driven by the dropdown.
    const s = sections[0];
    rowsHtml = GAINER_LOSER_TFS.map(tf => {
      const raw = data[s.key]?.[tf] || [];
      const rows = window.searchFilter?.filterRows(raw) || raw;
      return screenerDividerRow(s, rows.length, tf) + (rows.length ? rows.map(r => screenerRowHtml(r, s.meta)).join('') : SCREENER_EMPTY_ROW);
    }).join('');
  } else if (sections.length > 1) {
    // Combined tab — divider row + rows per section.
    rowsHtml = sections.map(s => {
      const rows = screenerSectionRows(s, data);
      return screenerDividerRow(s, rows.length) + (rows.length ? rows.map(r => screenerRowHtml(r, s.meta)).join('') : SCREENER_EMPTY_ROW);
    }).join('');
  } else if (sections[0]) {
    // Single-category tab — no divider needed, the tab itself is the label.
    const rows = screenerSectionRows(sections[0], data);
    rowsHtml = rows.length ? rows.map(r => screenerRowHtml(r, sections[0].meta)).join('') : SCREENER_EMPTY_ROW;
  } else {
    rowsHtml = SCREENER_EMPTY_ROW;
  }

  tbody.innerHTML = rowsHtml;
  restoreScroll();
}

// ── RENDER: SECTORS ──────────────────────────────────────────
function renderSectors(data) {
  if (!data?.data) {
    console.warn('[Render] No data available for sectors');
    return;
  }

  const searchQuery = window.stateManager.get('searchQuery').trim().toUpperCase();
  let allRows = [];

  // Sectors ALWAYS use daily data (1d_ALL) regardless of selected timeframe
  allRows = data.data['1d_ALL'] || [];

  // Group by sector
  const sectors = {};
  allRows.forEach(r => {
    if (!sectors[r.sector]) {
      sectors[r.sector] = { name: r.sector, stocks: 0, sumChg: 0, topGainer: r, topLoser: r };
    }
    sectors[r.sector].stocks++;
    sectors[r.sector].sumChg += r.chgPct;
    if (r.chgPct > sectors[r.sector].topGainer.chgPct) sectors[r.sector].topGainer = r;
    if (r.chgPct < sectors[r.sector].topLoser.chgPct) sectors[r.sector].topLoser = r;
  });

  let list = Object.values(sectors).map(s => {
    s.avgChg = s.sumChg / s.stocks;
    return s;
  });

  // Filter by search
  if (searchQuery) {
    const terms = searchQuery.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length > 0) {
      list = list.filter(s => terms.some(t => s.name.toUpperCase().includes(t)));
    }
  }

  // Sort
  const sortObj = window.stateManager.get('sortStack')[0] || { col: 'name', asc: true };
  const sortBy = sortObj.col === 'sector' ? 'name' : sortObj.col;

  list.sort((a, b) => {
    let res = 0;
    if (sortBy === 'name') res = a.name.localeCompare(b.name);
    else if (sortBy === 'topGainer') res = a.topGainer.chgPct - b.topGainer.chgPct;
    else if (sortBy === 'topLoser') res = a.topLoser.chgPct - b.topLoser.chgPct;
    else {
      const va = a[sortBy] || 0, vb = b[sortBy] || 0;
      res = va - vb;
    }
    return sortObj.asc ? res : -res;
  });

  // Update header
  document.getElementById('tableHeader').innerHTML = `<tr>
    <th onclick="window.sortManager.handleSort('name', event)" style="text-align:left; width:20%">Sector</th>
    <th onclick="window.sortManager.handleSort('avgChg', event)" style="width:20%">Average Change</th>
    <th onclick="window.sortManager.handleSort('stocks', event)" style="width:20%">Stocks</th>
    <th onclick="window.sortManager.handleSort('topGainer', event)" style="width:20%">Top Gainer</th>
    <th onclick="window.sortManager.handleSort('topLoser', event)" style="width:20%">Bottom Loser</th>
  </tr>`;

  // Update sort indicators
  updateSortIndicators(window.stateManager.get('sortStack'));

  // Build HTML
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (!list.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = 'No sectors found.';
    }
    return;
  }

  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  const html = list.map(s => {
    const avgColor = s.avgChg >= 0 ? 'up' : 'dn';
    const gainerColor = s.topGainer.chgPct >= 0 ? 'up' : 'dn';
    const loserColor = s.topLoser.chgPct >= 0 ? 'up' : 'dn';

    return `<tr>
      <td style="font-weight:700; color:var(--text);">${s.name}</td>
      <td data-label="Average Change" style="font-family:var(--mono); font-weight:700;" class="${avgColor}">${s.avgChg >= 0 ? '+' : ''}${s.avgChg.toFixed(2)}%</td>
      <td data-label="Stocks" style="text-align:center; font-family:var(--mono);">${s.stocks}</td>
      <td data-label="Top Gainer">
        <span class="${gainerColor}" style="font-family:var(--mono); font-weight:600;">${s.topGainer.symbol}</span>
        <span class="${gainerColor}" style="font-size:10px; margin-left:4px;">(${s.topGainer.chgPct >= 0 ? '+' : ''}${s.topGainer.chgPct.toFixed(2)}%)</span>
      </td>
      <td data-label="Bottom Loser">
        <span class="${loserColor}" style="font-family:var(--mono); font-weight:600;">${s.topLoser.symbol}</span>
        <span class="${loserColor}" style="font-size:10px; margin-left:4px;">(${s.topLoser.chgPct >= 0 ? '+' : ''}${s.topLoser.chgPct.toFixed(2)}%)</span>
      </td>
    </tr>`;
  }).join('');

  tbody.innerHTML = html;
  document.getElementById('rowCount').textContent = `Sectors: ${list.length}`;
}

// ── RENDER: PORTFOLIO ────────────────────────────────────────
function renderPortfolio(data) {
  if (!data) return;

  const { holdings, positions, summary } = data;

  // Show portfolio summary card
  const summaryEl = document.getElementById('portfolioSummary');
  if (summaryEl) {
    summaryEl.style.display = 'flex';
    // Build summary HTML (simplified for brevity)
    const equityPnl = holdings?.reduce((s, h) => s + (h.pnl || 0), 0) || 0;
    const equityInvested = holdings?.reduce((s, h) => s + (h.average_price * h.quantity), 0) || 0;
    const equityCurrent = holdings?.reduce((s, h) => s + (h.current_value || 0), 0) || 0;
    const totalPnl = equityPnl;

    const pricingIncomplete = summary?.pricing_incomplete;
    summaryEl.innerHTML = `
      <div style="background:linear-gradient(135deg, rgba(13,18,32,0.95), rgba(17,25,39,0.8)); border:1px solid var(--border); border-radius:14px; padding:16px 20px; margin-bottom:10px; width:100%;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
          <div>
            <div style="font-size:9px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:1.5px;">💼 Total Portfolio</div>
            <div style="font-size:24px; font-weight:800; font-family:var(--mono); color:var(--text); margin-top:2px;">₹${equityCurrent.toLocaleString('en-IN', {minimumFractionDigits:2})}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:9px; font-weight:600; color:var(--muted);">TOTAL P&L</div>
            <div style="font-size:18px; font-weight:800; font-family:var(--mono); color:${totalPnl >= 0 ? '#22c55e' : '#ef4444'};">${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}</div>
          </div>
        </div>
        ${pricingIncomplete ? `<div style="font-size:9px; color:var(--yellow, #eab308);">⚠ One or more holdings/positions have no live price this cycle — totals above exclude them, not "flat".</div>` : ''}
      </div>`;
  }

  // Hide default table header for portfolio
  document.getElementById('tableHeader').innerHTML = '';

  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (!holdings?.length && !positions?.length) {
    tbody.innerHTML = '';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      const restricted = data.restricted?.holdings || data.restricted?.positions;
      empty.textContent = restricted
        ? `⚠️ Upstox blocked this request: ${restricted}`
        : 'No holdings or positions found.';
    }
    const rcElEmpty = document.getElementById('rowCount');
    if (rcElEmpty) rcElEmpty.textContent = 'Portfolio: 0 items';
    return;
  }

  if (empty) { empty.classList.remove('loading'); empty.style.display = 'none'; }

  // Build portfolio cards (simplified)
  let html = '<div style="padding:10px;">';

  if (holdings?.length) {
    html += `<div style="margin-bottom:14px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; padding:8px 12px; background:linear-gradient(90deg, rgba(6,182,212,0.15), transparent); border-radius:8px;">
        <span style="font-size:16px;">📈</span>
        <span style="font-size:12px; font-weight:700; color:var(--text); letter-spacing:0.5px;">EQUITY HOLDINGS</span>
        <span style="font-size:9px; color:var(--muted); margin-left:auto;">${holdings.length} items</span>
      </div>`;

    holdings.forEach(h => {
      // current_price/pnl/pnl_percent are null (not 0) when Upstox didn't
      // return a live price for this holding — show "—", never a fabricated
      // ₹0.00 that would misread as "flat, no gain/loss."
      const hasPrice = h.current_price != null;
      const pnl = h.pnl;
      const pnlPct = h.pnl_percent;
      const pnlColor = !hasPrice ? 'var(--muted)' : (pnl >= 0 ? '#22c55e' : '#ef4444');
      const ltpTxt = hasPrice ? `₹${h.current_price.toFixed(2)}` : '—';
      const pnlTxt = hasPrice ? `${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}` : '—';
      const pnlPctTxt = hasPrice ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : 'price unavailable';

      html += `<div class="card" style="background:rgba(255,255,255,0.02); border-color:${pnlColor}30; padding:10px 14px; margin-bottom:6px; display:grid; grid-template-columns:1fr auto; gap:6px; align-items:center;">
        <div>
          <div style="font-weight:700; font-family:var(--mono); font-size:12px; color:var(--text);">${h.trading_symbol}</div>
          <div style="display:flex; gap:12px; margin-top:3px; font-size:9px; color:var(--muted);">
            <span>Qty: <b style="color:var(--text);">${h.quantity}</b></span>
            <span>Avg: <b style="color:var(--text);">₹${(h.average_price || 0).toFixed(2)}</b></span>
            <span>LTP: <b style="color:var(--text);">${ltpTxt}</b>${freshnessDot(h.price_source, h.price_ts ?? null)}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700; font-size:14px; font-family:var(--mono); color:${pnlColor};">${pnlTxt}</div>
          <div style="font-size:10px; font-weight:600; font-family:var(--mono); color:${pnlColor};">${pnlPctTxt}</div>
        </div>
      </div>`;
    });

    html += '</div>';
  }

  html += '</div>';
  tbody.innerHTML = html;

  const itemCount = (holdings?.length || 0) + (positions?.length || 0);
  document.getElementById('rowCount').textContent = `Portfolio: ${itemCount} items`;
}

// ── RENDER: OPTION CHAIN (for F&O expanded rows) ─────────────
function renderOptionChain(symbol, chain, wrap) {
  const calls = chain?.topCalls || chain?.callOptions || chain?.calls || [];
  const puts = chain?.topPuts || chain?.putOptions || chain?.puts || [];

  if (calls.length === 0 || puts.length === 0) {
    wrap.innerHTML = `<div style="padding:20px; text-align:center; color:var(--muted)">No Option Chain data available.</div>`;
    return;
  }

  // Simplified option chain display
  let html = `<div style="padding:10px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <span style="font-size:13px; font-weight:700; color:var(--text); text-transform:uppercase;">✦ OPTION CHAIN — ${symbol}</span>
      <span class="fn-badge" style="color:var(--accent);">${chain.source?.toUpperCase() || 'N/A'}</span>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <div>
        <div style="font-size:11px; font-weight:700; color:var(--green); margin-bottom:6px;">TOP 5 CALLS</div>
        <table style="width:100%; font-size:10px;">
          <thead><tr><th style="text-align:left;">STRIKE</th><th>LTP</th><th>IV%</th></tr></thead>
          <tbody>
            ${calls.slice(0, 5).map(o => `
              <tr>
                <td style="font-family:var(--mono);">₹${o.strikePrice || o.strike || '—'}</td>
                <td style="font-family:var(--mono); color:var(--green);">₹${((o.ltp || o.lastPrice) || 0).toFixed(2)}</td>
                <td style="font-family:var(--mono); color:var(--yellow);">${((o.greeks?.iv || o.iv) || 0).toFixed(1)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div>
        <div style="font-size:11px; font-weight:700; color:var(--red); margin-bottom:6px;">TOP 5 PUTS</div>
        <table style="width:100%; font-size:10px;">
          <thead><tr><th style="text-align:left;">STRIKE</th><th>LTP</th><th>IV%</th></tr></thead>
          <tbody>
            ${puts.slice(0, 5).map(o => `
              <tr>
                <td style="font-family:var(--mono);">₹${o.strikePrice || o.strike || '—'}</td>
                <td style="font-family:var(--mono); color:var(--red);">₹${((o.ltp || o.lastPrice) || 0).toFixed(2)}</td>
                <td style="font-family:var(--mono); color:var(--yellow);">${((o.greeks?.iv || o.iv) || 0).toFixed(1)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  wrap.innerHTML = html;
}

// ── MODAL CHART ──────────────────────────────────────────────
let modalChartInstance = null;

function openModalChart(symbol, tf) {
  const state = window.stateManager.get();
  let row = null;

  // Stocks tab's "All" chip never populates the Stage-2 cache below (see
  // renderStocks) — its own universe-snapshot cache is the ONLY correct
  // source for this view, and it's genuinely tf-specific now
  // (stage1_filter.mjs computes priceHist/ema21Hist/ema50Hist for whichever
  // tf is currently selected, not always 5m). This view deliberately does
  // NOT fall through to the Stage-2 cache below when its own data isn't
  // ready yet (e.g. this symbol's candles for the selected tf haven't been
  // fetched by stage1_filter.mjs's warm-up pass) — that cache belongs to a
  // completely different pipeline (Golden Cross/Buy/Sell chips) and could
  // hold a stale entry from an earlier, unrelated timeframe/session,
  // silently substituting the wrong data instead of honestly showing
  // nothing yet.
  if (state.activeTab === 'STOCKS' && (state.stockFilter || 'ALL') === 'ALL') {
    const cheapRow = (window.universeSnapshotCache || []).find(x => x.symbol === symbol);
    if (cheapRow?.priceHist?.length >= 2) row = { ...cheapRow, tf };
    if (!row) return; // still warming up for this symbol/tf — nothing honest to show yet
  }

  if (!row) {
    // /api/state always returns the same full snapshot regardless of which
    // (timeframe, tab) it was fetched for, so any populated cache entry works
    // — try the "obvious" key first, then fall back to whatever is cached
    // (needed for tabs like Intraday whose cache key doesn't follow the
    // tf+activeTab convention the primary lookup assumes).
    let data = window.dataManager.cache.get(window.dataManager.cacheKey(tf, state.activeTab))?.data;
    if (!data?.data) {
      for (const entry of window.dataManager.cache.values()) {
        if (entry?.data?.data) { data = entry.data; break; }
      }
    }

    if (data?.data) {
      // Look up the SAME timeframe the user actually clicked the sparkline
      // from first — this used to always try '1m_ALL' first regardless of
      // `tf`, so the modal silently showed 1-minute EMAs even when clicked
      // from a 15m/1d row, which both looks wrong on its own and can't match
      // a same-timeframe chart on Upstox (or anywhere else) since it's a
      // different timeframe's data entirely. Only fall back to other
      // timeframes if this symbol truly has no data at all for the requested
      // one.
      const ALL_TFS = ['1m', '5m', '10m', '15m', '30m', '1h', '1d'];
      const BUCKETS = ['ALL', 'GOLDEN', 'BUY', 'SELL'];
      const orderedTfs = [tf, ...ALL_TFS.filter(t => t !== tf)];
      const allKeys = orderedTfs.flatMap(t => BUCKETS.map(b => `${t}_${b}`));

      for (const key of allKeys) {
        row = data.data[key]?.find(x => x.symbol === symbol);
        if (row) break;
      }
    }
  }

  // Last-resort fallback for any other path that reaches here without a
  // Stage-2 row (e.g. Stage-2 cache genuinely empty) — same universe-snapshot
  // source, real tf, not a hardcoded one.
  if (!row) {
    const cheapRow = (window.universeSnapshotCache || []).find(x => x.symbol === symbol);
    if (cheapRow?.priceHist?.length >= 2) row = { ...cheapRow, tf };
  }

  if (!row) return;

  const modal = document.getElementById('chartModal');
  modal.style.display = 'flex';
  document.getElementById('modalTitle').innerText = `${row.symbol} (${row.tf})`;

  const ctx = document.getElementById('modalCanvas').getContext('2d');
  if (modalChartInstance) modalChartInstance.destroy();

  const labels = Array.from({ length: row.priceHist.length }, (_, i) => `T-${row.priceHist.length - 1 - i}`);

  // Cross markers — same crossing detection as the sparkline: a white dot on
  // the EMA21 line wherever it actually crosses EMA50 within this window.
  const ema21 = row.ema21Hist, ema50 = row.ema50Hist;
  const crossIndices = new Set();
  for (let i = 1; i < ema21.length; i++) {
    const p21 = ema21[i - 1], p50 = ema50[i - 1], c21 = ema21[i], c50 = ema50[i];
    if (![p21, p50, c21, c50].every(Number.isFinite)) continue;
    const prevDiff = p21 - p50, currDiff = c21 - c50;
    if (prevDiff === 0 || currDiff === 0 || (prevDiff > 0) === (currDiff > 0)) continue;
    crossIndices.add(i);
  }
  const crossRadius = ema21.map((_, i) => crossIndices.has(i) ? 5 : 0);
  const crossHoverRadius = ema21.map((_, i) => crossIndices.has(i) ? 6 : 4);

  modalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Price', data: row.priceHist, borderColor: 'rgba(255, 255, 255, 0.4)', borderWidth: 1, color: 'white', fill: false, tension: 0.1, pointRadius: 2, pointHoverRadius: 5 },
        { label: 'EMA 21', data: row.ema21Hist, borderColor: '#22c55e', borderWidth: 2, fill: false, tension: 0.1, pointRadius: crossRadius, pointHoverRadius: crossHoverRadius, pointBackgroundColor: '#ffffff', pointBorderColor: 'rgba(0,0,0,0.5)' },
        { label: 'EMA 50', data: row.ema50Hist, borderColor: '#ef4444', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 0, pointHoverRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#dce8f5', font: { family: 'Sora' } } },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function (context) { return context.dataset.label + ': ₹' + context.parsed.y.toFixed(2); }
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#526a85', font: { family: 'JetBrains Mono' } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#526a85', font: { family: 'JetBrains Mono' } } }
      }
    }
  });
}

function closeModalChart(event) {
  if (event && event.target !== document.getElementById('chartModal') && event.target.className !== 'modal-close') return;
  document.getElementById('chartModal').style.display = 'none';
  if (modalChartInstance) {
    modalChartInstance.destroy();
    modalChartInstance = null;
  }
}

// ── HELPER: Update badges ────────────────────────────────────
// Gainers/Losers are keyed by all 4 groupings (GAINER_LOSER_TFS) — sum
// across all of them for the badge. Volume Shockers/Bullish Crossover/
// Momentum Burst/RSI are keyed by all 7 real timeframes but only ONE is
// ever shown at a time (whichever the dropdown is on) — count just that one
// so the badge actually matches what's on screen.
function screenerCategoryCount(byTfObj, byTfGroup) {
  if (!byTfObj) return undefined;
  if (byTfGroup) return Object.values(byTfObj).reduce((sum, rows) => sum + (rows?.length || 0), 0);
  return byTfObj[currentScreenerTf()]?.length;
}

function updateBadges(data, screenerData) {
  if (screenerData) {
    const setScreenerBadge = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val === 0 ? '0' : (val || '—');
    };
    setScreenerBadge('badge-GAINERS', screenerCategoryCount(screenerData.gainers, true));
    setScreenerBadge('badge-LOSERS', screenerCategoryCount(screenerData.losers, true));
    setScreenerBadge('badge-VOLSHOCK', screenerCategoryCount(screenerData.volumeShockers));
    setScreenerBadge('badge-RANGE52W', (screenerData.high52w?.length || 0) + (screenerData.low52w?.length || 0));
    setScreenerBadge('badge-BULLCROSS', screenerCategoryCount(screenerData.bullishCrossover));
    setScreenerBadge('badge-MOMENTUM', screenerCategoryCount(screenerData.momentumBurst));
    setScreenerBadge('badge-RSI', (screenerCategoryCount(screenerData.rsiOversold) || 0) + (screenerCategoryCount(screenerData.rsiOverbought) || 0));
  }
  if (!data?.data) return;

  const timeframe = window.stateManager.get('timeframe');

  let all = [], buys = [], sells = [], golden = [];

  if (timeframe === 'ALL') {
    ['1m', '5m', '10m', '15m', '30m', '1h', '1d'].forEach(t => {
      const allKey = `${t}_ALL`;
      const buyKey = `${t}_BUY`;
      const sellKey = `${t}_SELL`;
      const goldenKey = `${t}_GOLDEN`;

      all.push(...(data.data[allKey] || []));
      buys.push(...(data.data[buyKey] || []));
      sells.push(...(data.data[sellKey] || []));
      golden.push(...(data.data[goldenKey] || []));
    });
  } else {
    const allKey = `${timeframe}_ALL`;
    const buyKey = `${timeframe}_BUY`;
    const sellKey = `${timeframe}_SELL`;
    const goldenKey = `${timeframe}_GOLDEN`;

    all = data.data[allKey] || [];
    buys = data.data[buyKey] || [];
    sells = data.data[sellKey] || [];
    golden = data.data[goldenKey] || [];
  }

  const setBadge = (id, val) => {
    const el = document.getElementById(id);
    if (el) {
      const displayVal = val === 0 ? '0' : (val || '—');
      el.textContent = displayVal;
    }
  };

  const uniqueGolden = new Set(golden.map(r => r.symbol)).size;
  const uniqueAll = new Set(all.map(r => r.symbol)).size;
  const uniqueBuy = new Set(buys.map(r => r.symbol)).size;
  const uniqueSell = new Set(sells.map(r => r.symbol)).size;
  const uniqueSectors = new Set(all.map(r => r.sector).filter(Boolean)).size;
}

// ── HELPER: Update last updated badge ────────────────────────
function updateLastUpdatedBadge(data) {
  const el = document.getElementById('lastUpdatedBadge');
  if (el && data?.lastUpdated) {
    const d = new Date(data.lastUpdated);
    const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `Scan synced ${date} - ${time}`;

    // `lastUpdated` is when this scan CYCLE synced, not a promise that every
    // row's price is that fresh — `dataAsOf` (the oldest priceTs actually
    // behind this data) is the honest freshness fact; surface it in the
    // tooltip rather than collapsing both into one string that could imply
    // more freshness than the data actually has. Per-row freshness is shown
    // by the dot next to each price.
    if (data.dataAsOf) {
      const asOf = new Date(data.dataAsOf);
      const asOfTime = asOf.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.title = `Scan cycle synced ${time} · oldest price behind this data is as of ${asOfTime} · see the dot next to each price for its own freshness`;
    } else {
      el.title = '';
    }
  }
}

// ── HELPER: Scan progress/duration badge (from /api/status, already polled
// every cycle by ui-main.mjs's pollStatus() — no extra network call here) ──
function updateScanProgressBadge(status) {
  const el = document.getElementById('scanProgressBadge');
  if (!el || !status) return;
  const p = status.scanProgress;
  if (!p) { el.textContent = ''; return; }

  if (status.scanning && p.stage === 'stage2') {
    el.textContent = `Stage 2: ${p.done}/${p.total} symbols`;
  } else if (p.lastCycleDurationMs != null) {
    const secs = (p.lastCycleDurationMs / 1000).toFixed(0);
    const etaMin = status.nextCycleEtaMs != null ? Math.max(0, Math.round(status.nextCycleEtaMs / 60000)) : null;
    el.textContent = `Last cycle ${secs}s${etaMin != null ? ` · next in ~${etaMin}m` : ''}`;
  } else {
    el.textContent = '';
  }
}

// ── HELPER: Render current view ──────────────────────────────
function renderCurrentView() {
  const activeTab = window.stateManager.get('activeTab');

  if (activeTab === 'AI') {
    renderAIScan(window.aiScanCache);
    return;
  }

  if (activeTab in SCREENER_TAB_MAP) {
    renderScreenerCategory(activeTab, window.dataManager.screenerCache?.data);
    return;
  }

  // "All" chip's cheap snapshot lives in its own cache (window.
  // universeSnapshotCache, kept fresh by ui-main.mjs's own poll), not the
  // Stage-2 `dataManager.cache` this function checks below — render
  // immediately instead of bailing out on "no Stage-2 data cached yet".
  if (activeTab === 'STOCKS' && window.stateManager.get('stockFilter') === 'ALL') {
    renderStocks(null);
    return;
  }

  const timeframe = window.stateManager.get('timeframe');
  const dataKey = window.dataManager.cacheKey(timeframe, activeTab);
  const cached = window.dataManager.cache.get(dataKey);
  if (!cached?.data) return;

  if (activeTab === 'INTRADAY') {
    renderIntraday(cached.data);
  } else {
    renderStocks(cached.data);
  }
}

// ── RENDER: CRITICAL TRADES ───────────────────────────────────
const CRIT_STATE_ORDER = ["STRONG HOLD", "HOLD", "MOMENTUM WEAKENING", "PROFIT PROTECTION", "STRONG EXIT WARNING", "THESIS INVALIDATED"];
function critStateClass(state) {
  return 'state-' + (state || '').toLowerCase().replace(/\s+/g, '-');
}
function critStateColor(state) {
  if (state === "STRONG HOLD" || state === "HOLD") return '#22c55e';
  if (state === "MOMENTUM WEAKENING" || state === "PROFIT PROTECTION") return '#f59e0b';
  return '#ef4444';
}

const CRITICAL_TABLE_HEADER = `<tr>
  <th style="text-align:left;">Stock</th>
  <th>Health</th>
  <th>Live Price</th>
  <th>P&amp;L</th>
  <th>Peak</th>
  <th>Giveback</th>
  <th>Stop / Target</th>
  <th>Deterioration</th>
  <th>Trend</th>
  <th>Actions</th>
</tr>`;

function renderCritical(payload) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  document.getElementById('tableHeader').innerHTML = CRITICAL_TABLE_HEADER;

  // Same wholesale-replacement scroll issue as renderIntraday — this tab
  // polls every ~8s, so without this a health-score update yanks the user
  // back to the top of the list constantly.
  const restoreScroll = captureScroll();

  const trades = payload?.trades || [];
  const rcEl = document.getElementById('rowCount');
  if (rcEl) rcEl.textContent = `Critical Trades: ${trades.length} active`;

  if (!trades.length) {
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = 'No Critical trades marked. Use "Mark Critical" on any Intraday/All-stocks row after you enter a position.';
    }
    tbody.innerHTML = '';
    restoreScroll();
    return;
  }
  if (empty) empty.style.display = 'none';

  const rows = trades.map(t => {
    const health = t.lastHealth || {};
    const score = health.score ?? '—';
    const state = health.state || 'PENDING';
    const pnl = health.pnl ?? 0;
    const pnlPct = health.pnlPct ?? 0;
    const pnlCls = pnl >= 0 ? 'up' : 'dn';
    const history = (t.minuteHistory || []).slice(-30);
    const historySpark = history.length >= 2
      ? generateSparkline(history.map(h => h.health), history.map(() => history[0]?.health ?? 50), history.map(() => history[0]?.health ?? 50))
      : '<span class="muted-xl">Building…</span>';

    const notifHtml = (t.notifications || []).slice(0, 4).map(n =>
      `<div class="crit-notif severity-${n.severity}">${n.type}: ${n.message}</div>`
    ).join('');

    const betterOppHtml = t.betterOpportunity
      ? `<div class="crit-better-opp">💡 BETTER OPPORTUNITY: ${t.betterOpportunity.reason}</div>`
      : '';

    const trapHtml = t.trap && t.trap.level !== 'NORMAL'
      ? `<div class="crit-warnings">⚠️ Trap risk: ${t.trap.level} — ${(t.trap.flags || []).join('; ')}</div>`
      : '';

    const warningsHtml = (health.warnings || []).length
      ? `<div class="crit-warnings">${health.warnings.slice(0, 4).join(' · ')}</div>`
      : '';

    const detailHtml = [warningsHtml, trapHtml, betterOppHtml, notifHtml].filter(Boolean).join('');

    return `<tr class="main-row ${critStateClass(state)}">
      <td style="text-align:left;">
        <div style="display:flex; align-items:baseline; gap:8px; flex-wrap:nowrap;">
          <div class="sym">${t.symbol}</div>
          <span class="muted-xl" style="white-space:nowrap;">Qty ${t.quantity} @ ₹${t.entryPrice}</span>
        </div>
      </td>
      <td><span class="crit-health-badge" style="background:${critStateColor(state)}22;color:${critStateColor(state)};">${score} — ${state}</span></td>
      <td>₹${health.price ?? '—'}</td>
      <td class="${pnlCls}">₹${pnl.toFixed ? pnl.toFixed(2) : pnl} (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</td>
      <td>₹${t.peakPrice}</td>
      <td>${t.givebackPct != null ? t.givebackPct + '%' : '—'}</td>
      <td>${t.stopLoss ?? '—'} / ${t.target ?? '—'}</td>
      <td>${t.lastDeteriorationPattern || '—'}</td>
      <td>${historySpark}</td>
      <td>
        <div class="crit-actions">
          <button onclick="window.criticalManager?.promptEditLevels('${t.id}', ${t.stopLoss ?? 'null'}, ${t.target ?? 'null'})">Edit SL/Target</button>
          <button onclick="window.criticalManager?.closeTrade('${t.id}')">Close Trade</button>
        </div>
      </td>
    </tr>
    ${detailHtml ? `<tr class="sub-row active"><td colspan="10"><div class="sub-wrap">${detailHtml}</div></td></tr>` : ''}`;
  }).join('');

  tbody.innerHTML = rows;
  restoreScroll();
}

// ── MODEL / LEARNING dashboard (read-only) ────────────────────
function fmtPct(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function renderModel(payload) {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  document.getElementById('tableHeader').innerHTML = '';
  const restoreScroll = captureScroll();

  const overview = payload?.overview;
  const segments = payload?.segments?.segments || [];
  const drift = payload?.drift?.drift || [];
  const versions = payload?.versions?.versions || [];

  const badge = document.getElementById('badge-MODEL');
  if (badge) badge.textContent = overview?.ok ? (overview.recentDriftFlagCount || 0) : '—';

  const rcEl = document.getElementById('rowCount');

  if (!overview?.ok) {
    if (rcEl) rcEl.textContent = 'Model / Learning';
    if (empty) {
      empty.classList.remove('loading');
      empty.style.display = 'block';
      empty.textContent = 'Learning layer unavailable — this is optional instrumentation and never affects live scoring either way.';
    }
    tbody.innerHTML = '';
    restoreScroll();
    return;
  }
  if (empty) empty.style.display = 'none';
  if (rcEl) rcEl.textContent = `Model / Learning — ${overview.snapshotCount} candidates captured, ${overview.outcomeCount} finalized`;

  const summaryCards = [
    { label: 'Snapshots Captured', value: overview.snapshotCount },
    { label: 'Outcomes Finalized', value: overview.outcomeCount },
    { label: 'Actually Traded', value: overview.takenCount },
    { label: 'Stats As Of', value: overview.latestAsOfDate || '—' },
    { label: 'Last Job Run', value: overview.lastJobRun ? `${overview.lastJobRun.run_date} (${overview.lastJobRun.status})` : '—' },
    { label: 'Production Model', value: overview.productionModel ? `v${overview.productionModel.version_id}` : 'None — rule-based scoring' },
  ].map(c => `<div class="model-card"><div class="m-label">${c.label}</div><div class="m-value">${c.value}</div></div>`).join('');

  const regimeRows = (overview.regimeOverview || []).map(r => `
    <tr class="${r.sufficient_sample ? '' : 'insufficient'}">
      <td>${r.segment_key.replace('regime:', '')}</td>
      <td data-label="Window">${r.window}</td>
      <td data-label="Samples">${r.sample_count}</td>
      <td data-label="Win Rate">${fmtPct(r.win_rate)}</td>
      <td data-label="Sufficient?">${r.sufficient_sample ? 'Yes' : 'No — below minimum sample size'}</td>
    </tr>`).join('');

  const segmentRows = segments.slice(0, 100).map(s => `
    <tr class="${s.sufficient_sample ? '' : 'insufficient'}">
      <td>${s.segment_key}</td>
      <td data-label="Window">${s.window}</td>
      <td data-label="N">${s.sample_count}</td>
      <td data-label="Win Rate">${fmtPct(s.win_rate)}</td>
      <td data-label="P(+1%)">${fmtPct(s.prob_reach_1pct)}</td>
      <td data-label="P(+2%)">${fmtPct(s.prob_reach_2pct)}</td>
      <td data-label="P(+5%)">${fmtPct(s.prob_reach_5pct)}</td>
      <td data-label="P(Major Adverse)">${fmtPct(s.prob_major_adverse)}</td>
    </tr>`).join('');

  const driftRows = drift.map(d => `
    <tr class="model-drift-row ${d.flagged ? 'flagged' : ''}">
      <td>${d.segment_key}</td>
      <td data-label="Recent">${fmtPct(d.recent_win_rate)}</td>
      <td data-label="Historical">${fmtPct(d.historical_win_rate)}</td>
      <td data-label="Delta">${d.delta > 0 ? '+' : ''}${d.delta}pp</td>
      <td data-label="N (recent/hist)">${d.recent_sample_count} / ${d.historical_sample_count}</td>
      <td data-label="Notes">${d.notes || '—'}</td>
    </tr>`).join('');

  const versionRows = versions.map(v => {
    const actions = [];
    if (v.status === 'PROPOSED') {
      actions.push(`<button onclick="window.modelManager?.validateVersion(${v.version_id})">Validate</button>`);
      actions.push(`<button onclick="window.modelManager?.promoteVersion(${v.version_id})">Promote</button>`);
    } else if (v.status === 'SUPERSEDED' || v.status === 'REJECTED') {
      actions.push(`<button onclick="window.modelManager?.rollbackToVersion(${v.version_id})">Rollback to this</button>`);
    }
    return `<tr>
      <td>v${v.version_id}</td>
      <td data-label="Status">${v.status}</td>
      <td data-label="Train N">${v.training_sample_count ?? '—'}</td>
      <td data-label="Validation N">${v.validation_sample_count ?? '—'}</td>
      <td data-label="Promoted At">${v.promoted_at ? new Date(v.promoted_at).toLocaleString() : '—'}</td>
      <td data-label="Actions">${actions.join(' ')}</td>
    </tr>`;
  }).join('');

  tbody.innerHTML = `<div class="model-grid">
    <div class="model-summary-cards">${summaryCards}</div>

    <div class="model-section">
      <h3>Win Rate by Market Regime</h3>
      ${regimeRows
        ? `<table class="model-table"><thead><tr><th>Regime</th><th>Window</th><th>Samples</th><th>Win Rate</th><th>Sufficient?</th></tr></thead><tbody>${regimeRows}</tbody></table>`
        : '<div class="model-empty">No rolling stats computed yet — runs automatically after the first day with finalized outcomes.</div>'}
    </div>

    <div class="model-section">
      <h3>Segments (regime × time-of-day × signal combo)</h3>
      ${segmentRows
        ? `<table class="model-table"><thead><tr><th>Segment</th><th>Window</th><th>N</th><th>Win Rate</th><th>P(+1%)</th><th>P(+2%)</th><th>P(+5%)</th><th>P(Major Adverse)</th></tr></thead><tbody>${segmentRows}</tbody></table>`
        : '<div class="model-empty">No segments yet.</div>'}
      ${segments.length > 100 ? `<div class="model-empty">Showing 100 of ${segments.length} segments.</div>` : ''}
    </div>

    <div class="model-section">
      <h3>Drift Alerts ${drift.length ? `(${drift.length})` : ''}</h3>
      ${driftRows
        ? `<table class="model-table"><thead><tr><th>Segment</th><th>Recent</th><th>Historical</th><th>Delta</th><th>N (recent/hist)</th><th>Notes</th></tr></thead><tbody>${driftRows}</tbody></table>`
        : '<div class="model-empty">No drift flagged — recent behavior matches historical baselines.</div>'}
    </div>

    <div class="model-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;">Model Versions</h3>
        <button onclick="window.modelManager?.proposeNewWeights()">Propose New Weights…</button>
      </div>
      ${versionRows
        ? `<table class="model-table"><thead><tr><th>Version</th><th>Status</th><th>Train N</th><th>Validation N</th><th>Promoted At</th><th>Actions</th></tr></thead><tbody>${versionRows}</tbody></table>`
        : '<div class="model-empty">No weight adaptation yet — scoring is fully rule-based (Part 1\'s Entry Score), unaffected by anything on this tab.</div>'}
    </div>
  </div>`;
  restoreScroll();
}

// ── NOTIFICATIONS BANNER (persists across tabs) ───────────────
let lastSeenNotifIds = new Set();
function renderCritNotifBanner(trades) {
  const el = document.getElementById('critNotifBanner');
  if (!el) return;
  const all = [];
  for (const t of trades || []) {
    for (const n of (t.notifications || []).slice(0, 3)) {
      all.push({ ...n, symbol: t.symbol });
    }
  }
  all.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const recent = all.slice(0, 3);
  if (!recent.length) { el.innerHTML = ''; return; }

  el.innerHTML = recent.map(n => `
    <div class="crit-notif severity-${n.severity}" style="margin-bottom:4px;">
      <strong>${n.symbol}</strong> — ${n.type}: ${n.message}
    </div>`).join('');

  // Browser notification for genuinely new, severe alerts only (avoid spam).
  for (const n of recent) {
    if (n.severity === 'danger' && !lastSeenNotifIds.has(n.id)) {
      try { window.notify?.(`${n.symbol}: ${n.type}`, n.message); } catch (_) { /* noop */ }
    }
    lastSeenNotifIds.add(n.id);
  }
}

// Export to window
window.freshnessDot = freshnessDot;
window.renderStocks = renderStocks;
window.renderSectors = renderSectors;
window.renderIntraday = renderIntraday;
window.renderQuality = renderQuality;
window.hideTopPicks = hideTopPicks;
window.renderScreenerCategory = renderScreenerCategory;
window.renderPortfolio = renderPortfolio;
window.renderCritical = renderCritical;
window.renderModel = renderModel;
window.renderCritNotifBanner = renderCritNotifBanner;
window.renderRegimeBanner = renderRegimeBanner;
window.renderOptionChain = renderOptionChain;
window.openModalChart = openModalChart;
window.closeModalChart = closeModalChart;
window.updateBadges = updateBadges;
window.updateLastUpdatedBadge = updateLastUpdatedBadge;
window.updateScanProgressBadge = updateScanProgressBadge;
window.renderCurrentView = renderCurrentView;
