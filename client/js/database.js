function tick() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
tick();
setInterval(tick, 1000);

const API_BASE = { etudiants: '/api/students', cours: '/api/courses', pointage: '/api/pointage' };
const SQL_TABLE = { etudiants: 'students', cours: 'courses', pointage: 'pointage' };
const THEAD_ID = { etudiants: 'thead-etudiants', cours: 'thead-cours', pointage: 'thead-pointage' };
const TBODY_ID = { etudiants: 'body-etudiants', cours: 'body-cours', pointage: 'body-pointage' };

// ---------- Colonnes (fixes + personnalisées) ----------
function editableCell(row, field, width) {
  return `<input class="editable-input" data-field="${field}" value="${escapeHtml(row[field] || '')}"${width ? ` style="width:${width}"` : ''}>`;
}
// Champ "HH:MM" natif (heure_debut / heure_fin) : déjà stocké en texte simple, pas de reconstruction nécessaire.
function editableTimeOnlyCell(row, field, width) {
  return `<input type="time" class="editable-input mono" data-field="${field}" value="${escapeHtml((row[field] || '').slice(0, 5))}"${width ? ` style="width:${width}"` : ''}>`;
}
// Champ horodatage complet (heure_arrivee / heure_expulsion) : affiché en HH:MM, reconstruit en ISO
// à la sauvegarde à partir de la date de la ligne (voir renderRowsGeneric).
function editableTimeIsoCell(row, field, width) {
  return `<input type="time" class="editable-input mono" data-timefield="${field}" data-date="${escapeHtml(row.date || '')}" value="${escapeHtml(fmtTimeOnly24(row[field]))}"${width ? ` style="width:${width}"` : ''}>`;
}
function fmtTimeOnly24(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function extraOf(row) {
  try { return JSON.parse(row.extra || '{}'); } catch { return {}; }
}
function extraInputType(format) {
  if (format === 'heure') return 'time';
  if (format === 'nombre') return 'number';
  if (format === 'date') return 'date';
  return 'text';
}
function editableExtraCell(row, key, linked, format) {
  const extra = extraOf(row);
  if (linked) {
    return `<input class="editable-input" value="${escapeHtml(extra[key] || '')}" disabled title="Valeur calculée depuis une autre table">`;
  }
  return `<input type="${extraInputType(format)}" class="editable-input" data-extra="${key}" value="${escapeHtml(extra[key] || '')}">`;
}
// Identifiant (id interne ou clé étrangère) : affiché en lecture seule, exploitable comme clé de
// jointure pour lier les tables entre elles via une colonne personnalisée liée (VLOOKUP).
function idCell(row, key) {
  const v = row[key];
  return `<span class="mono" style="color:var(--text-dim); font-size:12px;">${v != null ? escapeHtml(String(v)) : '—'}</span>`;
}

const FIXED_COLUMNS = {
  etudiants: [
    { key: 'id', label: 'ID', sortable: true, protected: true, render: r => idCell(r, 'id') },
    { key: 'nom', label: 'Nom', sortable: true, render: r => editableCell(r, 'nom') },
    { key: 'prenom', label: 'Prénom', sortable: true, render: r => editableCell(r, 'prenom') },
    { key: 'classe', label: 'Classe', sortable: true, render: r => editableCell(r, 'classe') },
    { key: 'niveau', label: 'Niveau', sortable: true, render: r => editableCell(r, 'niveau') },
    { key: 'ecole', label: 'École', sortable: true, render: r => editableCell(r, 'ecole') },
  ],
  cours: [
    { key: 'id', label: 'ID', sortable: true, protected: true, render: r => idCell(r, 'id') },
    { key: 'ecole', label: 'Ecole', sortable: true, render: r => editableCell(r, 'ecole') },
    { key: 'cours', label: 'Cours', sortable: true, render: r => editableCell(r, 'cours') },
    { key: 'niveau', label: 'Niveau', sortable: true, render: r => editableCell(r, 'niveau') },
    { key: 'vh', label: 'VH', sortable: true, render: r => editableCell(r, 'vh') },
    { key: 'nb_seances', label: 'Nb séances', sortable: true, render: r => editableCell(r, 'nb_seances') },
  ],
  // Alignées sur la feuille "Pointage" du modèle Excel : Nom, Prénom, Date, Ecole, Cours,
  // Heure de début, Heure de fin, Heure de présence, Heure d'expulsion, Raison d'expulsion.
  // (Classe/Niveau retirées : redondantes avec les fiches Étudiant/Cours liées par ID.)
  pointage: [
    { key: 'id', label: 'ID', sortable: true, protected: true, render: r => idCell(r, 'id') },
    { key: 'student_id', label: 'ID Étudiant', sortable: true, protected: true, render: r => idCell(r, 'student_id') },
    { key: 'cours_id', label: 'ID Cours', sortable: true, protected: true, render: r => idCell(r, 'cours_id') },
    { key: 'nom', label: 'Nom', sortable: true, render: r => editableCell(r, 'nom') },
    { key: 'prenom', label: 'Prénom', sortable: true, render: r => editableCell(r, 'prenom') },
    { key: 'date', label: 'Date', sortable: true, render: r => editableCell(r, 'date', '110px') },
    { key: 'ecole', label: 'Ecole', sortable: true, render: r => editableCell(r, 'ecole') },
    { key: 'cours', label: 'Cours', sortable: true, render: r => editableCell(r, 'cours') },
    { key: 'heure_debut', label: 'Heure de début', sortable: true, render: r => editableTimeOnlyCell(r, 'heure_debut', '110px') },
    { key: 'heure_fin', label: 'Heure de fin', sortable: true, render: r => editableTimeOnlyCell(r, 'heure_fin', '110px') },
    { key: 'heure_arrivee', label: 'Heure de présence', sortable: true, render: r => editableTimeIsoCell(r, 'heure_arrivee', '110px') },
    { key: 'heure_expulsion', label: "Heure d'expulsion", sortable: true, render: r => editableTimeIsoCell(r, 'heure_expulsion', '110px') },
    { key: 'raison_expulsion', label: "Raison d'expulsion", sortable: false, render: r => editableCell(r, 'raison_expulsion') },
    { key: 'minutes_ratees', label: 'Minutes ratées', sortable: false, computed: true, render: r => r.minutes_ratees != null ? String(r.minutes_ratees) : '—' },
    { key: 'note_assiduite', label: 'Note de séance', sortable: false, computed: true, render: r => r.note_assiduite != null ? `<span class="badge ${r.note_assiduite >= 15 ? 'badge-ok' : r.note_assiduite >= 8 ? 'badge-muted' : 'badge-danger'}">${r.note_assiduite}/20</span>` : '—' },
    { key: 'moyenne_assiduite', label: "Moyenne d'assiduité", sortable: false, computed: true, render: r => r.moyenne_assiduite != null ? `${r.moyenne_assiduite}/20` : '—' },
  ],
};

const customFields = { etudiants: [], cours: [], pointage: [] };
// Liaisons "VLOOKUP" configurées sur des colonnes NATIVES existantes (field_key -> field_defs row).
const builtinLinks = { etudiants: {}, cours: {}, pointage: {} };

function loadHiddenCols(table) {
  try { return new Set(JSON.parse(localStorage.getItem('hiddenCols:' + table) || '[]')); } catch { return new Set(); }
}
const hiddenColumns = { etudiants: loadHiddenCols('etudiants'), cours: loadHiddenCols('cours'), pointage: loadHiddenCols('pointage') };
function saveHiddenCols(table) {
  localStorage.setItem('hiddenCols:' + table, JSON.stringify([...hiddenColumns[table]]));
}

// Renommage des colonnes natives (les colonnes personnalisées sont renommées côté serveur via field_defs).
function loadColLabels(table) {
  try { return JSON.parse(localStorage.getItem('colLabels:' + table) || '{}'); } catch { return {}; }
}
const colLabels = { etudiants: loadColLabels('etudiants'), cours: loadColLabels('cours'), pointage: loadColLabels('pointage') };
function saveColLabels(table) {
  localStorage.setItem('colLabels:' + table, JSON.stringify(colLabels[table]));
}

// Ordre d'affichage des colonnes (déplacer avec ↑/↓ dans la fenêtre Colonnes).
function loadColOrder(table) {
  try { return JSON.parse(localStorage.getItem('colOrder:' + table) || '[]'); } catch { return []; }
}
const colOrder = { etudiants: loadColOrder('etudiants'), cours: loadColOrder('cours'), pointage: loadColOrder('pointage') };
function saveColOrder(table) {
  localStorage.setItem('colOrder:' + table, JSON.stringify(colOrder[table]));
}
function orderColumns(table, cols) {
  const order = colOrder[table];
  if (!order.length) return cols;
  const byKey = new Map(cols.map(c => [c.key, c]));
  const ordered = order.map(k => byKey.get(k)).filter(Boolean);
  const remaining = cols.filter(c => !order.includes(c.key));
  return [...ordered, ...remaining];
}
function safeId(key) { return key.replace(/[^a-zA-Z0-9_-]/g, '_'); }

// Réordonnancement manuel des lignes (glisser-déposer), seulement pour les tables non paginées.
const DRAGGABLE_TABLES = new Set(['etudiants', 'cours']);
function loadRowOrder(table) {
  try { return JSON.parse(localStorage.getItem('rowOrder:' + table) || '[]'); } catch { return []; }
}
const rowOrder = { etudiants: loadRowOrder('etudiants'), cours: loadRowOrder('cours') };
function saveRowOrder(table) {
  localStorage.setItem('rowOrder:' + table, JSON.stringify(rowOrder[table]));
}
function applyRowOrder(table, rows) {
  const order = rowOrder[table];
  if (!order || !order.length) return rows;
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const ordered = order.map(id => byId.get(String(id))).filter(Boolean);
  const remaining = rows.filter(r => !order.includes(String(r.id)));
  return [...ordered, ...remaining];
}

function allColumns(table) {
  const customCols = customFields[table].map(f => ({
    key: 'extra:' + f.field_key, label: f.label, sortable: false, custom: true, defId: f.id, format: f.format || 'text',
    linked: Boolean(f.linked_table), linkedTable: f.linked_table, linkedField: f.linked_field,
    render: r => editableExtraCell(r, f.field_key, Boolean(f.linked_table), f.format),
  }));
  const base = [...FIXED_COLUMNS[table], ...customCols]
    .filter(c => c.custom || c.computed || !liveSchema[table] || liveSchema[table].includes(c.key))
    .map(c => {
    const label = (!c.custom && colLabels[table][c.key]) ? colLabels[table][c.key] : c.label;
    // Une colonne native liée à une autre table (VLOOKUP) devient calculée / lecture seule.
    const link = !c.custom ? builtinLinks[table][c.key] : null;
    if (link) {
      return {
        ...c, label, linked: true, linkedTable: link.linked_table, linkedField: link.linked_field, defId: link.id,
        render: r => `<input class="editable-input" value="${escapeHtml(r[c.key] ?? '')}" disabled title="Valeur calculée depuis ${escapeHtml(link.linked_table)}.${escapeHtml(link.linked_field)}">`,
      };
    }
    return { ...c, label };
  });
  return orderColumns(table, base);
}
function visibleColumns(table) {
  return allColumns(table).filter(c => !hiddenColumns[table].has(c.key));
}

async function loadCustomFields(table) {
  const all = await api.get(`/api/fields?table=${SQL_TABLE[table]}`);
  customFields[table] = all.filter(f => !f.is_builtin);
  builtinLinks[table] = Object.fromEntries(all.filter(f => f.is_builtin).map(f => [f.field_key, f]));
}

function renderHeader(table, onSort) {
  const cols = visibleColumns(table);
  const thead = document.getElementById(THEAD_ID[table]);
  const drag = DRAGGABLE_TABLES.has(table);
  thead.innerHTML = `<tr>
    ${drag ? '<th style="width:26px;"></th>' : ''}
    <th style="width:36px;"><input type="checkbox" id="select-all-${table}"></th>
    ${cols.map(c => c.sortable
      ? `<th class="sortable" data-sort="${c.key}" data-col-key="${c.key}" draggable="true">${c.label}</th>`
      : `<th data-col-key="${c.key}" draggable="true">${c.label}</th>`).join('')}
    <th></th>
  </tr>`;
  wireSelectAll(table);
  wireSortableHeaders(THEAD_ID[table], table, onSort);
  wireColumnHeaderDrag(table, thead);
}

// Glisser-déposer sur les en-têtes pour réordonner les colonnes (mêmes mécanique que la liste de pointage live).
function wireColumnHeaderDrag(table, thead) {
  const row = thead.querySelector('tr');
  row.querySelectorAll('th[data-col-key]').forEach(th => {
    th.addEventListener('dragstart', () => th.classList.add('dragging'));
    th.addEventListener('dragend', () => th.classList.remove('dragging'));
    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = row.querySelector('th.dragging');
      if (!dragging || dragging === th) return;
      const rect = th.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      row.insertBefore(dragging, before ? th : th.nextSibling);
    });
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      colOrder[table] = [...row.querySelectorAll('th[data-col-key]')].map(t => t.dataset.colKey);
      saveColOrder(table);
      renderTable(table);
    });
  });
}

