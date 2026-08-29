// ============================================================
// PHASE 1: CORE INFRASTRUCTURE
// ============================================================

// For /api/universe-snapshot specifically — that endpoint only understands
// the 7 real candle timeframes (see scanner_testing.mjs's VALID_CHART_TFS).
// 'ALL' is a different, single-symbol-only feature (see
// DataManager.fetchSymbolAllTimeframes / renderSingleSymbolAllTimeframes in
// ui-renders.mjs) that never goes through this endpoint at all — this just
// keeps the universe-snapshot call sane if 'ALL' (or nothing) is ever passed
// in here by mistake.
export function effectiveChartTf(timeframe) {
  return timeframe && timeframe !== 'ALL' ? timeframe : '5m';
}

// ── 1. STATE MANAGER ─────────────────────────────────────────
export class StateManager {
  constructor() {
    this.state = {
      activeTab: 'STOCKS',
      // No filter-chip UI exists anymore (All Stocks/Intraday are flat
      // tabs, no sub-navigation) — always ALL/DEFAULT, not read from
      // localStorage, so a pre-existing stale value from before the chips
      // were removed can't silently filter these tabs with no way to
      // change it back.
      stockFilter: 'ALL',
      timeframe: localStorage.getItem('scanner_tf') || '15m', // Changed default to 15m
      sortStack: [{ col: 'techScore', asc: false }],
      tabSorts: {}, // Per-tab sort state: { STOCKS::ALL: [...], STOCKS::GOLDEN: [...], INTRADAY: [...], ... }
      searchQuery: '',
      showIndices: localStorage.getItem('scanner_showIndices') !== 'false', // Default true
      showDividend: localStorage.getItem('scanner_showDividend') === 'true', // Default false
      isAuthenticated: false,
      isScanning: false,
      marketOpen: false,
    };
    this.listeners = new Map();
    this.history = [];
  }

  get(key) {
    return key ? this.state[key] : { ...this.state };
  }

  set(key, value) {
    if (this.state[key] === value) return false;
    this.history.push({ key, oldValue: this.state[key], newValue: value, timestamp: Date.now() });
    this.state[key] = value;
    this.emit(key, value);
    this.emit('*', this.state);
    return true;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    this.listeners.get(event)?.forEach(cb => {
      try { cb(data); } catch (e) { console.error(`[State] Error in listener for ${event}:`, e); }
    });
  }

  persist() {
    try {
      localStorage.setItem('scanner_tf', this.state.timeframe);
      localStorage.setItem('scanner_stockFilter', this.state.stockFilter);
      localStorage.setItem('scanner_tabSorts', JSON.stringify(this.state.tabSorts));
      localStorage.setItem('scanner_showIndices', this.state.showIndices);
      localStorage.setItem('scanner_showDividend', this.state.showDividend);
      localStorage.setItem('scanner_searchQuery', this.state.searchQuery);
    } catch (e) { /* Ignore storage errors */ }
  }

  restore() {
    try {
      const savedSorts = localStorage.getItem('scanner_tabSorts');
      if (savedSorts) this.state.tabSorts = JSON.parse(savedSorts);

      // Restore search query
      const savedSearch = localStorage.getItem('scanner_searchQuery');
      if (savedSearch) {
        this.state.searchQuery = savedSearch;
        // Also update the search input
        setTimeout(() => {
          const searchInput = document.getElementById('search');
          if (searchInput) searchInput.value = savedSearch;
        }, 0);
      }
    } catch (e) { /* Ignore storage errors */ }
  }
}

// ── 2. DATA MANAGER ──────────────────────────────────────────
export class DataManager {
  constructor() {
    this.cache = new Map(); // Key: `${timeframe}_${tab}`, Value: { data, timestamp, promise }
    this.portfolioCache = null;
    this.screenerCache = null;
    this.isLoading = new Set(); // Track in-flight requests
    this.CACHE_TTL = 30000; // 30 seconds for scanner data
    this.PORTFOLIO_CACHE_TTL = 300000; // 5 minutes
  }

  // Get cache key
  cacheKey(timeframe, tab) {
    if (tab === 'PORTFOLIO' || tab === 'SECTORS') return tab;
    return `${timeframe}_${tab}`;
  }

