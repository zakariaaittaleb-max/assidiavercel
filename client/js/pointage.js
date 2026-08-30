function tick() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
tick();
setInterval(tick, 1000);

let currentSession = null;
let pendingExpulsionIds = [];
let finTouched = false;
const rosterSelection = new Set();
function nowIso() { return new Date().toISOString(); }

// ---------- Colonnes personnalisées sur la liste de pointage (mêmes champs que l'onglet Historique) ----------
let rosterCustomFields = [];
let rosterLinkMeta = { targets: [], localKeyFields: [] };
const ROSTER_DEFAULT_LINK_KEYS = {
  'pointage->students': { local: 'student_id', target: 'id' },
  'pointage->courses': { local: 'cours', target: 'cours' },
};
const ROSTER_FORMAT_LABELS = { text: 'Texte', heure: 'Heure', nombre: 'Nombre', date: 'Date' };

async function loadRosterCustomFields() {
  rosterCustomFields = (await api.get('/api/fields?table=pointage')).filter(f => !f.is_builtin);
}
function extraOf(row) { try { return JSON.parse(row.extra || '{}'); } catch { return {}; } }
function extraInputType(format) {
  if (format === 'heure') return 'time';
  if (format === 'nombre') return 'number';
  if (format === 'date') return 'date';
  return 'text';
}
function editableExtraCell(row, key, linked, format) {
  const extra = extraOf(row);
  if (linked) return `<input class="editable-input" value="${escapeHtml(extra[key] || '')}" disabled title="Valeur calculée depuis une autre table">`;
  return `<input type="${extraInputType(format)}" class="editable-input" data-extra="${key}" value="${escapeHtml(extra[key] || '')}">`;
}
// ---------- Colonnes fixes de la liste de pointage (réorganisables par glisser-déposer) ----------
const ROSTER_COLUMN_RENDERERS = {
  etudiant: {
    label: 'Étudiant',
    persisted: p => `<td><div class="roster-name">${escapeHtml(p.nom)} ${escapeHtml(p.prenom)}</div></td>`,
    draft: s => `<td><div class="roster-name">${escapeHtml(s.nom)} ${escapeHtml(s.prenom)} <span class="badge badge-wait">brouillon</span></div></td>`,
  },
  classe: {
    label: 'Classe',
    persisted: p => `<td>${escapeHtml(p.classe || '—')}</td>`,
    draft: s => `<td>${escapeHtml(s.classe || '—')}</td>`,
  },
  debut: {
    label: 'Début',
    persisted: p => `<td><input type="time" class="editable-input mono" data-field="heure_debut" value="${escapeHtml((p.heure_debut || '').slice(0,5))}" style="width:100px;"></td>`,
    draft: () => `<td class="mono">${escapeHtml(elDebut.value)}</td>`,
  },
  fin: {
    label: 'Fin',
    persisted: p => `<td><input type="time" class="editable-input mono" data-field="heure_fin" value="${escapeHtml((p.heure_fin || '').slice(0,5))}" style="width:100px;"></td>`,
    draft: () => `<td class="mono">${escapeHtml(elFin.value)}</td>`,
  },
  presence: {
    label: 'Présence',
    persisted: (p, pending) => {
      const pp = pending && pending.presence;
      if (pp === 'set') return `<td><div class="hstack"><span class="badge badge-wait">⏳ ${escapeHtml(fmtTimeOnly(pending.presenceAt))} (à valider)</span><button class="icon-btn btn-cancel-pending-arrivee" title="Annuler cette marque">✕</button></div></td>`;
      if (pp === 'clear') return `<td><div class="hstack"><span class="badge badge-wait">⏳ Retrait présence (à valider)</span><button class="icon-btn btn-cancel-pending-arrivee" title="Annuler cette marque">✕</button></div></td>`;
      return `<td>${p.heure_arrivee
        ? `<div class="hstack"><span class="badge badge-ok">${fmtTime(p.heure_arrivee)}</span><button class="icon-btn btn-undo-arrivee" title="Annuler">↺</button></div>`
        : `<button class="btn btn-success btn-sm btn-arrivee">✅ Présent</button>`}</td>`;
    },
    draft: () => `<td>—</td>`,
  },
  note: {
    label: 'Note séance',
    persisted: p => `<td>${p.note_assiduite != null ? `<span class="badge ${p.note_assiduite >= 15 ? 'badge-ok' : p.note_assiduite >= 8 ? 'badge-muted' : 'badge-danger'}">${p.note_assiduite}/20</span>` : '—'}</td>`,
    draft: () => `<td>—</td>`,
  },
  moyenne: {
    label: 'Moyenne',
    persisted: p => `<td>${p.moyenne_assiduite != null ? `${p.moyenne_assiduite}/20` : '—'}</td>`,
    draft: () => `<td>—</td>`,
  },
  expulsion: {
    label: 'Expulsion',
    persisted: (p, pending) => {
      const pe = pending && pending.expulsion;
      if (pe === 'clear') return `<td><div class="hstack"><span class="badge badge-wait">⏳ Retrait expulsion (à valider)</span><button class="icon-btn btn-cancel-pending-expulsion" title="Annuler cette marque">✕</button></div></td>`;
      if (pe && typeof pe === 'object') return `<td><div class="hstack" style="max-width:220px;"><span class="badge badge-wait" title="${escapeHtml(pe.raison || '')}">⏳ ${escapeHtml(fmtTimeOnly(pe.at))} (à valider)</span><button class="icon-btn btn-cancel-pending-expulsion" title="Annuler cette marque">✕</button></div></td>`;
      return `<td>${p.heure_expulsion
        ? `<div class="hstack" style="max-width:220px;"><span class="badge badge-danger" title="${escapeHtml(p.raison_expulsion || '')}">${fmtTime(p.heure_expulsion)}</span><span class="page-subtitle" style="font-size:11.5px;">${escapeHtml(p.raison_expulsion || '')}</span><button class="icon-btn btn-undo-expulsion" title="Annuler">↺</button></div>`
        : `<button class="btn btn-danger btn-sm btn-expulser">🚫 Expulser</button>`}</td>`;
    },
    draft: () => `<td>—</td>`,
  },
};

