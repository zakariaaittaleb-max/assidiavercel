/* Tableau de bord analytique.
 *
 * Un état de filtres unique alimente tous les blocs de la page (indicateurs,
 * chronologie, explorateur croisé, couverture horaire) : ce qui est affiché
 * correspond toujours exactement à la sélection en cours.
 */

function tick() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
tick();
setInterval(tick, 1000);

const STORE_KEY = 'assidia:dashboard:v2';
const $ = (id) => document.getElementById(id);

const state = {
  start: '', end: '', ecole: '', niveau: '', classe: '', cours: '',
  tolerance: '10', excludeOrphans: false, semesterIdx: null,
  timeline: { metric: 'taux_presence', granularity: 'mois', split: '', type: 'line' },
  explorer: { metric: 'taux_presence', dimension: 'ecole', split: '', type: 'bar-grouped', sort: 'value-desc' },
  couverture: { dimension: 'ecole' },
};
let META = null;
let dataRange = { start: null, end: null };
let lastTimelineSpec = null;
let lastExplorerSpec = null;

/* --------------------------------- Semestres --------------------------------- *
 * Semestre 1 : 1er août → 31 janvier. Semestre 2 : 1er février → 31 juillet.
 * Les semestres sont indexés en continu (pair = S1, impair = S2) pour pouvoir
 * naviguer précédent/suivant sans recalcul de cas particuliers.
 */
function semesterIndexForDate(d) {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  if (month >= 8) return year * 2;
  if (month === 1) return (year - 1) * 2;
  return (year - 1) * 2 + 1;
}
function semesterRangeFromIndex(idx) {
  const schoolYear = Math.floor(idx / 2);
  const semType = idx - schoolYear * 2;
  if (semType === 0) {
    return { start: `${schoolYear}-08-01`, end: `${schoolYear + 1}-01-31`, label: `Semestre 1 (${schoolYear}-${schoolYear + 1})` };
  }
  const calYear = schoolYear + 1;
  return { start: `${calYear}-02-01`, end: `${calYear}-07-31`, label: `Semestre 2 (${schoolYear}-${schoolYear + 1})` };
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota : sans effet */ }
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    Object.assign(state, saved, {
      timeline: { ...state.timeline, ...(saved.timeline || {}) },
      explorer: { ...state.explorer, ...(saved.explorer || {}) },
      couverture: { ...state.couverture, ...(saved.couverture || {}) },
    });
  } catch { /* état corrompu : on repart des valeurs par défaut */ }
}

/* ----------------------------- Paramètres API ----------------------------- */

function filterParams(extra = {}) {
  const p = new URLSearchParams();
  if (state.start) p.set('start', state.start);
  if (state.end) p.set('end', state.end);
  for (const k of ['ecole', 'niveau', 'classe', 'cours']) if (state[k]) p.set(k, state[k]);
  if (state.tolerance !== '') p.set('tolerance', state.tolerance);
  if (state.excludeOrphans) p.set('excludeOrphans', '1');
  for (const [k, v] of Object.entries(extra)) if (v !== '' && v != null) p.set(k, v);
  return p;
}

/* -------------------------------- Sélecteurs -------------------------------- */

function fillSelect(el, options, { allLabel, value }) {
  const opts = allLabel != null ? [{ value: '', label: allLabel }, ...options] : options;
  el.innerHTML = opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  el.value = opts.some(o => o.value === value) ? value : (allLabel != null ? '' : (opts[0] ? opts[0].value : ''));
}

/* --------------------------------- Rendu --------------------------------- */

function kpiClass(metricGood, value, thresholds) {
  if (value == null || metricGood === 'neutral') return '';
  const [good, warn] = thresholds;
  if (metricGood === 'high') return value >= good ? 'is-good' : value >= warn ? 'is-warn' : 'is-bad';
  return value <= good ? 'is-good' : value <= warn ? 'is-warn' : 'is-bad';
}

