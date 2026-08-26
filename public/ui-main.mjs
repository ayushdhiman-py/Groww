// ============================================================
// MAIN INTEGRATION FILE - Wires everything together
// ============================================================

import { StateManager, DataManager, RenderEngine, SCREENER_TABS } from './ui-core.mjs';
import { TabManager, TimeframeManager, LivePriceUpdater, PortfolioManager, SortManager, SearchFilter, FOManager, IntervalManager, CriticalManager, ModelManager } from './ui-managers.mjs';
import './ui-renders.mjs';

// ── Initialize all managers ──────────────────────────────────
let stateManager, dataManager, renderEngine, tabManager, timeframeManager;
let livePriceUpdater, portfolioManager, sortManager, searchFilter, foManager, intervalManager, criticalManager, modelManager;

async function initApp() {
  // Create all managers
  stateManager = new StateManager();
  dataManager = new DataManager();
  renderEngine = new RenderEngine();
  tabManager = new TabManager(stateManager, dataManager, renderEngine);
  timeframeManager = new TimeframeManager(stateManager, dataManager);
  livePriceUpdater = new LivePriceUpdater(stateManager, dataManager, renderEngine);
  portfolioManager = new PortfolioManager(stateManager, dataManager, renderEngine);
  sortManager = new SortManager(stateManager);
  searchFilter = new SearchFilter(stateManager);
  foManager = new FOManager(stateManager, dataManager);
  intervalManager = new IntervalManager(stateManager);
  criticalManager = new CriticalManager();
  modelManager = new ModelManager();

  // Make managers globally accessible
  window.stateManager = stateManager;
  window.dataManager = dataManager;
  window.renderEngine = renderEngine;
  window.tabManager = tabManager;
  window.timeframeManager = timeframeManager;
  window.portfolioManager = portfolioManager;
  window.sortManager = sortManager;
  window.searchFilter = searchFilter;
  window.foManager = foManager;
  window.criticalManager = criticalManager;
  window.modelManager = modelManager;

  // Restore state from localStorage FIRST
  stateManager.restore();

  const currentState = stateManager.get();

  // Initialize UI components
  timeframeManager.init();

  // Update timeframe dropdown to show restored timeframe
  timeframeManager.updateDropdown(currentState.timeframe);

  // Update toggle states from restored state
  const idxToggle = document.getElementById('idxTgl');
  if (idxToggle) idxToggle.checked = currentState.showIndices;

  const divToggle = document.getElementById('divTgl');
  if (divToggle) divToggle.checked = currentState.showDividend;

  tabManager.init();
  sortManager.init();
  searchFilter.init();
  foManager.init();

  // Setup modal close handler
  document.getElementById('chartModal')?.addEventListener('click', (e) => {
    closeModalChart(e);
  });

  setupRowSheetAndScanHint();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();

  // Start background tasks
  startBackgroundTasks();

  // Initial load
  await checkAuth();
}

// ── Initial load ──────────────────────────────────────────────
// The server authenticates with Upstox on its own at boot using the
// configured access token — there is no user-facing login step. Just load
// whatever data is available; if the backend hasn't finished authenticating
// yet, pollStatus()'s regular polling picks up data as soon as it appears.
async function checkAuth() {
  try {
    await loadInitialData();
  } catch (e) {
    console.error('[Init] Error loading initial data:', e);
  }
}

async function loadInitialData() {
  const timeframe = stateManager.get('timeframe');
  const activeTab = stateManager.get('activeTab');

  // Load scanner data
  const data = await dataManager.fetchState(timeframe, activeTab, true);
  if (data) {
    renderStocks(data);
    window.renderRegimeBanner?.(data.marketRegime);

    // Update universe count
    const sU = document.getElementById('sU');
    if (sU) {
      sU.textContent = data?.universe || '—';
    } else {
      console.warn('[App] Universe element (#sU) not found!');
    }

    // Update stat cards (Golden, Buy, Sell, etc.)
    if (typeof window.updateStatCards === 'function') {
      window.updateStatCards(data);
    }

    // Update badges
    updateBadges(data);
    updateLastUpdatedBadge(data);
  } else {
    console.error('[App] Failed to load initial data');
  }

  // Load cached portfolio if available
  const cachedPortfolio = dataManager.loadCachedPortfolio();
  if (cachedPortfolio) {
    const itemCount = (cachedPortfolio.holdings?.length || 0) + (cachedPortfolio.positions?.length || 0);
    const badge = document.getElementById('badge-PORTFOLIO');
    if (badge) badge.textContent = itemCount;
  }
}