function renderRowsGeneric(table, rows) {
  const cols = visibleColumns(table);
  const drag = DRAGGABLE_TABLES.has(table);
  const body = document.getElementById(TBODY_ID[table]);
  body.innerHTML = rows.map(r => `
    <tr data-id="${r.id}"${drag ? ' draggable="true"' : ''}>
      ${drag ? `<td class="drag-handle-cell"><span class="drag-handle" title="Glisser pour réordonner">⠿</span></td>` : ''}
      <td class="checkbox-cell"><input type="checkbox" class="row-check" data-id="${r.id}"></td>
      ${cols.map(c => `<td>${c.render(r)}</td>`).join('')}
      <td><button class="icon-btn btn-del" title="Supprimer">✕</button></td>
    </tr>
  `).join('');
  if (drag) wireRowDrag(table, body);

  body.querySelectorAll('.editable-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.closest('tr').dataset.id;
      try {
        if (inp.dataset.timefield !== undefined) {
          const field = inp.dataset.timefield;
          const val = inp.value.trim();
          let isoValue = null;
          if (val) {
            const dateStr = inp.dataset.date || new Date().toISOString().slice(0, 10);
            const d = new Date(`${dateStr}T${val}:00`);
            if (isNaN(d.getTime())) { toast('Heure invalide', 'error'); return; }
            isoValue = d.toISOString();
          }
          await api.put(`${API_BASE[table]}/${id}`, { [field]: isoValue });
        } else if (inp.dataset.extra !== undefined) {
          await api.patch(`${API_BASE[table]}/${id}/extra`, { key: inp.dataset.extra, value: inp.value });
        } else {
          await api.put(`${API_BASE[table]}/${id}`, { [inp.dataset.field]: inp.value });
        }
        toast('Mis à jour', 'success');
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  body.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      if (!confirm('Supprimer cet élément ?')) return;
      try {
        await api.del(`${API_BASE[table]}/${tr.dataset.id}`);
        toast('Supprimé', 'success');
        reloadTable(table);
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  wireRowChecks(table);
}

// ---------- Sélection multiple générique ----------
class Selection {
  constructor(tableKey, apiBase) {
    this.tableKey = tableKey;
    this.apiBase = apiBase;
    this.ids = new Set();
    // Nombre total de lignes correspondant aux filtres actuels quand la sélection dépasse la page
    // affichée (ex: "Tout sélectionner" sur l'historique paginé) — sert à calculer l'état ✓/indéterminé.
    this.totalMatching = null;
  }
  toggle(id, checked) {
    if (checked) this.ids.add(id); else this.ids.delete(id);
    this.refresh();
  }
  clear() {
    this.ids.clear();
    this.totalMatching = null;
    this.refresh();
  }
  refresh() {
    const bar = document.getElementById(`bulk-bar-${this.tableKey}`);
    const count = document.getElementById(`bulk-count-${this.tableKey}`);
    if (bar) bar.style.display = this.ids.size ? 'flex' : 'none';
    if (count) count.textContent = `${this.ids.size} sélectionné(s)`;
    const selectAll = document.getElementById(`select-all-${this.tableKey}`);
    if (selectAll) {
      const rows = document.querySelectorAll(`#body-${this.tableKey} .row-check`);
      const total = this.totalMatching != null ? this.totalMatching : rows.length;
      selectAll.checked = total > 0 && this.ids.size === total;
      selectAll.indeterminate = this.ids.size > 0 && this.ids.size < total;
    }
  }
}

const selections = {
  etudiants: new Selection('etudiants', '/api/students'),
  cours: new Selection('cours', '/api/courses'),
  pointage: new Selection('pointage', '/api/pointage'),
};

const BULK_FIELD_OPTIONS = {
  etudiants: [
    { value: 'classe', label: 'Classe' },
    { value: 'niveau', label: 'Niveau' },
    { value: 'ecole', label: 'École' },
  ],
  cours: [
    { value: 'ecole', label: 'École' },
    { value: 'niveau', label: 'Niveau' },
    { value: 'vh', label: 'VH' },
    { value: 'nb_seances', label: 'Nombre de séances' },
  ],
  pointage: [
    { value: 'classe', label: 'Classe' },
    { value: 'ecole', label: 'École' },
    { value: 'niveau', label: 'Niveau' },
    { value: 'heure_debut', label: 'Heure de début' },
    { value: 'heure_fin', label: 'Heure de fin' },
  ],
};

// Tables où la liste affichée est paginée côté serveur : "Tout sélectionner" doit donc aller chercher
// tous les identifiants correspondant aux filtres actuels, pas seulement les lignes visibles à l'écran.
const PAGINATED_TABLES = new Set(['pointage']);
const SELECT_ALL_IDS_ENDPOINT = { pointage: () => '/api/pointage/ids?' + new URLSearchParams(pointageFilterParams()) };

function wireSelectAll(tableKey) {
  const selectAll = document.getElementById(`select-all-${tableKey}`);
  if (!selectAll) return;
  selectAll.addEventListener('change', async () => {
    // Capturer l'état cible une seule fois : selections.refresh() réécrit selectAll.checked,
    // le relire à chaque itération ferait retomber la sélection à 1 seul élément.
    const shouldCheck = selectAll.checked;
    const sel = selections[tableKey];

    if (!shouldCheck) {
      // Décoche tout, y compris une sélection "toutes pages" qui dépasse les lignes visibles.
      document.querySelectorAll(`#body-${tableKey} .row-check`).forEach(cb => { cb.checked = false; });
      sel.clear();
      return;
    }

    if (PAGINATED_TABLES.has(tableKey)) {
      selectAll.disabled = true;
      try {
        const ids = await api.get(SELECT_ALL_IDS_ENDPOINT[tableKey]());
        sel.ids = new Set(ids.map(String));
        sel.totalMatching = ids.length;
        document.querySelectorAll(`#body-${tableKey} .row-check`).forEach(cb => { cb.checked = true; });
        toast(`${ids.length} ligne(s) sélectionnée(s) (toutes les pages)`, 'success');
      } catch (e) { toast(e.message, 'error'); }
      selectAll.disabled = false;
      sel.refresh();
      return;
    }

    const checks = document.querySelectorAll(`#body-${tableKey} .row-check`);
    checks.forEach(cb => {
      cb.checked = true;
      sel.ids.add(cb.dataset.id);
    });
    sel.refresh();
  });
}

function wireRowChecks(tableKey) {
  document.querySelectorAll(`#body-${tableKey} .row-check`).forEach(cb => {
    cb.addEventListener('change', () => selections[tableKey].toggle(cb.dataset.id, cb.checked));
  });
  selections[tableKey].refresh();
}

function wireBulkBar(tableKey) {
  const clearBtn = document.getElementById(`bulk-clear-${tableKey}`);
  const delBtn = document.getElementById(`bulk-del-${tableKey}`);
  const editBtn = document.getElementById(`bulk-edit-${tableKey}`);
  if (clearBtn) clearBtn.addEventListener('click', () => selections[tableKey].clear());
  if (delBtn) delBtn.addEventListener('click', async () => {
    const sel = selections[tableKey];
    if (!sel.ids.size) return;
    if (!confirm(`Supprimer ${sel.ids.size} élément(s) sélectionné(s) ?`)) return;
    try {
      await api.post(`${sel.apiBase}/bulk-delete`, { ids: [...sel.ids] });
      toast('Éléments supprimés', 'success');
      sel.clear();
      reloadTable(tableKey);
    } catch (e) { toast(e.message, 'error'); }
  });
  if (editBtn) editBtn.addEventListener('click', () => openBulkEdit(tableKey));
}

function reloadTable(tableKey) {
  if (tableKey === 'etudiants') loadEtudiants();
  if (tableKey === 'cours') loadCours();
  if (tableKey === 'pointage') loadPointage();
}

// ---------- Modal édition en masse ----------
let bulkEditTable = null;
function openBulkEdit(tableKey) {
  const sel = selections[tableKey];
  if (!sel.ids.size) return;
  bulkEditTable = tableKey;
  document.getElementById('bulk-edit-count').textContent = `${sel.ids.size} élément(s) sélectionné(s)`;
  const fieldSelect = document.getElementById('bulk-edit-field');
  fieldSelect.innerHTML = BULK_FIELD_OPTIONS[tableKey].map(f => `<option value="${f.value}">${f.label}</option>`).join('');
  document.getElementById('bulk-edit-value').value = '';
  document.getElementById('modal-bulk-edit').style.display = 'flex';
}
document.getElementById('bulk-edit-cancel').addEventListener('click', () => {
  document.getElementById('modal-bulk-edit').style.display = 'none';
  bulkEditTable = null;
});
document.getElementById('modal-bulk-edit').addEventListener('click', (e) => {
  if (e.target.id === 'modal-bulk-edit') { document.getElementById('modal-bulk-edit').style.display = 'none'; bulkEditTable = null; }
});
document.getElementById('bulk-edit-confirm').addEventListener('click', async () => {
  if (!bulkEditTable) return;
  const sel = selections[bulkEditTable];
  const field = document.getElementById('bulk-edit-field').value;
  const value = document.getElementById('bulk-edit-value').value;
  try {
    await api.post(`${sel.apiBase}/bulk-update`, { ids: [...sel.ids], field, value });
    toast('Modification appliquée', 'success');
    document.getElementById('modal-bulk-edit').style.display = 'none';
    const table = bulkEditTable;
    bulkEditTable = null;
    sel.clear();
    reloadTable(table);
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- Modal doublons ----------
const DEDUPE_LABEL = {
  etudiants: g => `${escapeHtml(g.nom)} ${escapeHtml(g.prenom)} <span class="page-subtitle">×${g.count}</span>`,
  cours: g => `${escapeHtml(g.cours)} <span class="page-subtitle">(${escapeHtml(g.ecole || '—')} · ${escapeHtml(g.niveau || '—')}) ×${g.count}</span>`,
  pointage: g => `${escapeHtml(g.nom)} ${escapeHtml(g.prenom)} <span class="page-subtitle">${escapeHtml(g.date || '')} · ${escapeHtml(g.cours || '')} ×${g.count}</span>`,
};
let dedupeTable = null;
async function openDedupeModal(tableKey) {
  const sel = selections[tableKey];
  try {
    const data = await api.get(`${sel.apiBase}/duplicates`);
    if (!data.groupCount) { toast('Aucun doublon trouvé', 'success'); return; }
    dedupeTable = tableKey;
    document.getElementById('dedupe-summary').textContent =
      `${data.groupCount} groupe(s) de doublons — ${data.extraCount} fiche(s) en trop seront supprimées (la plus ancienne est conservée).`;
    const labelFn = DEDUPE_LABEL[tableKey];
    document.getElementById('dedupe-list').innerHTML = data.groups.slice(0, 50).map(g => `<div class="dedupe-row"><span>${labelFn(g)}</span></div>`).join('')
      + (data.groups.length > 50 ? `<div class="dedupe-row"><span class="page-subtitle">... et ${data.groups.length - 50} de plus</span></div>` : '');
    document.getElementById('modal-dedupe').style.display = 'flex';
  } catch (e) { toast(e.message, 'error'); }
}
document.getElementById('dedupe-cancel').addEventListener('click', () => {
  document.getElementById('modal-dedupe').style.display = 'none';
  dedupeTable = null;
});
document.getElementById('modal-dedupe').addEventListener('click', (e) => {
  if (e.target.id === 'modal-dedupe') { document.getElementById('modal-dedupe').style.display = 'none'; dedupeTable = null; }
});
document.getElementById('dedupe-confirm').addEventListener('click', async () => {
  if (!dedupeTable) return;
  const sel = selections[dedupeTable];
  try {
    const res = await api.post(`${sel.apiBase}/dedupe`, {});
    toast(`${res.removed} doublon(s) supprimé(s)`, 'success');
    document.getElementById('modal-dedupe').style.display = 'none';
    const table = dedupeTable;
    dedupeTable = null;
    reloadTable(table);
  } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('btn-dedupe-etudiants').addEventListener('click', () => openDedupeModal('etudiants'));
document.getElementById('btn-dedupe-cours').addEventListener('click', () => openDedupeModal('cours'));
document.getElementById('btn-dedupe-pointage').addEventListener('click', () => openDedupeModal('pointage'));

// ---------- Modal gestion des colonnes ----------
let columnsTable = null;
let linkMeta = { targets: [], localKeyFields: [] };
const TABLE_KEY_FROM_SQL = { students: 'etudiants', courses: 'cours', pointage: 'pointage' };

// Colonnes réellement présentes en base (reflète les suppressions de colonnes natives).
const liveSchema = { etudiants: null, cours: null, pointage: null };
async function loadSchema(table) {
  liveSchema[table] = await api.get(`/api/fields/schema?table=${SQL_TABLE[table]}`);
}

async function openColumnsModal(table) {
  columnsTable = table;
  await Promise.all([loadCustomFields(table), loadSchema(table), loadLinkableTargets(table)]);
  renderColumnsList(table);
  document.getElementById('add-field-label').value = '';
  document.getElementById('link-field-toggle').checked = false;
  document.getElementById('link-field-selects').style.display = 'none';
  document.getElementById('link-field-key-selects').style.display = 'none';
  document.getElementById('modal-columns').style.display = 'flex';
}

async function loadLinkableTargets(table) {
  linkMeta = await api.get(`/api/fields/linkable?table=${SQL_TABLE[table]}`);
  const row = document.getElementById('link-field-row');
  row.style.display = linkMeta.targets.length ? 'block' : 'none';
  const tableSelect = document.getElementById('link-field-table');
  tableSelect.innerHTML = linkMeta.targets.map(t => `<option value="${t.table}">${escapeHtml(t.label)}</option>`).join('');
  const localKeySelect = document.getElementById('link-field-local-key');
  localKeySelect.innerHTML = linkMeta.localKeyFields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('');
  fillLinkFieldOptions();
}
function fillLinkFieldOptions() {
  const tableSelect = document.getElementById('link-field-table');
  const fieldSelect = document.getElementById('link-field-field');
  const targetKeySelect = document.getElementById('link-field-target-key');
  const target = linkMeta.targets.find(t => t.table === tableSelect.value) || linkMeta.targets[0];
  fieldSelect.innerHTML = target ? target.fields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('') : '';
  targetKeySelect.innerHTML = target ? target.keyFields.map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('') : '';
  const localKeySelect = document.getElementById('link-field-local-key');
  const defaultKeys = DEFAULT_LINK_KEYS_CLIENT[`${columnsTable ? SQL_TABLE[columnsTable] : ''}->${target ? target.table : ''}`];
  if (defaultKeys) { localKeySelect.value = defaultKeys.local; targetKeySelect.value = defaultKeys.target; }
}
document.getElementById('link-field-toggle').addEventListener('change', (e) => {
  document.getElementById('link-field-selects').style.display = e.target.checked ? 'flex' : 'none';
  document.getElementById('link-field-key-selects').style.display = e.target.checked ? 'flex' : 'none';
});
document.getElementById('link-field-table').addEventListener('change', fillLinkFieldOptions);

// Miroir côté client des clés par défaut définies dans routes/_linkedFields.js — juste pour présélectionner
// intelligemment les listes déroulantes ; le serveur reste la seule source de vérité/validation.
const DEFAULT_LINK_KEYS_CLIENT = {
  'pointage->students': { local: 'student_id', target: 'id' },
  'pointage->courses': { local: 'cours', target: 'cours' },
  'students->courses': { local: 'niveau', target: 'niveau' },
};

const FORMAT_LABELS = { text: 'Texte', heure: 'Heure', nombre: 'Nombre', date: 'Date' };

function renderColumnsList(table) {
  const cols = allColumns(table);
  const list = document.getElementById('columns-list');
  list.innerHTML = cols.map((c, i) => `
    <div class="column-row" data-key="${escapeHtml(c.key)}">
      <input type="checkbox" class="col-toggle" data-key="${c.key}" ${hiddenColumns[table].has(c.key) ? '' : 'checked'}>
      <label>${escapeHtml(c.label)}</label>
      ${c.linked ? `<span class="badge badge-muted" title="Calculée depuis ${escapeHtml(c.linkedTable)}.${escapeHtml(c.linkedField)}">liée</span>` : ''}
      ${c.custom ? `<span class="badge badge-muted">perso. · ${FORMAT_LABELS[c.format] || 'Texte'}</span>` : ''}
      ${c.protected ? `<span class="badge badge-muted" title="Identifiant : utilisable comme clé de jointure pour lier une colonne personnalisée à une autre table">ID</span>` : ''}
      <div class="col-actions">
        <button class="icon-btn col-move-up" data-key="${c.key}" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn col-move-down" data-key="${c.key}" title="Descendre" ${i === cols.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn col-rename" data-key="${c.key}" data-id="${c.defId || ''}" data-custom="${c.custom ? '1' : ''}" title="Renommer">✎</button>
        ${!c.computed && !c.protected && linkMeta.targets.length ? `<button class="icon-btn col-link" data-key="${c.key}" data-custom="${c.custom ? '1' : ''}" title="Lier à une autre table (VLOOKUP)">🔗</button>` : ''}
        ${!c.computed && !c.protected ? `<button class="icon-btn btn-del-field" data-key="${c.key}" data-id="${c.defId || ''}" data-custom="${c.custom ? '1' : ''}" title="Supprimer définitivement cette colonne">✕</button>` : ''}
      </div>
    </div>
    <div class="col-link-editor" id="link-editor-${safeId(c.key)}" style="display:none;"></div>
  `).join('');

  list.querySelectorAll('.col-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenColumns[table].delete(cb.dataset.key);
      else hiddenColumns[table].add(cb.dataset.key);
      saveHiddenCols(table);
      renderTable(table);
    });
  });
  list.querySelectorAll('.col-move-up').forEach(btn => btn.addEventListener('click', () => moveColumn(table, btn.dataset.key, -1)));
  list.querySelectorAll('.col-move-down').forEach(btn => btn.addEventListener('click', () => moveColumn(table, btn.dataset.key, 1)));
  list.querySelectorAll('.col-rename').forEach(btn => {
    btn.addEventListener('click', () => startRenameColumn(table, btn.closest('.column-row'), btn.dataset.key, btn.dataset.custom === '1', btn.dataset.id));
  });
  list.querySelectorAll('.col-link').forEach(btn => btn.addEventListener('click', () => toggleLinkEditor(table, btn.dataset.key, btn.dataset.custom === '1')));
  list.querySelectorAll('.btn-del-field').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isCustom = btn.dataset.custom === '1';
      if (isCustom) {
        if (!confirm('Retirer définitivement ce champ personnalisé ?')) return;
        try {
          await api.del(`/api/fields/${btn.dataset.id}`);
          await loadCustomFields(table);
          renderColumnsList(table);
          renderTable(table);
          toast('Champ retiré', 'success');
        } catch (e) { toast(e.message, 'error'); }
      } else {
        const label = allColumns(table).find(c => c.key === btn.dataset.key)?.label || btn.dataset.key;
        if (!confirm(`Supprimer DÉFINITIVEMENT la colonne "${label}" ? Cette action est irréversible : toutes les valeurs de cette colonne, pour toutes les lignes, seront perdues.`)) return;
        try {
          await api.del('/api/fields/builtin-column', { table: SQL_TABLE[table], field_key: btn.dataset.key });
          await Promise.all([loadCustomFields(table), loadSchema(table)]);
          renderColumnsList(table);
          renderHeader(table, table === 'etudiants' ? renderEtudiants : table === 'cours' ? renderCours : () => loadPointage());
          renderTable(table);
          toast('Colonne supprimée', 'success');
        } catch (e) { toast(e.message, 'error'); }
      }
    });
  });
}

// Déplace une colonne d'un cran (up=-1 / down=+1) et persiste l'ordre choisi.
function moveColumn(table, key, dir) {
  const cols = allColumns(table).map(c => c.key);
  const idx = cols.indexOf(key);
  const swapIdx = idx + dir;
  if (idx === -1 || swapIdx < 0 || swapIdx >= cols.length) return;
  [cols[idx], cols[swapIdx]] = [cols[swapIdx], cols[idx]];
  colOrder[table] = cols;
  saveColOrder(table);
  renderColumnsList(table);
  renderTable(table);
}

// Renommer une colonne (édition inline) : les champs personnalisés sont renommés côté serveur
// (field_defs), les colonnes natives via une surcouche locale (localStorage) — le champ en base reste inchangé.
function startRenameColumn(table, rowEl, key, isCustom, defId) {
  const labelEl = rowEl.querySelector('label');
  if (!labelEl) return;
  const current = labelEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'col-rename-input';
  input.value = current;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  function commit() {
    if (settled) return;
    settled = true;
    const trimmed = input.value.trim();
    if (!trimmed || trimmed === current) { renderColumnsList(table); return; }
    if (isCustom) {
      api.patch(`/api/fields/${defId}`, { label: trimmed }).then(async () => {
        await loadCustomFields(table);
        renderColumnsList(table);
        renderTable(table);
        toast('Colonne renommée', 'success');
      }).catch(e => { toast(e.message, 'error'); renderColumnsList(table); });
    } else {
      colLabels[table][key] = trimmed;
      saveColLabels(table);
      renderColumnsList(table);
      renderTable(table);
      toast('Colonne renommée', 'success');
    }
  }
  function cancel() {
    if (settled) return;
    settled = true;
    renderColumnsList(table);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => commit());
}

// Ouvre/ferme un petit éditeur inline pour (re)configurer la liaison d'une colonne — personnalisée
// OU native existante (VLOOKUP) — vers une autre table, et (pour le personnalisé) son format.
function toggleLinkEditor(table, key, isCustom) {
  const field = isCustom ? customFields[table].find(f => 'extra:' + f.field_key === key) : builtinLinks[table][key];
  const defId = field ? field.id : null;
  const fieldKey = isCustom ? key.slice(6) : key;
  const id = 'link-editor-' + safeId(key);
  const el = document.getElementById(id);
  if (!el) return;
  document.querySelectorAll('.col-link-editor').forEach(e => { if (e.id !== id) e.style.display = 'none'; });
  if (el.style.display === 'block') { el.style.display = 'none'; return; }

  const tableOptions = linkMeta.targets.map(t =>
    `<option value="${t.table}" ${field && t.table === field.linked_table ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
  ).join('');
  const formatSelect = isCustom ? `
    <label class="hint" style="margin:0 0 4px;">Format</label>
    <select class="le-format" style="margin-bottom:8px; width:100%;">
      ${Object.entries(FORMAT_LABELS).map(([v, l]) => `<option value="${v}" ${((field && field.format) || 'text') === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
  ` : '';
  el.innerHTML = `
    ${formatSelect}
    <label class="hint" style="margin:0 0 4px;">Lier à une autre table (VLOOKUP)</label>
    <div class="link-field-selects" style="margin:0 0 8px;">
      <select class="le-table">${tableOptions}</select>
      <select class="le-field"></select>
    </div>
    <label class="hint" style="margin:0 0 4px;">Clé de connexion (cette colonne doit correspondre à...)</label>
    <div class="link-field-selects" style="margin:0 0 8px;">
      <select class="le-local-key"></select>
      <span class="hint" style="margin:0 6px; align-self:center;">=</span>
      <select class="le-target-key"></select>
    </div>
    <div class="hstack" style="gap:8px;">
      <button class="btn btn-ghost btn-sm le-clear" type="button" ${field ? '' : 'disabled'}>Retirer la liaison</button>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm le-save" type="button">Enregistrer</button>
    </div>
  `;
  const tableSel = el.querySelector('.le-table');
  const fieldSel = el.querySelector('.le-field');
  const localKeySel = el.querySelector('.le-local-key');
  const targetKeySel = el.querySelector('.le-target-key');
  localKeySel.innerHTML = linkMeta.localKeyFields.map(f => `<option value="${f.key}" ${field && field.link_local_key === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
  function fillFields() {
    const target = linkMeta.targets.find(t => t.table === tableSel.value) || linkMeta.targets[0];
    fieldSel.innerHTML = target ? target.fields.map(f =>
      `<option value="${f.key}" ${field && target.table === field.linked_table && f.key === field.linked_field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`
    ).join('') : '';
    targetKeySel.innerHTML = target ? target.keyFields.map(f =>
      `<option value="${f.key}" ${field && field.link_target_key === f.key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`
    ).join('') : '';
    // Si aucune clé n'est encore enregistrée pour ce champ, présélectionner la paire par défaut de la relation.
    if (target && !field?.link_local_key) {
      const defaults = DEFAULT_LINK_KEYS_CLIENT[`${SQL_TABLE[table]}->${target.table}`];
      if (defaults) { localKeySel.value = defaults.local; targetKeySel.value = defaults.target; }
    }
  }
  fillFields();
  tableSel.addEventListener('change', fillFields);
  el.querySelector('.le-save').addEventListener('click', async () => {
    try {
      const linkBody = { linked_table: tableSel.value, linked_field: fieldSel.value, link_local_key: localKeySel.value, link_target_key: targetKeySel.value };
      if (isCustom) {
        linkBody.format = el.querySelector('.le-format').value;
        await api.patch(`/api/fields/${defId}`, linkBody);
      } else {
        await api.post('/api/fields/builtin-link', { table: SQL_TABLE[table], field_key: fieldKey, ...linkBody });
      }
      await loadCustomFields(table);
      renderColumnsList(table);
      renderTable(table);
      toast('Liaison mise à jour', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('.le-clear').addEventListener('click', async () => {
    if (!field) return;
    try {
      if (isCustom) {
        await api.patch(`/api/fields/${defId}`, { linked_table: '' });
      } else {
        await api.del(`/api/fields/${defId}`);
      }
      await loadCustomFields(table);
      renderColumnsList(table);
      renderTable(table);
      toast('Liaison retirée', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  el.style.display = 'block';
}
document.getElementById('add-field-confirm').addEventListener('click', async () => {
  const input = document.getElementById('add-field-label');
  const label = input.value.trim();
  if (!label || !columnsTable) return;
  const body = { table: SQL_TABLE[columnsTable], label, format: document.getElementById('add-field-format').value };
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
    await loadCustomFields(columnsTable);
    renderColumnsList(columnsTable);
    renderTable(columnsTable);
    toast('Champ ajouté', 'success');
  } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('columns-done').addEventListener('click', () => {
  document.getElementById('modal-columns').style.display = 'none';
  columnsTable = null;
});
document.getElementById('modal-columns').addEventListener('click', (e) => {
  if (e.target.id === 'modal-columns') { document.getElementById('modal-columns').style.display = 'none'; columnsTable = null; }
});
document.getElementById('btn-columns-etudiants').addEventListener('click', () => openColumnsModal('etudiants'));
document.getElementById('btn-columns-cours').addEventListener('click', () => openColumnsModal('cours'));
document.getElementById('btn-columns-pointage').addEventListener('click', () => openColumnsModal('pointage'));

function renderTable(table) {
  if (table === 'etudiants') { renderHeader('etudiants', renderEtudiants); renderEtudiants(); }
  if (table === 'cours') { renderHeader('cours', renderCours); renderCours(); }
  if (table === 'pointage') { renderHeader('pointage', () => loadPointage()); loadPointage(); }
}

// ---------- Tri générique ----------
// Pour Étudiants/Cours, un tri manuel (glisser-déposer) persiste tant que l'utilisateur ne clique pas sur un en-tête triable.
const sortState = {
  etudiants: { field: localStorage.getItem('sortField:etudiants') || 'nom', dir: 'asc' },
  cours: { field: localStorage.getItem('sortField:cours') || 'ecole', dir: 'asc' },
  pointage: { field: 'date', dir: 'desc' },
};

function compareValues(a, b) {
  const av = a === null || a === undefined ? '' : a;
  const bv = b === null || b === undefined ? '' : b;
  const an = parseFloat(av), bn = parseFloat(bv);
  if (!isNaN(an) && !isNaN(bn) && String(an) === String(av).trim() && String(bn) === String(bv).trim()) return an - bn;
  return String(av).localeCompare(String(bv), 'fr', { sensitivity: 'base' });
}

function sortRows(rows, field, dir) {
  const sorted = [...rows].sort((a, b) => compareValues(a[field], b[field]));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

function wireSortableHeaders(theadId, tableKey, onSort) {
  document.querySelectorAll(`#${theadId} th.sortable`).forEach(th => {
    const field = th.dataset.sort;
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.textContent = '↕';
    th.appendChild(arrow);
    th.addEventListener('click', () => {
      const state = sortState[tableKey];
      if (state.field === field) {
        state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.field = field;
        state.dir = 'asc';
      }
      if (DRAGGABLE_TABLES.has(tableKey)) localStorage.setItem('sortField:' + tableKey, state.field);
      refreshSortIndicators(theadId, tableKey);
      onSort();
    });
  });
  refreshSortIndicators(theadId, tableKey);
}

// Glisser-déposer pour réordonner manuellement les lignes (Étudiants / Cours uniquement).
function wireRowDrag(table, body) {
  body.querySelectorAll('tr[draggable="true"]').forEach(tr => {
    tr.addEventListener('dragstart', () => { tr.classList.add('dragging'); });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); });
    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = body.querySelector('.dragging');
      if (!dragging || dragging === tr) return;
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      body.insertBefore(dragging, before ? tr : tr.nextSibling);
    });
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      rowOrder[table] = [...body.querySelectorAll('tr[data-id]')].map(r => r.dataset.id);
      saveRowOrder(table);
      sortState[table].field = '__manual__';
      localStorage.setItem('sortField:' + table, '__manual__');
      refreshSortIndicators(THEAD_ID[table], table);
      toast('Ordre des lignes enregistré', 'success');
    });
  });
}