function renderKpis(o) {
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const card = (label, value, unit, cls, sub) => `
    <div class="kpi-card ${cls || ''}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${value == null ? '—' : nf.format(value)}<span class="kpi-unit">${escapeHtml(unit || '')}</span></div>
      ${sub ? `<div class="kpi-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;

  $('kpis').innerHTML = [
    card('Taux de présence', o.taux_presence, '%', kpiClass('high', o.taux_presence, [90, 75]), `${nf.format(o.presents)} présences sur ${nf.format(o.pointages)}`),
    card('Taux d’absence', o.taux_absence, '%', kpiClass('low', o.taux_absence, [10, 25]), `${nf.format(o.absences)} absences`),
    card('Taux de retard', o.taux_retard, '%', kpiClass('low', o.taux_retard, [15, 35]), `${nf.format(o.retards)} retards au-delà de ${o.tolerance} min`),
    card('Retard moyen', o.retard_moyen, ' min', kpiClass('low', o.retard_moyen, [15, 25]), 'Parmi les retardataires'),
    card('Expulsions', o.expulsions, '', o.expulsions > 0 ? 'is-warn' : 'is-good', `${nf.format(o.taux_expulsion)} % des pointages`),
    card('Séances', o.seances, '', '', 'Séances distinctes pointées'),
    card('Étudiants suivis', o.effectif, '', '', 'Sur la période filtrée'),
    card('Volume horaire couvert', o.vh_couvert, ' h', '', 'Cumul des séances pointées'),
  ].join('');
}

async function loadOverview() {
  const o = await api.get('/api/stats/overview?' + filterParams());
  dataRange = o.range;
  renderKpis(o);
  const parts = [];
  if (state.start || state.end) parts.push(`${state.start || '…'} → ${state.end || '…'}`);
  else parts.push(`${o.range.start || '?'} → ${o.range.end || '?'} (toutes les données)`);
  for (const k of ['ecole', 'niveau', 'classe', 'cours']) if (state[k]) parts.push(state[k]);
  $('period-label').textContent = parts.join(' · ');
}

async function loadFacets() {
  const f = await api.get('/api/stats/facets?' + filterParams());
  const toOpts = (arr) => arr.map(v => ({ value: v, label: v }));
  fillSelect($('f-ecole'), toOpts(f.ecole), { allLabel: 'Toutes', value: state.ecole });
  fillSelect($('f-niveau'), toOpts(f.niveau), { allLabel: 'Tous', value: state.niveau });
  fillSelect($('f-classe'), toOpts(f.classe), { allLabel: 'Toutes', value: state.classe });
  fillSelect($('f-cours'), toOpts(f.cours), { allLabel: 'Tous', value: state.cours });
  // Une valeur devenue impossible (parce qu'un autre filtre l'exclut) est abandonnée.
  for (const [k, el] of [['ecole', 'f-ecole'], ['niveau', 'f-niveau'], ['classe', 'f-classe'], ['cours', 'f-cours']]) {
    if (state[k] && $(el).value !== state[k]) state[k] = '';
  }
}

async function loadTimeline() {
  const t = state.timeline;
  const res = await api.get('/api/stats/timeseries?' + filterParams({
    metric: t.metric, granularity: t.granularity, split: t.split,
  }));
  const spec = Charts.pivot(res.rows, {
    splitEnabled: Boolean(res.split),
    seriesName: res.metric.label,
  });
  spec.type = t.type;
  spec.unit = res.metric.unit;
  spec.height = 320;
  spec.dimensionLabel = res.granularity === 'date' ? 'Jour' : res.granularity === 'semaine' ? 'Semaine' : 'Mois';
  lastTimelineSpec = spec;
  Charts.render($('chart-timeline'), spec);
}