  // Fetch scanner state
  async fetchState(timeframe, tab, force = false) {
    const key = this.cacheKey(timeframe, tab);

    // Return cached data if fresh
    if (!force) {
      const cached = this.cache.get(key);
      if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL) && cached.data) {
        return cached.data;
      }
    }

    // Prevent concurrent requests
    if (this.isLoading.has(key)) {
      const pending = this.cache.get(key);
      if (pending?.promise) return pending.promise;
    }

    const fetchPromise = (async () => {
      try {
        const res = await fetch('/api/state');
        if (res.status === 401) {
          window.location.reload();
          return null;
        }
        const data = await res.json();
        this.cache.set(key, { data, timestamp: Date.now(), promise: null });
        return data;
      } catch (e) {
        console.error('[Data] Fetch state error:', e);
        return null;
      } finally {
        this.isLoading.delete(key);
      }
    })();

    this.isLoading.add(key);
    this.cache.set(key, { data: null, timestamp: Date.now(), promise: fetchPromise });
    return fetchPromise;
  }

  // Fetch live prices
  async fetchLTP() {
    try {
      const res = await fetch('/api/ltp');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch LTP error:', e);
      return null;
    }
  }

  // Fetch portfolio data
  async fetchPortfolio(force = false) {
    if (!force && this.portfolioCache && (Date.now() - this.portfolioCache.timestamp < this.PORTFOLIO_CACHE_TTL)) {
      return this.portfolioCache.data;
    }

    try {
      const res = await fetch(`/api/portfolio?fresh=1&t=${Date.now()}`);
      if (!res.ok) return null;
      const data = await res.json();
      this.portfolioCache = { data, timestamp: Date.now() };

      // Also cache to localStorage
      try {
        localStorage.setItem('scanner_portfolio', JSON.stringify({ data, ts: Date.now() }));
      } catch (e) { /* Ignore */ }

      return data;
    } catch (e) {
      console.error('[Data] Fetch portfolio error:', e);
      return null;
    }
  }

  // Load cached portfolio from localStorage
  loadCachedPortfolio() {
    try {
      const cached = localStorage.getItem('scanner_portfolio');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.data && (Date.now() - parsed.ts < this.PORTFOLIO_CACHE_TTL)) {
          this.portfolioCache = { data: parsed.data, timestamp: parsed.ts };
          return parsed.data;
        }
      }
    } catch (e) { /* Ignore */ }
    return null;
  }

  // Fetch option chain
  async fetchOptionChain(symbol) {
    try {
      const res = await fetch(`/api/option-chain/${symbol}`);
      if (!res.ok) throw new Error('Chain unavailable');
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch option chain error:', e);
      throw e;
    }
  }

  // Fetch indices
  async fetchIndices() {
    try {
      const res = await fetch('/api/indices');
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch indices error:', e);
      return [];
    }
  }

  // Cheap full-Nifty-500 snapshot (price/chgPct, no indicators) for the
  // Stocks tab's "All" chip — server refreshes this every ~2s at zero
  // Upstox REST cost, so no client-side TTL/caching needed here either.
  async fetchUniverseSnapshot(tf) {
    try {
      const res = await fetch(`/api/universe-snapshot?tf=${encodeURIComponent(tf || '5m')}`);
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch universe snapshot error:', e);
      return [];
    }
  }

  // "ALL" timeframe, single symbol only (see stage1_filter.mjs's
  // computeSymbolAllTimeframes) — only ever called once search has narrowed
  // to exactly one stock; never a universe-wide fetch.
  async fetchSymbolAllTimeframes(symbol) {
    try {
      const res = await fetch(`/api/symbol-all-timeframes/${encodeURIComponent(symbol)}`);
      if (!res.ok) return { symbol, rows: [] };
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch symbol all-timeframes error:', e);
      return { symbol, rows: [] };
    }
  }

  // Intraday tab's sole data source — src/intraday_movers.mjs, fully
  // independent of Stage-2/entry_score/actionable_score. No client-side
  // caching needed: the server's own loop only recomputes every 20s, so
  // there's nothing to gain from a TTL here.
  async fetchIntradayMovers() {
    try {
      const res = await fetch('/api/intraday-movers');
      if (!res.ok) return { movers: [], updatedAt: null, universeSize: 0 };
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch intraday movers error:', e);
      return { movers: [], updatedAt: null, universeSize: 0 };
    }
  }

  // AI tab's sole data source — src/ai_scanner.mjs's 7-layer pipeline, its
  // own 5-min server-side loop. Layers 4-5 (joint probability/Rank Score/
  // decision) are BLOCKED in every response until a Layer-6-validated model
  // version exists — see that file's header for why.
  async fetchAIScan() {
    try {
      const res = await fetch('/api/ai-scan');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch AI scan error:', e);
      return null;
    }
  }

  // Market-wide screener (Nifty 500) — refreshes server-side on its own slow
  // cadence, so no client-side TTL logic needed; just cache the last fetch
  // for renderCurrentView() to read back (same pattern as portfolioCache).
  async fetchScreener() {
    try {
      const res = await fetch('/api/screener');
      if (!res.ok) return null;
      const data = await res.json();
      this.screenerCache = { data, timestamp: Date.now() };
      return data;
    } catch (e) {
      console.error('[Data] Fetch screener error:', e);
      return null;
    }
  }

  // MODEL/LEARNING dashboard — read-only, refreshes once daily server-side
  // (the nightly job), so no client-side TTL logic needed, same reasoning
  // as fetchScreener().
  async fetchLearningOverview() {
    try {
      const [overviewRes, segmentsRes, driftRes, versionsRes] = await Promise.all([
        fetch('/api/learning/overview'), fetch('/api/learning/segments'),
        fetch('/api/learning/drift'), fetch('/api/learning/versions'),
      ]);
      const [overview, segments, drift, versions] = await Promise.all([
        overviewRes.json(), segmentsRes.json(), driftRes.json(), versionsRes.json(),
      ]);
      return { overview, segments, drift, versions };
    } catch (e) {
      console.error('[Data] Fetch learning overview error:', e);
      return null;
    }
  }

  // Fetch scan status
  async fetchStatus() {
    try {
      const res = await fetch('/api/status');
      return await res.json();
    } catch (e) {
      console.error('[Data] Fetch status error:', e);
      return { scanning: false, authenticated: false };
    }
  }

  // Clear cache for specific key
  invalidate(key) {
    this.cache.delete(key);
  }

  // Clear all cache
  clearCache() {
    this.cache.clear();
  }
}

