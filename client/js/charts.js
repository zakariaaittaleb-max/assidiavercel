/* Bibliothèque de graphiques SVG — sans dépendance externe.
 *
 * Format d'entrée unique pour tous les types de graphiques :
 *   { type, categories: [...], series: [{ name, values: [...] }], unit, height }
 * Le même jeu de données peut donc être basculé d'un type à l'autre sans transformation,
 * ce qui est la base de l'explorateur croisé du tableau de bord.
 */
(function (global) {
  'use strict';

  const PALETTE = [
    '#2f6bff', '#00c2b8', '#7b5cff', '#f5a524', '#17b26a',
    '#ef4444', '#0ea5e9', '#ec4899', '#84cc16', '#f97316',
    '#6366f1', '#14b8a6', '#a855f7', '#eab308', '#22c55e',
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  function fmt(v, unit) {
    if (v == null || Number.isNaN(v)) return '—';
    return nf.format(v) + (unit || '');
  }

  // SVG ne sait pas rogner le texte : on tronque nous-mêmes pour que les libellés longs
  // (noms de cours, d'étudiants) ne débordent pas hors de la carte. Le texte complet
  // reste accessible au survol via <title>.
  function truncate(s, maxChars) {
    s = String(s == null ? '' : s);
    return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + '…' : s;
  }
  function labelWithTitle(full, maxChars) {
    const short = truncate(full, maxChars);
    const title = short === String(full) ? '' : `<title>${esc(full)}</title>`;
    return title + esc(short);
  }

  // Bornes « rondes » pour l'axe des valeurs (1 / 2 / 5 × 10^n).
  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const rawStep = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step / 1000; v += step) {
      ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return { min: niceMin, max: niceMax, ticks };
  }

  function colorAt(i) { return PALETTE[i % PALETTE.length]; }

  function emptyState(el, msg) {
    el.innerHTML = `<div class="chart-empty">${esc(msg || 'Aucune donnée pour ces filtres.')}</div>`;
  }

  /* ---------------------------- Infobulle ---------------------------- */

  function ensureTooltip(el) {
    let tip = el.querySelector(':scope > .chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.style.display = 'none';
      el.appendChild(tip);
    }
    return tip;
  }

  function bindTooltip(el, svg, resolve) {
    const tip = ensureTooltip(el);
    svg.querySelectorAll('[data-tip-idx]').forEach(node => {
      node.addEventListener('mouseenter', () => {
        const html = resolve(Number(node.dataset.tipIdx), node.dataset.tipSeries);
        if (!html) return;
        tip.innerHTML = html;
        tip.style.display = 'block';
      });
      node.addEventListener('mousemove', (ev) => {
        const box = el.getBoundingClientRect();
        const x = ev.clientX - box.left;
        const y = ev.clientY - box.top;
        tip.style.left = Math.min(Math.max(x + 14, 8), Math.max(8, box.width - tip.offsetWidth - 8)) + 'px';
        tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
      });
      node.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }

  function legendHtml(series, opts = {}) {
    if (!series.length || (series.length === 1 && !opts.force)) return '';
    return `<div class="chart-legend">` + series.map((s, i) =>
      `<span class="chart-legend-item"><i style="background:${colorAt(i)}"></i>${esc(s.name)}</span>`
    ).join('') + `</div>`;
  }

  /* ------------------- Graphiques à axes (X catégoriel) ------------------- */

  function renderCartesian(el, spec) {
    const { categories, series, unit, type } = spec;
    const width = Math.max(el.clientWidth || 640, 320);
    const stacked = type === 'bar-stacked' || type === 'area-stacked';

    // Étiquettes longues ou nombreuses : on bascule en oblique pour rester lisible.
    const longest = categories.reduce((m, c) => Math.max(m, String(c).length), 0);
    const slot = (width - 70) / Math.max(1, categories.length);
    const rotate = slot < Math.max(28, longest * 6.5);
    const mBottom = rotate ? Math.min(120, 28 + longest * 5.5) : 34;
    const M = { top: 14, right: 14, bottom: mBottom, left: 56 };
    const height = (spec.height || 320) + (rotate ? mBottom - 34 : 0);
    const iw = width - M.left - M.right;
    const ih = height - M.top - M.bottom;

    // Domaine des valeurs
    let lo = 0, hi = 0;
    if (stacked) {
      categories.forEach((_, ci) => {
        let pos = 0, neg = 0;
        series.forEach(s => { const v = s.values[ci] || 0; if (v >= 0) pos += v; else neg += v; });
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      });
    } else {
      series.forEach(s => s.values.forEach(v => {
        if (v == null) return;
        hi = Math.max(hi, v); lo = Math.min(lo, v);
      }));
    }
    if (hi === 0 && lo === 0) hi = 1;
    const scale = niceTicks(lo, hi, 5);
    const y = (v) => M.top + ih - ((v - scale.min) / (scale.max - scale.min)) * ih;
    const bandW = iw / Math.max(1, categories.length);

    let s = '';

    // Grille + axe Y
    scale.ticks.forEach(t => {
      const yy = y(t);
      s += `<line x1="${M.left}" y1="${yy}" x2="${M.left + iw}" y2="${yy}" class="chart-grid"/>`;
      s += `<text x="${M.left - 8}" y="${yy + 4}" class="chart-axis-label" text-anchor="end">${esc(fmt(t, unit))}</text>`;
    });

    // Étiquettes X
    const maxXChars = rotate ? Math.floor(mBottom / 5.4) : Math.max(4, Math.floor(bandW / 6.4));
    categories.forEach((c, ci) => {
      const cx = M.left + bandW * (ci + 0.5);
      const yy = M.top + ih + 16;
      s += rotate
        ? `<text x="${cx}" y="${yy}" class="chart-axis-label" text-anchor="end" transform="rotate(-40 ${cx} ${yy})">${labelWithTitle(c, maxXChars)}</text>`
        : `<text x="${cx}" y="${yy}" class="chart-axis-label" text-anchor="middle">${labelWithTitle(c, maxXChars)}</text>`;
    });

    const zeroY = y(Math.max(scale.min, 0));

    if (type === 'bar' || type === 'bar-grouped' || type === 'bar-stacked') {
      const inner = bandW * 0.72;
      if (stacked) {
        categories.forEach((_, ci) => {
          let accPos = 0;
          series.forEach((se, si) => {
            const v = se.values[ci] || 0;
            const y0 = y(accPos), y1 = y(accPos + v);
            accPos += v;
            const top = Math.min(y0, y1), h = Math.abs(y1 - y0);
            if (h <= 0) return;
            s += `<rect x="${M.left + bandW * ci + (bandW - inner) / 2}" y="${top}" width="${inner}" height="${h}" fill="${colorAt(si)}" rx="2"/>`;
          });
        });
      } else {
        const each = inner / Math.max(1, series.length);
        categories.forEach((_, ci) => {
          series.forEach((se, si) => {
            const v = se.values[ci];
            if (v == null) return;
            const y1 = y(v), top = Math.min(zeroY, y1), h = Math.abs(zeroY - y1);
            const x = M.left + bandW * ci + (bandW - inner) / 2 + each * si;
            s += `<rect x="${x}" y="${top}" width="${Math.max(1, each - 2)}" height="${Math.max(1, h)}" fill="${colorAt(si)}" rx="2"/>`;
          });
        });
      }
    } else {
      // Courbes / aires
      series.forEach((se, si) => {
        const pts = [];
        se.values.forEach((v, ci) => {
          if (v == null) return;
          pts.push([M.left + bandW * (ci + 0.5), y(v)]);
        });
        if (!pts.length) return;
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
        if (type === 'area' || type === 'area-stacked') {
          s += `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${zeroY} L${pts[0][0].toFixed(1)},${zeroY} Z" fill="${colorAt(si)}" opacity="0.16"/>`;
        }
        s += `<path d="${d}" fill="none" stroke="${colorAt(si)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (pts.length <= 60) {
          pts.forEach(p => { s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#fff" stroke="${colorAt(si)}" stroke-width="2"/>`; });
        }
      });
    }

    // Axe zéro
    s += `<line x1="${M.left}" y1="${zeroY}" x2="${M.left + iw}" y2="${zeroY}" class="chart-axis"/>`;

    // Zones de survol : une bande par catégorie, l'infobulle liste toutes les séries.
    categories.forEach((_, ci) => {
      s += `<rect data-tip-idx="${ci}" x="${M.left + bandW * ci}" y="${M.top}" width="${bandW}" height="${ih}" fill="transparent" class="chart-hit"/>`;
    });

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${s}</svg>` + legendHtml(series);
    bindTooltip(el, el.querySelector('svg'), (ci) => {
      const lines = series
        .map((se, si) => ({ se, si, v: se.values[ci] }))
        .filter(r => r.v != null)
        .map(r => `<div class="chart-tip-row"><i style="background:${colorAt(r.si)}"></i><span>${esc(r.se.name)}</span><b>${esc(fmt(r.v, unit))}</b></div>`)
        .join('');
      return `<div class="chart-tip-title">${esc(categories[ci])}</div>${lines}`;
    });
  }

  /* --------------------------- Barres horizontales --------------------------- */

  function renderHBar(el, spec) {
    const { categories, series, unit } = spec;
    const width = Math.max(el.clientWidth || 640, 320);
    const rowH = 30;
    const labelW = Math.min(220, Math.max(90, width * 0.28));
    // Avec plusieurs séries, la valeur de droite liste chaque série : il faut plus de place.
    const M = { top: 8, right: series.length > 1 ? 128 : 60, bottom: 8, left: labelW };
    const height = M.top + M.bottom + categories.length * rowH * Math.max(1, series.length > 1 ? 1 : 1);
    const iw = width - M.left - M.right;

    let hi = 0;
    series.forEach(s => s.values.forEach(v => { if (v != null) hi = Math.max(hi, v); }));
    if (hi <= 0) hi = 1;

    let s = '';
    categories.forEach((c, ci) => {
      const yTop = M.top + ci * rowH;
      const barsN = series.length;
      const barH = Math.max(4, (rowH - 8) / barsN);
      s += `<text x="${M.left - 10}" y="${yTop + rowH / 2 + 4}" class="chart-axis-label" text-anchor="end">${labelWithTitle(c, Math.floor((labelW - 14) / 6.2))}</text>`;
      s += `<rect x="${M.left}" y="${yTop + 4}" width="${iw}" height="${rowH - 8}" class="chart-track" rx="4"/>`;
      series.forEach((se, si) => {
        const v = se.values[ci];
        if (v == null) return;
        const w = Math.max(0, (v / hi) * iw);
        s += `<rect x="${M.left}" y="${yTop + 4 + barH * si}" width="${w}" height="${barH}" fill="${colorAt(si)}" rx="3"/>`;
      });
      // Additionner des séries qui ne s'additionnent pas (ex. couvert vs planifié) n'aurait aucun sens :
      // on affiche chaque valeur, ou l'étiquette fournie par l'appelant.
      const label = spec.rowLabel
        ? spec.rowLabel(ci)
        : series.map(se => fmt(se.values[ci], unit)).join(' / ');
      s += `<text x="${M.left + iw + 8}" y="${yTop + rowH / 2 + 4}" class="chart-value-label">${esc(label)}</text>`;
      s += `<rect data-tip-idx="${ci}" x="0" y="${yTop}" width="${width}" height="${rowH}" fill="transparent" class="chart-hit"/>`;
    });

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${s}</svg>` + legendHtml(series);
    bindTooltip(el, el.querySelector('svg'), (ci) => {
      const lines = series.map((se, si) => `<div class="chart-tip-row"><i style="background:${colorAt(si)}"></i><span>${esc(se.name)}</span><b>${esc(fmt(se.values[ci], unit))}</b></div>`).join('');
      return `<div class="chart-tip-title">${esc(categories[ci])}</div>${lines}`;
    });
  }

  /* ------------------------------- Secteurs ------------------------------- */

  function renderPie(el, spec, donut) {
    const { categories, series, unit } = spec;
    const values = categories.map((_, ci) => series.reduce((a, se) => a + (se.values[ci] || 0), 0));
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return emptyState(el, 'Aucune valeur à répartir (métrique nulle sur cette sélection).');

    const width = Math.max(el.clientWidth || 480, 300);
    const height = spec.height || 320;
    const cx = width / 2, cy = height / 2;
    const r = Math.min(width, height) / 2 - 16;
    const rInner = donut ? r * 0.58 : 0;

    let angle = -Math.PI / 2;
    let s = '';
    values.forEach((v, ci) => {
      if (v <= 0) return;
      const sweep = (v / total) * Math.PI * 2;
      const a0 = angle, a1 = angle + sweep;
      angle = a1;
      const large = sweep > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      let d;
      if (rInner > 0) {
        const xi1 = cx + rInner * Math.cos(a1), yi1 = cy + rInner * Math.sin(a1);
        const xi0 = cx + rInner * Math.cos(a0), yi0 = cy + rInner * Math.sin(a0);
        d = `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${rInner},${rInner} 0 ${large} 0 ${xi0},${yi0} Z`;
      } else {
        d = `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
      }
      s += `<path d="${d}" fill="${colorAt(ci)}" stroke="#fff" stroke-width="2" data-tip-idx="${ci}" class="chart-hit"/>`;
      const pct = (v / total) * 100;
      if (pct >= 6) {
        const am = (a0 + a1) / 2, rl = rInner > 0 ? (r + rInner) / 2 : r * 0.65;
        s += `<text x="${cx + rl * Math.cos(am)}" y="${cy + rl * Math.sin(am) + 4}" class="chart-slice-label" text-anchor="middle">${pct.toFixed(0)}%</text>`;
      }
    });
    if (donut) {
      s += `<text x="${cx}" y="${cy - 2}" class="chart-donut-total" text-anchor="middle">${esc(fmt(total, unit))}</text>`;
      s += `<text x="${cx}" y="${cy + 16}" class="chart-axis-label" text-anchor="middle">Total</text>`;
    }

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${s}</svg>`
      + `<div class="chart-legend">` + categories.map((c, ci) =>
        `<span class="chart-legend-item"><i style="background:${colorAt(ci)}"></i>${esc(c)} <b>${esc(fmt(values[ci], unit))}</b></span>`).join('') + `</div>`;
    bindTooltip(el, el.querySelector('svg'), (ci) =>
      `<div class="chart-tip-title">${esc(categories[ci])}</div><div class="chart-tip-row"><span>Valeur</span><b>${esc(fmt(values[ci], unit))}</b></div><div class="chart-tip-row"><span>Part</span><b>${((values[ci] / total) * 100).toFixed(1)}%</b></div>`);
  }

  /* ------------------------------- Heatmap ------------------------------- */

  function renderHeatmap(el, spec) {
    const { categories, series, unit } = spec;
    if (!series.length) return emptyState(el);
    const width = Math.max(el.clientWidth || 640, 320);
    const labelW = Math.min(200, Math.max(90, width * 0.24));
    const cellH = 30;
    const longest = categories.reduce((m, c) => Math.max(m, String(c).length), 0);
    const topH = Math.min(110, 24 + longest * 5.2);
    const M = { top: topH, left: labelW, right: 12, bottom: 8 };
    const iw = width - M.left - M.right;
    const cellW = iw / Math.max(1, categories.length);
    const height = M.top + M.bottom + series.length * cellH;

    let lo = Infinity, hi = -Infinity;
    series.forEach(s => s.values.forEach(v => { if (v == null) return; lo = Math.min(lo, v); hi = Math.max(hi, v); }));
    if (!Number.isFinite(lo)) return emptyState(el);
    if (lo === hi) hi = lo + 1;

    let s = '';
    categories.forEach((c, ci) => {
      const x = M.left + cellW * (ci + 0.5);
      s += `<text x="${x}" y="${M.top - 8}" class="chart-axis-label" text-anchor="start" transform="rotate(-45 ${x} ${M.top - 8})">${esc(c)}</text>`;
    });
    const maxLabelChars = Math.floor((labelW - 14) / 6.2);
    series.forEach((se, si) => {
      const yTop = M.top + si * cellH;
      s += `<text x="${M.left - 10}" y="${yTop + cellH / 2 + 4}" class="chart-axis-label" text-anchor="end">${labelWithTitle(se.name, maxLabelChars)}</text>`;
      se.values.forEach((v, ci) => {
        const x = M.left + cellW * ci;
        if (v == null) {
          s += `<rect x="${x + 1}" y="${yTop + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="var(--surface-alt)" rx="3"/>`;
          return;
        }
        const t = (v - lo) / (hi - lo);
        s += `<rect data-tip-idx="${ci}" data-tip-series="${si}" x="${x + 1}" y="${yTop + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="${colorAt(0)}" fill-opacity="${(0.10 + t * 0.85).toFixed(3)}" rx="3" class="chart-hit"/>`;
        if (cellW > 46) {
          s += `<text x="${x + cellW / 2}" y="${yTop + cellH / 2 + 4}" class="chart-cell-label" text-anchor="middle" fill="${t > 0.55 ? '#fff' : 'var(--text)'}">${esc(fmt(v, unit))}</text>`;
        }
      });
    });

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${s}</svg>`;
    bindTooltip(el, el.querySelector('svg'), (ci, si) => {
      const se = series[Number(si)];
      return `<div class="chart-tip-title">${esc(se.name)} × ${esc(categories[ci])}</div><div class="chart-tip-row"><b>${esc(fmt(se.values[ci], unit))}</b></div>`;
    });
  }

  /* -------------------------------- Table -------------------------------- */

  function renderTable(el, spec) {
    const { categories, series, unit } = spec;
    // La colonne Total n'a d'intérêt qu'en présence d'un croisement : avec une seule
    // série, elle ne ferait que recopier la colonne de valeurs.
    const multi = series.length > 1;
    let head = `<th>${esc(spec.dimensionLabel || 'Catégorie')}</th>` + series.map(s => `<th class="num">${esc(s.name)}</th>`).join('');
    if (multi) head += `<th class="num">Total</th>`;
    const body = categories.map((c, ci) => {
      const cells = series.map(s => `<td class="num">${esc(fmt(s.values[ci], unit))}</td>`).join('');
      const total = series.reduce((a, s) => a + (s.values[ci] || 0), 0);
      return `<tr><td>${esc(c)}</td>${cells}${multi ? `<td class="num"><strong>${esc(fmt(total, unit))}</strong></td>` : ''}</tr>`;
    }).join('');
    el.innerHTML = `<div class="chart-table-wrap"><table class="chart-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /* ------------------------------ Dispatch ------------------------------ */

  const RENDERERS = {
    line: renderCartesian,
    area: renderCartesian,
    'area-stacked': renderCartesian,
    bar: renderCartesian,
    'bar-grouped': renderCartesian,
    'bar-stacked': renderCartesian,
    hbar: renderHBar,
    pie: (el, spec) => renderPie(el, spec, false),
    donut: (el, spec) => renderPie(el, spec, true),
    heatmap: renderHeatmap,
    table: renderTable,
  };

  const observed = new WeakMap();

  function render(el, spec) {
    if (!el) return;
    if (!spec || !spec.categories || !spec.categories.length || !spec.series || !spec.series.length) {
      return emptyState(el, spec && spec.emptyMessage);
    }
    const fn = RENDERERS[spec.type] || renderCartesian;
    el.classList.add('chart');
    fn(el, spec);

    // Re-rendu au redimensionnement : les graphiques sont dessinés à la largeur réelle
    // du conteneur (texte net) plutôt qu'étirés par le navigateur.
    if (!observed.has(el) && typeof ResizeObserver !== 'undefined') {
      let w = el.clientWidth, timer;
      const ro = new ResizeObserver(() => {
        if (Math.abs(el.clientWidth - w) < 24) return;
        w = el.clientWidth;
        clearTimeout(timer);
        timer = setTimeout(() => { const last = observed.get(el); if (last) (RENDERERS[last.type] || renderCartesian)(el, last); }, 120);
      });
      ro.observe(el);
    }
    observed.set(el, spec);
  }

  // Conversion des lignes de l'API ({dim, split, value}) vers le format des graphiques.
  function pivot(rows, { splitEnabled, seriesName = 'Valeur' } = {}) {
    const categories = [...new Set(rows.map(r => String(r.dim)))];
    if (!splitEnabled) {
      const byDim = new Map(rows.map(r => [String(r.dim), r.value]));
      return { categories, series: [{ name: seriesName, values: categories.map(c => byDim.get(c) ?? null) }] };
    }
    const splits = [...new Set(rows.map(r => String(r.split)))];
    const key = (d, s) => d + ' ' + s;
    const map = new Map(rows.map(r => [key(String(r.dim), String(r.split)), r.value]));
    return {
      categories,
      series: splits.map(sp => ({ name: sp, values: categories.map(c => map.get(key(c, sp)) ?? null) })),
    };
  }

  function toCsv(spec) {
    const head = ['Catégorie', ...spec.series.map(s => s.name)];
    const lines = [head.map(csvCell).join(';')];
    spec.categories.forEach((c, ci) => {
      lines.push([c, ...spec.series.map(s => (s.values[ci] == null ? '' : String(s.values[ci]).replace('.', ',')))].map(csvCell).join(';'));
    });
    return '﻿' + lines.join('\r\n');
  }
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  global.Charts = { render, pivot, toCsv, PALETTE, colorAt, fmt };
})(window);
