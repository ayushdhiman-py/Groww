// ============================================================
// PHASE 3: REAL-TIME UPDATES & USER INTERACTIONS
// ============================================================

import { StateManager, DataManager, RenderEngine, TabManager, TimeframeManager } from './ui-core.mjs';

// Re-export TabManager and TimeframeManager from ui-core.mjs
export { TabManager, TimeframeManager };

// ── 6. LIVE PRICE UPDATER ────────────────────────────────────
export class LivePriceUpdater {
  constructor(stateManager, dataManager, renderEngine) {
    this.state = stateManager;
    this.data = dataManager;
    this.render = renderEngine;
    this.intervalId = null;
    this.isUpdating = false;
  }

  start() {
    // Only start if not already running
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      // Skip if tab is hidden, market closed, or on Portfolio/Sectors
      if (document.hidden) return;
      if (!this.state.get('marketOpen')) return;

      const activeTab = this.state.get('activeTab');
      if (activeTab === 'PORTFOLIO' || activeTab === 'SECTORS') return;

      await this.update();
    }, 3000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async update() {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      const ltpData = await this.data.fetchLTP();
      if (!ltpData) return;

      const activeTab = this.state.get('activeTab');
      const timeframe = this.state.get('timeframe');
      const dataKey = this.data.cacheKey(timeframe, activeTab);
      const cached = this.data.cache.get(dataKey);

      if (!cached?.data?.data) return;

      let anyChanged = false;
      const allKeys = [`${timeframe}_ALL`, `${timeframe}_BUY`, `${timeframe}_SELL`, `${timeframe}_GOLDEN`];

      for (const key of allKeys) {
        const rows = cached.data.data[key];
        if (!rows) continue;

        for (const row of rows) {
          const newPrice = ltpData[row.symbol];
          if (newPrice && row.open) {
            const oldPrice = row.price;
            row.price = +newPrice.toFixed(2);
            row.chgPct = +(((newPrice - row.prevClose) / row.prevClose) * 100).toFixed(2);
            if (row.vwap !== null) row.aboveVwap = newPrice > row.vwap;

            // Patch the freshness metadata in the SAME pass — otherwise this
            // update would reproduce the exact bug it's meant to fix: a
            // freshly-patched price paired with stale priceSource/priceTs
            // left over from the last full /api/state fetch, making the row
            // look as fresh as the price alone when the rest of it isn't.
            const meta = ltpData.meta?.[row.symbol];
            if (meta) {
              row.priceSource = meta.source;
              row.priceTs = meta.ts;
            }

            if (oldPrice !== row.price) {
              anyChanged = true;
            }
          }
        }
      }

      if (anyChanged) {
        // Update badges and stats
        window.updateBadges?.(cached.data);
        window.updateLastUpdatedBadge?.(cached.data);

        // Re-render if not currently rendering
        if (!this.render.isRendering) {
          this.render.scheduleRender(() => window.renderStocks(cached.data), 0);
        }
      }
    } catch (e) {
      console.error('[LivePrice] Update error:', e);
    } finally {
      this.isUpdating = false;
    }
  }
}

// ── 7. PORTFOLIO MANAGER ─────────────────────────────────────
export class PortfolioManager {
  constructor(stateManager, dataManager, renderEngine) {
    this.state = stateManager;
    this.data = dataManager;
    this.render = renderEngine;
    this.refreshInterval = null;
    this.isLoading = false;
  }