// ── 3. RENDER ENGINE ─────────────────────────────────────────
export class RenderEngine {
  constructor() {
    this.isRendering = false;
    this.pendingRender = false;
    this.currentTaskId = 0;
    this.CHUNK_SIZE = 200; // Increased from 50 to 200 for faster rendering
    this.renderTimers = new Map();
  }

  // Schedule a render with debouncing
  scheduleRender(renderFn, delay = 0) {
    // Cancel pending render
    this.pendingRender = true;

    // If currently rendering, queue it
    if (this.isRendering) {
      return;
    }

    const timerId = setTimeout(() => {
      if (!this.pendingRender) return;
      this.pendingRender = false;
      this.executeRender(renderFn);
    }, delay);

    this.renderTimers.set(renderFn.name || 'default', timerId);
  }

  // Execute render with task tracking
  async executeRender(renderFn) {
    if (this.isRendering) {
      this.pendingRender = true;
      return;
    }

    const taskId = ++this.currentTaskId;
    this.isRendering = true;
    this.pendingRender = false;

    try {
      await renderFn(taskId);

      // Check if newer task started during render
      if (taskId !== this.currentTaskId) {
        return; // Abort, newer render will take over
      }
    } catch (e) {
      console.error('[Render] Error:', e);
    } finally {
      this.isRendering = false;

      // Execute pending render if queued
      if (this.pendingRender) {
        this.pendingRender = false;
        requestAnimationFrame(() => this.executeRender(renderFn));
      }
    }
  }

  // Chunked row rendering
  renderChunks(rows, renderRowFn, tbody, onComplete) {
    const taskId = this.currentTaskId;
    let index = 0;

    const renderNextChunk = () => {
      // Check if task is still current
      if (taskId !== this.currentTaskId) return;

      const chunk = rows.slice(index, index + this.CHUNK_SIZE);
      if (index === 0) {
        tbody.innerHTML = chunk.map(renderRowFn).join('');
      } else {
        tbody.insertAdjacentHTML('beforeend', chunk.map(renderRowFn).join(''));
      }

      index += this.CHUNK_SIZE;

      if (index < rows.length) {
        requestAnimationFrame(renderNextChunk);
      } else if (onComplete) {
        onComplete();
      }
    };

    requestAnimationFrame(renderNextChunk);
  }

  // Cancel all pending renders
  cancelAll() {
    this.currentTaskId++;
    this.isRendering = false;
    this.pendingRender = false;
    this.renderTimers.forEach(timer => clearTimeout(timer));
    this.renderTimers.clear();
  }
}

// ============================================================
// PHASE 2: TAB & NAVIGATION MANAGERS
// ============================================================

// Tabs backed by the single shared /api/screener fetch (see ui-renders.mjs's
// renderScreenerCategory for the tab -> data-key mapping).
export const SCREENER_TABS = ['GAINERS', 'LOSERS', 'VOLSHOCK', 'RANGE52W', 'BULLCROSS', 'MOMENTUM', 'RSI'];

