const db = require('../db');

// Retrouve l'id du cours correspondant (ecole+cours+niveau, puis ecole+cours à défaut), pour rattacher
// une ligne de pointage à sa fiche Cours par ID plutôt que par les seuls champs texte dupliqués.
async function resolveCoursId(ecole, cours, niveau) {
  if (!cours) return null;
  const exact = await db.prepare(
    `SELECT id FROM courses WHERE COALESCE(ecole,'') = COALESCE(?,'') AND cours = ? AND COALESCE(niveau,'') = COALESCE(?,'')`
  ).get(ecole || null, cours, niveau || null);
  if (exact) return exact.id;
  const loose = await db.prepare(
    `SELECT id FROM courses WHERE COALESCE(ecole,'') = COALESCE(?,'') AND cours = ? LIMIT 1`
  ).get(ecole || null, cours);
  return loose ? loose.id : null;
}

// Retrouve l'id de l'étudiant correspondant à nom+prenom(+ecole), seulement si le match est unique
// (évite de rattacher à tort deux homonymes) — utilisé notamment pour l'import Excel de l'historique
// de pointage, qui ne fournit que des noms en texte libre.
async function resolveStudentId(nom, prenom, ecole) {
  if (!nom && !prenom) return null;
  const rows = await db.prepare(
    `SELECT id FROM students WHERE UPPER(TRIM(COALESCE(nom,''))) = UPPER(TRIM(?)) AND UPPER(TRIM(COALESCE(prenom,''))) = UPPER(TRIM(?)) AND COALESCE(ecole,'') = COALESCE(?,'')`
  ).all(nom || '', prenom || '', ecole || null);
  return rows.length === 1 ? rows[0].id : null;
}

module.exports = { resolveCoursId, resolveStudentId };