  async loadAndRender(force = false) {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      const data = await this.data.fetchPortfolio(force);
      if (data) {
        this.renderPortfolio(data);
        this.startRefresh();

        // Update badge
        const itemCount = (data.holdings?.length || 0) + (data.positions?.length || 0);
        const badge = document.getElementById('badge-PORTFOLIO');
        if (badge) badge.textContent = itemCount;
      } else {
        const empty = document.getElementById('empty');
        if (empty) {
          empty.classList.remove('loading');
          empty.style.display = 'block';
          empty.textContent = 'Failed to load portfolio';
        }
      }
    } catch (e) {
      console.error('[Portfolio] Load error:', e);
    } finally {
      this.isLoading = false;
    }
  }

  renderPortfolio(data) {
    // Implementation will be in render functions file
    if (typeof window.renderPortfolio === 'function') {
      window.renderPortfolio(data);
    }
  }

  startRefresh() {
    if (this.refreshInterval) return;

    this.refreshInterval = setInterval(async () => {
      // Only refresh if Portfolio tab is active
      if (this.state.get('activeTab') !== 'PORTFOLIO') return;

      try {
        const ltpData = await this.data.fetchLTP();
        if (!ltpData || !this.data.portfolioCache?.data?.holdings) return;

        const holdings = this.data.portfolioCache.data.holdings;
        let changed = false;

        holdings.forEach(h => {
          const freshPrice = ltpData[h.trading_symbol] || ltpData[`NSE_${h.trading_symbol}`];
          if (freshPrice && freshPrice !== h.current_price) {
            h.current_price = +freshPrice.toFixed(2);
            h.current_value = +(freshPrice * h.quantity).toFixed(2);
            h.pnl = +(h.current_value - h.average_price * h.quantity).toFixed(2);
            h.pnl_percent = h.average_price > 0 ? +((h.pnl / (h.average_price * h.quantity)) * 100).toFixed(2) : 0;
            changed = true;
          }
        });

        if (changed) {
          this.renderPortfolio(this.data.portfolioCache.data);
        }
      } catch (e) {
        console.error('[Portfolio] Refresh error:', e);
      }
    }, 5000);
  }

  stopRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

// ── 7b. CRITICAL TRADES MANAGER ──────────────────────────────
export class CriticalManager {
  constructor() {
    this.refreshInterval = null;
    this.markContext = null;
    this.lastPayload = null;
  }

  async fetchAndRender() {
    try {
      const res = await fetch('/api/critical');
      if (!res.ok) return;
      const payload = await res.json();
      this.lastPayload = payload;

      const badge = document.getElementById('badge-CRITICAL');
      if (badge) badge.textContent = payload.trades?.length ?? 0;

      window.renderCritNotifBanner?.(payload.trades);
      if (window.stateManager?.get('activeTab') === 'CRITICAL') {
        window.renderCritical?.(payload);
      }
    } catch (e) {
      console.error('[Critical] fetch error:', e);
    }
  }

  startPolling() {
    if (this.refreshInterval) return;
    this.fetchAndRender();
    // Notifications should stay live regardless of which tab is open — poll
    // faster than the main 30s scanner reload since Trade Health depends on
    // the same scan cycle anyway, but the banner should feel responsive.
    this.refreshInterval = setInterval(() => this.fetchAndRender(), 8000);
  }

  openMarkModal(symbol, price) {
    this.markContext = { symbol };
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    document.getElementById('mcSymbol').textContent = symbol;
    set('mcEntryPrice', price ? (+price).toFixed(2) : '');
    set('mcQuantity', '');
    set('mcStopLoss', '');
    set('mcTarget', '');
    document.getElementById('mcModalOverlay')?.classList.add('open');
  }

  closeMarkModal(event) {
    if (event && event.target.id !== 'mcModalOverlay') return;
    document.getElementById('mcModalOverlay')?.classList.remove('open');
  }

