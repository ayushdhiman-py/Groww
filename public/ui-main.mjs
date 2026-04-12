// ============================================================
// MAIN INTEGRATION FILE - Wires everything together
// ============================================================

import { StateManager, DataManager, RenderEngine } from './ui-core.mjs';
import { TabManager, TimeframeManager, LivePriceUpdater, PortfolioManager, SortManager, SearchFilter, FOManager, IntervalManager } from './ui-managers.mjs';
import './ui-renders.mjs';

// ── Initialize all managers ──────────────────────────────────
let stateManager, dataManager, renderEngine, tabManager, timeframeManager;
let livePriceUpdater, portfolioManager, sortManager, searchFilter, foManager, intervalManager;

async function initApp() {
  console.log('[App] Initializing...');

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

  // Restore state from localStorage
  stateManager.restore();

  // Initialize UI components
  timeframeManager.init();
  
  // Update timeframe dropdown to show restored timeframe
  timeframeManager.updateDropdown(stateManager.get('timeframe'));
  
  tabManager.init();
  sortManager.init();
  searchFilter.init();
  foManager.init();

  // Setup modal close handler
  document.getElementById('chartModal')?.addEventListener('click', (e) => {
    closeModalChart(e);
  });

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();

  // Start background tasks
  startBackgroundTasks();

  // Initial load
  await checkAuth();
  
  console.log('[App] Initialized successfully');
}

// ── Authentication ──────────────────────────────────────────
async function checkAuth() {
  try {
    const status = await dataManager.fetchStatus();
    
    if (!status.authenticated) {
      document.getElementById('LS').style.display = 'flex';
      document.getElementById('APP').style.display = 'none';
      stateManager.set('isAuthenticated', false);
    } else {
      document.getElementById('LS').style.display = 'none';
      document.getElementById('APP').style.display = 'block';
      stateManager.set('isAuthenticated', true);
      
      // Load initial data
      await loadInitialData();
    }
  } catch (e) {
    console.error('[Auth] Error:', e);
  }
}

async function loadInitialData() {
  const timeframe = stateManager.get('timeframe');
  const activeTab = stateManager.get('activeTab');
  
  // Load scanner data
  const data = await dataManager.fetchState(timeframe, activeTab, true);
  if (data) {
    renderStocks(data);
    updateBadges(data);
    updateLastUpdatedBadge(data);
  }

  // Load cached portfolio if available
  const cachedPortfolio = dataManager.loadCachedPortfolio();
  if (cachedPortfolio) {
    const itemCount = (cachedPortfolio.holdings?.length || 0) + (cachedPortfolio.positions?.length || 0);
    const badge = document.getElementById('badge-PORTFOLIO');
    if (badge) badge.textContent = itemCount;
  }

  // Update universe count
  const sU = document.getElementById('sU');
  if (sU) sU.textContent = data?.universe || '—';
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

  // Full state reload (every 30s)
  intervalManager.add('fullReload', async () => {
    const activeTab = stateManager.get('activeTab');
    if (activeTab !== 'PORTFOLIO') {
      const timeframe = stateManager.get('timeframe');
      const data = await dataManager.fetchState(timeframe, activeTab, true);
      if (data) {
        renderStocks(data);
        updateBadges(data);
        updateLastUpdatedBadge(data);
      }
    }
  }, 30000);

  // Fetch indices (every 5s)
  intervalManager.add('fetchIndices', async () => {
    await fetchIndices();
  }, 5000);
}

// ── Market Status ────────────────────────────────────────────
function updateMarketStatus() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay();
  const isOpen = d > 0 && d < 6 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));

  stateManager.set('marketOpen', isOpen);

  const brand = document.getElementById('brandEl');
  const capsule = document.getElementById('marketCapsule');
  const txt = document.getElementById('marketText');

  if (brand) {
    brand.className = isOpen ? 'brand market-open' : 'brand market-closed';
  }
  if (capsule) capsule.className = isOpen ? 'market-capsule open' : 'market-capsule';
  if (txt) txt.textContent = isOpen ? 'Open' : 'Closed';

  // Disable refresh button when market closed
  const rfBtn = document.querySelector('.action-btn[onclick*="load"]');
  if (rfBtn) {
    rfBtn.disabled = !isOpen;
    rfBtn.style.opacity = isOpen ? '' : '0.4';
    rfBtn.style.cursor = isOpen ? '' : 'not-allowed';
  }
}

// ── Poll Status ──────────────────────────────────────────────
let lastScanState = false;
let lastUpdatedTs = null;
let scanDataInterval = null;

