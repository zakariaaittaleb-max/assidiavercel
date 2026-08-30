const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');
const { attachExtraFieldRoute } = require('./_extraFields');
const { buildFacets } = require('./_facets');
const { resolveLinkedFields } = require('./_linkedFields');
const { insertRow, updateRow } = require('./_dynamicSql');

const BULK_FIELDS = ['classe', 'niveau', 'ecole'];
const FACET_FIELDS = ['classe', 'niveau', 'ecole'];

attachExtraFieldRoute(router, 'students');

// Options disponibles pour chaque filtre, compte tenu des autres filtres actifs
router.get('/facets', async (req, res) => {
  const { classe, niveau, ecole, search } = req.query;
  let extraWhere = null;
  if (search) {
    const q = `%${search}%`;
    extraWhere = { clause: '(nom LIKE ? OR prenom LIKE ?)', params: [q, q] };
  }
  res.json(await buildFacets(db, 'students', FACET_FIELDS, { classe, niveau, ecole }, extraWhere));
});

router.post('/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`DELETE FROM students WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, deleted: info.changes });
});

router.post('/bulk-update', async (req, res) => {
  const { ids, field, value } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const cols = await db.tableColumns('students');
  if (!BULK_FIELDS.includes(field) || !cols.includes(field)) return res.status(400).json({ error: 'Champ non autorisé' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`UPDATE students SET ${field} = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(value || null, ...ids);
  res.json({ ok: true, updated: info.changes });
});

// Postgres n'autorise pas un alias de sortie dans HAVING (contrairement à SQLite) : la condition
// répète donc l'agrégat.
async function findDuplicateGroups() {
  const groups = await db.prepare(
    `SELECT LOWER(TRIM(nom)) AS nkey, LOWER(TRIM(prenom)) AS pkey, COUNT(*) AS c
     FROM students GROUP BY nkey, pkey HAVING COUNT(*) > 1`
  ).all();
  const out = [];
  for (const g of groups) {
    const rows = await db.prepare(
      `SELECT id, nom, prenom, classe, niveau, ecole FROM students
       WHERE LOWER(TRIM(nom)) = ? AND LOWER(TRIM(prenom)) = ? ORDER BY id`
    ).all(g.nkey, g.pkey);
    out.push({ nom: rows[0].nom, prenom: rows[0].prenom, count: rows.length, rows });
  }
  return out;
}

// Aperçu des doublons (nom + prénom identiques, insensible à la casse)
router.get('/duplicates', async (req, res) => {
  const groups = await findDuplicateGroups();
  const extra = groups.reduce((sum, g) => sum + (g.count - 1), 0);
  res.json({ groups, groupCount: groups.length, extraCount: extra });
});

// Fusionne chaque groupe de doublons : conserve la fiche la plus ancienne,
// réattribue le pointage des autres fiches puis les supprime (aucune donnée de présence perdue).
router.post('/dedupe', async (req, res) => {
  const groups = await findDuplicateGroups();
  let removed = 0;
  let reassigned = 0;
  const tx = db.transaction(async () => {
    for (const g of groups) {
      const [keep, ...extras] = g.rows;
      for (const extra of extras) {
        const info = await db.prepare(`UPDATE pointage SET student_id = ? WHERE student_id = ?`).run(keep.id, extra.id);
        reassigned += info.changes;
        await db.prepare(`DELETE FROM students WHERE id = ?`).run(extra.id);
        removed++;
      }
    }
  });
  await tx();
  res.json({ ok: true, removed, reassigned, groups: groups.length });
});

router.get('/', async (req, res) => {
  const { search, classe, niveau, ecole } = req.query;
  const filters = [];
  const params = [];
  if (classe) { filters.push('classe = ?'); params.push(classe); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (search) {
    filters.push('(nom LIKE ? OR prenom LIKE ? OR classe LIKE ? OR niveau LIKE ? OR ecole LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  let sql = 'SELECT * FROM students';
  if (filters.length) sql += ' WHERE ' + filters.join(' AND ');
  sql += ' ORDER BY nom, prenom';
  const rows = await db.prepare(sql).all(...params);
  res.json(await resolveLinkedFields('students', rows));
});

router.post('/', async (req, res) => {
  const { nom, prenom, classe, niveau, ecole, external_id } = req.body;
  if (!nom || !prenom) return res.status(400).json({ error: 'Nom et prénom requis' });
  const code = await db.nextStudentCode(ecole);
  const info = await insertRow(db, 'students', {
    code, external_id: external_id || null, nom: nom.trim(), prenom: prenom.trim(),
    classe: classe || null, niveau: niveau || null, ecole: ecole || null,
  });
  const row = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const { nom, prenom, classe, niveau, ecole, external_id } = req.body;
  const existing = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Étudiant introuvable' });
  await updateRow(db, 'students', req.params.id, {
    nom: nom ?? existing.nom,
    prenom: prenom ?? existing.prenom,
    classe: classe ?? existing.classe,
    niveau: niveau ?? existing.niveau,
    ecole: ecole ?? existing.ecole,
    external_id: external_id ?? existing.external_id,
  });
  res.json(await db.prepare(`SELECT * FROM students WHERE id = ?`).get(req.params.id));
});

router.delete('/:id', async (req, res) => {
  await db.prepare(`DELETE FROM students WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

module.exports = router;