function loadRosterColOrder() {
  try { return JSON.parse(localStorage.getItem('colOrder:roster') || '[]'); } catch { return []; }
}
let rosterColOrder = loadRosterColOrder();
function saveRosterColOrder() { localStorage.setItem('colOrder:roster', JSON.stringify(rosterColOrder)); }

function rosterAllColumnKeys() {
  return [...Object.keys(ROSTER_COLUMN_RENDERERS), ...rosterCustomFields.map(f => 'extra:' + f.field_key)];
}
function rosterColumnKeysOrdered() {
  const all = rosterAllColumnKeys();
  if (!rosterColOrder.length) return all;
  const ordered = rosterColOrder.filter(k => all.includes(k));
  const remaining = all.filter(k => !ordered.includes(k));
  return [...ordered, ...remaining];
}
function rosterColumnLabel(key) {
  if (ROSTER_COLUMN_RENDERERS[key]) return ROSTER_COLUMN_RENDERERS[key].label;
  const f = rosterCustomFields.find(f => 'extra:' + f.field_key === key);
  return f ? f.label : key;
}
function rosterRenderCell(key, row, isDraft) {
  const std = ROSTER_COLUMN_RENDERERS[key];
  if (std) return isDraft ? std.draft(row) : std.persisted(row, pendingEdits.get(String(row.id)));
  const f = rosterCustomFields.find(f => 'extra:' + f.field_key === key);
  if (!f) return '<td>—</td>';
  return isDraft ? '<td>—</td>' : `<td>${editableExtraCell(row, f.field_key, Boolean(f.linked_table), f.format)}</td>`;
}

function renderRosterHeader() {
  const theadRow = document.getElementById('roster-thead-row');
  const keys = rosterColumnKeysOrdered();
  const lastTh = theadRow.lastElementChild; // <th> vide, réservé aux actions, toujours en dernier
  theadRow.querySelectorAll('th[data-col-key]').forEach(th => th.remove());
  keys.forEach(key => {
    const th = document.createElement('th');
    th.dataset.colKey = key;
    th.draggable = true;
    th.textContent = rosterColumnLabel(key);
    theadRow.insertBefore(th, lastTh);
  });
  wireRosterHeaderDrag(theadRow);
}

// Glisser-déposer sur les en-têtes pour réordonner les colonnes (case à cocher et colonne d'actions fixes).
function wireRosterHeaderDrag(theadRow) {
  theadRow.querySelectorAll('th[data-col-key]').forEach(th => {
    th.addEventListener('dragstart', () => th.classList.add('dragging'));
    th.addEventListener('dragend', () => th.classList.remove('dragging'));
    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = theadRow.querySelector('th.dragging');
      if (!dragging || dragging === th) return;
      const rect = th.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      theadRow.insertBefore(dragging, before ? th : th.nextSibling);
    });
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      rosterColOrder = [...theadRow.querySelectorAll('th[data-col-key]')].map(t => t.dataset.colKey);
      saveRosterColOrder();
      renderRoster();
    });
  });
}

const elEcole = document.getElementById('s-ecole');
const elCours = document.getElementById('s-cours');
const elNiveau = document.getElementById('s-niveau');
const elClasse = document.getElementById('s-classe');
const elDate = document.getElementById('s-date');
const elDebut = document.getElementById('s-heure-debut');
const elFin = document.getElementById('s-heure-fin');
const seancePanel = document.getElementById('seance-panel');
const noSeanceState = document.getElementById('no-seance-state');

function pad2(n) { return String(n).padStart(2, '0'); }

function roundedPastHour(d = new Date()) {
  return `${pad2(d.getHours())}:00`;
}