function refreshSortIndicators(theadId, tableKey) {
  const state = sortState[tableKey];
  document.querySelectorAll(`#${theadId} th.sortable`).forEach(th => {
    const active = th.dataset.sort === state.field;
    th.classList.toggle('sort-active', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (state.dir === 'asc' ? '↑' : '↓') : '↕';
  });
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
    if (btn.dataset.tab === 'pointage') requestAnimationFrame(scrollFriezeToActive);
  });
});

// ---------- Import panel ----------
const importPanel = document.getElementById('import-panel');
document.getElementById('btn-import-open').addEventListener('click', () => {
  importPanel.style.display = importPanel.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('btn-import-cancel').addEventListener('click', () => {
  importPanel.style.display = 'none';
});

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) importFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) importFile(fileInput.files[0]);
});

async function importFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/excel/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec import');
    toast(`Import réussi : ${data.summary.etudiants} étudiants, ${data.summary.cours} cours, ${data.summary.pointage} entrées de pointage`, 'success');
    importPanel.style.display = 'none';
    fileInput.value = '';
    loadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- Datalists (saisie libre, formulaires d'ajout) ----------
// Chaque champ suggère uniquement les valeurs qui existent déjà dans SA propre table (sa "variable
// mère") : École/Niveau/Classe d'un nouvel étudiant viennent de la table Étudiants elle-même, École/Niveau
// d'un nouveau cours viennent de la table Cours elle-même — jamais un mélange des deux.
async function loadEntrySuggestions() {
  try {
    const [studentFacets, courseFacets] = await Promise.all([
      api.get('/api/students/facets'),
      api.get('/api/courses/facets'),
    ]);
    fillDatalist('dl-ecoles-etudiants', studentFacets.ecole);
    fillDatalist('dl-classes-etudiants', studentFacets.classe);
    fillDatalist('dl-niveaux-etudiants', studentFacets.niveau);
    fillDatalist('dl-ecoles-cours', courseFacets.ecole);
    fillDatalist('dl-niveaux-cours', courseFacets.niveau);
  } catch (e) { /* silencieux */ }
}

// ---------- Filtres en cascade (facettes) ----------
function fillFacetSelect(el, values) {
  const keep = el.value;
  const allLabel = el.dataset.allLabel || 'Tous';
  el.dataset.allLabel = allLabel;
  el.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  el.value = values.includes(keep) ? keep : '';
}
// Variante "champ texte + datalist" : ne réinitialise jamais ce que l'utilisateur a saisi (contrairement
// à un <select>, la valeur tapée reste valide même si elle ne figure pas — encore — dans les suggestions).
function fillDatalist(id, values) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">`).join('');
}

