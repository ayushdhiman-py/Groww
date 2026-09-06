// trial-ui.mjs — lightweight UI module used by public/trial.html
export async function fetchTrialFeed() {
    try {
        const resp = await fetch('/api/trial');
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.warn('[Trial UI] fetch failed', e);
        return null;
    }
}

export function renderTrialTable(feed) {
    const panel = document.getElementById('trial-root') || document.getElementById('trialPanel');
    if (!panel) return;
    if (!feed || !feed.items || !feed.items.length) {
        panel.innerHTML = `<div class="card">No Trial candidates available (generatedAt: ${feed?.generatedAt ?? 'n/a'})</div>`;
        return;
    }

    const rows = feed.items.map(i => {
        const est = i.estimator || {};
        const conf = est.confidence != null ? `${Math.round(est.confidence * 100)}%` : 'n/a';
        const pReach = est.pReach15 != null ? `${Math.round(est.pReach15 * 100)}%` : 'n/a';
        const pCont = est.pContinue != null ? `${Math.round(est.pContinue * 100)}%` : 'n/a';
        const pRev = est.pReversal != null ? `${Math.round(est.pReversal * 100)}%` : 'n/a';
        const expRet = est.expectedReturnPct != null ? `${(+est.expectedReturnPct).toFixed(2)}%` : 'n/a';
        const rvol = i.indicators?.relativeVolume ?? 'n/a';
        const rsi = i.indicators?.rsi ?? 'n/a';
        const macd = i.indicators?.macdVal ?? 'n/a';
        const st = i.indicators?.supertrend === 'UP' ? '▲' : i.indicators?.supertrend === 'DOWN' ? '▼' : '-';
        const sig = i.signal || '';

        return `<tr>
            <td><b>${i.symbol}</b></td>
            <td style="text-align:right">₹${i.price}</td>
            <td style="text-align:right">${i.chg1m != null ? (i.chg1m>0?'+':'')+i.chg1m+'%' : 'n/a'}</td>
            <td style="text-align:right">${i.chg5m != null ? (i.chg5m>0?'+':'')+i.chg5m+'%' : 'n/a'}</td>
            <td style="text-align:right">${i.chg15m != null ? (i.chg15m>0?'+':'')+i.chg15m+'%' : 'n/a'}</td>
            <td style="text-align:right">${pReach}</td>
            <td style="text-align:right">${pCont}</td>
            <td style="text-align:right">${pRev}</td>
            <td style="text-align:right">${expRet}</td>
            <td style="text-align:right">${rvol}</td>
            <td style="text-align:right">${rsi}</td>
            <td style="text-align:right">${macd}</td>
            <td style="text-align:center">${st}</td>
            <td style="text-align:center">${sig}</td>
        </tr>`;
    }).join('\n');

    panel.innerHTML = `
      <div class="card" style="padding:8px; overflow:auto;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Generated: ${feed.generatedAt || 'n/a'}</div>
        <table>
          <thead>
            <tr style="text-align:left;color:#9fb3cc;font-size:12px">
              <th>Symbol</th><th style="text-align:right">Price</th><th>1m</th><th>5m</th><th>15m</th>
              <th>P≥1.5%</th><th>Cont</th><th>Rev</th><th>Exp 5m</th><th>RVOL</th><th>RSI</th><th>MACD</th><th>ST</th><th>Signal</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
}