function addHours(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h + hours) % 24;
  return `${pad2(total)}:${pad2(m)}`;
}

function setDefaults() {
  elDate.value = new Date().toISOString().slice(0, 10);
  elDebut.value = roundedPastHour();
  elFin.value = addHours(elDebut.value, 3);
  finTouched = false;
}
setDefaults();

elDebut.addEventListener('change', () => {
  if (!finTouched && elDebut.value) elFin.value = addHours(elDebut.value, 3);
});
elFin.addEventListener('change', () => { finTouched = true; });

// ---------- Réinitialiser le formulaire de session ----------
document.getElementById('btn-reset-session').addEventListener('click', () => {
  elEcole.value = '';
  elCours.value = '';
  elNiveau.value = '';
  elClasse.value = '';
  setDefaults();
  currentSession = null;
  seancePanel.style.display = 'none';
  noSeanceState.style.display = 'block';
  rosterSelection.clear();
  elCours.focus();
  toast('Formulaire réinitialisé', 'success');
});

// ---------- Suggestions en cascade (datalists) ----------
// Chaque filtre (École/Cours/Niveau/Classe) shortliste les options des autres, via la même source
// /api/meta/facets qu'utilisent les tables de la base de données (Cours = source pour École/Cours/Niveau,
// Étudiants = source pour Classe — le pont entre les deux se fait par le Niveau).
async function loadSuggestions() {
  try {
    const params = new URLSearchParams();
    if (elEcole.value.trim()) params.set('ecole', elEcole.value.trim());
    if (elNiveau.value.trim()) params.set('niveau', elNiveau.value.trim());
    if (elCours.value.trim()) params.set('cours', elCours.value.trim());
    if (elClasse.value.trim()) params.set('classe', elClasse.value.trim());
    const s = await api.get('/api/meta/facets?' + params);
    document.getElementById('dl-ecoles').innerHTML = s.ecoles.map(v => `<option value="${escapeHtml(v)}">`).join('');
    document.getElementById('dl-cours').innerHTML = s.cours.map(v => `<option value="${escapeHtml(v)}">`).join('');
    document.getElementById('dl-niveaux').innerHTML = s.niveaux.map(v => `<option value="${escapeHtml(v)}">`).join('');
    document.getElementById('dl-classes').innerHTML = s.classes.map(v => `<option value="${escapeHtml(v)}">`).join('');
  } catch (e) { /* silencieux */ }
}
loadSuggestions();
let suggestTimer;
[elEcole, elNiveau, elCours, elClasse].forEach(el => el.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(loadSuggestions, 200);
}));

// ---------- Open session ----------
document.getElementById('btn-open-session').addEventListener('click', async () => {
  if (!elCours.value.trim()) { toast('Veuillez indiquer le cours', 'error'); elCours.focus(); return; }
  if (!elDate.value) { toast('Veuillez indiquer la date', 'error'); return; }

  currentSession = {
    ecole: elEcole.value.trim(),
    cours: elCours.value.trim(),
    niveau: elNiveau.value.trim(),
    classe: elClasse.value.trim(),
    date: elDate.value,
    heure_debut: elDebut.value,
    heure_fin: elFin.value,
  };
  seancePanel.style.display = 'block';
  noSeanceState.style.display = 'none';
  renderSessionInfo();
  await loadRoster();
  loadSuggestions();
});

function renderSessionInfo() {
  const s = currentSession;
  document.getElementById('info-cours').textContent = s.cours;
  document.getElementById('info-meta').textContent = [s.ecole, s.niveau, s.date, s.heure_debut ? `${s.heure_debut} → ${s.heure_fin || '?'}` : null].filter(Boolean).join(' · ');
}

// Le chargement d'un niveau entier est mis en attente ("brouillon") : rien n'est écrit en base tant
// que l'utilisateur n'a pas cliqué sur "Valider le chargement" (ou "Annuler" pour tout jeter).
let draftRoster = [];

