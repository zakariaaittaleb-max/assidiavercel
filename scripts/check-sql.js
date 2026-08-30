/**
 * Banc de vérification du portage SQLite -> Postgres.
 *
 *   npm run check:sql
 *
 * Démarre l'application en local, s'authentifie, puis appelle chaque endpoint de lecture avec des
 * combinaisons de filtres, dimensions et métriques. Le but n'est pas de vérifier les valeurs
 * métier mais de faire réellement exécuter par Postgres chacune des requêtes réécrites : une
 * tournure restée en dialecte SQLite s'y manifeste immédiatement par une erreur 500.
 */
const app = require('../app');
const db = require('../db');

const results = [];

async function main() {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const username = process.env.CHECK_USER || 'admin';
  const password = process.env.CHECK_PASSWORD;
  if (!password) throw new Error('CHECK_PASSWORD manquant : mot de passe du compte de test.');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`Connexion refusée (${login.status}) : ${await login.text()}`);
  const cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Aucun cookie de session renvoyé.');

  async function check(label, url) {
    let status = 0;
    let detail = '';
    try {
      const res = await fetch(base + url, { headers: { cookie } });
      status = res.status;
      if (!res.ok) detail = (await res.text()).slice(0, 300);
    } catch (err) {
      detail = err.message;
    }
    results.push({ label, url, status, detail });
  }

  // Dimensions et métriques couvrent les expressions SQL les plus spécifiques au dialecte
  // (semaine ISO, jour de la semaine, créneau, volume horaire, retards).
  const DIMENSIONS = ['ecole', 'classe', 'niveau', 'cours', 'etudiant', 'date', 'semaine', 'mois', 'jour_semaine', 'creneau'];
  const METRICS = ['taux_presence', 'taux_absence', 'taux_retard', 'taux_expulsion', 'presents',
    'absences', 'retards', 'expulsions', 'pointages', 'effectif', 'seances', 'retard_moyen',
    'minutes_ratees', 'vh_couvert'];

  await check('stats/meta', '/api/stats/meta');
  await check('stats/overview', '/api/stats/overview');
  await check('stats/overview filtré', '/api/stats/overview?start=2025-09-01&end=2026-07-31&tolerance=15&excludeOrphans=1');
  await check('stats (compat)', '/api/stats/');
  await check('stats/facets', '/api/stats/facets');
  await check('stats/quality', '/api/stats/quality');

  for (const d of DIMENSIONS) {
    await check(`analytics dim=${d}`, `/api/stats/analytics?dimension=${d}`);
  }
  for (const m of METRICS) {
    await check(`analytics metric=${m}`, `/api/stats/analytics?metric=${m}&dimension=ecole`);
    await check(`timeseries metric=${m}`, `/api/stats/timeseries?metric=${m}&granularity=semaine`);
  }
  await check('analytics croisé', '/api/stats/analytics?dimension=ecole&split=niveau&metric=taux_retard');
  await check('timeseries mois + split', '/api/stats/timeseries?granularity=mois&split=ecole');
  for (const d of ['ecole', 'niveau', 'cours', 'classe']) {
    await check(`couverture dim=${d}`, `/api/stats/couverture?dimension=${d}`);
  }

  await check('students', '/api/students');
  await check('students recherche', '/api/students?search=a');
  await check('students facets', '/api/students/facets?search=a');
  await check('students doublons', '/api/students/duplicates');

  await check('courses', '/api/courses');
  await check('courses recherche', '/api/courses?search=e');
  await check('courses facets', '/api/courses/facets');
  await check('courses doublons', '/api/courses/duplicates');

  await check('pointage', '/api/pointage');
  await check('pointage facets', '/api/pointage/facets?q=a');
  await check('pointage timeline', '/api/pointage/timeline?q=a');
  await check('pointage ids', '/api/pointage/ids?q=a');
  await check('pointage search', '/api/pointage/search?page=1&pageSize=20&sort_by=nom&sort_dir=asc&q=a');
  await check('pointage doublons', '/api/pointage/duplicates');
  await check('pointage candidats', '/api/pointage/candidates?date=2025-09-30&cours=Grand%20Oral&search=a');

  await check('meta facets', '/api/meta/facets');
  await check('meta facets classe', '/api/meta/facets?classe=A');

  for (const t of ['students', 'courses', 'pointage']) {
    await check(`fields ${t}`, `/api/fields?table=${t}`);
    await check(`fields schema ${t}`, `/api/fields/schema?table=${t}`);
    await check(`fields linkable ${t}`, `/api/fields/linkable?table=${t}`);
  }

  await check('export excel', '/api/excel/export');

  server.close();
  await db.pool.end();

  const failed = results.filter(r => r.status !== 200);
  for (const r of results) {
    console.log(`${r.status === 200 ? ' ok ' : 'FAIL'}  ${String(r.status).padEnd(4)} ${r.label}`);
    if (r.detail) console.log(`        ${r.detail.replace(/\n/g, '\n        ')}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} endpoints OK`);
  if (failed.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
