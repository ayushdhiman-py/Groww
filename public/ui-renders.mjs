// ============================================================
// PHASE 5: RENDER FUNCTIONS
// ============================================================

// ── Utility Functions ────────────────────────────────────────
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
  const all = [...priceHist, ...ema21Hist, ...ema50Hist];
  const min = Math.min(...all), max = Math.max(...all), range = max - min || 1;
  
  const getX = i => (i / (priceHist.length - 1)) * w;
  const getY = v => h - ((v - min) / range) * h;
  
  const mkPath = (arr, cls) => {
    let d = `M ${getX(0)} ${getY(arr[0])}`;
    for (let i = 1; i < arr.length; i++) d += ` L ${getX(i)} ${getY(arr[i])}`;
    return `<path class='${cls}' d='${d}' />`;
  };
  
  return `<svg class='sparkline' viewBox='0 0 ${w} ${h}'>`
    + mkPath(priceHist, 'spark-p')
    + mkPath(ema50Hist, 'spark-50')
    + mkPath(ema21Hist, 'spark-21')
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

// ── MAIN RENDER: STOCKS (ALL, GOLDEN, BUY, SELL, FO) ─────────
function renderStocks(data) {
  const state = window.stateManager.get();
  const activeTab = state.activeTab;
  const timeframe = state.timeframe;
  const sortStack = state.sortStack;
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (!data?.data) {
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'No data available';
    }
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
      <th onclick="window.sortManager.handleSort('dayH', event)">Day Range</th>
      <th onclick="window.sortManager.handleSort('w52H', event)">52W Range</th>
      <th onclick="window.sortManager.handleSort('techScore', event)">Score</th>
      <th onclick="window.sortManager.handleSort('rating', event)">Rating</th>
    </tr>`;
  }

  // Collect rows based on active tab and timeframe
  let rows = [];
  if (activeTab === 'FO') {
    const key = timeframe === 'ALL' ? '5m_ALL' : `${timeframe}_ALL`;
    const rawRows = data.data[key] || [];
    const sorted = rawRows.slice().sort((a, b) => Math.abs(b.volumeChange) - Math.abs(a.volumeChange));
    rows = sorted.slice(0, 30);
  } else if (timeframe === 'ALL') {
    const allTfs = ['1m', '5m', '10m', '15m', '30m', '1h', '1d'];
    allTfs.forEach(t => {
      rows.push(...(data.data[`${t}_${activeTab}`] || []));
    });
  } else {
    rows = (data.data[`${timeframe}_${activeTab}`] || []).slice();
  }

  // Apply filters
  rows = window.searchFilter?.filterRows(rows) || rows;

  // Apply sorting
  if (sortStack?.length > 0) {
    const tfOrder = { '1m': 1, '5m': 2, '10m': 3, '15m': 4, '30m': 5, '1h': 6, '1d': 7 };
    const ratingOrder = { 'STRONG BUY': 5, 'MODERATE': 3, 'SKIP': 1, 'WEAK BUY': 2, 'NEUTRAL': 0 };

    rows.sort((a, b) => {
      if (timeframe === 'ALL') {
        if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
        return (tfOrder[a.tf] || 0) - (tfOrder[b.tf] || 0);
      }
      return window.sortManager?.compare(a, b, sortStack) || 0;
    });
  }

  // Update row count
  const uniqueStocks = new Set(rows.map(r => r.symbol)).size;
  const totalStocks = data.universe || 0;
  const rcEl = document.getElementById('rowCount');
  if (rcEl) {
    if (activeTab === 'FO') {
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

  // Update sort indicators in headers
  document.querySelectorAll('#tableHeader th').forEach(th => {
    const onClick = th.getAttribute('onclick');
    if (!onClick) return;
    const colMatch = onClick.match(/'([^']+)'/);
    if (!colMatch) return;
    const col = colMatch[1];
    const idx = sortStack?.findIndex(s => s.col === col);
    
    th.querySelectorAll('.sort-meta').forEach(m => m.remove());
    if (idx !== -1) {
      const s = sortStack[idx];
      const span = document.createElement('span');
      span.className = 'sort-meta';
      span.innerHTML = (sortStack.length > 1 ? (idx + 1) + ' ' : '') + (s.asc ? '↑' : '↓');
      th.appendChild(span);
    }
  });

  // Handle empty state
  if (!rows.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'No results for current filter.';
    }
    return;
  }

  if (empty) empty.style.display = 'none';

  // Save scroll position
  const tableContainer = document.querySelector('.tw');
  const scrollPos = tableContainer ? tableContainer.scrollTop : 0;

  // Render row function
  const renderRow = (r) => {
    const cc = r.chgPct >= 0 ? 'up' : 'dn';
    const chgP = (r.priceChange >= 0 ? '+' : '') + r.priceChange.toFixed(2);
    const chg = (r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%';
    const fullChg = `${chgP} (${chg})`;

    // EMA status
    let statusTxt = '';
    if (r.goldenCross) {
      statusTxt = `<div class='ea muted-xl hr-dots' style='font-weight:700; color:var(--green)'>EMA 21 > 50</div>`;
    } else if (r.deathCross) {
      statusTxt = `<div class='eb muted-xl hr-dots' style='font-weight:700; color:var(--red)'>EMA 21 < 50</div>`;
    } else {
      statusTxt = r.ema21above 
        ? `<div class='ea muted-xl hr-dots' style='font-weight:600; color:var(--green)'>EMA 21 > 50</div>`
        : `<div class='eb muted-xl hr-dots' style='font-weight:600; color:var(--red)'>EMA 21 < 50</div>`;
    }

    // Chart sparkline
    const chartTxt = `<div style='cursor:pointer; opacity:0.85;' onclick="window.openModalChart('${r.symbol}', '${r.tf}')">` 
      + generateSparkline(r.priceHist, r.ema21Hist, r.ema50Hist) + `</div>`;
    
    const volBarPct = Math.round((Math.abs(r.volume || 0) / Math.max(...rows.map(x => x.volume || 0), 1)) * 100);
    const macdVal = r.macdVal !== null ? r.macdVal.toFixed(2) : '—';
    const macdTxt = r.macdAbove
      ? `<div class='hr-dots'><span class='up' style='font-size:12px;font-weight:600;'>▲ Bull <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`
      : `<div class='hr-dots'><span class='dn' style='font-size:12px;font-weight:600;'>▼ Bear <span style='opacity:0.5;font-size:10px;'>(${macdVal})</span></span></div>`;

    const gcBadge = r.goldenCross ? `<span class='bgc'>🟣GC</span>` : '';
    const symLower = r.symbol.toLowerCase().replace(/\s+/g, '-');
    const growwUrl = `https://groww.in/stocks/${symLower}`;
    const growwAppUrl = `groww://stock/${symLower}`;
    
    const symLink = `<a href="${growwUrl}" target="_blank" rel="noopener noreferrer"
      style="color:inherit; text-decoration:none; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"
      onmouseover="this.style.color='var(--accent)'"
      onmouseout="this.style.color='inherit'"
      onclick="event.preventDefault(); event.stopPropagation();
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
        if (isMobile) {
          window.location.href = '${growwAppUrl}';
          setTimeout(() => { window.open('${growwUrl}', '_blank'); }, 1500);
        } else {
          window.open('${growwUrl}', '_blank');
        }">
      ${r.symbol}<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;

    // Technical check boxes
    const boxes = [
      r.checks?.['Golden Cross (EMA 21>50)'] || r.checks?.['EMA 21 above 50'],
      r.checks?.['MACD Bull cross'] || r.checks?.['MACD above signal'],
      r.checks?.['Vol spike + price up'],
      r.checks?.['RSI healthy (45-75)'],
      r.checks?.['Price > VWAP']
    ].map((isOn, idx) => `<span class='ck ${isOn ? 'on' : 'off'}'></span>`).join('');

    const ratCls = r.rating === 'STRONG BUY' ? 'rat-sb' : r.rating === 'MODERATE' ? 'rat-wl' : 'rat-sk';
    
    // F&O expand toggle
    const isExpanded = activeTab === 'FO' && window.foManager?.expandedSymbol === r.symbol;
    const expandToggle = activeTab === 'FO' 
      ? `<span class="exp-btn ${isExpanded ? 'active' : ''}" onclick="window.foManager.toggleRow('${r.symbol}', this, event)">▼</span> ` 
      : '';
    const subRowClass = isExpanded ? 'sub-row active' : 'sub-row';

    return `<tr class='main-row ${(r.goldenCross ? 'gc-row' : '')}' id="row-${r.symbol}">
      <td style="text-align:left;">
        <div class='sym' style="white-space:nowrap;">${expandToggle}${symLink} <span class="tf-purple">(${r.tf})</span>${gcBadge}</div>
        <div class='muted-xl' style="text-transform:uppercase; font-size:9px; margin-top:3px;">${r.sector} · <span class='${cc}'>${fullChg}</span></div>
        ${r.dividend ? `<div class='dividend-info' style="margin-top:2px; font-size:9px; font-family:var(--mono);">💰 <span class="${r.dividend.colorClass}">${r.dividend.displayText}</span> <span style="opacity:0.6;">(${r.dividend.yield.toFixed(2)}% yield)</span></div>` : ''}
      </td>
      <td>
        <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
          <span class="price-bold">₹${r.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          <span class="muted-xl">VWAP <span class="${r.aboveVwap ? 'up' : 'dn'}">${r.aboveVwap ? '▲' : '▼'}</span> ₹${(r.vwap || r.price).toFixed(1)}</span>
        </div>
      </td>
      <td><div style="display:flex; justify-content:center;">${chartTxt}</div></td>
      <td>
        <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
          <div>${statusTxt}</div>
          <div class="muted-xl ${cc}" style="font-weight:600;">Gap ${Math.abs(r.emaGap || 0).toFixed(2)}%</div>
        </div>
      </td>
      <td>
        <div style="display:flex; flex-direction:column; align-items:center; gap:5px;">
          <div class="${r.volSpike ? 'vol-spike-⚡' : ''}" style="font-size:13px; font-weight:700; font-family:var(--mono); color:${r.volSpike ? 'var(--yellow)' : 'var(--text)'};">${r.volSpike ? '⚡ ' : ''}${formatVolume(r.volume)}</div>
          <div style="width:88px; height:7px; background:rgba(255,255,255,0.07); border-radius:6px; overflow:hidden;">
            <div class="vol-bar-fill ${r.volSpike ? 'vb-spike' : 'vb-normal'}" style="width:${volBarPct}%; height:100%; border-radius:6px; transition:width 0.4s ease;"></div>
          </div>
          <div class="${(r.volumeChange || 0) >= 0 ? 'up' : 'dn'}" style="font-size:10px; font-family:var(--mono);">${(r.volumeChange || 0) >= 0 ? '+' : ''}${formatVolume(r.volumeChange)} ${(r.volumeChange || 0) >= 0 ? '↑' : '↓'}</div>
        </div>
      </td>
      <td><div style="display:flex; justify-content:center;">${macdTxt}</div></td>
      <td><div>${generateRangeBar(r.dayL, r.dayH, r.price)}</div></td>
      <td><div>${generateRangeBar((r.w52L || r.weekL || 0), (r.w52H || r.weekH || 0), r.price)}</div></td>
      <td>
        <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
          <span style="font-weight:800; font-family:var(--mono); font-size:15px; color:var(--text);">${r.techScore}<span style="color:var(--muted); font-weight:400; font-size:10px;">/7</span></span>
          <div class="checks">${boxes}</div>
        </div>
      </td>
      <td>
        <div style="display:flex; flex-direction:column; align-items:center; gap:6px;">
          <div class="rat-badge ${ratCls}">${r.rating}</div>
          <div class="flag-group">
            <span class="up" style="font-weight:700; font-size:11px;">⚑${r.techScore}</span>
            <span style="color:var(--muted); font-size:9px; margin:0 3px;">/</span>
            <span class="dn" style="font-weight:700; font-size:11px;">⚑${r.redCount || 0}</span>
          </div>
        </div>
      </td>
    </tr>
    <tr class="${subRowClass}" id="sub-${r.symbol}">
      <td colspan="10"><div class="sub-wrap" id="wrap-${r.symbol}">${isExpanded ? '<div style="color:var(--muted);text-align:center;padding:20px">⏳ Reloading Option Chain...</div>' : 'Loading...'}</div></td>
    </tr>`;
  };

  // Execute chunked render
  window.renderEngine?.renderChunks(rows, renderRow, tbody, () => {
    // Restore scroll position
    if (tableContainer) tableContainer.scrollTop = scrollPos;
    
    // Reload expanded F&O row if exists
    if (activeTab === 'FO' && window.foManager?.expandedSymbol) {
      const wrap = document.getElementById(`wrap-${window.foManager.expandedSymbol}`);
      if (wrap) window.foManager.loadOptionChain(window.foManager.expandedSymbol, wrap);
    }
  });
}

// ── RENDER: SECTORS ──────────────────────────────────────────
function renderSectors(data) {
  if (!data?.data) return;

  const searchQuery = window.stateManager.get('searchQuery').trim().toUpperCase();
  let allRows = [];
  const timeframe = window.stateManager.get('timeframe');
  
  if (timeframe === 'ALL') {
    allRows = data.data['1d_ALL'] || [];
  } else {
    allRows = data.data[`${timeframe}_ALL`] || [];
  }

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
  document.querySelectorAll('#tableHeader th').forEach(th => {
    let text = th.innerText.replace(/ ▲| ▼/g, '');
    if (th.getAttribute('onclick').includes(`'${sortBy}'`)) {
      const arrow = sortObj.asc ? ' ▲' : ' ▼';
      th.innerHTML = th.innerHTML.replace(text, text + arrow);
    }
  });

  // Build HTML
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  
  if (!list.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'No sectors found.';
    }
    return;
  }

  if (empty) empty.style.display = 'none';

  const html = list.map(s => {
    const avgColor = s.avgChg >= 0 ? 'up' : 'dn';
    const gainerColor = s.topGainer.chgPct >= 0 ? 'up' : 'dn';
    const loserColor = s.topLoser.chgPct >= 0 ? 'up' : 'dn';
    
    return `<tr>
      <td style="font-weight:700; color:var(--text);">${s.name}</td>
      <td style="font-family:var(--mono); font-weight:700;" class="${avgColor}">${s.avgChg >= 0 ? '+' : ''}${s.avgChg.toFixed(2)}%</td>
      <td style="text-align:center; font-family:var(--mono);">${s.stocks}</td>
      <td>
        <span class="${gainerColor}" style="font-family:var(--mono); font-weight:600;">${s.topGainer.symbol}</span>
        <span class="${gainerColor}" style="font-size:10px; margin-left:4px;">(${s.topGainer.chgPct >= 0 ? '+' : ''}${s.topGainer.chgPct.toFixed(2)}%)</span>
      </td>
      <td>
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
      </div>`;
  }

  // Hide default table header for portfolio
  document.getElementById('tableHeader').innerHTML = '';

  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');

  if (!holdings?.length && !positions?.length) {
    tbody.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'No holdings or positions found.';
    }
    return;
  }

  if (empty) empty.style.display = 'none';

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
      const pnl = h.pnl || 0;
      const pnlPct = h.pnl_percent || 0;
      const pnlColor = pnl >= 0 ? '#22c55e' : '#ef4444';
      
      html += `<div style="background:rgba(255,255,255,0.02); border:1px solid ${pnlColor}30; border-radius:10px; padding:10px 14px; margin-bottom:6px; display:grid; grid-template-columns:1fr auto; gap:6px; align-items:center;">
        <div>
          <div style="font-weight:700; font-family:var(--mono); font-size:12px; color:var(--text);">${h.trading_symbol}</div>
          <div style="display:flex; gap:12px; margin-top:3px; font-size:9px; color:var(--muted);">
            <span>Qty: <b style="color:var(--text);">${h.quantity}</b></span>
            <span>Avg: <b style="color:var(--text);">₹${(h.average_price || 0).toFixed(2)}</b></span>
            <span>LTP: <b style="color:var(--text);">₹${(h.current_price || 0).toFixed(2)}</b></span>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700; font-size:14px; font-family:var(--mono); color:${pnlColor};">${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}</div>
          <div style="font-size:10px; font-weight:600; font-family:var(--mono); color:${pnlColor};">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</div>
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
  const data = window.dataManager.cache.get(window.dataManager.cacheKey(tf, state.activeTab))?.data;
  
  if (!data?.data) return;

  const allKeys = ['1m_ALL', '5m_ALL', '10m_ALL', '15m_ALL', '30m_ALL', '1h_ALL', '1d_ALL',
                   '1m_GOLDEN', '5m_GOLDEN', '10m_GOLDEN', '15m_GOLDEN', '30m_GOLDEN', '1h_GOLDEN', '1d_GOLDEN',
                   '1m_BUY', '5m_BUY', '10m_BUY', '15m_BUY', '30m_BUY', '1h_BUY', '1d_BUY',
                   '1m_SELL', '5m_SELL', '10m_SELL', '15m_SELL', '30m_SELL', '1h_SELL', '1d_SELL'];
  
  let row = null;
  for (const key of allKeys) {
    row = data.data[key]?.find(x => x.symbol === symbol);
    if (row) break;
  }
  
  if (!row) return;

  const modal = document.getElementById('chartModal');
  modal.style.display = 'flex';
  document.getElementById('modalTitle').innerText = `${row.symbol} (${row.tf})`;

  const ctx = document.getElementById('modalCanvas').getContext('2d');
  if (modalChartInstance) modalChartInstance.destroy();

  const labels = Array.from({ length: row.priceHist.length }, (_, i) => `T-${row.priceHist.length - 1 - i}`);

  modalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Price', data: row.priceHist, borderColor: 'rgba(255, 255, 255, 0.4)', borderWidth: 1, color: 'white', fill: false, tension: 0.1, pointRadius: 2, pointHoverRadius: 5 },
        { label: 'EMA 21', data: row.ema21Hist, borderColor: '#22c55e', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 0, pointHoverRadius: 4 },
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
function updateBadges(data) {
  if (!data?.data) return;
  
  const timeframe = window.stateManager.get('timeframe');
  let all = [], buys = [], sells = [], golden = [];
  
  if (timeframe === 'ALL') {
    ['1m', '5m', '10m', '15m', '30m', '1h', '1d'].forEach(t => {
      all.push(...(data.data[`${t}_ALL`] || []));
      buys.push(...(data.data[`${t}_BUY`] || []));
      sells.push(...(data.data[`${t}_SELL`] || []));
      golden.push(...(data.data[`${t}_GOLDEN`] || []));
    });
  } else {
    all = data.data[`${timeframe}_ALL`] || [];
    buys = data.data[`${timeframe}_BUY`] || [];
    sells = data.data[`${timeframe}_SELL`] || [];
    golden = data.data[`${timeframe}_GOLDEN`] || [];
  }

  const setBadge = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  };
  
  setBadge('badge-GOLDEN', new Set(golden.map(r => r.symbol)).size || '—');
  setBadge('badge-ALL', new Set(all.map(r => r.symbol)).size || '—');
  setBadge('badge-BUY', new Set(buys.map(r => r.symbol)).size || '—');
  setBadge('badge-SELL', new Set(sells.map(r => r.symbol)).size || '—');
  setBadge('badge-FO', 30);
  setBadge('badge-SECTORS', new Set(all.map(r => r.sector).filter(Boolean)).size || '—');
}

// ── HELPER: Update last updated badge ────────────────────────
function updateLastUpdatedBadge(data) {
  const el = document.getElementById('lastUpdatedBadge');
  if (el && data?.lastUpdated) {
    const d = new Date(data.lastUpdated);
    const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `Updated ${date} - ${time}`;
  }
}

// ── HELPER: Render current view ──────────────────────────────
function renderCurrentView() {
  const activeTab = window.stateManager.get('activeTab');
  const timeframe = window.stateManager.get('timeframe');
  const dataKey = window.dataManager.cacheKey(timeframe, activeTab);
  const cached = window.dataManager.cache.get(dataKey);
  
  if (!cached?.data) return;
  
  if (activeTab === 'PORTFOLIO') {
    renderPortfolio(window.dataManager.portfolioCache?.data);
  } else if (activeTab === 'SECTORS') {
    renderSectors(cached.data);
  } else {
    renderStocks(cached.data);
  }
}

// Export to window
window.renderStocks = renderStocks;
window.renderSectors = renderSectors;
window.renderPortfolio = renderPortfolio;
window.renderOptionChain = renderOptionChain;
window.openModalChart = openModalChart;
window.closeModalChart = closeModalChart;
window.updateBadges = updateBadges;
window.updateLastUpdatedBadge = updateLastUpdatedBadge;
window.renderCurrentView = renderCurrentView;