async function pollStatus() {
  try {
    const status = await dataManager.fetchStatus();

    // If scanning, poll /api/state every 3s to show progress
    if (status.scanning && !scanDataInterval) {
      scanDataInterval = setInterval(async () => {
        const st = await dataManager.fetchState(stateManager.get('timeframe'), stateManager.get('activeTab'));
        if (st?.lastUpdated && st.lastUpdated !== lastUpdatedTs) {
          lastUpdatedTs = st.lastUpdated;
          renderStocks(st);
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
      const data = await dataManager.fetchState(timeframe, activeTab, true);
      if (data) {
        renderStocks(data);
        updateBadges(data);
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
        ? `<div style='display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;'>
            <span style='font-size:11px;font-weight:700;color:rgb(${rgba})'>${arr} ${idx.priceChange >= 0 ? '+' : ''}${idx.priceChange.toFixed(2)}</span>
            <span style='font-size:9px;background:rgba(${rgba},0.15);padding:1px 5px;border-radius:4px;color:rgb(${rgba})'>${sgn}${idx.chgPct.toFixed(2)}%</span>
          </div>`
        : '';
      
      html += `<div class='sc'>
        <div class='scl'><a href='https://groww.in/search?q=${idx.symbol}' target='_blank' rel='noopener noreferrer' style='color:inherit; text-decoration:none; cursor:pointer;' onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='inherit'">${idx.symbol}</a></div>
        <div class='scv ${cl}' style='font-size:14px;display:flex;align-items:center;justify-content:space-between;'>
          Rs ${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          ${pctHtml}
        </div></div>`;
    });
    
    ctr.innerHTML = html;
  } catch (e) {
    console.error('[Indices] Fetch error:', e);
  }
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
        document.querySelector('[data-set="GOLDEN"]')?.click();
        break;
      case '2':
        e.preventDefault();
        document.querySelector('[data-set="ALL"]')?.click();
        break;
      case '3':
        e.preventDefault();
        document.querySelector('[data-set="FO"]')?.click();
        break;
      case '4':
        e.preventDefault();
        document.querySelector('[data-set="BUY"]')?.click();
        break;
      case '5':
        e.preventDefault();
        document.querySelector('[data-set="SELL"]')?.click();
        break;
      case '7':
        e.preventDefault();
        document.querySelector('[data-set="SECTORS"]')?.click();
        break;
      case '8':
        e.preventDefault();
        document.querySelector('[data-set="PORTFOLIO"]')?.click();
        break;
    }
  });
}

// ── Login Handler ────────────────────────────────────────────
async function doLogin() {
  const btn = document.querySelector('.lbtn');
  if (btn) {
    btn.textContent = 'Initiating Login...';
    btn.disabled = true;
  }
  
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const d = await r.json();
    
    if (d.ok) {
      if (btn) btn.textContent = 'Login Successful! Redirecting...';
      setTimeout(() => window.location.reload(), 1500);
    } else {
      if (d.error && d.error.toLowerCase().includes('timed out')) {
        alert('Login Timed Out: Please make sure to approve the request in your Groww app quickly.');
      } else {
        alert('Login failed: ' + d.error);
      }
    }
  } catch (e) {
    alert('Login error: ' + e.message);
  } finally {
    if (btn) {
      btn.textContent = '🔐 Login with Groww API';
      btn.disabled = false;
    }
  }
}

// ── Manual Load Function (for refresh button) ────────────────
async function manualLoad() {
  if (!stateManager.get('marketOpen')) return;
  
  const timeframe = stateManager.get('timeframe');
  const activeTab = stateManager.get('activeTab');
  const data = await dataManager.fetchState(timeframe, activeTab, true);
  
  if (data) {
    if (activeTab === 'PORTFOLIO') {
      await portfolioManager.loadAndRender(true);
    } else if (activeTab === 'SECTORS') {
      renderSectors(data);
    } else {
      renderStocks(data);
      updateBadges(data);
      updateLastUpdatedBadge(data);
    }
  }
}

// ── Start the app ────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Export for inline handlers
window.doLogin = doLogin;
window.manualLoad = manualLoad;
window.load = manualLoad;
window.toggleTfDropdown = () => document.getElementById('tfDropdown')?.classList.toggle('open');
window.selectTf = (value, el) => timeframeManager?.selectTimeframe(value, el);
window.toggleIndices = () => {
  const el = document.getElementById('idxTgl');
  if (el) {
    // Don't manually flip - onchange already did it
    stateManager.set('showIndices', el.checked);
    console.log(`[Toggle] Indices: ${el.checked ? 'ON' : 'OFF'}`);
    renderCurrentView();
  }
};
window.toggleDividendHighlight = () => {
  const el = document.getElementById('divTgl');
  if (el) {
    // Don't manually flip - onchange already did it
    stateManager.set('showDividend', el.checked);
    console.log(`[Toggle] Dividend: ${el.checked ? 'ON' : 'OFF'}`);
    renderCurrentView();
  }
};