document.getElementById('btn-load-roster').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    const params = new URLSearchParams({
      date: currentSession.date, ecole: currentSession.ecole, cours: currentSession.cours, niveau: currentSession.niveau,
    });
    if (currentSession.classe) params.set('classe', currentSession.classe);
    const candidates = await api.get(`/api/pointage/candidates?${params}`);
    if (!candidates.length) { toast('Aucun étudiant supplémentaire à charger pour ce niveau', 'error'); return; }
    const existingIds = new Set(draftRoster.map(s => s.id));
    draftRoster = [...draftRoster, ...candidates.filter(s => !existingIds.has(s.id))];
    renderRoster();
    toast(`${candidates.length} étudiant(s) en attente de validation`, 'success');
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('btn-valider-chargement').addEventListener('click', async () => {
  if (!draftRoster.length || !currentSession) return;
  try {
    const res = await api.post('/api/pointage/bulk-add', {
      date: currentSession.date, ecole: currentSession.ecole, cours: currentSession.cours, niveau: currentSession.niveau,
      heure_debut: elDebut.value, heure_fin: elFin.value, student_ids: draftRoster.map(s => s.id),
    });
    toast(`${res.inserted} étudiant(s) ajouté(s) à la session`, 'success');
    draftRoster = [];
    await loadRoster();
  } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('btn-annuler-chargement').addEventListener('click', () => {
  draftRoster = [];
  renderRoster();
  toast('Chargement annulé', 'success');
});
function refreshDraftBar() {
  const bar = document.getElementById('draft-bar-roster');
  bar.style.display = draftRoster.length ? 'flex' : 'none';
  document.getElementById('draft-count-roster').textContent = `${draftRoster.length} étudiant(s) chargé(s), en attente de validation`;
}

// ---------- Add student search ----------
const addSearch = document.getElementById('add-student-search');
const addResults = document.getElementById('add-student-results');
let addSearchTimer;
addSearch.addEventListener('input', () => {
  clearTimeout(addSearchTimer);
  addSearchTimer = setTimeout(async () => {
    if (!currentSession || !addSearch.value.trim()) { addResults.innerHTML = ''; return; }
    const params = new URLSearchParams({
      date: currentSession.date, ecole: currentSession.ecole, cours: currentSession.cours,
      niveau: currentSession.niveau, search: addSearch.value
    });
    const rows = await api.get(`/api/pointage/candidates?${params}`);
    renderAddResults(rows);
  }, 200);
});

function renderAddResults(rows) {
  if (!rows.length) {
    addResults.innerHTML = `<div class="card" style="position:absolute; z-index:20; width:100%; padding:10px 14px; color:var(--text-faint); font-size:13px;">Aucun résultat</div>`;
    return;
  }
  addResults.innerHTML = `<div class="card" style="position:absolute; z-index:20; width:100%; max-height:220px; overflow-y:auto;">` +
    rows.map(s => `
      <div class="add-result-row" data-id="${s.id}" style="padding:9px 14px; cursor:pointer; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
        <span>${escapeHtml(s.nom)} ${escapeHtml(s.prenom)}</span>
        <span class="page-subtitle">${escapeHtml(s.classe || '')} ${escapeHtml(s.niveau || '')}</span>
      </div>
    `).join('') + `</div>`;

  addResults.querySelectorAll('.add-result-row').forEach(row => {
    row.addEventListener('click', async () => {
      try {
        await api.post('/api/pointage/add', {
          student_id: row.dataset.id,
          date: currentSession.date, ecole: currentSession.ecole, cours: currentSession.cours,
          niveau: currentSession.niveau, heure_debut: elDebut.value, heure_fin: elFin.value,
        });
        addSearch.value = '';
        addResults.innerHTML = '';
        toast('Étudiant ajouté à la session', 'success');
        await loadRoster();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// ---------- Sélection multiple sur la liste de pointage ----------
function refreshRosterSelectionUI() {
  const bar = document.getElementById('bulk-bar-roster');
  const count = document.getElementById('bulk-count-roster');
  bar.style.display = rosterSelection.size ? 'flex' : 'none';
  count.textContent = `${rosterSelection.size} sélectionné(s)`;
  const selectAll = document.getElementById('select-all-roster');
  const rows = document.querySelectorAll('#body-roster .row-check');
  selectAll.checked = rows.length > 0 && rosterSelection.size === rows.length;
  selectAll.indeterminate = rosterSelection.size > 0 && rosterSelection.size < rows.length;
}
document.getElementById('select-all-roster').addEventListener('change', (e) => {
  const shouldCheck = e.target.checked;
  const checks = document.querySelectorAll('#body-roster .row-check');
  checks.forEach(cb => {
    cb.checked = shouldCheck;
    if (shouldCheck) rosterSelection.add(cb.dataset.id); else rosterSelection.delete(cb.dataset.id);
  });
  refreshRosterSelectionUI();
});
document.getElementById('bulk-clear-roster').addEventListener('click', () => {
  rosterSelection.clear();
  document.querySelectorAll('#body-roster .row-check').forEach(cb => { cb.checked = false; });
  refreshRosterSelectionUI();
});
document.getElementById('bulk-present-roster').addEventListener('click', () => {
  if (!rosterSelection.size) return;
  const ids = [...rosterSelection];
  const at = nowIso();
  ids.forEach(id => { const e = pendingEdits.get(id) || {}; e.presence = 'set'; e.presenceAt = at; pendingEdits.set(id, e); });
  renderRoster();
  toast(`${ids.length} présence(s) en attente de validation`, 'success');
});
document.getElementById('bulk-remove-roster').addEventListener('click', () => {
  if (!rosterSelection.size) return;
  const ids = [...rosterSelection];
  ids.forEach(id => { const e = pendingEdits.get(id) || {}; e.remove = true; pendingEdits.set(id, e); });
  renderRoster();
  toast(`${ids.length} retrait(s) en attente de validation`, 'success');
});
document.getElementById('bulk-expel-roster').addEventListener('click', () => {
  if (!rosterSelection.size) return;
  openExpulsionModal([...rosterSelection], `${rosterSelection.size} étudiant(s) sélectionné(s)`);
});

// ---------- Roster ----------
let persistedRoster = [];

async function loadRoster() {
  if (!currentSession) return;
  const params = new URLSearchParams({ date: currentSession.date, ecole: currentSession.ecole, cours: currentSession.cours });
  persistedRoster = await api.get('/api/pointage?' + params);
  renderRoster();
}

function renderRoster() {
  const body = document.getElementById('body-roster');
  const empty = document.getElementById('empty-roster');
  empty.style.display = (persistedRoster.length || draftRoster.length) ? 'none' : 'block';
  rosterSelection.clear();
  refreshDraftBar();
  refreshModifsBar();

  const arrivedCount = persistedRoster.filter(r => r.heure_arrivee).length;
  document.getElementById('count-arrived').textContent = arrivedCount + ' présents';
  document.getElementById('count-expelled').textContent = persistedRoster.filter(r => r.heure_expulsion).length + ' expulsés';
  document.getElementById('count-absent').textContent = (persistedRoster.length - arrivedCount) + ' absents';
  document.getElementById('count-total').textContent = 'Total : ' + persistedRoster.length;

  renderRosterHeader();
  const colKeys = rosterColumnKeysOrdered();

  const draftHtml = draftRoster.map(s => `
    <tr class="roster-draft-row">
      <td class="checkbox-cell">—</td>
      ${colKeys.map(k => rosterRenderCell(k, s, true)).join('')}
      <td><button class="icon-btn btn-remove-draft" data-id="${s.id}" title="Retirer du brouillon">✕</button></td>
    </tr>
  `).join('');

  const persistedHtml = persistedRoster.map(p => {
    const pending = pendingEdits.get(String(p.id));
    const rowClass = pending ? 'row-modified' : '';
    const removeCell = pending && pending.remove
      ? `<td><div class="hstack"><span class="badge badge-wait" style="font-size:10px;">à retirer</span><button class="icon-btn btn-cancel-pending-remove" title="Annuler le retrait">↺</button></div></td>`
      : `<td><button class="icon-btn btn-remove" title="Retirer de la session">✕</button></td>`;
    return `
    <tr data-id="${p.id}" class="${rowClass}">
      <td class="checkbox-cell"><input type="checkbox" class="row-check" data-id="${p.id}"></td>
      ${colKeys.map(k => rosterRenderCell(k, p, false)).join('')}
      ${removeCell}
    </tr>
  `;
  }).join('');

  body.innerHTML = draftHtml + persistedHtml;

  body.querySelectorAll('.btn-remove-draft').forEach(btn => {
    btn.addEventListener('click', () => {
      draftRoster = draftRoster.filter(s => String(s.id) !== btn.dataset.id);
      renderRoster();
    });
  });

  body.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) rosterSelection.add(cb.dataset.id); else rosterSelection.delete(cb.dataset.id);
      refreshRosterSelectionUI();
    });
  });
  refreshRosterSelectionUI();

  // Toute action ci-dessous ne fait que MARQUER une modification en attente (pendingEdits) —
  // rien n'est écrit dans l'historique de pointage avant le clic sur "Valider les modifications".
  body.querySelectorAll('.btn-arrivee').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      const at = nowIso();
      stagePending(id, e => { e.presence = 'set'; e.presenceAt = at; });
    });
  });
  body.querySelectorAll('.btn-undo-arrivee').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { e.presence = 'clear'; });
    });
  });
  body.querySelectorAll('.btn-cancel-pending-arrivee').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { delete e.presence; });
    });
  });
  body.querySelectorAll('.btn-undo-expulsion').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { e.expulsion = 'clear'; });
    });
  });
  body.querySelectorAll('.btn-cancel-pending-expulsion').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { delete e.expulsion; });
    });
  });
  body.querySelectorAll('.btn-expulser').forEach(btn => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      openExpulsionModal([tr.dataset.id], tr.querySelector('.roster-name').textContent);
    });
  });
  body.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { e.remove = true; });
    });
  });
  body.querySelectorAll('.btn-cancel-pending-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      stagePending(id, e => { delete e.remove; });
    });
  });
  body.querySelectorAll('.editable-input').forEach(inp => {
    if (inp.disabled) return; // champ calculé (lié)
    inp.addEventListener('input', () => {
      const id = inp.closest('tr').dataset.id;
      if (!id) return;
      const entry = pendingEdits.get(id) || {};
      if (inp.dataset.extra !== undefined) {
        entry.extra = entry.extra || {};
        entry.extra[inp.dataset.extra] = inp.value;
      } else {
        entry.fields = entry.fields || {};
        entry.fields[inp.dataset.field] = inp.value;
      }
      pendingEdits.set(id, entry);
      inp.closest('tr').classList.add('row-modified');
      refreshModifsBar();
    });
  });
}