  async submitMarkCritical() {
    const symbol = this.markContext?.symbol;
    const entryPrice = parseFloat(document.getElementById('mcEntryPrice').value);
    const quantity = parseInt(document.getElementById('mcQuantity').value, 10);
    const stopLossRaw = document.getElementById('mcStopLoss').value;
    const targetRaw = document.getElementById('mcTarget').value;

    if (!symbol || !Number.isFinite(entryPrice) || !Number.isFinite(quantity)) {
      alert('Symbol, entry price and quantity are required.');
      return;
    }

    try {
      const res = await fetch('/api/critical', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, entryPrice, quantity,
          stopLoss: stopLossRaw === '' ? null : parseFloat(stopLossRaw),
          target: targetRaw === '' ? null : parseFloat(targetRaw),
        }),
      });
      const json = await res.json();
      if (!json.ok) { alert('Failed to mark critical: ' + json.error); return; }
      document.getElementById('mcModalOverlay')?.classList.remove('open');
      this.fetchAndRender();
    } catch (e) {
      alert('Failed to mark critical: ' + e.message);
    }
  }

  async closeTrade(id) {
    if (!confirm('Close this Critical trade? This only stops monitoring it here — it does not place any order.')) return;
    try {
      await fetch(`/api/critical/${id}/close`, { method: 'POST' });
      this.fetchAndRender();
    } catch (e) {
      console.error('[Critical] close error:', e);
    }
  }

  async promptEditLevels(id, currentStop, currentTarget) {
    const sl = prompt('Stop Loss (blank = none):', currentStop ?? '');
    if (sl === null) return; // cancelled
    const tgt = prompt('Target (blank = none):', currentTarget ?? '');
    if (tgt === null) return;
    try {
      await fetch(`/api/critical/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stopLoss: sl === '' ? null : parseFloat(sl),
          target: tgt === '' ? null : parseFloat(tgt),
        }),
      });
      this.fetchAndRender();
    } catch (e) {
      console.error('[Critical] update error:', e);
    }
  }
}

// ── 7c. MODEL / LEARNING MANAGER ──────────────────────────────
// Propose/validate/promote/rollback are deliberate, infrequent, manual
// actions (Phase 5's weight adaptation is gated behind an explicit human
// decision, never automatic) — a couple of prompt() dialogs for the date
// range is consistent with CriticalManager's promptEditLevels() above and
// avoids building a full date-picker UI for something used rarely.
export class ModelManager {
  async refresh() {
    const data = await window.dataManager?.fetchLearningOverview();
    window.renderModel(data);
  }

  async proposeNewWeights() {
    const from = prompt('Training period start (YYYY-MM-DD):');
    if (!from) return;
    const to = prompt('Training period end (YYYY-MM-DD):', from);
    if (!to) return;
    try {
      const res = await fetch('/api/learning/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const json = await res.json();
      if (!json.ok) { alert('Propose failed: ' + (json.reason || json.error)); return; }
      alert(`Proposed model version ${json.versionId} from ${json.sampleCount} samples (train accuracy ${(json.trainAccuracy * 100).toFixed(1)}%). Validate it next.`);
      this.refresh();
    } catch (e) {
      alert('Propose failed: ' + e.message);
    }
  }

  async validateVersion(versionId) {
    const from = prompt('Validation period start (YYYY-MM-DD):');
    if (!from) return;
    const to = prompt('Validation period end (YYYY-MM-DD):', from);
    if (!to) return;
    try {
      const res = await fetch(`/api/learning/validate/${versionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const json = await res.json();
      if (!json.ok) { alert('Validate failed: ' + (json.reason || json.error)); return; }
      alert(`Validated version ${versionId} on ${json.metrics.sampleCount} samples.\nProposed correlation: ${json.metrics.proposedCorrelation}\nProduction correlation: ${json.metrics.productionCorrelation}`);
      this.refresh();
    } catch (e) {
      alert('Validate failed: ' + e.message);
    }
  }

  async promoteVersion(versionId) {
    if (!confirm(`Promote model version ${versionId} to PRODUCTION? This changes live Opportunity Score weighting immediately.`)) return;
    try {
      const res = await fetch(`/api/learning/promote/${versionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!json.ok) { alert('Promote failed: ' + json.error); return; }
      this.refresh();
    } catch (e) {
      alert('Promote failed: ' + e.message);
    }
  }

  async rollbackToVersion(versionId) {
    if (!confirm(`Roll back to model version ${versionId}? This demotes the current PRODUCTION version and reinstates this one.`)) return;
    try {
      const res = await fetch(`/api/learning/rollback/${versionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!json.ok) { alert('Rollback failed: ' + json.error); return; }
      this.refresh();
    } catch (e) {
      alert('Rollback failed: ' + e.message);
    }
  }
}

// ── 8. SORT MANAGER ──────────────────────────────────────────
export class SortManager {
  constructor(stateManager) {
    this.state = stateManager;
    this.sortDebounceTimer = null;
    this.SORT_DEBOUNCE_MS = 50; // Reduced from 100ms for instant feel
  }

  init() {
    // Sort handlers are attached to table headers via onclick
    // This manager provides the sorting logic
  }

  handleSort(column, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    // Debounce rapid sort clicks
    if (this.sortDebounceTimer) {
      clearTimeout(this.sortDebounceTimer);
    }

    this.sortDebounceTimer = setTimeout(() => {
      this.executeSort(column, event?.shiftKey);
    }, this.SORT_DEBOUNCE_MS);
  }

  executeSort(column, shift) {
    let sortStack = [...this.state.get('sortStack')];

    if (!shift) {
      // Single column sort
      if (sortStack.length === 1 && sortStack[0].col === column) {
        sortStack[0].asc = !sortStack[0].asc;
      } else {
        sortStack = [{ col: column, asc: false }];
      }
    } else {
      // Multi-column sort
      const existing = sortStack.find(s => s.col === column);
      if (existing) {
        existing.asc = !existing.asc;
      } else {
        sortStack.push({ col: column, asc: false });
      }
    }

    this.state.set('sortStack', sortStack);

    // Persist sort state for current tab
    const activeTab = this.state.get('activeTab');
    const tabSorts = this.state.get('tabSorts');
    tabSorts[activeTab] = [...sortStack];
    this.state.set('tabSorts', tabSorts);
    this.state.persist();

    // Re-render from CACHED data (don't fetch!)
    this.reRenderCurrentTab();
  }

  // Re-render current tab from cached data without fetching
  reRenderCurrentTab() {
    const activeTab = this.state.get('activeTab');
    const timeframe = this.state.get('timeframe');

    try {
      if (activeTab === 'PORTFOLIO') {
        window.portfolioManager?.loadAndRender();
      } else if (activeTab === 'SECTORS') {
        // Sectors always use 1d_ALL data (daily timeframe)
        const dataKey = window.dataManager.cacheKey('1d', 'ALL');
        const cached = window.dataManager.cache.get(dataKey);
        if (cached?.data) {
          window.renderSectors(cached.data);
        } else {
          // Fallback: try any available daily data
          const allCached = window.dataManager.cache.get(window.dataManager.cacheKey(timeframe === 'ALL' ? '1d' : timeframe, 'ALL'));
          if (allCached?.data) {
            window.renderSectors(allCached.data);
          } else {
            console.error('[Sort] ❌ No cached data available for sectors');
          }
        }
      } else {
        // Regular tabs: ALL, GOLDEN, BUY, SELL, FO
        const dataKey = window.dataManager.cacheKey(timeframe, activeTab);

        const cached = window.dataManager.cache.get(dataKey);
        if (cached?.data) {
          window.renderStocks(cached.data);
        } else {
          window.tabManager?.loadScannerData();
        }
      }
    } catch (e) {
      console.error('[Sort] Re-render error:', e);
    }
  }

  // Sort comparison function
  compare(a, b, sortStack) {
    for (const sort of sortStack) {
      let va = a[sort.col];
      let vb = b[sort.col];

      // Handle different data types
      if (sort.col === 'symbol' || sort.col === 'sector' || sort.col === 'name') {
        const res = (va || '').localeCompare(vb || '');
        if (res !== 0) return sort.asc ? res : -res;
      } else if (sort.col === 'rating') {
        const ratingOrder = { 'STRONG BUY': 5, 'MODERATE': 3, 'SKIP': 1, 'WEAK BUY': 2, 'NEUTRAL': 0 };
        const ra = ratingOrder[va] || 0;
        const rb = ratingOrder[vb] || 0;
        if (ra !== rb) return sort.asc ? ra - rb : rb - ra;
      } else {
        // Numeric sort
        va = (va !== null && va !== undefined) ? +va : 0;
        vb = (vb !== null && vb !== undefined) ? +vb : 0;
        if (va !== vb) return sort.asc ? va - vb : vb - va;
      }
    }
    return 0;
  }
}

// ── 9. SEARCH & FILTER MANAGER ───────────────────────────────
export class SearchFilter {
  constructor(stateManager) {
    this.state = stateManager;
    this.debounceTimer = null;
  }

  init() {
    // Search input
    const searchInput = document.getElementById('search');
    if (searchInput) {
      // Debounced search
      searchInput.addEventListener('input', (e) => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.state.set('searchQuery', e.target.value);
          this.state.persist(); // Persist search query
          window.renderCurrentView?.();
        }, 200);
      });

      // Instant filter on change
      searchInput.addEventListener('change', () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.state.set('searchQuery', searchInput.value);
        this.state.persist(); // Persist search query
        window.renderCurrentView?.();
      });
    }

    // Index toggle
    const idxToggle = document.getElementById('idxTgl');
    if (idxToggle) {
      idxToggle.addEventListener('change', (e) => {
        this.state.set('showIndices', e.target.checked);
        this.state.persist(); // Persist indices toggle
        window.renderCurrentView?.();
      });
    }

    // Dividend toggle
    const divToggle = document.getElementById('divTgl');
    if (divToggle) {
      divToggle.addEventListener('change', (e) => {
        this.state.set('showDividend', e.target.checked);
        this.state.persist(); // Persist dividend toggle
        window.renderCurrentView?.();
      });
    }
  }

  // Filter rows based on search query and filters
  filterRows(rows) {
    const query = this.state.get('searchQuery').trim().toUpperCase();
    const showIndices = this.state.get('showIndices');
    const showDividend = this.state.get('showDividend');

    let filtered = rows;

    // Apply search filter
    if (query) {
      // Split by comma for multi-term search, then remove all spaces from each term
      const terms = query.split(',').map(t => t.replace(/\s+/g, '').trim()).filter(Boolean);
      if (terms.length > 0) {
        filtered = filtered.filter(r => {
          // Remove spaces from symbol for flexible matching (e.g., "tata motor" matches "TATAMOTORS")
          const symUpper = (r.symbol?.toUpperCase() || '').replace(/\s+/g, '');
          const secUpper = ((r.sector || '').toUpperCase()).replace(/\s+/g, '');
          const sigUpper = ((r.signal || '').toUpperCase()).replace(/\s+/g, '');
          const ratUpper = ((r.rating || '').toUpperCase()).replace(/\s+/g, '');

          return terms.some(t =>
            symUpper.includes(t) ||
            secUpper.includes(t) ||
            sigUpper.includes(t) ||
            ratUpper.includes(t)
          );
        });
      }
    }

    // Filter indices
    if (!showIndices) {
      filtered = filtered.filter(r => r.sector !== 'INDEX');
    }

    // Filter dividend
    if (showDividend) {
      filtered = filtered.filter(r => r.dividend);
    }

    return filtered;
  }
}