// ── Background Tasks ─────────────────────────────────────────
function startBackgroundTasks() {
  // Market status tick (every 1s)
  intervalManager.add('marketTick', () => {
    updateMarketStatus();
  }, 1000);

  // Poll status (every 2s)
  intervalManager.add('pollStatus', async () => {
    await pollStatus();
  }, 2000);

  // Live price updates (every 3s) - managed by LivePriceUpdater
  livePriceUpdater.start();

  // Critical trades: health/notifications poll (independent of active tab —
  // "continuously monitor Critical trades" per the spec, not just while the
  // Critical tab happens to be open).
  criticalManager.startPolling();

  // Full state reload (every 30s)
  intervalManager.add('fullReload', async () => {
    const activeTab = stateManager.get('activeTab');
    if (activeTab === 'CRITICAL') return; // CriticalManager polls on its own 8s cadence
    if (SCREENER_TABS.includes(activeTab)) {
      const screenerData = await dataManager.fetchScreener();
      if (screenerData) {
        window.renderScreenerCategory(activeTab, screenerData);
        updateBadges(null, screenerData);
        updateLastUpdatedBadge(screenerData);
      }
      return;
    }
    const timeframe = stateManager.get('timeframe');
    const data = await dataManager.fetchState(timeframe, activeTab, true);
    if (!data) return;
    window.renderRegimeBanner?.(data.marketRegime);
    if (activeTab === 'INTRADAY') {
      window.renderIntraday(data);
    } else {
      renderStocks(data);
    }
    updateBadges(data);
    updateLastUpdatedBadge(data);
  }, 30000);

  // Fetch indices (every 5s)
  intervalManager.add('fetchIndices', async () => {
    await fetchIndices();
  }, 5000);
}