// ---------- Étudiants ----------
const searchEtudiants = document.getElementById('search-etudiants');
const filterEtudiantsClasse = document.getElementById('filter-etudiants-classe');
const filterEtudiantsNiveau = document.getElementById('filter-etudiants-niveau');
const filterEtudiantsEcole = document.getElementById('filter-etudiants-ecole');
filterEtudiantsClasse.dataset.allLabel = 'Toutes';
filterEtudiantsNiveau.dataset.allLabel = 'Tous';
filterEtudiantsEcole.dataset.allLabel = 'Toutes';
let etudiantsRows = [];

function etudiantsFilterParams() {
  const p = {};
  if (searchEtudiants.value) p.search = searchEtudiants.value;
  if (filterEtudiantsClasse.value) p.classe = filterEtudiantsClasse.value;
  if (filterEtudiantsNiveau.value) p.niveau = filterEtudiantsNiveau.value;
  if (filterEtudiantsEcole.value) p.ecole = filterEtudiantsEcole.value;
  return p;
}

async function refreshEtudiantsFacets() {
  try {
    // Les 3 filtres reflètent les valeurs qui existent réellement dans la table Étudiants elle-même
    // (pas la table Cours) : sinon un École/Niveau visible dans la liste peut ne renvoyer aucun étudiant.
    const facets = await api.get('/api/students/facets?' + new URLSearchParams({
      ecole: filterEtudiantsEcole.value, niveau: filterEtudiantsNiveau.value, classe: filterEtudiantsClasse.value,
    }));
    fillDatalist('dl-filter-niveaux-etudiants', facets.niveau);
    fillDatalist('dl-filter-ecoles-etudiants', facets.ecole);
    fillDatalist('dl-filter-classes-etudiants', facets.classe);
  } catch (e) { /* silencieux */ }
}

