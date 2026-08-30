const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');
const { attachExtraFieldRoute } = require('./_extraFields');
const { buildFacets } = require('./_facets');
const { insertRow, updateRow } = require('./_dynamicSql');

const BULK_FIELDS = ['ecole', 'niveau', 'vh', 'nb_seances'];
const FACET_FIELDS = ['ecole', 'niveau', 'cours'];

attachExtraFieldRoute(router, 'courses');

router.get('/facets', async (req, res) => {
  const { ecole, niveau, cours, search } = req.query;
  let extraWhere = null;
  if (search) {
    const q = `%${search}%`;
    extraWhere = { clause: 'cours LIKE ?', params: [q] };
  }
  res.json(await buildFacets(db, 'courses', FACET_FIELDS, { ecole, niveau, cours }, extraWhere));
});

router.get('/', async (req, res) => {
  const { ecole, niveau, cours, search } = req.query;
  const filters = [];
  const params = [];
  if (ecole) { filters.push('ecole = ?'); params.push(ecole); }
  if (niveau) { filters.push('niveau = ?'); params.push(niveau); }
  if (cours) { filters.push('cours = ?'); params.push(cours); }
  if (search) {
    filters.push('(ecole LIKE ? OR cours LIKE ? OR niveau LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  let sql = 'SELECT * FROM courses';
  if (filters.length) sql += ' WHERE ' + filters.join(' AND ');
  sql += ' ORDER BY ecole, cours';
  res.json(await db.prepare(sql).all(...params));
});

// Postgres n'autorise pas un alias de sortie dans HAVING (contrairement à SQLite).
async function findCourseDuplicateGroups() {
  const groups = await db.prepare(
    `SELECT LOWER(TRIM(COALESCE(ecole,''))) AS ekey, LOWER(TRIM(cours)) AS ckey,
            LOWER(TRIM(COALESCE(niveau,''))) AS nkey,
            COUNT(*) AS c
     FROM courses GROUP BY ekey, ckey, nkey HAVING COUNT(*) > 1`
  ).all();
  const out = [];
  for (const g of groups) {
    const rows = await db.prepare(
      `SELECT id, ecole, cours, niveau FROM courses
       WHERE LOWER(TRIM(COALESCE(ecole,''))) = ? AND LOWER(TRIM(cours)) = ?
         AND LOWER(TRIM(COALESCE(niveau,''))) = ?
       ORDER BY id`
    ).all(g.ekey, g.ckey, g.nkey);
    out.push({ ecole: rows[0].ecole, cours: rows[0].cours, niveau: rows[0].niveau, count: rows.length, rows });
  }
  return out;
}

router.get('/duplicates', async (req, res) => {
  const groups = await findCourseDuplicateGroups();
  const extra = groups.reduce((sum, g) => sum + (g.count - 1), 0);
  res.json({ groups, groupCount: groups.length, extraCount: extra });
});

router.post('/dedupe', async (req, res) => {
  const groups = await findCourseDuplicateGroups();
  let removed = 0;
  const tx = db.transaction(async () => {
    for (const g of groups) {
      const [, ...extras] = g.rows;
      for (const extra of extras) {
        await db.prepare(`DELETE FROM courses WHERE id = ?`).run(extra.id);
        removed++;
      }
    }
  });
  await tx();
  res.json({ ok: true, removed, groups: groups.length });
});

router.post('/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`DELETE FROM courses WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, deleted: info.changes });
});

router.post('/bulk-update', async (req, res) => {
  const { ids, field, value } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requis' });
  const cols = await db.tableColumns('courses');
  if (!BULK_FIELDS.includes(field) || !cols.includes(field)) return res.status(400).json({ error: 'Champ non autorisé' });
  const placeholders = ids.map(() => '?').join(',');
  const info = await db.prepare(`UPDATE courses SET ${field} = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(value || null, ...ids);
  res.json({ ok: true, updated: info.changes });
});

router.post('/', async (req, res) => {
  const { ecole, cours, niveau, vh, nb_seances } = req.body;
  if (!cours) return res.status(400).json({ error: 'Nom du cours requis' });
  const code = await db.nextCourseCode(ecole, niveau);
  const info = await insertRow(db, 'courses', {
    code, ecole: ecole || null, cours: cours.trim(), niveau: niveau || null, vh: vh || null, nb_seances: nb_seances || null,
  });
  res.status(201).json(await db.prepare(`SELECT * FROM courses WHERE id = ?`).get(info.lastInsertRowid));
});

router.put('/:id', async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM courses WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Cours introuvable' });
  const { ecole, cours, niveau, vh, nb_seances } = req.body;
  await updateRow(db, 'courses', req.params.id, {
    ecole: ecole ?? existing.ecole,
    cours: cours ?? existing.cours,
    niveau: niveau ?? existing.niveau,
    vh: vh ?? existing.vh,
    nb_seances: nb_seances ?? existing.nb_seances,
  });
  res.json(await db.prepare(`SELECT * FROM courses WHERE id = ?`).get(req.params.id));
});

router.delete('/:id', async (req, res) => {
  await db.prepare(`DELETE FROM courses WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

module.exports = router;