// ---------- Édition en différé : AUCUNE modification (champs, présence, expulsion, retrait) ne
// s'enregistre dans l'historique de pointage avant le clic sur "Valider les modifications". ----------
// id -> { fields?: {champ: valeur}, extra?: {clé: valeur}, presence?: 'set'|'clear', expulsion?: 'clear'|{raison}, remove?: true }
const pendingEdits = new Map();

// Applique `mutator` à l'entrée en attente de `id` (la crée si besoin), la retire si elle redevient vide.
function stagePending(id, mutator) {
  const entry = pendingEdits.get(id) || {};
  mutator(entry);
  if (Object.keys(entry).length) pendingEdits.set(id, entry);
  else pendingEdits.delete(id);
  renderRoster();
}

function refreshModifsBar() {
  const has = pendingEdits.size > 0;
  document.getElementById('btn-valider-modifs').disabled = !has;
  document.getElementById('btn-annuler-modifs').disabled = !has;
}

document.getElementById('btn-valider-modifs').addEventListener('click', async () => {
  if (!pendingEdits.size) return;
  const entries = [...pendingEdits.entries()];
  try {
    for (const [id, entry] of entries) {
      if (entry.remove) { await api.del(`/api/pointage/${id}`); continue; }
      if (entry.fields) await api.patch(`/api/pointage/${id}`, entry.fields);
      if (entry.extra) {
        for (const [key, value] of Object.entries(entry.extra)) {
          await api.patch(`/api/pointage/${id}/extra`, { key, value });
        }
      }
      if (entry.presence === 'set') await api.post(`/api/pointage/${id}/arrivee`, { heure_arrivee: entry.presenceAt });
      else if (entry.presence === 'clear') await api.post(`/api/pointage/${id}/arrivee/annuler`, {});
      if (entry.expulsion === 'clear') await api.post(`/api/pointage/${id}/expulser/annuler`, {});
      else if (entry.expulsion && typeof entry.expulsion === 'object') await api.post(`/api/pointage/${id}/expulser`, { raison: entry.expulsion.raison, heure_expulsion: entry.expulsion.at });
    }
    toast(`${entries.length} ligne(s) mise(s) à jour`, 'success');
    pendingEdits.clear();
    await loadRoster();
  } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('btn-annuler-modifs').addEventListener('click', () => {
  pendingEdits.clear();
  renderRoster();
  toast('Modifications annulées', 'success');
});

// ---------- Expulsion modal (une ligne ou une sélection multiple) ----------
function openExpulsionModal(ids, label) {
  pendingExpulsionIds = ids;
  document.getElementById('modal-student-name').textContent = label;
  document.getElementById('modal-reason').value = '';
  document.getElementById('modal-expulsion').style.display = 'flex';
  document.getElementById('modal-reason').focus();
}
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-expulsion').addEventListener('click', (e) => {
  if (e.target.id === 'modal-expulsion') closeModal();
});
function closeModal() {
  document.getElementById('modal-expulsion').style.display = 'none';
  pendingExpulsionIds = [];
}

