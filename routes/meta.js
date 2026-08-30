const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');

// Source unique de vérité pour les filtres en cascade sur toutes les tables :
// École / Cours / Niveau proviennent de la table Cours, Classe provient de la table Étudiants.
// La Classe n'existe pas dans Cours : le pont entre les deux tables se fait par le Niveau (et l'École)
// partagés, pour que choisir une Classe restreigne aussi École/Niveau/Cours, et inversement.
router.get('/facets', async (req, res) => {
  const { ecole, niveau, cours, classe } = req.query;

  let classeNiveaux = null;
  let classeEcoles = null;
  if (classe) {
    const p1 = [classe];
    let sql1 = `SELECT DISTINCT niveau FROM students WHERE classe = ? AND niveau IS NOT NULL AND niveau != ''`;
    if (ecole) { sql1 += ' AND ecole = ?'; p1.push(ecole); }
    classeNiveaux = (await db.prepare(sql1).all(...p1)).map(r => r.niveau);

    const p2 = [classe];
    let sql2 = `SELECT DISTINCT ecole FROM students WHERE classe = ? AND ecole IS NOT NULL AND ecole != ''`;
    if (niveau) { sql2 += ' AND niveau = ?'; p2.push(niveau); }
    classeEcoles = (await db.prepare(sql2).all(...p2)).map(r => r.ecole);
  }

  async function coursesFacet(field) {
    const clauses = [`${field} IS NOT NULL`, `${field} != ''`];
    const params = [];
    if (field !== 'ecole' && ecole) { clauses.push('ecole = ?'); params.push(ecole); }
    if (field !== 'niveau' && niveau) { clauses.push('niveau = ?'); params.push(niveau); }
    if (field !== 'cours' && cours) { clauses.push('cours = ?'); params.push(cours); }
    // Une liste vide doit rendre la facette vide. Postgres exige un booléen dans WHERE : `false`,
    // là où SQLite acceptait l'entier 0.
    if (field !== 'niveau' && classeNiveaux) {
      clauses.push(classeNiveaux.length ? `niveau IN (${classeNiveaux.map(() => '?').join(',')})` : 'false');
      params.push(...classeNiveaux);
    }
    if (field !== 'ecole' && classeEcoles) {
      clauses.push(classeEcoles.length ? `ecole IN (${classeEcoles.map(() => '?').join(',')})` : 'false');
      params.push(...classeEcoles);
    }
    const rows = await db.prepare(`SELECT DISTINCT ${field} AS v FROM courses WHERE ${clauses.join(' AND ')} ORDER BY v`).all(...params);
    return rows.map(r => r.v);
  }

  const classeFilters = [`classe IS NOT NULL`, `classe != ''`];
  const classeParams = [];
  if (ecole) { classeFilters.push('ecole = ?'); classeParams.push(ecole); }
  if (niveau) { classeFilters.push('niveau = ?'); classeParams.push(niveau); }
  const classes = (await db.prepare(
    `SELECT DISTINCT classe AS v FROM students WHERE ${classeFilters.join(' AND ')} ORDER BY v`
  ).all(...classeParams)).map(r => r.v);

  res.json({
    ecoles: await coursesFacet('ecole'),
    niveaux: await coursesFacet('niveau'),
    cours: await coursesFacet('cours'),
    classes,
  });
});

module.exports = router;
