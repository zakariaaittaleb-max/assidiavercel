const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');
const { attachExtraFieldRoute } = require('./_extraFields');
const { buildFacets } = require('./_facets');
const { resolveLinkedFields } = require('./_linkedFields');
const { insertRow, updateRow } = require('./_dynamicSql');
const { resolveCoursId } = require('./_resolveIds');

const FACET_FIELDS = ['date', 'ecole', 'cours', 'niveau', 'classe'];

attachExtraFieldRoute(router, 'pointage');

// L'école d'une session peut être nulle. SQLite acceptait `ecole IS ?` avec un paramètre NULL ;
// Postgres réserve `IS` à IS NULL / IS TRUE… et exige cette forme pour comparer en traitant NULL
// comme une valeur ordinaire. Elle couvre les deux cas (valeur ou NULL) d'un seul tenant.
const ECOLE_MATCH = `ecole IS NOT DISTINCT FROM ?`;

function nowIso() {
  return new Date().toISOString();
}

function pad2(n) { return String(n).padStart(2, '0'); }

function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes de retard à l'arrivée par rapport à l'heure de début de la séance (0 si arrivé à l'heure ou en avance).
function computeMinutesRatees(heure_debut, heure_arrivee) {
  if (!heure_arrivee) return null;
  const arrivalDate = new Date(heure_arrivee);
  if (Number.isNaN(arrivalDate.getTime())) return null;
  const startMin = hhmmToMinutes(heure_debut);
  const arrivalMin = hhmmToMinutes(`${pad2(arrivalDate.getHours())}:${pad2(arrivalDate.getMinutes())}`);
  if (startMin == null || arrivalMin == null) return null;
  let diff = arrivalMin - startMin;
  if (diff < 0) diff += 24 * 60;
  return Math.max(0, diff);
}

// Note d'assiduité de la séance sur 20 : 10 premières minutes de retard gratuites, puis -1 point/minute.
function computeNoteAssiduite(minutesRatees) {
  if (minutesRatees == null) return null;
  if (minutesRatees <= 10) return 20;
  return Math.max(0, 20 - (minutesRatees - 10));
}

const IDENT_EXPR_ASSIDUITE = `CASE WHEN student_id IS NOT NULL THEN 'S' || student_id ELSE 'N' || LOWER(TRIM(COALESCE(nom,''))) || '|' || LOWER(TRIM(COALESCE(prenom,''))) END`;
const assiduiteSessionsStmt = db.prepare(
  `SELECT heure_debut, heure_arrivee FROM pointage WHERE (${IDENT_EXPR_ASSIDUITE}) = ? AND COALESCE(cours,'') = ?`
);
function identityKey(r) {
  return r.student_id ? `S${r.student_id}` : `N${String(r.nom || '').trim().toLowerCase()}|${String(r.prenom || '').trim().toLowerCase()}`;
}

// Ajoute minutes_ratees, note_assiduite (séance) et moyenne_assiduite (moyenne des séances du même
// étudiant, pour le même cours, enregistrées jusqu'à maintenant — absences non comptées) à chaque ligne.
async function attachAssiduite(rows) {
  const withGrades = rows.map(r => {
    const minutes_ratees = r.heure_arrivee ? computeMinutesRatees(r.heure_debut, r.heure_arrivee) : null;
    const note_assiduite = r.heure_arrivee ? computeNoteAssiduite(minutes_ratees) : null;
    return { ...r, minutes_ratees, note_assiduite };
  });

  const avgCache = new Map();
  for (const r of withGrades) {
    const cacheKey = `${identityKey(r)}||${r.cours || ''}`;
    if (!avgCache.has(cacheKey)) {
      const sessions = await assiduiteSessionsStmt.all(identityKey(r), r.cours || '');
      const grades = sessions
        .filter(s => s.heure_arrivee)
        .map(s => computeNoteAssiduite(computeMinutesRatees(s.heure_debut, s.heure_arrivee)))
        .filter(g => g != null);
      avgCache.set(cacheKey, grades.length ? Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 10) / 10 : null);
    }
    r.moyenne_assiduite = avgCache.get(cacheKey);
  }
  return withGrades;
}