async function loadExplorer() {
  const e = state.explorer;
  const res = await api.get('/api/stats/analytics?' + filterParams({
    metric: e.metric, dimension: e.dimension, split: e.split,
  }));
  const spec = Charts.pivot(res.rows, {
    splitEnabled: Boolean(res.split),
    seriesName: res.metric.label,
  });

  // Tri appliqué côté client pour rester instantané au changement d'option.
  const totals = new Map(spec.categories.map((c, i) => [c, spec.series.reduce((a, s) => a + (s.values[i] || 0), 0)]));
  const order = [...spec.categories];
  if (e.sort === 'value-desc') order.sort((a, b) => totals.get(b) - totals.get(a));
  else if (e.sort === 'value-asc') order.sort((a, b) => totals.get(a) - totals.get(b));
  else order.sort((a, b) => String(a).localeCompare(String(b), 'fr'));
  const idx = order.map(c => spec.categories.indexOf(c));
  spec.categories = order;
  spec.series = spec.series.map(s => ({ name: s.name, values: idx.map(i => s.values[i]) }));

  spec.type = e.type;
  spec.unit = res.metric.unit;
  spec.height = 340;
  spec.dimensionLabel = res.dimension.label;
  lastExplorerSpec = spec;

  // Un secteur représente une part d'un tout. Additionner des taux calculés sur des
  // effectifs différents ne produit pas un tout : on le signale au lieu de laisser
  // lire un graphique faux.
  const isPart = e.type === 'pie' || e.type === 'donut';
  $('explorer-warning').innerHTML = (isPart && res.metric.unit === '%')
    ? `<div class="chart-warning">Un graphique en secteurs représente la répartition d’un total.
       « ${escapeHtml(res.metric.label)} » est un taux : les parts affichées ne s’additionnent pas
       en un tout interprétable. Préférez un histogramme, ou choisissez un indicateur en effectif
       (présences, absences, retards…).</div>`
    : '';

  Charts.render($('chart-explorer'), spec);
}

async function loadCouverture() {
  const res = await api.get('/api/stats/couverture?' + filterParams({ dimension: state.couverture.dimension }));
  const rows = res.rows.filter(r => r.planifie > 0 || r.couvert > 0);
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  Charts.render($('chart-couverture'), {
    type: 'hbar',
    categories: rows.map(r => r.dim),
    series: [
      { name: 'Couvert', values: rows.map(r => r.couvert) },
      { name: 'Planifié', values: rows.map(r => r.planifie) },
    ],
    unit: ' h',
    // Le taux de couverture est l'information utile ; la somme des deux barres n'aurait aucun sens.
    rowLabel: (ci) => {
      const r = rows[ci];
      const pct = r.planifie > 0 ? Math.round((r.couvert / r.planifie) * 100) : null;
      return `${nf.format(r.couvert)}/${nf.format(r.planifie)} h${pct != null ? ` · ${pct}%` : ''}`;
    },
    emptyMessage: 'Aucun volume horaire à comparer sur cette sélection.',
  });
}