// ── 10. F&O MANAGER ──────────────────────────────────────────
export class FOManager {
  constructor(stateManager, dataManager) {
    this.state = stateManager;
    this.data = dataManager;
    this.expandedSymbol = null;
    this.refreshInterval = null;
    this.countdown = 300;
    this.nextRefreshAt = Date.now() + 300000;
  }

  init() {
    // Start countdown ticker
    setInterval(() => {
      if (this.state.get('activeTab') !== 'FO') return;

      this.countdown = Math.max(0, Math.round((this.nextRefreshAt - Date.now()) / 1000));
      const rcEl = document.getElementById('rowCount');
      if (rcEl && rcEl.textContent.startsWith('F&O:')) {
        const mm = Math.floor(this.countdown / 60);
        const ss = String(this.countdown % 60).padStart(2, '0');
        rcEl.textContent = `F&O: 30 stocks · Next refresh: ${mm}m ${ss}s`;
      }
    }, 1000);

    // F&O refresh interval (5 minutes)
    setInterval(async () => {
      this.nextRefreshAt = Date.now() + 300000;
      this.countdown = 300;

      // Only refresh if F&O tab is active and market is open
      if (this.state.get('activeTab') === 'FO' && this.state.get('marketOpen')) {
        await window.tabManager?.loadScannerData();

        // Reload expanded row if exists
        if (this.expandedSymbol) {
          const wrap = document.getElementById(`wrap-${this.expandedSymbol}`);
          if (wrap) await this.loadOptionChain(this.expandedSymbol, wrap);
        }
      }
    }, 300000);
  }