async function loadEtudiants() {
  const params = new URLSearchParams(etudiantsFilterParams());
  etudiantsRows = await api.get('/api/students' + (params.toString() ? `?${params}` : ''));
  renderEtudiants();
}

function renderEtudiants() {
  const state = sortState.etudiants;
  const rows = state.field === '__manual__' ? applyRowOrder('etudiants', etudiantsRows) : sortRows(etudiantsRows, state.field, state.dir);
  document.getElementById('count-etudiants').textContent = `${rows.length} étudiant(s)`;
  document.getElementById('empty-etudiants').style.display = rows.length ? 'none' : 'block';
  selections.etudiants.clear();
  renderRowsGeneric('etudiants', rows);
}

document.getElementById('form-etudiant').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api.post('/api/students', Object.fromEntries(fd));
    e.target.reset();
    toast('Étudiant ajouté', 'success');
    loadEtudiants();
    refreshEtudiantsFacets();
    loadEntrySuggestions();
  } catch (err) { toast(err.message, 'error'); }
});

let searchTimer;
searchEtudiants.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { loadEtudiants(); refreshEtudiantsFacets(); }, 250);
});
let etudiantsFilterTimer;
[filterEtudiantsClasse, filterEtudiantsNiveau, filterEtudiantsEcole].forEach(el => el.addEventListener('input', () => {
  clearTimeout(etudiantsFilterTimer);
  etudiantsFilterTimer = setTimeout(() => { loadEtudiants(); refreshEtudiantsFacets(); }, 250);
}));
document.getElementById('btn-etudiants-reset').addEventListener('click', () => {
  searchEtudiants.value = '';
  filterEtudiantsClasse.value = '';
  filterEtudiantsNiveau.value = '';
  filterEtudiantsEcole.value = '';
  loadEtudiants();
  refreshEtudiantsFacets();
});

