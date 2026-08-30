const db = require('../db');

const BUILTIN_FIELDS = {
  students: ['nom', 'prenom', 'classe', 'niveau', 'ecole'],
  courses: ['ecole', 'cours', 'niveau', 'vh', 'nb_seances'],
  pointage: ['nom', 'prenom', 'date', 'ecole', 'cours', 'niveau', 'classe', 'heure_debut', 'heure_fin', 'heure_arrivee', 'heure_expulsion', 'raison_expulsion'],
};

// Directions de liaison autorisées : la table de gauche peut afficher un champ calculé
// provenant de la table de droite (relation plusieurs-vers-un).
const VALID_LINKS = { pointage: ['students', 'courses'], students: ['courses'], courses: [] };

// Clé de jointure par défaut quand l'utilisateur n'en précise pas explicitement à la création du lien
// (reproduit le comportement historique : student_id->id, cours->cours, niveau->niveau).
const DEFAULT_LINK_KEYS = {
  'pointage->students': { local: 'student_id', target: 'id' },
  'pointage->courses': { local: 'cours', target: 'cours' },
  'students->courses': { local: 'niveau', target: 'niveau' },
};

function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

function valueFor(row, fieldKey) {
  if (!row) return null;
  if (fieldKey === 'id') return row.id;
  if (BUILTIN_FIELDS[row.__table]?.includes(fieldKey)) return row[fieldKey];
  const extra = safeParse(row.extra);
  return extra[fieldKey] ?? null;
}

// Écrit la valeur calculée soit directement sur la colonne native (liaison "VLOOKUP" d'une colonne
// existante), soit dans le blob "extra" (champ personnalisé lié) — comme le fait déjà chaque appelant.
function setComputedValue(row, def, value) {
  if (def.is_builtin) {
    row[def.field_key] = value;
  } else {
    const extra = safeParse(row.extra);
    extra[def.field_key] = value;
    row.extra = JSON.stringify(extra);
  }
}

// Injecte les valeurs des champs "liés" (personnalisés ou colonnes natives en mode VLOOKUP) dans chaque
// ligne, en appariant sur la clé de jointure explicite (link_local_key/link_target_key) choisie par
// l'utilisateur à la configuration du lien — ou la paire par défaut de la relation si non précisée.
async function resolveLinkedFields(table, rows) {
  const defs = await db.prepare(
    `SELECT * FROM field_defs WHERE table_name = ? AND linked_table IS NOT NULL AND linked_field IS NOT NULL`
  ).all(table);
  if (!defs.length || !rows.length) return rows;

  for (const def of defs) {
    const fallback = DEFAULT_LINK_KEYS[`${table}->${def.linked_table}`] || { local: 'id', target: 'id' };
    const localKey = def.link_local_key || fallback.local;
    const targetKey = def.link_target_key || fallback.target;
    const cache = new Map();
    for (const row of rows) {
      const localVal = localKey === 'id' ? row.id : row[localKey];
      if (localVal === undefined || localVal === null || localVal === '') { setComputedValue(row, def, null); continue; }
      const cacheKey = String(localVal);
      if (!cache.has(cacheKey)) {
        const target = targetKey === 'id'
          ? await db.prepare(`SELECT * FROM ${def.linked_table} WHERE id = ?`).get(localVal)
          : await db.prepare(`SELECT * FROM ${def.linked_table} WHERE COALESCE(${targetKey},'') = ? LIMIT 1`).get(String(localVal));
        if (target) target.__table = def.linked_table;
        cache.set(cacheKey, target || null);
      }
      setComputedValue(row, def, valueFor(cache.get(cacheKey), def.linked_field));
    }
  }
  return rows;
}

module.exports = { resolveLinkedFields, BUILTIN_FIELDS, VALID_LINKS, DEFAULT_LINK_KEYS };