  async toggleRow(symbol, btn, event) {
    if (event) event.stopPropagation();

    const subRow = document.getElementById(`sub-${symbol}`);
    const wrap = document.getElementById(`wrap-${symbol}`);

    if (!subRow || !wrap) return;

    // If already expanded, collapse it
    if (subRow.classList.contains('active')) {
      subRow.classList.remove('active');
      btn?.classList.remove('active');
      this.expandedSymbol = null;
      return;
    }

    // Collapse all other rows
    document.querySelectorAll('.sub-row.active').forEach(r => r.classList.remove('active'));
    document.querySelectorAll('.exp-btn.active').forEach(b => b.classList.remove('active'));

    // Expand this row
    subRow.classList.add('active');
    btn?.classList.add('active');
    this.expandedSymbol = symbol;

    // Load option chain
    await this.loadOptionChain(symbol, wrap);
  }

  async loadOptionChain(symbol, wrap) {
    try {
      wrap.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">⏳ Loading Option Chain...</div>';

      const chain = await this.data.fetchOptionChain(symbol);
      if (!chain) throw new Error('No data');

      // Render option chain
      if (typeof window.renderOptionChain === 'function') {
        window.renderOptionChain(symbol, chain, wrap);
      }
    } catch (e) {
      wrap.innerHTML = `<div style="padding:20px; text-align:center; color:var(--red)">Failed to load: ${e.message}</div>`;
    }
  }