// ---------- Cours ----------
const searchCours = document.getElementById('search-cours');
const filterCoursEcole = document.getElementById('filter-cours-ecole');
const filterCoursNiveau = document.getElementById('filter-cours-niveau');
const filterCoursCours = document.getElementById('filter-cours-cours');
filterCoursEcole.dataset.allLabel = 'Toutes';
filterCoursNiveau.dataset.allLabel = 'Tous';
filterCoursCours.dataset.allLabel = 'Tous';
let coursRows = [];

function coursFilterParams() {
  const p = {};
  if (searchCours.value) p.search = searchCours.value;
  if (filterCoursEcole.value) p.ecole = filterCoursEcole.value;
  if (filterCoursNiveau.value) p.niveau = filterCoursNiveau.value;
  if (filterCoursCours.value) p.cours = filterCoursCours.value;
  return p;
}

async function refreshCoursFacets() {
  try {
    // Sourcé directement depuis la table Cours elle-même (sa propre "variable mère").
    const facets = await api.get('/api/courses/facets?' + new URLSearchParams({ ecole: filterCoursEcole.value, niveau: filterCoursNiveau.value, cours: filterCoursCours.value }));
    fillDatalist('dl-filter-ecoles-cours', facets.ecole);
    fillDatalist('dl-filter-niveaux-cours', facets.niveau);
    fillDatalist('dl-filter-cours-cours', facets.cours);
  } catch (e) { /* silencieux */ }
}