document.getElementById('modal-confirm').addEventListener('click', () => {
  const reason = document.getElementById('modal-reason').value.trim();
  if (!reason) { toast('Veuillez préciser une raison', 'error'); return; }
  const at = nowIso();
  pendingExpulsionIds.forEach(id => { const e = pendingEdits.get(id) || {}; e.expulsion = { raison: reason, at }; pendingEdits.set(id, e); });
  toast(`Expulsion en attente de validation (${pendingExpulsionIds.length})`, 'success');
  closeModal();
  renderRoster();
});

// ---------- Édition en masse de la sélection ----------
const ROSTER_BULK_FIELDS = [
  { value: 'classe', label: 'Classe' },
  { value: 'ecole', label: 'École' },
  { value: 'niveau', label: 'Niveau' },
  { value: 'heure_debut', label: 'Heure de début' },
  { value: 'heure_fin', label: 'Heure de fin' },
];
document.getElementById('bulk-edit-roster').addEventListener('click', () => {
  if (!rosterSelection.size) return;
  document.getElementById('bulk-edit-count').textContent = `${rosterSelection.size} élément(s) sélectionné(s)`;
  document.getElementById('bulk-edit-field').innerHTML = ROSTER_BULK_FIELDS.map(f => `<option value="${f.value}">${f.label}</option>`).join('');
  document.getElementById('bulk-edit-value').value = '';
  document.getElementById('modal-bulk-edit').style.display = 'flex';
});
document.getElementById('bulk-edit-cancel').addEventListener('click', () => {
  document.getElementById('modal-bulk-edit').style.display = 'none';
});
document.getElementById('modal-bulk-edit').addEventListener('click', (e) => {
  if (e.target.id === 'modal-bulk-edit') document.getElementById('modal-bulk-edit').style.display = 'none';
});
document.getElementById('bulk-edit-confirm').addEventListener('click', () => {
  if (!rosterSelection.size) return;
  const field = document.getElementById('bulk-edit-field').value;
  const value = document.getElementById('bulk-edit-value').value;
  const ids = [...rosterSelection];
  ids.forEach(id => {
    const e = pendingEdits.get(id) || {};
    e.fields = e.fields || {};
    e.fields[field] = value;
    pendingEdits.set(id, e);
  });
  toast(`Modification en attente sur ${ids.length} ligne(s)`, 'success');
  document.getElementById('modal-bulk-edit').style.display = 'none';
  renderRoster();
});

