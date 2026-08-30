const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');
const { BUILTIN_FIELDS, VALID_LINKS, DEFAULT_LINK_KEYS } = require('./_linkedFields');

const ALLOWED_TABLES = ['students', 'courses', 'pointage'];
const TABLE_LABELS = { students: 'Étudiants', courses: 'Cours', pointage: 'Pointage' };
const FORMATS = ['text', 'heure', 'nombre', 'date'];

function slugify(label) {
  return label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

router.get('/', async (req, res) => {
  const { table } = req.query;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  res.json(await db.prepare(`SELECT * FROM field_defs WHERE table_name = ? ORDER BY id`).all(table));
});

// Colonnes actuellement présentes en base pour une table (reflète les suppressions de colonnes natives).
router.get('/schema', async (req, res) => {
  const { table } = req.query;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  res.json(await db.tableColumns(table));
});

// Pour une table donnée, les tables cibles valides et leurs champs disponibles (pour lier une nouvelle colonne),
// ainsi que les colonnes de la table elle-même utilisables comme clé de jointure locale.
router.get('/linkable', async (req, res) => {
  const { table } = req.query;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  const targets = [];
  for (const targetTable of VALID_LINKS[table] || []) {
    const customs = await db.prepare(`SELECT field_key, label FROM field_defs WHERE table_name = ? AND linked_table IS NULL`).all(targetTable);
    targets.push({
      table: targetTable,
      label: TABLE_LABELS[targetTable],
      fields: [
        ...BUILTIN_FIELDS[targetTable].map(f => ({ key: f, label: f })),
        ...customs.map(f => ({ key: f.field_key, label: f.label })),
      ],
      // Colonnes de la table cible utilisables comme clé de jointure (côté "cible" du VLOOKUP).
      keyFields: [{ key: 'id', label: 'id (identifiant interne)' }, ...BUILTIN_FIELDS[targetTable].map(f => ({ key: f, label: f }))],
    });
  }
  const localKeyFields = [
    { key: 'id', label: 'id (identifiant interne)' },
    ...(table === 'pointage' ? [{ key: 'student_id', label: 'student_id (lien étudiant)' }] : []),
    ...BUILTIN_FIELDS[table].map(f => ({ key: f, label: f })),
  ];
  res.json({ targets, localKeyFields });
});

function isValidKeyColumn(table, key) {
  if (key === 'id') return true;
  if (table === 'pointage' && key === 'student_id') return true;
  return Boolean(BUILTIN_FIELDS[table]?.includes(key));
}

async function validateLinkTarget(table, linked_table, linked_field) {
  if (!(VALID_LINKS[table] || []).includes(linked_table)) {
    return 'Liaison non autorisée vers cette table';
  }
  const customFieldExists = await db.prepare(`SELECT id FROM field_defs WHERE table_name = ? AND field_key = ? AND is_builtin = 0`).get(linked_table, linked_field);
  if (!BUILTIN_FIELDS[linked_table]?.includes(linked_field) && !customFieldExists) {
    return 'Champ cible introuvable';
  }
  return null;
}

// Résout la paire (clé locale, clé cible) utilisée pour le matching : celles fournies par l'utilisateur,
// sinon la paire par défaut de la relation, validées contre les colonnes réellement disponibles.
function resolveLinkKeys(table, linked_table, link_local_key, link_target_key) {
  const fallback = DEFAULT_LINK_KEYS[`${table}->${linked_table}`] || { local: 'id', target: 'id' };
  const localKey = link_local_key || fallback.local;
  const targetKey = link_target_key || fallback.target;
  if (!isValidKeyColumn(table, localKey)) return { error: `Colonne locale invalide : ${localKey}` };
  if (!isValidKeyColumn(linked_table, targetKey)) return { error: `Colonne cible invalide : ${targetKey}` };
  return { localKey, targetKey };
}

router.post('/', async (req, res) => {
  const { table, label, linked_table, linked_field, format, link_local_key, link_target_key } = req.body;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  if (!label || !label.trim()) return res.status(400).json({ error: 'Nom du champ requis' });
  const key = slugify(label);
  if (!key) return res.status(400).json({ error: 'Nom de champ invalide' });
  if (BUILTIN_FIELDS[table]?.includes(key)) return res.status(409).json({ error: 'Ce nom est réservé à une colonne native' });
  const exists = await db.prepare(`SELECT id FROM field_defs WHERE table_name = ? AND field_key = ?`).get(table, key);
  if (exists) return res.status(409).json({ error: 'Un champ avec ce nom existe déjà' });
  const formatVal = FORMATS.includes(format) ? format : 'text';

  let linkedTableVal = null, linkedFieldVal = null, localKeyVal = null, targetKeyVal = null;
  if (linked_table) {
    const err = await validateLinkTarget(table, linked_table, linked_field);
    if (err) return res.status(400).json({ error: err });
    const keys = resolveLinkKeys(table, linked_table, link_local_key, link_target_key);
    if (keys.error) return res.status(400).json({ error: keys.error });
    linkedTableVal = linked_table;
    linkedFieldVal = linked_field;
    localKeyVal = keys.localKey;
    targetKeyVal = keys.targetKey;
  }

  const info = await db.prepare(
    `INSERT INTO field_defs (table_name, field_key, label, linked_table, linked_field, format, link_local_key, link_target_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(table, key, label.trim(), linkedTableVal, linkedFieldVal, formatVal, localKeyVal, targetKeyVal);
  res.status(201).json(await db.prepare(`SELECT * FROM field_defs WHERE id = ?`).get(info.lastInsertRowid));
});

// Configurer (créer ou mettre à jour) la liaison d'une colonne NATIVE existante vers une autre table —
// équivalent d'un VLOOKUP Excel : la colonne devient calculée/lecture seule tant que la liaison est active.
router.post('/builtin-link', async (req, res) => {
  const { table, field_key, linked_table, linked_field, link_local_key, link_target_key } = req.body;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  if (!BUILTIN_FIELDS[table]?.includes(field_key)) return res.status(400).json({ error: 'Colonne native introuvable' });
  if (!linked_table) return res.status(400).json({ error: 'Table cible requise' });
  const err = await validateLinkTarget(table, linked_table, linked_field);
  if (err) return res.status(400).json({ error: err });
  const keys = resolveLinkKeys(table, linked_table, link_local_key, link_target_key);
  if (keys.error) return res.status(400).json({ error: keys.error });

  const existing = await db.prepare(`SELECT id FROM field_defs WHERE table_name = ? AND field_key = ? AND is_builtin = 1`).get(table, field_key);
  if (existing) {
    await db.prepare(`UPDATE field_defs SET linked_table = ?, linked_field = ?, link_local_key = ?, link_target_key = ? WHERE id = ?`)
      .run(linked_table, linked_field, keys.localKey, keys.targetKey, existing.id);
    return res.json(await db.prepare(`SELECT * FROM field_defs WHERE id = ?`).get(existing.id));
  }
  const info = await db.prepare(
    `INSERT INTO field_defs (table_name, field_key, label, linked_table, linked_field, is_builtin, link_local_key, link_target_key)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(table, field_key, field_key, linked_table, linked_field, keys.localKey, keys.targetKey);
  res.status(201).json(await db.prepare(`SELECT * FROM field_defs WHERE id = ?`).get(info.lastInsertRowid));
});

// Modifier un champ existant : renommer, reconfigurer sa liaison (activer/changer/retirer), changer son format.
router.patch('/:id', async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM field_defs WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' });
  const { label, linked_table, linked_field, format, link_local_key, link_target_key } = req.body;

  const updates = {};
  if (label !== undefined) {
    if (!label.trim()) return res.status(400).json({ error: 'Nom du champ requis' });
    updates.label = label.trim();
  }
  if (format !== undefined) {
    updates.format = FORMATS.includes(format) ? format : 'text';
  }
  if (linked_table !== undefined) {
    if (!linked_table) {
      updates.linked_table = null;
      updates.linked_field = null;
      updates.link_local_key = null;
      updates.link_target_key = null;
    } else {
      const err = await validateLinkTarget(existing.table_name, linked_table, linked_field);
      if (err) return res.status(400).json({ error: err });
      const keys = resolveLinkKeys(existing.table_name, linked_table, link_local_key, link_target_key);
      if (keys.error) return res.status(400).json({ error: keys.error });
      updates.linked_table = linked_table;
      updates.linked_field = linked_field;
      updates.link_local_key = keys.localKey;
      updates.link_target_key = keys.targetKey;
    }
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setClause) {
    await db.prepare(`UPDATE field_defs SET ${setClause} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  }
  res.json(await db.prepare(`SELECT * FROM field_defs WHERE id = ?`).get(req.params.id));
});

// Supprime un champ personnalisé, ou retire la liaison d'une colonne native (redevient librement éditable).
router.delete('/:id', async (req, res) => {
  await db.prepare(`DELETE FROM field_defs WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

// Supprime DÉFINITIVEMENT une colonne native (ALTER TABLE DROP COLUMN) — irréversible, retire la
// valeur de cette colonne sur toutes les lignes de la table. Nettoie aussi les liaisons devenues invalides.
router.delete('/builtin-column', async (req, res) => {
  const { table, field_key } = req.body;
  if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ error: 'Table non autorisée' });
  if (!BUILTIN_FIELDS[table]?.includes(field_key)) return res.status(400).json({ error: 'Colonne native introuvable ou protégée' });
  await db.dropColumnIfExists(table, field_key);
  await db.prepare(`DELETE FROM field_defs WHERE table_name = ? AND field_key = ? AND is_builtin = 1`).run(table, field_key);
  await db.prepare(`DELETE FROM field_defs WHERE linked_table = ? AND (linked_field = ? OR link_target_key = ?)`).run(table, field_key, field_key);
  res.status(204).end();
});

module.exports = router;