async function loadCours() {
  const params = new URLSearchParams(coursFilterParams());
  coursRows = await api.get('/api/courses' + (params.toString() ? `?${params}` : ''));
  renderCours();
}

function renderCours() {
  const state = sortState.cours;
  const rows = state.field === '__manual__' ? applyRowOrder('cours', coursRows) : sortRows(coursRows, state.field, state.dir);
  document.getElementById('count-cours').textContent = `${rows.length} cours`;
  document.getElementById('empty-cours').style.display = rows.length ? 'none' : 'block';
  selections.cours.clear();
  renderRowsGeneric('cours', rows);
}

document.getElementById('form-cours').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api.post('/api/courses', Object.fromEntries(fd));
    e.target.reset();
    toast('Cours ajouté', 'success');
    loadCours();
    refreshCoursFacets();
    loadEntrySuggestions();
  } catch (err) { toast(err.message, 'error'); }
});

let searchCoursTimer;
searchCours.addEventListener('input', () => {
  clearTimeout(searchCoursTimer);
  searchCoursTimer = setTimeout(() => { loadCours(); refreshCoursFacets(); }, 250);
});
let coursFilterTimer;
[filterCoursEcole, filterCoursNiveau, filterCoursCours].forEach(el => el.addEventListener('input', () => {
  clearTimeout(coursFilterTimer);
  coursFilterTimer = setTimeout(() => { loadCours(); refreshCoursFacets(); }, 250);
}));
document.getElementById('btn-cours-reset').addEventListener('click', () => {
  searchCours.value = '';
  filterCoursEcole.value = '';
  filterCoursNiveau.value = '';
  filterCoursCours.value = '';
  loadCours();
  refreshCoursFacets();
});

// ---------- Historique de pointage ----------
const searchPointage = document.getElementById('search-pointage');
const filterPointageDate = document.getElementById('filter-pointage-date');
const filterPointageClasse = document.getElementById('filter-pointage-classe');
const filterPointageEcole = document.getElementById('filter-pointage-ecole');
const filterPointageCours = document.getElementById('filter-pointage-cours');
const filterPointageNiveau = document.getElementById('filter-pointage-niveau');
filterPointageClasse.dataset.allLabel = 'Toutes';
filterPointageEcole.dataset.allLabel = 'Toutes';
filterPointageCours.dataset.allLabel = 'Tous';
filterPointageNiveau.dataset.allLabel = 'Tous';

