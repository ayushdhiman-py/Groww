// ============================================================
// PHASE 1: CORE INFRASTRUCTURE
// ============================================================

// ── 1. STATE MANAGER ─────────────────────────────────────────
export class StateManager {
  constructor() {
    this.state = {
      activeTab: 'ALL',
      timeframe: localStorage.getItem('scanner_tf') || '15m', // Changed default to 15m
      sortStack: [{ col: 'techScore', asc: false }],
      tabSorts: {}, // Per-tab sort state: { ALL: [...], GOLDEN: [...], ... }
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

// ── 4. TAB MANAGER ───────────────────────────────────────────
export class TabManager {
  constructor(stateManager, dataManager, renderEngine) {
    this.state = stateManager;
    this.data = dataManager;
    this.render = renderEngine;
    this.previousTab = 'ALL';
    this.scrollPositions = new Map(); // Save scroll position per tab
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
    tabSorts[oldTab] = [...currentSort];
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
    if (tab === 'PORTFOLIO') {
      // Portfolio cleanup handled by PortfolioManager
      window.portfolioManager?.stopRefresh();
      const summaryEl = document.getElementById('portfolioSummary');
      if (summaryEl) summaryEl.style.display = 'none';
    }

    if (tab === 'FO') {
      // Clear expanded F&O row
      window.foManager?.collapseAll();
    }
  }

  // Load data for new tab
  async loadTabData(tab) {
    // Restore sort state for new tab
    const tabSorts = this.state.get('tabSorts');
    const savedSort = tabSorts[tab];
    if (savedSort) {
      this.state.set('sortStack', [...savedSort]);
    } else {
      this.state.set('sortStack', [{ col: 'techScore', asc: false }]);
    }

    // Load appropriate data based on tab
    if (tab === 'PORTFOLIO') {
      await window.portfolioManager?.loadAndRender();
    } else if (tab === 'SECTORS') {
      // Sectors always use daily data (1d_ALL)
      const data = await this.data.fetchState('1d', 'ALL');
      if (data) {
        window.renderSectors(data);
      } else {
        console.error('[TabManager] Failed to fetch sectors data');
      }
    } else if (tab === 'INTRADAY') {
      // Intraday always needs both 5m and 15m regardless of the timeframe
      // dropdown — /api/state returns the full scan state either way.
      const data = await this.data.fetchState('INTRADAY', 'INTRADAY', true);
      if (data) {
        window.renderIntraday(data);
        window.updateBadges?.(data);
      } else {
        console.error('[TabManager] Failed to fetch intraday data');
      }
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

      // Update universe count
      const sU = document.getElementById('sU');
      if (sU) {
        sU.textContent = data?.universe || '—';
      }

      // Update stat cards (Golden, Buy, Sell, Vol Spikes, etc.)
      if (typeof window.updateStatCards === 'function') {
        window.updateStatCards(data);
      }

      // Update badges with fresh data
      if (typeof window.updateBadges === 'function') {
        window.updateBadges(data);
      }
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
    // Debounce to prevent rapid switching
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      const changed = this.state.set('timeframe', value);
      if (changed) {
        this.state.persist();
        this.updateDropdown(value);
        document.getElementById('tfDropdown')?.classList.remove('open');

        // Reload data with new timeframe
        window.tabManager?.loadScannerData();
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