async function loadQuality() {
  const q = await api.get('/api/stats/quality');
  const el = $('quality-list');
  if (!q.issues.length) {
    el.innerHTML = `<p class="page-subtitle" style="margin:0; color:var(--success);">Aucune anomalie détectée sur les ${q.total} lignes de pointage.</p>`;
    return;
  }
  el.innerHTML = q.issues.map(i => `
    <div class="quality-item">
      <div class="quality-count ${i.severity}">${i.count}</div>
      <div class="quality-body">
        <div class="quality-title">${escapeHtml(i.label)}</div>
        <div class="quality-hint">${escapeHtml(i.hint)}</div>
      </div>
      ${i.fixable ? `<button class="btn btn-ghost btn-sm" data-fix="${escapeHtml(i.key)}">Corriger</button>` : ''}
    </div>`).join('');

  el.querySelectorAll('[data-fix]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.fix;
      const item = q.issues.find(i => i.key === key);
      if (!confirm(`« ${item.label} » : ${item.count} élément(s) concerné(s).\n\nCette correction modifie définitivement la base de données. Continuer ?`)) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/stats/quality/fix', { key });
        toast(`Correction appliquée (${r.removed ?? r.updated} élément(s))`, 'success');
        refreshAll();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------ Orchestration ------------------------------ */

let refreshTimer;
function refreshAll() {
  saveState();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await loadFacets();
      await Promise.all([loadOverview(), loadTimeline(), loadExplorer(), loadCouverture(), loadQuality()]);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, 60);
}

function refreshCharts() {
  saveState();
  Promise.all([loadTimeline(), loadExplorer()]).catch(e => toast(e.message, 'error'));
}

/* -------------------------------- Contrôles -------------------------------- */

function bindSelect(id, apply) {
  $(id).addEventListener('change', () => { apply($(id).value); });
}

function setupControls() {
  bindSelect('f-ecole', v => { state.ecole = v; refreshAll(); });
  bindSelect('f-niveau', v => { state.niveau = v; refreshAll(); });
  bindSelect('f-classe', v => { state.classe = v; refreshAll(); });
  bindSelect('f-cours', v => { state.cours = v; refreshAll(); });
  bindSelect('f-tolerance', v => { state.tolerance = v; refreshAll(); });
  $('f-start').addEventListener('change', () => { state.start = $('f-start').value; markPreset(null); refreshAll(); });
  $('f-end').addEventListener('change', () => { state.end = $('f-end').value; markPreset(null); refreshAll(); });
  $('f-exclude-orphans').addEventListener('change', () => {
    state.excludeOrphans = $('f-exclude-orphans').checked;
    refreshAll();
  });

  document.querySelectorAll('[data-preset]').forEach(btn => {
    if (btn.id === 'btn-semester') return; // câblé séparément avec sem-prev/sem-next
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === 'all') { state.start = ''; state.end = ''; }
      else {
        const end = dataRange.end ? new Date(dataRange.end) : new Date();
        const start = new Date(end);
        if (p === '30') start.setDate(start.getDate() - 30);
        else if (p === '90') start.setMonth(start.getMonth() - 3);
        else if (p === 'year') start.setFullYear(start.getFullYear() - 1);
        state.start = start.toISOString().slice(0, 10);
        state.end = end.toISOString().slice(0, 10);
      }
      $('f-start').value = state.start;
      $('f-end').value = state.end;
      markPreset(p);
      refreshAll();
    });
  });

  $('btn-semester').addEventListener('click', () => { ensureSemesterIdx(); applySemester(state.semesterIdx); });
  $('sem-prev').addEventListener('click', () => { ensureSemesterIdx(); applySemester(state.semesterIdx - 1); });
  $('sem-next').addEventListener('click', () => { ensureSemesterIdx(); applySemester(state.semesterIdx + 1); });

  $('btn-reset-filters').addEventListener('click', () => {
    Object.assign(state, { start: '', end: '', ecole: '', niveau: '', classe: '', cours: '', tolerance: '10', excludeOrphans: false });
    syncFilterInputs();
    markPreset('all');
    refreshAll();
  });

  // Chronologie
  bindSelect('t-metric', v => { state.timeline.metric = v; refreshCharts(); });
  bindSelect('t-granularity', v => { state.timeline.granularity = v; refreshCharts(); });
  bindSelect('t-split', v => { state.timeline.split = v; refreshCharts(); });
  bindTypeButtons('t-types', type => { state.timeline.type = type; refreshCharts(); });

  // Explorateur
  bindSelect('e-metric', v => { state.explorer.metric = v; refreshCharts(); });
  bindSelect('e-dimension', v => {
    state.explorer.dimension = v;
    if (state.explorer.split === v) state.explorer.split = '';
    populateExplorerSplit();
    refreshCharts();
  });
  bindSelect('e-split', v => { state.explorer.split = v; refreshCharts(); });
  bindSelect('e-sort', v => { state.explorer.sort = v; refreshCharts(); });
  bindTypeButtons('e-types', type => { state.explorer.type = type; refreshCharts(); });

  bindSelect('c-dimension', v => { state.couverture.dimension = v; saveState(); loadCouverture(); });

  $('btn-export-time').addEventListener('click', () => downloadCsv(lastTimelineSpec, 'chronologie'));
  $('btn-export-explorer').addEventListener('click', () => downloadCsv(lastExplorerSpec, 'explorateur'));
}