// ---------- Modal gestion des colonnes (champs personnalisés de la table pointage) ----------
document.getElementById('btn-columns-roster').addEventListener('click', openRosterColumnsModal);

async function openRosterColumnsModal() {
  await Promise.all([loadRosterCustomFields(), loadRosterLinkMeta()]);
  renderRosterColumnsList();
  document.getElementById('add-field-label').value = '';
  document.getElementById('add-field-format').value = 'text';
  document.getElementById('link-field-toggle').checked = false;
  document.getElementById('link-field-selects').style.display = 'none';
  document.getElementById('link-field-key-selects').style.display = 'none';
  document.getElementById('modal-columns').style.display = 'flex';
}

async function loadRosterLinkMeta() {
  rosterLinkMeta = await api.get('/api/fields/linkable?table=pointage');
  const row = document.getElementById('link-field-row');
  row.style.display = rosterLinkMeta.targets.length ? 'block' : 'none';
  const tableSelect = document.getElementById('link-field-table');
  tableSelect.innerHTML = rosterLinkMeta.targets.map(t => `<option value="${t.table}">${escapeHtml(t.label)}</option>`).join('');
  const localKeySelect = document.getElementById('link-field-local-key');
  localKeySelect.innerHTML = rosterLinkMeta.localKeyFields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('');
  fillRosterLinkFieldOptions();
}
function fillRosterLinkFieldOptions() {
  const tableSelect = document.getElementById('link-field-table');
  const fieldSelect = document.getElementById('link-field-field');
  const targetKeySelect = document.getElementById('link-field-target-key');
  const target = rosterLinkMeta.targets.find(t => t.table === tableSelect.value) || rosterLinkMeta.targets[0];
  fieldSelect.innerHTML = target ? target.fields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('') : '';
  targetKeySelect.innerHTML = target ? target.keyFields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('') : '';
  const localKeySelect = document.getElementById('link-field-local-key');
  const defaults = ROSTER_DEFAULT_LINK_KEYS[`pointage->${target ? target.table : ''}`];
  if (defaults) { localKeySelect.value = defaults.local; targetKeySelect.value = defaults.target; }
}
document.getElementById('link-field-toggle').addEventListener('change', (e) => {
  document.getElementById('link-field-selects').style.display = e.target.checked ? 'flex' : 'none';
  document.getElementById('link-field-key-selects').style.display = e.target.checked ? 'flex' : 'none';
});
document.getElementById('link-field-table').addEventListener('change', fillRosterLinkFieldOptions);