// ── 4. TAB MANAGER ───────────────────────────────────────────
export class TabManager {
  constructor(stateManager, dataManager, renderEngine) {
    this.state = stateManager;
    this.data = dataManager;
    this.render = renderEngine;
    this.previousTab = 'STOCKS';
    this.scrollPositions = new Map(); // Save scroll position per tab
  }

  // Sort-persistence key: the STOCKS tab has 5 filter chips sharing one
  // cached fetch, each remembering its own sort (matching the old per-tab
  // behavior when ALL/GOLDEN/BUY/SELL/FO were separate tabs).
  sortKey(tab) {
    return tab === 'STOCKS' ? `STOCKS::${this.state.get('stockFilter')}` : tab;
  }

  // Initialize tab click handlers
  init() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.switchToTab(tab.dataset.set);
      }, { passive: false });
    });
  }

  // Switch to a different tab
  async switchToTab(newTab) {
    const oldTab = this.state.get('activeTab');

    if (oldTab === newTab) {
      return;
    }

    this.previousTab = oldTab;

    // Save scroll position
    const tableContainer = document.querySelector('.tw');
    if (tableContainer) {
      this.scrollPositions.set(oldTab, tableContainer.scrollTop);
    }

    // Save sort state for old tab
    const currentSort = this.state.get('sortStack');
    const tabSorts = this.state.get('tabSorts');
    tabSorts[this.sortKey(oldTab)] = [...currentSort];
    this.state.set('tabSorts', tabSorts);

    // Update active tab in state
    this.state.set('activeTab', newTab);

    // Update UI: active tab class
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-set="${newTab}"]`)?.classList.add('active');

    // Clear table and show loading state
    this.showLoadingState();

    // Cleanup old tab
    await this.cleanupTab(oldTab);

    // Load data for new tab
    await this.loadTabData(newTab);
  }

  // Show loading state
  showLoadingState() {
    const tbody = document.getElementById('tbody');
    const empty = document.getElementById('empty');
    if (tbody) tbody.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.classList.add('loading');
      empty.textContent = 'Loading...';
    }
  }

  // Cleanup when leaving a tab
  async cleanupTab(tab) {
    if (tab === 'INTRADAY') {
      window.hideTopPicks?.();
    }

    if (tab === 'STOCKS') {
      // Clear any expanded F&O row
      window.foManager?.collapseAll();
    }
  }

  // Load data for new tab
  async loadTabData(tab) {
    // Restore sort state for new tab. Intraday has no clickable sort
    // columns (its list is always pre-ranked by src/intraday_movers.mjs's
    // composite score) so it's excluded here rather than given a stale
    // sortStack default from the old flagship pipeline.
    if (tab !== 'INTRADAY' && tab !== 'AI') {
      const tabSorts = this.state.get('tabSorts');
      const savedSort = tabSorts[this.sortKey(tab)];
      this.state.set('sortStack', savedSort ? [...savedSort] : [{ col: 'techScore', asc: false }]);
    }

    // Load appropriate data based on tab
    if (tab === 'AI') {
      // AI tab's one data source — see src/ai_scanner.mjs. Fully independent
      // of every other tab's data/loops, its own 5-min server-side cycle.
      window.aiScanCache = await this.data.fetchAIScan();
      window.renderAIScan(window.aiScanCache);
    } else if (tab === 'INTRADAY') {
      // Intraday's one data source — see src/intraday_movers.mjs. Fully
      // independent of /api/state.
      const payload = await this.data.fetchIntradayMovers();
      window.renderIntraday(payload);
    } else if (SCREENER_TABS.includes(tab)) {
      // Top Gainers/Losers/Volume Shockers/52W High-Low/Bullish Crossover/
      // Momentum Burst/RSI Oversold-Overbought — one shared market-wide
      // screener fetch, each tab just renders a different slice of it.
      const data = await this.data.fetchScreener();
      window.renderScreenerCategory(tab, data);
      if (data) {
        window.updateBadges?.(null, data);
        window.updateLastUpdatedBadge?.(data);
      }
    } else if (tab === 'CRITICAL') {
      await window.criticalManager?.fetchAndRender();
    } else if (tab === 'STOCKS' && this.state.get('stockFilter') === 'ALL') {
      // "All Stocks" — its one data source is /api/universe-snapshot.
      window.universeSnapshotCache = await this.data.fetchUniverseSnapshot(effectiveChartTf(this.state.get('timeframe')));
      window.renderStocks(null);
    } else {
      await this.loadScannerData();
    }
  }

  // Load scanner data for regular tabs
  async loadScannerData() {
    const timeframe = this.state.get('timeframe');
    const tab = this.state.get('activeTab');

    const data = await this.data.fetchState(timeframe, tab, true);

    if (data) {
      window.renderStocks(data);

      // Update badges with fresh data
      if (typeof window.updateBadges === 'function') {
        window.updateBadges(data);
      }

      window.updateLastUpdatedBadge?.(data);
    } else {
      console.error(`[TabManager] ❌ Failed to fetch scanner data for tab=${tab}, timeframe=${timeframe}`);
    }
  }

  // Restore scroll position
  restoreScrollPosition(tab) {
    const tableContainer = document.querySelector('.tw');
    const scrollPos = this.scrollPositions.get(tab);
    if (tableContainer && scrollPos !== undefined) {
      tableContainer.scrollTop = scrollPos;
    }
  }
}

// ── 5. TIMEFRAME MANAGER ─────────────────────────────────────
export class TimeframeManager {
  constructor(stateManager, dataManager) {
    this.state = stateManager;
    this.data = dataManager;
    this.debounceTimer = null;
  }

  init() {
    // Initialize dropdown
    this.updateDropdown(this.state.get('timeframe'));
    window.updateAllTfAvailability?.(); // reflect any persisted search query's match state on the ALL option right away

    // Setup click handlers
    document.querySelectorAll('#tfOptions .option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.preventDefault();
        this.selectTimeframe(option.dataset.value, option);
      });
    });

    // Toggle dropdown
    const trigger = document.getElementById('tfSelected')?.parentElement;
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('tfDropdown')?.classList.toggle('open');
      });
    }

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('tfDropdown');
      if (dropdown && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });
  }

  selectTimeframe(value, optionEl) {
    // "ALL" is only ever valid once search has narrowed to exactly one stock
    // (see ui-renders.mjs's getSingleStockMatch/updateAllTfAvailability) —
    // this is the one place both the inline onclick and this manager's own
    // click listener funnel through, so it's the single point that actually
    // needs to enforce that, not just the dropdown's greyed-out styling.
    if (value === 'ALL' && !window.getSingleStockMatch?.()) return;

    // Debounce to prevent rapid switching
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      const changed = this.state.set('timeframe', value);
      if (changed) {
        this.state.persist();
        this.updateDropdown(value);
        document.getElementById('tfDropdown')?.classList.remove('open');

        // Reload data with new timeframe. "All Stocks" has its own data
        // source (loadScannerData() would trigger the unrelated heavy
        // Stage-2 fetch instead of re-fetching the chart at the new tf).
        if (this.state.get('activeTab') === 'STOCKS' && this.state.get('stockFilter') === 'ALL') {
          if (value === 'ALL') {
            // Single-symbol, 7-real-timeframes view — see
            // stage1_filter.mjs's computeSymbolAllTimeframes. Never a
            // universe-wide fetch.
            const symbol = window.getSingleStockMatch?.();
            if (symbol) {
              window.dataManager.fetchSymbolAllTimeframes(symbol).then(payload => {
                window.symbolAllTimeframesCache = payload;
                window.renderStocks(null);
              });
            }
          } else {
            window.dataManager.fetchUniverseSnapshot(effectiveChartTf(value)).then(rows => {
              window.universeSnapshotCache = rows;
              window.renderStocks(null);
            });
          }
        } else if (SCREENER_TABS.includes(this.state.get('activeTab'))) {
          // Top Gainers/Losers/Volume Shockers/Bullish Crossover/Momentum
          // Burst/RSI Oversold-Overbought — src/screener.mjs already
          // precomputes every real timeframe on its own 15-min server-side
          // cycle, so switching the dropdown just needs to re-render from
          // the already-fetched cache (renderScreenerCategory picks the
          // right timeframe's slice itself), never a new fetch. Previously
          // this fell through to the `else` branch below, which called
          // loadScannerData() — that fetches the unrelated Stage-2 pipeline
          // and calls renderStocks(), which immediately no-ops for any tab
          // that isn't STOCKS, so changing timeframe on a screener tab
          // silently did nothing at all.
          window.renderScreenerCategory?.(this.state.get('activeTab'), window.dataManager.screenerCache?.data);
        } else {
          window.tabManager?.loadScannerData();
        }
      }
    }, 150);
  }

  updateDropdown(value) {
    // Update active state
    document.querySelectorAll('#tfOptions .option').forEach(o => {
      o.classList.toggle('active', o.dataset.value === value);
    });

    // Update trigger text
    const label = document.querySelector(`#tfOptions .option[data-value="${value}"]`)?.querySelector('div')?.textContent || value;
    const trigger = document.getElementById('tfSelected');
    if (trigger) trigger.textContent = label;
  }
}