/* Sur une page dense en menus déroulants, faire défiler avec le curseur au-dessus d'un
 * <select> en modifie silencieusement la valeur : on croit lire le graphique demandé alors
 * que le filtre a changé. On retire le focus au passage de la molette, ce qui laisse la page
 * défiler normalement sans toucher à la sélection. */
document.addEventListener('wheel', (ev) => {
  const el = ev.target;
  if (el && el.tagName === 'SELECT' && document.activeElement === el) el.blur();
}, true);

function bindTypeButtons(containerId, apply) {
  const container = $(containerId);
  container.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      apply(btn.dataset.type);
    });
  });
}

function markPreset(p) {
  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('active', b.dataset.preset === p));
}

// Semestre par défaut : celui qui contient la donnée la plus récente, pas la date du jour —
// sinon le tableau de bord s'ouvrirait sur un semestre vide si "aujourd'hui" est postérieur
// aux données disponibles.
function ensureSemesterIdx() {
  if (state.semesterIdx == null) {
    const ref = dataRange.end ? new Date(dataRange.end) : new Date();
    state.semesterIdx = semesterIndexForDate(ref);
  }
}
function applySemester(idx) {
  state.semesterIdx = idx;
  const r = semesterRangeFromIndex(idx);
  state.start = r.start;
  state.end = r.end;
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  markPreset('semester');
  updateSemesterLabel();
  refreshAll();
}
function updateSemesterLabel() {
  ensureSemesterIdx();
  $('btn-semester').textContent = semesterRangeFromIndex(state.semesterIdx).label;
}

function syncFilterInputs() {
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  $('f-tolerance').value = state.tolerance;
  $('f-exclude-orphans').checked = state.excludeOrphans;
  $('t-metric').value = state.timeline.metric;
  $('t-granularity').value = state.timeline.granularity;
  $('t-split').value = state.timeline.split;
  $('e-metric').value = state.explorer.metric;
  $('e-dimension').value = state.explorer.dimension;
  $('e-sort').value = state.explorer.sort;
  $('c-dimension').value = state.couverture.dimension;
  for (const [containerId, type] of [['t-types', state.timeline.type], ['e-types', state.explorer.type]]) {
    $(containerId).querySelectorAll('.chart-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  }
}

function populateExplorerSplit() {
  const opts = META.dimensions
    .filter(d => d.key !== state.explorer.dimension)
    .map(d => ({ value: d.key, label: d.label }));
  fillSelect($('e-split'), opts, { allLabel: 'Aucun croisement', value: state.explorer.split });
  state.explorer.split = $('e-split').value;
}

function downloadCsv(spec, name) {
  if (!spec) return toast('Aucune donnée à exporter', 'error');
  const blob = new Blob([Charts.toCsv(spec)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `assidia-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------- Init ---------------------------------- */

(async function init() {
  loadState();
  try {
    META = await api.get('/api/stats/meta');
  } catch (e) {
    return toast('Impossible de charger le tableau de bord : ' + e.message, 'error');
  }
  dataRange = META.range;

  const metricOpts = META.metrics.map(m => ({ value: m.key, label: m.label }));
  fillSelect($('t-metric'), metricOpts, { value: state.timeline.metric });
  fillSelect($('e-metric'), metricOpts, { value: state.explorer.metric });

  const dimOpts = META.dimensions.map(d => ({ value: d.key, label: d.label }));
  fillSelect($('e-dimension'), dimOpts, { value: state.explorer.dimension });
  // Comparer une série temporelle par une autre échelle de temps n'aurait pas de sens.
  const splitOpts = META.dimensions.filter(d => !['date', 'semaine', 'mois'].includes(d.key)).map(d => ({ value: d.key, label: d.label }));
  fillSelect($('t-split'), splitOpts, { allLabel: 'Aucune comparaison', value: state.timeline.split });
  populateExplorerSplit();

  syncFilterInputs();
  updateSemesterLabel();
  if (!state.start && !state.end) markPreset('all');
  else if (state.semesterIdx != null) {
    const r = semesterRangeFromIndex(state.semesterIdx);
    if (state.start === r.start && state.end === r.end) markPreset('semester');
  }
  setupControls();
  refreshAll();
})();