// Options disponibles pour chaque filtre (date, école, cours, niveau, classe), en cascade
router.get('/facets', async (req, res) => {
  const { date, ecole, cours, niveau, classe, q } = req.query;
  let extraWhere = null;
  if (q) {
    const term = `%${q}%`;
    extraWhere = { clause: '(nom LIKE ? OR prenom LIKE ?)', params: [term, term] };
  }
  const facets = await buildFacets(db, 'pointage', FACET_FIELDS, { date, ecole, cours, niveau, classe }, extraWhere);
  res.json(facets);
});

// Liste des entrées de pointage, filtrable par date / école / cours / niveau / classe (combinables)
router.get('/', async (req, res) => {
  const { date, ecole, cours, niveau, classe } = req.query;
  const filters = [];
  const params = [];
  if (date) { filters.push('date = ?'); params.push(date); }
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (cours) { filters.push('cours = ?'); params.push(cours); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (classe) { filters.push('classe = ?'); params.push(classe); }

  let sql = 'SELECT * FROM pointage';
  if (filters.length) sql += ' WHERE ' + filters.join(' AND ');
  sql += ' ORDER BY date DESC, nom, prenom';
  if (!filters.length) sql += ' LIMIT 500';

  const rows = await db.prepare(sql).all(...params);
  res.json(await attachAssiduite(await resolveLinkedFields('pointage', rows)));
});

// Chronologie : dates ayant du pointage (les plus récentes d'abord), filtrable par école/cours/niveau/classe/recherche
router.get('/timeline', async (req, res) => {
  const { ecole, cours, niveau, classe, q } = req.query;
  const filters = [`date IS NOT NULL`, `date != ''`];
  const params = [];
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (cours) { filters.push('cours = ?'); params.push(cours); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (classe) { filters.push('classe = ?'); params.push(classe); }
  if (q) { filters.push('(nom LIKE ? OR prenom LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = await db.prepare(
    `SELECT date, COUNT(*) AS count FROM pointage WHERE ${filters.join(' AND ')}
     GROUP BY date ORDER BY date DESC LIMIT 120`
  ).all(...params);
  res.json(rows);
});

const SORTABLE = ['date', 'nom', 'prenom', 'ecole', 'cours', 'niveau', 'classe', 'heure_debut', 'heure_fin', 'heure_arrivee', 'heure_expulsion'];

// Tous les identifiants correspondant aux filtres (au-delà de la page affichée) — pour "Tout sélectionner".
router.get('/ids', async (req, res) => {
  const { date, ecole, cours, niveau, classe, q } = req.query;
  const filters = [];
  const params = [];
  if (date) { filters.push('date = ?'); params.push(date); }
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (cours) { filters.push('cours = ?'); params.push(cours); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (classe) { filters.push('classe = ?'); params.push(classe); }
  if (q) { filters.push('(nom LIKE ? OR prenom LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const whereClause = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const rows = await db.prepare(`SELECT id FROM pointage${whereClause}`).all(...params);
  res.json(rows.map(r => r.id));
});

// Recherche paginée pour l'historique (grands volumes) : mêmes filtres que GET /, + pagination et tri
router.get('/search', async (req, res) => {
  const { date, ecole, cours, niveau, classe, q, sort_by, sort_dir } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 100));

  const filters = [];
  const params = [];
  if (date) { filters.push('date = ?'); params.push(date); }
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (cours) { filters.push('cours = ?'); params.push(cours); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (classe) { filters.push('classe = ?'); params.push(classe); }
  if (q) { filters.push('(nom LIKE ? OR prenom LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const whereClause = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const { c: total } = await db.prepare(`SELECT COUNT(*) c FROM pointage${whereClause}`).get(...params);

  const sortCol = SORTABLE.includes(sort_by) ? sort_by : 'date';
  const sortDir = sort_dir === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;

  const rows = await db.prepare(
    `SELECT * FROM pointage${whereClause} ORDER BY ${sortCol} ${sortDir}, nom, prenom LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  res.json({
    rows: await attachAssiduite(await resolveLinkedFields('pointage', rows)),
    total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

const IDENT_EXPR = `CASE WHEN student_id IS NOT NULL THEN 'S' || student_id ELSE 'N' || LOWER(TRIM(COALESCE(nom,''))) || '|' || LOWER(TRIM(COALESCE(prenom,''))) END`;

async function findPointageDuplicateGroups() {
  // HAVING ne peut pas référencer un alias de sortie en Postgres : l'agrégat y est répété.
  const groups = await db.prepare(
    `SELECT
       ${IDENT_EXPR} AS ident,
       COALESCE(date,'') AS dkey, COALESCE(ecole,'') AS ekey, COALESCE(cours,'') AS ckey, COALESCE(heure_debut,'') AS hkey,
       COUNT(*) AS c
     FROM pointage
     GROUP BY ident, dkey, ekey, ckey, hkey
     HAVING COUNT(*) > 1`
  ).all();
  const out = [];
  for (const g of groups) {
    const rows = await db.prepare(
      `SELECT id, student_id, nom, prenom, date, ecole, cours, niveau, classe, heure_debut, heure_fin, heure_arrivee, heure_expulsion
       FROM pointage
       WHERE (${IDENT_EXPR}) = ?
         AND COALESCE(date,'') = ? AND COALESCE(ecole,'') = ? AND COALESCE(cours,'') = ? AND COALESCE(heure_debut,'') = ?
       ORDER BY id`
    ).all(g.ident, g.dkey, g.ekey, g.ckey, g.hkey);
    if (!rows.length) continue;
    out.push({ nom: rows[0].nom, prenom: rows[0].prenom, date: rows[0].date, ecole: rows[0].ecole, cours: rows[0].cours, count: rows.length, rows });
  }
  return out;
}

router.get('/duplicates', async (req, res) => {
  const groups = await findPointageDuplicateGroups();
  const extra = groups.reduce((sum, g) => sum + (g.count - 1), 0);
  res.json({ groups, groupCount: groups.length, extraCount: extra });
});

// Fusionne chaque groupe de doublons : conserve l'entrée la plus ancienne, en priorité
// celle qui a déjà une présence/expulsion enregistrée, puis supprime les autres.
router.post('/dedupe', async (req, res) => {
  const groups = await findPointageDuplicateGroups();
  let removed = 0;
  const tx = db.transaction(async () => {
    for (const g of groups) {
      const sorted = [...g.rows].sort((a, b) => {
        const scoreA = (a.heure_arrivee ? 1 : 0) + (a.heure_expulsion ? 1 : 0);
        const scoreB = (b.heure_arrivee ? 1 : 0) + (b.heure_expulsion ? 1 : 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.id - b.id;
      });
      const extras = sorted.slice(1);
      for (const extra of extras) {
        await db.prepare(`DELETE FROM pointage WHERE id = ?`).run(extra.id);
        removed++;
      }
    }
  });
  await tx();
  res.json({ ok: true, removed, groups: groups.length });
});

const BULK_FIELDS = ['classe', 'ecole', 'niveau', 'heure_debut', 'heure_fin'];

// Marquer plusieurs étudiants présents en une fois (session en cours)
router.post('/bulk-present', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const t = nowIso();
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`UPDATE pointage SET heure_arrivee = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(t, ...ids);
  res.json({ ok: true, updated: info.changes });
});

router.post('/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`DELETE FROM pointage WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, deleted: info.changes });
});

router.post('/bulk-update', async (req, res) => {
  const { ids, field, value } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const cols = await db.tableColumns('pointage');
  if (!BULK_FIELDS.includes(field) || !cols.includes(field)) return res.status(400).json({ error: 'Champ non autorisé' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`UPDATE pointage SET ${field} = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(value || null, ...ids);
  res.json({ ok: true, updated: info.changes });
});

// Étudiants du niveau donné, pas encore présents dans cette session
router.get('/candidates', async (req, res) => {
  const { date, ecole, cours, niveau, classe, search } = req.query;
  if (!date || !cours) return res.status(400).json({ error: 'date et cours requis' });

  const already = (await db.prepare(
    `SELECT student_id FROM pointage WHERE date = ? AND cours = ? AND ${ECOLE_MATCH} AND student_id IS NOT NULL`
  ).all(date, cours, ecole || null)).map(r => r.student_id);

  let query = `SELECT * FROM students WHERE 1=1`;
  const params = [];
  if (niveau) {
    query += ` AND niveau = ?`;
    params.push(niveau);
  }
  if (classe) {
    query += ` AND classe = ?`;
    params.push(classe);
  }
  if (already.length) {
    query += ` AND id NOT IN (${already.map(() => '?').join(',')})`;
    params.push(...already);
  }
  if (search) {
    query += ` AND (nom LIKE ? OR prenom LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ` ORDER BY nom, prenom`;
  res.json(await db.prepare(query).all(...params));
});

// Charger automatiquement tous les étudiants du niveau dans la session de pointage
router.post('/init', async (req, res) => {
  const { date, ecole, cours, niveau, heure_debut, heure_fin } = req.body;
  if (!date || !cours) return res.status(400).json({ error: 'date et cours requis' });

  const already = (await db.prepare(
    `SELECT student_id FROM pointage WHERE date = ? AND cours = ? AND ${ECOLE_MATCH} AND student_id IS NOT NULL`
  ).all(date, cours, ecole || null)).map(r => r.student_id);

  const students = niveau
    ? await db.prepare(`SELECT * FROM students WHERE niveau = ?`).all(niveau)
    : [];
  const toAdd = students.filter(s => !already.includes(s.id));

  const cours_id = await resolveCoursId(ecole, cours, niveau);
  const insertMany = db.transaction(async (list) => {
    for (const s of list) {
      await insertRow(db, 'pointage', {
        code: await db.nextPointageCode(date), student_id: s.id, cours_id, nom: s.nom, prenom: s.prenom, classe: s.classe,
        ecole: ecole || null, cours, niveau: niveau || null, date, heure_debut: heure_debut || null, heure_fin: heure_fin || null,
      });
    }
  });
  await insertMany(toAdd);

  res.json(await db.prepare(
    `SELECT * FROM pointage WHERE date = ? AND cours = ? AND ${ECOLE_MATCH} ORDER BY nom, prenom`
  ).all(date, cours, ecole || null));
});

// Valider un chargement en attente (liste d'étudiants choisie côté client, pas encore persistée) :
// insère en une seule transaction, en ignorant silencieusement ceux déjà présents dans la session.
router.post('/bulk-add', async (req, res) => {
  const { date, ecole, cours, niveau, heure_debut, heure_fin, student_ids } = req.body;
  if (!date || !cours || !Array.isArray(student_ids) || !student_ids.length) {
    return res.status(400).json({ error: 'date, cours et student_ids requis' });
  }
  const cours_id = await resolveCoursId(ecole, cours, niveau);
  let inserted = 0;
  const tx = db.transaction(async () => {
    for (const sid of student_ids) {
      const student = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(sid);
      if (!student) continue;
      const exists = await db.prepare(
        `SELECT id FROM pointage WHERE date = ? AND cours = ? AND ${ECOLE_MATCH} AND student_id = ?`
      ).get(date, cours, ecole || null, sid);
      if (exists) continue;
      await insertRow(db, 'pointage', {
        code: await db.nextPointageCode(date), student_id: student.id, cours_id, nom: student.nom, prenom: student.prenom, classe: student.classe,
        ecole: ecole || null, cours, niveau: niveau || student.niveau || null, date, heure_debut: heure_debut || null, heure_fin: heure_fin || null,
      });
      inserted++;
    }
  });
  await tx();
  res.json({ ok: true, inserted });
});

// Ajouter manuellement un étudiant précis à une session de pointage
router.post('/add', async (req, res) => {
  const { student_id, date, ecole, cours, niveau, heure_debut, heure_fin } = req.body;
  if (!student_id || !date || !cours) return res.status(400).json({ error: 'student_id, date et cours requis' });
  const student = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(student_id);
  if (!student) return res.status(404).json({ error: 'Étudiant introuvable' });

  const exists = await db.prepare(
    `SELECT id FROM pointage WHERE date = ? AND cours = ? AND ${ECOLE_MATCH} AND student_id = ?`
  ).get(date, cours, ecole || null, student_id);
  if (exists) return res.status(409).json({ error: 'Étudiant déjà présent dans cette session' });

  const info = await insertRow(db, 'pointage', {
    code: await db.nextPointageCode(date), student_id: student.id, cours_id: await resolveCoursId(ecole, cours, niveau || student.niveau), nom: student.nom, prenom: student.prenom, classe: student.classe,
    ecole: ecole || null, cours, niveau: niveau || student.niveau || null, date, heure_debut: heure_debut || null, heure_fin: heure_fin || null,
  });
  res.status(201).json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(info.lastInsertRowid));
});

// Capturer l'heure de présence (clic "Présent"). Le client transmet l'heure du clic (heure_arrivee) pour que la
// validation différée des modifications n'écrase pas ce moment par l'heure de validation.
router.post('/:id/arrivee', async (req, res) => {
  const row = await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entrée introuvable' });
  const { heure_arrivee } = req.body;
  const t = (heure_arrivee && !Number.isNaN(new Date(heure_arrivee).getTime())) ? heure_arrivee : nowIso();
  await db.prepare(`UPDATE pointage SET heure_arrivee = ?, updated_at = datetime('now') WHERE id = ?`).run(t, req.params.id);
  res.json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id));
});

router.post('/:id/arrivee/annuler', async (req, res) => {
  const row = await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entrée introuvable' });
  await db.prepare(`UPDATE pointage SET heure_arrivee = NULL, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id));
});

// Expulser un étudiant avec raison. Le client transmet l'heure du clic (heure_expulsion) pour que la
// validation différée des modifications n'écrase pas ce moment par l'heure de validation.
router.post('/:id/expulser', async (req, res) => {
  const row = await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entrée introuvable' });
  const { raison, heure_expulsion } = req.body;
  if (!raison || !raison.trim()) return res.status(400).json({ error: 'La raison est requise' });
  const t = (heure_expulsion && !Number.isNaN(new Date(heure_expulsion).getTime())) ? heure_expulsion : nowIso();
  await db.prepare(`UPDATE pointage SET heure_expulsion = ?, raison_expulsion = ?, updated_at = datetime('now') WHERE id = ?`).run(t, raison.trim(), req.params.id);
  res.json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id));
});

router.post('/:id/expulser/annuler', async (req, res) => {
  const row = await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entrée introuvable' });
  await db.prepare(`UPDATE pointage SET heure_expulsion = NULL, raison_expulsion = NULL, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id));
});

// Modification manuelle libre (toujours possible) — toute valeur de la table est éditable.
const EDITABLE_FIELDS = ['nom', 'prenom', 'classe', 'date', 'ecole', 'cours', 'niveau', 'heure_debut', 'heure_fin', 'heure_arrivee', 'heure_expulsion', 'raison_expulsion'];
async function updatePointageRow(req, res) {
  const existing = await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entrée introuvable' });
  const cols = await db.tableColumns('pointage');
  const updates = {};
  for (const f of EDITABLE_FIELDS) {
    if (!cols.includes(f)) continue;
    if (req.body[f] !== undefined) updates[f] = req.body[f] === '' ? null : req.body[f];
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setClause) {
    await db.prepare(`UPDATE pointage SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
      .run(...Object.values(updates), req.params.id);
  }
  res.json(await db.prepare(`SELECT * FROM pointage WHERE id = ?`).get(req.params.id));
}
router.patch('/:id', updatePointageRow);
router.put('/:id', updatePointageRow);

router.delete('/:id', async (req, res) => {
  await db.prepare(`DELETE FROM pointage WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

module.exports = router;