// ── Market Status ────────────────────────────────────────────
function updateMarketStatus() {
  // Prefer the server's own isMarketOpen() (same function every freshness
  // classification in the backend already uses) over recomputing
  // independently from the browser's clock — a wrong client clock could
  // otherwise silently disagree with what the backend actually treats as
  // open/closed. Only falls back to a local estimate in the brief window
  // before the first status poll completes.
  let isOpen, dataAsOf, lastUpdated;
  if (serverMarketStatus) {
    ({ marketOpen: isOpen, dataAsOf, lastUpdated } = serverMarketStatus);
  } else {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay();
    isOpen = d > 0 && d < 6 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
  }

  stateManager.set('marketOpen', isOpen);

  const brand = document.getElementById('brandEl');
  const capsule = document.getElementById('marketCapsule');
  const txt = document.getElementById('marketText');

  if (brand) {
    brand.className = isOpen ? 'brand market-open' : 'brand market-closed';
  }
  if (capsule) capsule.className = isOpen ? 'market-capsule open' : 'market-capsule';
  if (txt) {
    if (isOpen) {
      txt.textContent = 'Open';
      capsule?.removeAttribute('title');
    } else {
      // dataAsOf (oldest price actually behind the current data) is a more
      // honest "last real trading timestamp" than lastUpdated (which is
      // just "last time a scan cycle finished," and could tick forward
      // even after close on nothing but re-computed/cached candles).
      const lastTs = dataAsOf ?? lastUpdated ?? null;
      if (lastTs) {
        const lastTimeStr = new Date(lastTs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        txt.textContent = `Closed · last data ${lastTimeStr}`;
        if (capsule) capsule.title = `Market closed. Last trading data as of ${new Date(lastTs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`;
      } else {
        txt.textContent = 'Closed';
        capsule?.removeAttribute('title');
      }
    }
  }

  // Refresh button always enabled
}

// NSE blocks dividend lookups from server/datacenter IPs — this is a
// standing, not transient, restriction. If the Dividend toggle is left on
// while the backend reports it unavailable, it silently hides every row on
// every tab (the filter keeps only rows with dividend data, and none ever
// have any) with no visible explanation. Disable the control and force it
// off rather than let it sit as a trap; re-enable automatically if the
// backend ever reports it working again (e.g. after moving to a non-blocked IP).
let lastDividendAvailable = true;
function syncDividendToggleAvailability(available) {
  if (available === lastDividendAvailable) return;
  lastDividendAvailable = available;

  const divToggle = document.getElementById('divTgl');
  if (!divToggle) return;

  // The checkbox itself is visually hidden (the label + custom switch is
  // what's actually shown/hovered), so the tooltip belongs on the label —
  // setting it on the input alone would be invisible to the user.
  const label = divToggle.closest('.div-tg') || divToggle;
  if (!label.dataset.defaultTitle) label.dataset.defaultTitle = label.title || '';

  divToggle.disabled = !available;
  label.title = available
    ? label.dataset.defaultTitle
    : 'Dividend data is currently unavailable (NSE is blocking lookups from this server)';

  if (!available && divToggle.checked) {
    divToggle.checked = false;
    stateManager.set('showDividend', false);
    stateManager.persist();
    renderCurrentView?.();
  }
}

// ── Poll Status ──────────────────────────────────────────────
let lastScanState = false;
let lastUpdatedTs = null;
let scanDataInterval = null;
// Server-truth market status, refreshed every 2s poll below. null only
// before the very first successful poll — updateMarketStatus() falls back
// to a client-clock estimate for that brief window, and otherwise always
// prefers this over recomputing independently in the browser.
let serverMarketStatus = null;

async function pollStatus() {
  try {
    const status = await dataManager.fetchStatus();
    serverMarketStatus = { marketOpen: status.marketOpen, dataAsOf: status.dataAsOf, lastUpdated: status.lastUpdated };
    updateMarketStatus();
    syncDividendToggleAvailability(status.dividendAvailable !== false);
    window.updateScanProgressBadge?.(status);

    // If scanning, poll /api/state every 3s to show progress. This MUST force
    // a real fetch — DataManager's 30s cache TTL would otherwise silently
    // serve the same stale snapshot for up to 10 consecutive polls, so rows
    // discovered mid-scan wouldn't appear until the unrelated 30s fullReload
    // interval happened to fire.
    if (status.scanning && !scanDataInterval) {
      scanDataInterval = setInterval(async () => {
        const activeTab = stateManager.get('activeTab');
        // These tabs each have their own independent data source/refresh
        // path (CriticalManager's 8s poll, the screener tabs' own ~15min
        // cycle) — fetching /api/state and falling through to renderStocks()
        // for them would overwrite their correct view with the generic
        // stocks table every 3s while a scan is running (this was a real,
        // visible bug: a Critical trade card flickering into "No results
        // for current filter" every few seconds during market hours).
        if (activeTab === 'CRITICAL') {
          window.criticalManager?.fetchAndRender();
          return;
        }
        if (SCREENER_TABS.includes(activeTab)) return;

        const st = await dataManager.fetchState(stateManager.get('timeframe'), activeTab, true);
        if (st?.lastUpdated && st.lastUpdated !== lastUpdatedTs) {
          lastUpdatedTs = st.lastUpdated;
          if (activeTab === 'INTRADAY') {
            window.renderIntraday(st);
          } else {
            renderStocks(st);
          }
          updateBadges(st);
          updateLastUpdatedBadge(st);
        }
      }, 3000);
    }

    // When scan ends, do a final load
    if (lastScanState === true && status.scanning === false) {
      if (scanDataInterval) {
        clearInterval(scanDataInterval);
        scanDataInterval = null;
      }
      lastUpdatedTs = null;
      const timeframe = stateManager.get('timeframe');
      const activeTab = stateManager.get('activeTab');
      if (activeTab === 'CRITICAL') {
        window.criticalManager?.fetchAndRender();
      } else if (SCREENER_TABS.includes(activeTab)) {
        const screenerData = await dataManager.fetchScreener();
        if (screenerData) {
          window.renderScreenerCategory(activeTab, screenerData);
          updateBadges(null, screenerData);
        }
      } else if (activeTab === 'INTRADAY') {
        const data = await dataManager.fetchState(timeframe, activeTab, true);
        if (data) {
          window.renderIntraday(data);
          updateBadges(data);
        }
      } else {
        const data = await dataManager.fetchState(timeframe, activeTab, true);
        if (data) {
          renderStocks(data);
          updateBadges(data);
        }
      }
    }

    lastScanState = status.scanning;

    // If no data yet and scan isn't running, keep trying
    const activeTab = stateManager.get('activeTab');
    const timeframe = stateManager.get('timeframe');
    const dataKey = dataManager.cacheKey(timeframe, activeTab);
    const hasData = dataManager.cache.get(dataKey)?.data;

    if (!hasData && !status.scanning && !scanDataInterval) {
      await loadInitialData();
    }
  } catch (e) {
    console.error('[Poll] Error:', e);
  }
}

// ── Fetch Indices ────────────────────────────────────────────
let prevIndexLtp = {};

async function fetchIndices() {
  try {
    const rows = await dataManager.fetchIndices();
    const ctr = document.getElementById('indexCardsContainer');
    if (!ctr || !rows?.length) return;

    let html = '';
    rows.forEach(idx => {
      const ltp = idx.ltp;
      if (!ltp) {
        html += `<div class='sc' style='opacity:0.4'>
          <div class='scl'>${idx.symbol}</div>
          <div class='scv sm'>--</div></div>`;
        return;
      }

      let chgPct = null;
      const timeframe = stateManager.get('timeframe');
      const dataKey = dataManager.cacheKey(timeframe, 'ALL');
      const cached = dataManager.cache.get(dataKey);

      if (cached?.data?.data?.['1d_ALL']) {
        const rowInfo = cached.data.data['1d_ALL'].find(r => r.symbol === idx.symbol);
        if (rowInfo && typeof rowInfo.chgPct === 'number') {
          chgPct = rowInfo.chgPct;
        }
      }

      if (chgPct === null) {
        const prev = prevIndexLtp[idx.symbol];
        chgPct = prev ? ((ltp - prev) / prev * 100) : null;
        prevIndexLtp[idx.symbol] = prevIndexLtp[idx.symbol] || ltp;
      }

      const isUp = idx.chgPct === null ? null : idx.chgPct >= 0;
      const cl = isUp === null ? 'a' : (isUp ? 'g' : 'r');
      const sgn = isUp ? '+' : '';
      const arr = isUp ? '^' : 'v';
      const rgba = isUp ? '34,197,94' : '239,68,68';

      const showChange = idx.chgPct !== null && idx.priceChange !== null;
      const pctHtml = showChange
        ? `<div class='idx-change'>
            <span style='font-size:11px;font-weight:700;color:rgb(${rgba})'>${arr} ${idx.priceChange >= 0 ? '+' : ''}${idx.priceChange.toFixed(2)}</span>
            <span style='font-size:9px;background:rgba(${rgba},0.15);padding:1px 5px;border-radius:4px;color:rgb(${rgba})'>${sgn}${idx.chgPct.toFixed(2)}%</span>
          </div>`
        : '';

      html += `<div class='sc'>
        <div class='scl'>${idx.symbol}</div>
        <div class='scv ${cl} idx-value' style='font-size:14px;'>
          <span class='idx-price'>Rs ${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          ${pctHtml}
        </div></div>`;
    });

    ctr.innerHTML = html;
  } catch (e) {
    console.error('[Indices] Fetch error:', e);
  }
}

// ── Mobile row-detail bottom sheet ──────────────────────────────
// Previously auto-opened on row tap for the .tw-scan (Stocks/Intraday/
// Top 50) tables, back when those used a sticky-column horizontal-scroll
// table on mobile that hid most fields off-screen. All tabs now render
// as full labeled cards on mobile (every field already visible inline),
// so the auto-open trigger was removed — it would just pop up a
// redundant sheet duplicating what's already on screen. openRowSheet/
// closeRowSheet are left in place, unused, in case a future "view full
// detail" affordance wants them.
const MOBILE_SCAN_MQ = '(max-width: 768px)';

function openRowSheet(trEl) {
  if (!trEl || !window.matchMedia(MOBILE_SCAN_MQ).matches) return;
  const cells = [...trEl.querySelectorAll('td')];
  if (!cells.length) return;

  const headerCells = [...document.querySelectorAll('#tableHeader th')];
  const titleText = cells[0].querySelector('.sym')?.textContent?.trim()
    || cells[0].textContent.trim().split('\n')[0].trim();

  const titleEl = document.getElementById('rowSheetTitle');
  if (titleEl) titleEl.textContent = titleText || '—';

  const rows = cells.slice(1).map((td, i) => {
    const label = td.getAttribute('data-label') || headerCells[i + 1]?.textContent?.trim() || '';
    if (!label || !td.innerHTML.trim()) return '';
    return `<div class="rs-row"><div class="rs-label">${label}</div><div class="rs-value">${td.innerHTML}</div></div>`;
  }).join('');

  const bodyEl = document.getElementById('rowSheetBody');
  if (bodyEl) bodyEl.innerHTML = rows || '<div class="rs-row"><div class="rs-value">No further detail on this row.</div></div>';

  document.getElementById('rowSheet')?.classList.add('open');
  document.getElementById('rowSheetBackdrop')?.classList.add('open');
}

function closeRowSheet() {
  document.getElementById('rowSheet')?.classList.remove('open');
  document.getElementById('rowSheetBackdrop')?.classList.remove('open');
}
window.openRowSheet = openRowSheet;
window.closeRowSheet = closeRowSheet;

function setupRowSheetAndScanHint() {
  // Intentionally empty — see the comment above MOBILE_SCAN_MQ. Kept as a
  // named call site rather than removed outright so re-enabling a manual
  // "view detail" trigger later is a one-line change, not an archaeology dig.
}

// ── Keyboard Shortcuts ───────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    const key = e.key.toLowerCase();

    switch(key) {
      case 'r':
        e.preventDefault();
        const timeframe = stateManager.get('timeframe');
        const activeTab = stateManager.get('activeTab');
        dataManager.fetchState(timeframe, activeTab, true).then(data => {
          if (data) {
            renderStocks(data);
            updateBadges(data);
            updateLastUpdatedBadge(data);
          }
        });
        break;
      case '/':
        e.preventDefault();
        document.getElementById('search')?.focus();
        break;
      case 'escape':
        if (document.getElementById('chartModal').style.display === 'flex') {
          closeModalChart();
        } else if (foManager?.expandedSymbol) {
          const btn = document.querySelector(`#row-${foManager.expandedSymbol} .exp-btn`);
          if (btn) foManager.toggleRow(foManager.expandedSymbol, btn, null);
        }
        break;
      case '1':
        e.preventDefault();
        document.querySelector('[data-set="STOCKS"]')?.click();
        break;
      case '2':
        e.preventDefault();
        document.querySelector('[data-set="INTRADAY"]')?.click();
        break;
      case '3':
        e.preventDefault();
        document.querySelector('[data-set="CRITICAL"]')?.click();
        break;
      case '4':
        e.preventDefault();
        document.querySelector('[data-set="GAINERS"]')?.click();
        break;
      case '5':
        e.preventDefault();
        document.querySelector('[data-set="LOSERS"]')?.click();
        break;
      case '6':
        e.preventDefault();
        document.querySelector('[data-set="VOLSHOCK"]')?.click();
        break;
      case '7':
        e.preventDefault();
        document.querySelector('[data-set="RANGE52W"]')?.click();
        break;
      case '8':
        e.preventDefault();
        document.querySelector('[data-set="BULLCROSS"]')?.click();
        break;
      case '9':
        e.preventDefault();
        document.querySelector('[data-set="MOMENTUM"]')?.click();
        break;
      case '0':
        e.preventDefault();
        document.querySelector('[data-set="RSI"]')?.click();
        break;
    }
  });
}

// ── Manual Load Function (for refresh button) ─────────────────
// Delegates to TabManager.loadTabData, which already knows the correct
// fetch/render path per tab (and force-fetches) — this used to duplicate
// that dispatch here, out of sync with the actual tab set (it called
// renderStocks for Intraday, since it had never been taught that tab).
async function manualLoad() {
  await tabManager.loadTabData(stateManager.get('activeTab'));
}

// ── Start the app ────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Export for inline handlers
window.manualLoad = manualLoad;
window.load = manualLoad;
window.toggleTfDropdown = () => document.getElementById('tfDropdown')?.classList.toggle('open');
window.selectTf = (value, el) => timeframeManager?.selectTimeframe(value, el);
window.toggleIndices = () => {
  const el = document.getElementById('idxTgl');
  if (el) {
    // Don't manually flip - onchange already did it
    stateManager.set('showIndices', el.checked);
    renderCurrentView();
  }
};
window.toggleDividendHighlight = () => {
  const el = document.getElementById('divTgl');
  if (el) {
    // Don't manually flip - onchange already did it
    stateManager.set('showDividend', el.checked);
    renderCurrentView();
  }
};