function renderRosterColumnsList() {
  const list = document.getElementById('columns-list');
  if (!rosterCustomFields.length) {
    list.innerHTML = `<p class="page-subtitle" style="margin:8px 4px;">Aucune colonne personnalisée pour l'instant — ajoutez-en une ci-dessous.</p>`;
    return;
  }
  list.innerHTML = rosterCustomFields.map(f => `
    <div class="column-row" data-key="extra:${f.field_key}">
      <label style="flex:1;">${escapeHtml(f.label)}</label>
      ${f.linked_table ? `<span class="badge badge-muted" title="Calculée depuis ${escapeHtml(f.linked_table)}.${escapeHtml(f.linked_field)}">liée</span>` : ''}
      <span class="badge badge-muted">${ROSTER_FORMAT_LABELS[f.format] || 'Texte'}</span>
      <div class="col-actions">
        <button class="icon-btn col-link" data-id="${f.id}" title="Lier / modifier la liaison">🔗</button>
        <button class="icon-btn btn-del-field" data-id="${f.id}" title="Supprimer cette colonne">✕</button>
      </div>
    </div>
    <div class="col-link-editor" id="link-editor-extra-${f.id}" style="display:none;"></div>
  `).join('');
  list.querySelectorAll('.col-link').forEach(btn => btn.addEventListener('click', () => toggleRosterLinkEditor(btn.dataset.id)));
  list.querySelectorAll('.btn-del-field').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer définitivement ce champ personnalisé ?')) return;
      try {
        await api.del(`/api/fields/${btn.dataset.id}`);
        await loadRosterCustomFields();
        renderRosterColumnsList();
        renderRosterHeader();
        renderRoster();
        toast('Champ retiré', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function toggleRosterLinkEditor(defId) {
  const field = rosterCustomFields.find(f => f.id == defId);
  if (!field) return;
  const id = 'link-editor-extra-' + defId;
  const el = document.getElementById(id);
  if (!el) return;
  document.querySelectorAll('.col-link-editor').forEach(e => { if (e.id !== id) e.style.display = 'none'; });
  if (el.style.display === 'block') { el.style.display = 'none'; return; }

  const tableOptions = rosterLinkMeta.targets.map(t =>
    `<option value="${t.table}" ${t.table === field.linked_table ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
  ).join('');
  el.innerHTML = `
    <label class="hint" style="margin:0 0 4px;">Format</label>
    <select class="le-format" style="margin-bottom:8px; width:100%;">
      ${Object.entries(ROSTER_FORMAT_LABELS).map(([v, l]) => `<option value="${v}" ${(field.format || 'text') === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <label class="hint" style="margin:0 0 4px;">Lier à une autre table (VLOOKUP)</label>
    <div class="link-field-selects" style="margin:0 0 8px;">
      <select class="le-table">${tableOptions}</select>
      <select class="le-field"></select>
    </div>
    <label class="hint" style="margin:0 0 4px;">Clé de connexion</label>
    <div class="link-field-selects" style="margin:0 0 8px;">
      <select class="le-local-key"></select>
      <span class="hint" style="margin:0 6px; align-self:center;">=</span>
      <select class="le-target-key"></select>
    </div>
    <div class="hstack" style="gap:8px;">
      <button class="btn btn-ghost btn-sm le-clear" type="button">Retirer la liaison</button>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm le-save" type="button">Enregistrer</button>
    </div>
  `;
  const tableSel = el.querySelector('.le-table');
  const fieldSel = el.querySelector('.le-field');
  const localKeySel = el.querySelector('.le-local-key');
  const targetKeySel = el.querySelector('.le-target-key');
  localKeySel.innerHTML = rosterLinkMeta.localKeyFields.map(f => `<option value="${f.key}" ${field.link_local_key === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
  function fillFields() {
    const target = rosterLinkMeta.targets.find(t => t.table === tableSel.value) || rosterLinkMeta.targets[0];
    fieldSel.innerHTML = target ? target.fields.map(f =>
      `<option value="${f.key}" ${target.table === field.linked_table && f.key === field.linked_field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`
    ).join('') : '';
    targetKeySel.innerHTML = target ? target.keyFields.map(f =>
      `<option value="${f.key}" ${field.link_target_key === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`
    ).join('') : '';
    if (target && !field.link_local_key) {
      const defaults = ROSTER_DEFAULT_LINK_KEYS[`pointage->${target.table}`];
      if (defaults) { localKeySel.value = defaults.local; targetKeySel.value = defaults.target; }
    }
  }
  fillFields();
  tableSel.addEventListener('change', fillFields);
  el.querySelector('.le-save').addEventListener('click', async () => {
    try {
      await api.patch(`/api/fields/${defId}`, {
        linked_table: tableSel.value, linked_field: fieldSel.value,
        link_local_key: localKeySel.value, link_target_key: targetKeySel.value,
        format: el.querySelector('.le-format').value,
      });
      await loadRosterCustomFields();
      renderRosterColumnsList();
      renderRoster();
      toast('Liaison mise à jour', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('.le-clear').addEventListener('click', async () => {
    try {
      await api.patch(`/api/fields/${defId}`, { linked_table: '' });
      await loadRosterCustomFields();
      renderRosterColumnsList();
      renderRoster();
      toast('Liaison retirée', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  el.style.display = 'block';
}

document.getElementById('add-field-confirm').addEventListener('click', async () => {
  const input = document.getElementById('add-field-label');
  const label = input.value.trim();
  if (!label) return;
  const body = { table: 'pointage', label, format: document.getElementById('add-field-format').value };
  if (document.getElementById('link-field-toggle').checked) {
    body.linked_table = document.getElementById('link-field-table').value;
    body.linked_field = document.getElementById('link-field-field').value;
    body.link_local_key = document.getElementById('link-field-local-key').value;
    body.link_target_key = document.getElementById('link-field-target-key').value;
  }
  try {
    await api.post('/api/fields', body);
    input.value = '';
    document.getElementById('add-field-format').value = 'text';
    document.getElementById('link-field-toggle').checked = false;
    document.getElementById('link-field-selects').style.display = 'none';
    document.getElementById('link-field-key-selects').style.display = 'none';
    await loadRosterCustomFields();
    renderRosterColumnsList();
    renderRosterHeader();
    renderRoster();
    toast('Champ ajouté', 'success');
  } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('columns-done').addEventListener('click', () => {
  document.getElementById('modal-columns').style.display = 'none';
});
document.getElementById('modal-columns').addEventListener('click', (e) => {
  if (e.target.id === 'modal-columns') document.getElementById('modal-columns').style.display = 'none';
});

loadRosterCustomFields().then(renderRosterHeader);