  collapseAll() {
    document.querySelectorAll('.sub-row.active').forEach(r => r.classList.remove('active'));
    document.querySelectorAll('.exp-btn.active').forEach(b => b.classList.remove('active'));
    this.expandedSymbol = null;
  }

  isExpanded() {
    return this.expandedSymbol !== null;
  }
}

// ── 11. INTERVAL MANAGER ─────────────────────────────────────
export class IntervalManager {
  constructor(stateManager) {
    this.state = stateManager;
    this.intervals = new Map();
  }

  // Register a new interval
  add(name, callback, ms, condition = null) {
    this.remove(name); // Remove existing if any

    const id = setInterval(() => {
      // Check condition before executing
      if (condition && !condition()) return;
      // callback() is usually async — a sync try/catch around it cannot catch
      // errors thrown inside the async function body (they surface as an
      // unhandled rejection instead, invisible here). Route through
      // Promise.resolve().catch() so failures are always logged instead of
      // silently killing that tick's update.
      try {
        Promise.resolve(callback()).catch(e => console.error(`[Interval] Error in ${name}:`, e));
      } catch (e) {
        console.error(`[Interval] Error in ${name}:`, e);
      }
    }, ms);

    this.intervals.set(name, id);
  }

  // Remove an interval
  remove(name) {
    const id = this.intervals.get(name);
    if (id) {
      clearInterval(id);
      this.intervals.delete(name);
    }
  }

  // Remove all intervals
  removeAll() {
    this.intervals.forEach((id, name) => {
      clearInterval(id);
    });
    this.intervals.clear();
  }

  // Pause all intervals
  pause() {
    this.intervals.forEach((id, name) => {
      clearInterval(id);
    });
  }

  // Resume all intervals (restart them)
  resume(callbacks) {
    this.intervals.forEach((id, name) => {
      clearInterval(id);
    });
    this.intervals.clear();
  }
}