let pointagePage = 1;
const POINTAGE_PAGE_SIZE = 100;

function pointageFilterParams() {
  const p = {};
  if (filterPointageDate.value) p.date = filterPointageDate.value;
  if (filterPointageClasse.value) p.classe = filterPointageClasse.value;
  if (filterPointageEcole.value) p.ecole = filterPointageEcole.value;
  if (filterPointageCours.value) p.cours = filterPointageCours.value;
  if (filterPointageNiveau.value) p.niveau = filterPointageNiveau.value;
  if (searchPointage.value) p.q = searchPointage.value;
  return p;
}

async function refreshPointageFacets() {
  try {
    // Les 4 filtres reflètent les valeurs qui existent réellement dans la table Pointage elle-même
    // (pas Cours/Étudiants) : sinon une valeur listée peut ne renvoyer aucune ligne d'historique.
    const facets = await api.get('/api/pointage/facets?' + new URLSearchParams({
      date: filterPointageDate.value, ecole: filterPointageEcole.value, niveau: filterPointageNiveau.value,
      cours: filterPointageCours.value, classe: filterPointageClasse.value, q: searchPointage.value,
    }));
    fillDatalist('dl-filter-ecoles-pointage', facets.ecole);
    fillDatalist('dl-filter-cours-pointage', facets.cours);
    fillDatalist('dl-filter-niveaux-pointage', facets.niveau);
    fillDatalist('dl-filter-classes-pointage', facets.classe);
  } catch (e) { /* silencieux */ }
}

function onPointageFilterChange() {
  pointagePage = 1;
  loadPointage();
  refreshPointageFacets();
  loadTimeline();
}

filterPointageDate.addEventListener('change', onPointageFilterChange);
let pointageTextFilterTimer;
[filterPointageClasse, filterPointageEcole, filterPointageCours, filterPointageNiveau].forEach(el => {
  el.addEventListener('input', () => {
    clearTimeout(pointageTextFilterTimer);
    pointageTextFilterTimer = setTimeout(onPointageFilterChange, 250);
  });
});
let searchPointageTimer;
searchPointage.addEventListener('input', () => {
  clearTimeout(searchPointageTimer);
  searchPointageTimer = setTimeout(onPointageFilterChange, 250);
});

document.getElementById('btn-pointage-reset').addEventListener('click', () => {
  searchPointage.value = '';
  filterPointageDate.value = '';
  filterPointageClasse.value = '';
  filterPointageEcole.value = '';
  filterPointageCours.value = '';
  filterPointageNiveau.value = '';
  onPointageFilterChange();
});

document.getElementById('pointage-prev').addEventListener('click', () => {
  if (pointagePage > 1) { pointagePage--; loadPointage(); }
});
document.getElementById('pointage-next').addEventListener('click', () => {
  pointagePage++; loadPointage();
});

// ---------- Chronologie : frise horizontale reliée ----------
let timelineData = [];
async function loadTimeline() {
  const params = new URLSearchParams();
  if (filterPointageEcole.value) params.set('ecole', filterPointageEcole.value);
  if (filterPointageClasse.value) params.set('classe', filterPointageClasse.value);
  if (filterPointageCours.value) params.set('cours', filterPointageCours.value);
  if (filterPointageNiveau.value) params.set('niveau', filterPointageNiveau.value);
  if (searchPointage.value) params.set('q', searchPointage.value);
  timelineData = await api.get('/api/pointage/timeline' + (params.toString() ? `?${params}` : ''));
  renderTimeline();
}

function renderTimeline() {
  const el = document.getElementById('pointage-timeline');
  if (!timelineData.length) {
    el.innerHTML = `<p class="page-subtitle" style="margin:0;">Aucune activité enregistrée pour ces filtres.</p>`;
    return;
  }
  const chronological = [...timelineData].reverse(); // du plus ancien au plus récent, de gauche à droite
  const max = Math.max(...chronological.map(d => d.count), 1);
  el.innerHTML = `<div class="frieze-wrap"><div class="frieze">` +
    chronological.map(d => {
      const size = Math.round(10 + (d.count / max) * 12);
      const active = d.date === filterPointageDate.value;
      return `
        <div class="frieze-node${active ? ' active' : ''}" data-date="${d.date}">
          <div class="frieze-dot" style="--dot-size:${size}px"></div>
          <div class="frieze-label">${escapeHtml(d.date)}<span class="frieze-count">${d.count}</span></div>
        </div>
      `;
    }).join('') +
    `</div></div>`;
  el.querySelectorAll('.frieze-node').forEach(node => {
    node.addEventListener('click', () => {
      filterPointageDate.value = filterPointageDate.value === node.dataset.date ? '' : node.dataset.date;
      pointagePage = 1;
      renderTimelineActive();
      loadPointage();
      refreshPointageFacets();
    });
  });
  // centre la frise sur le noeud sélectionné (ou le plus récent)
  requestAnimationFrame(scrollFriezeToActive);
}

function scrollFriezeToActive() {
  const el = document.getElementById('pointage-timeline');
  const wrap = el.querySelector('.frieze-wrap');
  const activeNode = el.querySelector('.frieze-node.active') || el.querySelector('.frieze-node:last-child');
  if (wrap && activeNode) {
    wrap.scrollLeft = activeNode.offsetLeft - wrap.clientWidth / 2 + activeNode.offsetWidth / 2;
  }
}
function renderTimelineActive() {
  document.querySelectorAll('.frieze-node').forEach(node => {
    node.classList.toggle('active', node.dataset.date === filterPointageDate.value);
  });
}

async function loadPointage() {
  const state = sortState.pointage;
  const params = new URLSearchParams(pointageFilterParams());
  params.set('page', pointagePage);
  params.set('pageSize', POINTAGE_PAGE_SIZE);
  params.set('sort_by', state.field);
  params.set('sort_dir', state.dir);

  const data = await api.get('/api/pointage/search?' + params.toString());
  document.getElementById('count-pointage').textContent = `${data.total} résultat(s)`;
  document.getElementById('pointage-page-label').textContent = `Page ${data.page} / ${data.totalPages}`;
  document.getElementById('pointage-prev').disabled = data.page <= 1;
  document.getElementById('pointage-next').disabled = data.page >= data.totalPages;
  document.getElementById('empty-pointage').style.display = data.rows.length ? 'none' : 'block';
  selections.pointage.clear();
  renderRowsGeneric('pointage', data.rows);
}

wireBulkBar('etudiants');
wireBulkBar('cours');
wireBulkBar('pointage');

// ---------- Amorçage ----------
async function loadAll() {
  await Promise.all([
    loadCustomFields('etudiants'), loadCustomFields('cours'), loadCustomFields('pointage'),
    loadSchema('etudiants'), loadSchema('cours'), loadSchema('pointage'),
  ]);

  renderHeader('etudiants', renderEtudiants);
  renderHeader('cours', renderCours);
  renderHeader('pointage', () => loadPointage());

  // La date par défaut de l'historique = la date de pointage la plus récente enregistrée
  const latestTimeline = await api.get('/api/pointage/timeline');
  timelineData = latestTimeline;
  filterPointageDate.value = latestTimeline.length ? latestTimeline[0].date : '';
  renderTimeline();

  loadEtudiants();
  loadCours();
  loadPointage();
  refreshEtudiantsFacets();
  refreshCoursFacets();
  refreshPointageFacets();
  loadEntrySuggestions();
}
loadAll();
