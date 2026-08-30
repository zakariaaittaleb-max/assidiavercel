const { asyncRouter } = require('./_async');
const router = asyncRouter();
const db = require('../db');

/* ------------------------------------------------------------------ *
 * Base résolue
 *
 * Les colonnes `classe` et `niveau` de la table `pointage` sont vides sur
 * la quasi-totalité des lignes importées (la feuille Excel « Pointage » ne
 * les contient pas). Lire ces colonnes directement donnait des découpages
 * entièrement faux ("Non renseignée" partout). On les résout donc par
 * jointure sur les clés étrangères — student_id → students, cours_id →
 * courses — qui sont la source de vérité. Toute statistique de ce module
 * passe par cette base.
 * ------------------------------------------------------------------ */
const FROM_RESOLVED = `
  FROM pointage p
  LEFT JOIN students s ON s.id = p.student_id
  LEFT JOIN courses  c ON c.id = p.cours_id
`;

/* --------------------------- Fuseau de l'établissement --------------------------- *
 * `heure_arrivee` est un instant ISO en UTC, `heure_debut` une heure locale "HH:MM" :
 * les comparer suppose de savoir dans quel fuseau se déroule la séance. Sous SQLite ce
 * fuseau était implicitement celui de la machine ('localtime'), ce qui aurait silencieusement
 * basculé en UTC une fois hébergé — décalant d'une heure tous les retards calculés.
 * Il est donc désormais explicite, et surchargeable par APP_TZ.
 * --------------------------------------------------------------------------------- */
const APP_TZ = (process.env.APP_TZ || 'Africa/Casablanca').replace(/'/g, '');

// Minutes depuis minuit pour une heure "HH:MM" — NULL si la valeur n'a pas ce format.
// Le garde-fou est indispensable : Postgres échoue sur `''::int` là où SQLite renvoyait 0.
const hhmmMinutes = expr =>
  `(CASE WHEN ${expr} ~ '^[0-9]{1,2}:[0-9]{2}'
         THEN split_part(${expr}, ':', 1)::int * 60 + split_part(${expr}, ':', 2)::int END)`;

// Minutes depuis minuit de l'arrivée, ramenée au fuseau de l'établissement.
const ARRIVEE_MINUTES = `(
  CASE WHEN p.heure_arrivee ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       THEN EXTRACT(HOUR   FROM (p.heure_arrivee::timestamptz AT TIME ZONE '${APP_TZ}'))::int * 60
          + EXTRACT(MINUTE FROM (p.heure_arrivee::timestamptz AT TIME ZONE '${APP_TZ}'))::int END
)`;

// Date sûre : NULL si la chaîne n'est pas une date ISO, pour ne jamais faire échouer un cast.
const SAFE_DATE = expr => `(CASE WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ${expr}::date END)`;

// `vh` est saisi en texte libre : on ne convertit que ce qui est réellement numérique.
const VH_NUM = `(CASE WHEN vh ~ '^\\s*[0-9]+([.,][0-9]+)?\\s*$' THEN replace(btrim(vh), ',', '.')::numeric ELSE 0 END)`;

// Expressions SQL de chaque dimension analysable, dans l'ordre de priorité des sources.
const DIMENSIONS = {
  ecole: {
    label: 'École',
    sql: `COALESCE(NULLIF(TRIM(p.ecole),''), NULLIF(TRIM(s.ecole),''), NULLIF(TRIM(c.ecole),''), 'Non renseignée')`,
  },
  classe: {
    label: 'Classe',
    sql: `COALESCE(NULLIF(TRIM(p.classe),''), NULLIF(TRIM(s.classe),''), 'Non renseignée')`,
  },
  niveau: {
    label: 'Niveau',
    sql: `COALESCE(NULLIF(TRIM(p.niveau),''), NULLIF(TRIM(s.niveau),''), NULLIF(TRIM(c.niveau),''), 'Non renseigné')`,
  },
  cours: {
    label: 'Cours',
    sql: `COALESCE(NULLIF(TRIM(p.cours),''), NULLIF(TRIM(c.cours),''), 'Non renseigné')`,
  },
  etudiant: {
    label: 'Étudiant',
    sql: `TRIM(COALESCE(NULLIF(TRIM(p.nom),''), NULLIF(TRIM(s.nom),''), '?') || ' ' || COALESCE(NULLIF(TRIM(p.prenom),''), NULLIF(TRIM(s.prenom),''), ''))`,
  },
  date: { label: 'Jour', sql: `p.date` },
  // Semaine ISO, équivalent lisible du strftime('%Y-W%W') d'origine.
  semaine: { label: 'Semaine', sql: `to_char(${SAFE_DATE('p.date')}, 'IYYY-"W"IW')` },
  mois: { label: 'Mois', sql: `substr(p.date, 1, 7)` },
  jour_semaine: {
    label: 'Jour de la semaine',
    // EXTRACT(DOW) suit la même convention que strftime('%w') : 0 = dimanche.
    sql: `CASE EXTRACT(DOW FROM ${SAFE_DATE('p.date')})::int
            WHEN 1 THEN '1 Lundi'    WHEN 2 THEN '2 Mardi'
            WHEN 3 THEN '3 Mercredi' WHEN 4 THEN '4 Jeudi'
            WHEN 5 THEN '5 Vendredi' WHEN 6 THEN '6 Samedi'
            ELSE '7 Dimanche' END`,
  },
  creneau: {
    label: 'Créneau horaire',
    sql: `COALESCE(NULLIF(substr(p.heure_debut, 1, 2), '') || 'h', 'Non renseigné')`,
  },
};

// Un pointage compte comme « présent » dès qu'une heure d'arrivée est enregistrée.
const IS_PRESENT = `(p.heure_arrivee IS NOT NULL AND TRIM(p.heure_arrivee) != '')`;
const IS_EXPULSE = `(p.heure_expulsion IS NOT NULL AND TRIM(p.heure_expulsion) != '')`;
const HAS_DEBUT = `(p.heure_debut IS NOT NULL AND TRIM(p.heure_debut) != '')`;

const MINUTES_RETARD = `(${ARRIVEE_MINUTES} - ${hhmmMinutes('p.heure_debut')})`;

/* Seuil de tolérance (en minutes) au-delà duquel une arrivée compte comme un retard.
 * Règle métier : est en retard l'étudiant qui arrive plus de 10 minutes après le démarrage.
 * Ce seuil ne peut pas valoir 0 : dans les données existantes, aucune arrivée n'est jamais
 * enregistrée avant l'heure de début (minimum observé +1 min, l'enseignant pointant les
 * étudiants au fil de leur entrée), si bien qu'un seuil strict classerait 100 % des présents
 * en retard. Il reste réglable depuis l'interface pour permettre d'autres lectures. */
const DEFAULT_TOLERANCE = 10;
const isRetard = (tol) => `(${IS_PRESENT} AND ${HAS_DEBUT} AND ${MINUTES_RETARD} > ${tol})`;
function toleranceOf(q) {
  const n = parseInt(q.tolerance, 10);
  return Number.isFinite(n) && n >= 0 && n <= 240 ? n : DEFAULT_TOLERANCE;
}

const SUM_IF = (cond) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
// ROUND(x, n) n'existe en Postgres que pour numeric : le cast est obligatoire.
const RATE = (num, den) => `ROUND((100.0 * ${num} / NULLIF(${den}, 0))::numeric, 1)`;

// Clé identifiant une séance unique (une même séance apparaît sur autant de lignes que d'étudiants).
const SEANCE_KEY = `p.date || '|' || COALESCE(p.ecole,'') || '|' || COALESCE(p.cours,'') || '|' || COALESCE(p.heure_debut,'')`;

function metricsFor(tol) {
  const RETARD = isRetard(tol);
  return {
    taux_presence: { label: 'Taux de présence', unit: '%', sql: RATE(SUM_IF(IS_PRESENT), 'COUNT(*)'), good: 'high' },
    taux_absence: { label: 'Taux d’absence', unit: '%', sql: RATE(SUM_IF(`NOT ${IS_PRESENT}`), 'COUNT(*)'), good: 'low' },
    taux_retard: { label: 'Taux de retard', unit: '%', sql: RATE(SUM_IF(RETARD), SUM_IF(IS_PRESENT)), good: 'low' },
    taux_expulsion: { label: 'Taux d’expulsion', unit: '%', sql: RATE(SUM_IF(IS_EXPULSE), 'COUNT(*)'), good: 'low' },
    presents: { label: 'Présences', unit: '', sql: SUM_IF(IS_PRESENT), good: 'high' },
    absences: { label: 'Absences', unit: '', sql: SUM_IF(`NOT ${IS_PRESENT}`), good: 'low' },
    retards: { label: 'Retards', unit: '', sql: SUM_IF(RETARD), good: 'low' },
    expulsions: { label: 'Expulsions', unit: '', sql: SUM_IF(IS_EXPULSE), good: 'low' },
    pointages: { label: 'Pointages', unit: '', sql: 'COUNT(*)', good: 'neutral' },
    effectif: {
      label: 'Étudiants distincts', unit: '', good: 'neutral',
      sql: `COUNT(DISTINCT COALESCE(CAST(p.student_id AS TEXT), TRIM(COALESCE(p.nom,'')) || '|' || TRIM(COALESCE(p.prenom,''))))`,
    },
    seances: { label: 'Séances', unit: '', sql: `COUNT(DISTINCT ${SEANCE_KEY})`, good: 'neutral' },
    retard_moyen: {
      label: 'Retard moyen (des retardataires)', unit: ' min', good: 'low',
      sql: `ROUND(AVG(CASE WHEN ${RETARD} THEN ${MINUTES_RETARD} END)::numeric, 1)`,
    },
    minutes_ratees: {
      label: 'Minutes ratées (total)', unit: ' min', good: 'low',
      sql: `COALESCE(SUM(CASE WHEN ${RETARD} THEN ${MINUTES_RETARD} END), 0)`,
    },
    // Volume horaire réellement dispensé : chaque séance distincte ne compte qu'une fois,
    // d'où un traitement à part dans les requêtes.
    vh_couvert: { label: 'Volume horaire couvert', unit: ' h', good: 'high', distinctSession: true },
  };
}
const METRIC_KEYS = Object.keys(metricsFor(DEFAULT_TOLERANCE));

// Durée d'une séance en heures. Les colonnes ne sont pas préfixées : cette expression est utilisée
// dans la requête englobante, au-dessus de la sous-requête qui a dédoublonné les séances.
const DUREE_SEANCE_H = `((${hhmmMinutes('heure_fin')} - ${hhmmMinutes('heure_debut')}) / 60.0)`;

/* ------------------------------- Filtres ------------------------------- */

function buildWhere(q) {
  const clauses = [`p.date IS NOT NULL`, `p.date != ''`];
  const params = [];
  if (q.start) { clauses.push(`p.date >= ?`); params.push(q.start); }
  if (q.end) { clauses.push(`p.date <= ?`); params.push(q.end); }
  for (const dim of ['ecole', 'classe', 'niveau', 'cours', 'etudiant']) {
    const raw = q[dim];
    if (!raw) continue;
    // Sélection multiple : "A||B||C"
    const values = String(raw).split('||').map(v => v.trim()).filter(Boolean);
    if (!values.length) continue;
    clauses.push(`${DIMENSIONS[dim].sql} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  if (q.search) {
    clauses.push(`(p.nom LIKE ? OR p.prenom LIKE ?)`);
    params.push(`%${q.search}%`, `%${q.search}%`);
  }
  if (q.excludeOrphans === '1') {
    clauses.push(`p.student_id IS NOT NULL`);
  }
  return { where: clauses.join(' AND '), params };
}

/* --------------------------- Période par défaut ------------------------ *
 * L'ancien tableau de bord partait du semestre calendaire courant : avec des
 * données 2025-2026 consultées en août 2026, tous les indicateurs affichaient
 * 0. La période par défaut suit désormais les données réellement présentes.
 * ---------------------------------------------------------------------- */
async function dataRange() {
  const r = await db.prepare(
    `SELECT MIN(date) AS min, MAX(date) AS max FROM pointage WHERE date IS NOT NULL AND date != ''`
  ).get();
  return { start: r.min || null, end: r.max || null };
}

/* ------------------------------ Endpoints ------------------------------ */

router.get('/meta', async (req, res) => {
  const metrics = metricsFor(DEFAULT_TOLERANCE);
  res.json({
    dimensions: Object.entries(DIMENSIONS).map(([key, d]) => ({ key, label: d.label })),
    metrics: Object.entries(metrics).map(([key, m]) => ({ key, label: m.label, unit: m.unit, good: m.good })),
    range: await dataRange(),
    defaultTolerance: DEFAULT_TOLERANCE,
  });
});

// Valeurs disponibles pour chaque filtre, compte tenu des autres filtres actifs,
// calculées sur les données de pointage résolues (et non sur les tables Cours/Étudiants,
// qui peuvent contenir des valeurs sans aucune ligne de pointage associée).
router.get('/facets', async (req, res) => {
  const out = {};
  for (const dim of ['ecole', 'classe', 'niveau', 'cours']) {
    const q = { ...req.query };
    delete q[dim]; // une facette ne se restreint pas elle-même
    const { where, params } = buildWhere(q);
    const rows = await db.prepare(
      `SELECT DISTINCT ${DIMENSIONS[dim].sql} AS v ${FROM_RESOLVED} WHERE ${where} ORDER BY v`
    ).all(...params);
    out[dim] = rows.map(r => r.v);
  }
  res.json(out);
});

router.get('/overview', async (req, res) => {
  const { where, params } = buildWhere(req.query);
  const tol = toleranceOf(req.query);
  const M = metricsFor(tol);
  const RETARD = isRetard(tol);
  const row = await db.prepare(`
    SELECT COUNT(*) AS pointages,
           ${SUM_IF(IS_PRESENT)} AS presents,
           ${SUM_IF(`NOT ${IS_PRESENT}`)} AS absences,
           ${SUM_IF(RETARD)} AS retards,
           ${SUM_IF(IS_EXPULSE)} AS expulsions,
           ${M.effectif.sql} AS effectif,
           ${M.seances.sql} AS seances,
           ROUND(AVG(CASE WHEN ${RETARD} THEN ${MINUTES_RETARD} END)::numeric, 1) AS retard_moyen
    ${FROM_RESOLVED} WHERE ${where}
  `).get(...params);

  // Postgres exige un alias sur toute sous-requête placée dans FROM (contrairement à SQLite).
  const vh = await db.prepare(`
    SELECT ROUND(SUM(${DUREE_SEANCE_H})::numeric, 1) AS h FROM (
      SELECT DISTINCT p.date, p.ecole, p.cours, p.heure_debut, p.heure_fin
      ${FROM_RESOLVED}
      WHERE ${where} AND ${HAS_DEBUT} AND p.heure_fin IS NOT NULL AND TRIM(p.heure_fin) != ''
    ) AS seances
  `).get(...params);

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  res.json({
    ...row,
    retard_moyen: row.retard_moyen ?? 0,
    vh_couvert: vh.h ?? 0,
    taux_presence: pct(row.presents, row.pointages),
    taux_absence: pct(row.absences, row.pointages),
    taux_retard: pct(row.retards, row.presents),
    taux_expulsion: pct(row.expulsions, row.pointages),
    tolerance: tol,
    range: await dataRange(),
  });
});

// Cœur de l'explorateur : une métrique agrégée par dimension, éventuellement
// croisée avec une seconde dimension (le front pivote ensuite en séries).
router.get('/analytics', async (req, res) => {
  const M = metricsFor(toleranceOf(req.query));
  const metricKey = M[req.query.metric] ? req.query.metric : 'taux_presence';
  const dimKey = DIMENSIONS[req.query.dimension] ? req.query.dimension : 'ecole';
  const splitKey = DIMENSIONS[req.query.split] && req.query.split !== dimKey ? req.query.split : null;
  const metric = M[metricKey];
  const { where, params } = buildWhere(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  const dimSql = DIMENSIONS[dimKey].sql;
  const splitSql = splitKey ? DIMENSIONS[splitKey].sql : null;
  const groupCols = splitSql ? `${dimSql} AS dim, ${splitSql} AS split` : `${dimSql} AS dim`;
  const groupBy = splitSql ? `1, 2` : `1`;

  let rows;
  if (metric.distinctSession) {
    // Volume horaire : on dédoublonne les séances avant de sommer leur durée.
    rows = await db.prepare(`
      SELECT dim${splitSql ? ', split' : ''}, ROUND(SUM(${DUREE_SEANCE_H})::numeric, 1) AS value
      FROM (
        SELECT DISTINCT ${groupCols}, p.date, p.ecole, p.cours, p.heure_debut, p.heure_fin
        ${FROM_RESOLVED}
        WHERE ${where} AND ${HAS_DEBUT} AND p.heure_fin IS NOT NULL AND TRIM(p.heure_fin) != ''
      ) AS seances
      GROUP BY ${groupBy} ORDER BY 1 LIMIT ${limit}
    `).all(...params);
  } else {
    rows = await db.prepare(`
      SELECT ${groupCols}, ${metric.sql} AS value, COUNT(*) AS n
      ${FROM_RESOLVED} WHERE ${where}
      GROUP BY ${groupBy} ORDER BY 1 LIMIT ${limit}
    `).all(...params);
  }

  res.json({
    metric: { key: metricKey, ...metric, sql: undefined },
    dimension: { key: dimKey, label: DIMENSIONS[dimKey].label },
    split: splitKey ? { key: splitKey, label: DIMENSIONS[splitKey].label } : null,
    rows: rows.map(r => ({ ...r, value: r.value ?? 0 })),
  });
});

// Série temporelle : même moteur, mais la dimension principale est une granularité de date.
router.get('/timeseries', async (req, res) => {
  const M = metricsFor(toleranceOf(req.query));
  const metricKey = M[req.query.metric] ? req.query.metric : 'taux_presence';
  const grain = ['date', 'semaine', 'mois'].includes(req.query.granularity) ? req.query.granularity : 'date';
  const splitKey = DIMENSIONS[req.query.split] ? req.query.split : null;
  const metric = M[metricKey];
  const { where, params } = buildWhere(req.query);

  const dimSql = DIMENSIONS[grain].sql;
  const splitSql = splitKey ? DIMENSIONS[splitKey].sql : null;
  const groupCols = splitSql ? `${dimSql} AS dim, ${splitSql} AS split` : `${dimSql} AS dim`;
  const groupBy = splitSql ? `1, 2` : `1`;

  let rows;
  if (metric.distinctSession) {
    rows = await db.prepare(`
      SELECT dim${splitSql ? ', split' : ''}, ROUND(SUM(${DUREE_SEANCE_H})::numeric, 1) AS value
      FROM (
        SELECT DISTINCT ${groupCols}, p.date, p.ecole, p.cours, p.heure_debut, p.heure_fin
        ${FROM_RESOLVED}
        WHERE ${where} AND ${HAS_DEBUT} AND p.heure_fin IS NOT NULL AND TRIM(p.heure_fin) != ''
      ) AS seances
      GROUP BY ${groupBy} ORDER BY 1
    `).all(...params);
  } else {
    rows = await db.prepare(`
      SELECT ${groupCols}, ${metric.sql} AS value, COUNT(*) AS n
      ${FROM_RESOLVED} WHERE ${where}
      GROUP BY ${groupBy} ORDER BY 1
    `).all(...params);
  }

  res.json({
    metric: { key: metricKey, ...metric, sql: undefined },
    granularity: grain,
    split: splitKey ? { key: splitKey, label: DIMENSIONS[splitKey].label } : null,
    rows: rows.map(r => ({ ...r, value: r.value ?? 0 })),
  });
});

// Volume horaire planifié (table Cours) vs réellement couvert (table Pointage).
// Le planifié est calculé par école+niveau puis rattaché aux classes via la table
// Étudiants, sans jamais additionner deux fois le même cours pour une même classe.
router.get('/couverture', async (req, res) => {
  const { where, params } = buildWhere(req.query);
  const dimKey = ['ecole', 'niveau', 'cours', 'classe'].includes(req.query.dimension) ? req.query.dimension : 'ecole';

  const couvert = await db.prepare(`
    SELECT dim, ROUND(SUM(${DUREE_SEANCE_H})::numeric, 1) AS couvert FROM (
      SELECT DISTINCT ${DIMENSIONS[dimKey].sql} AS dim, p.date, p.ecole, p.cours, p.heure_debut, p.heure_fin
      ${FROM_RESOLVED}
      WHERE ${where} AND ${HAS_DEBUT} AND p.heure_fin IS NOT NULL AND TRIM(p.heure_fin) != ''
    ) AS seances GROUP BY dim
  `).all(...params);

  const planifieMap = new Map();
  if (dimKey === 'classe') {
    // Pour chaque classe, l'ensemble des cours de ses couples (école, niveau) — dédoublonné par id de cours.
    const pairs = await db.prepare(
      `SELECT DISTINCT TRIM(classe) AS classe, TRIM(COALESCE(ecole,'')) AS ecole, TRIM(COALESCE(niveau,'')) AS niveau
       FROM students WHERE classe IS NOT NULL AND TRIM(classe) != ''`
    ).all();
    const courses = await db.prepare(
      `SELECT id, TRIM(COALESCE(ecole,'')) AS ecole, TRIM(COALESCE(niveau,'')) AS niveau, vh FROM courses`
    ).all();
    for (const pair of pairs) {
      const seen = planifieMap.get(pair.classe) || new Map();
      for (const c of courses) {
        if (c.ecole === pair.ecole && c.niveau === pair.niveau) seen.set(c.id, parseFloat(c.vh) || 0);
      }
      planifieMap.set(pair.classe, seen);
    }
    for (const [k, m] of planifieMap) {
      planifieMap.set(k, [...m.values()].reduce((a, b) => a + b, 0));
    }
  } else {
    const col = dimKey === 'cours' ? 'cours' : dimKey;
    const rows = await db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(${col}),''), 'Non renseigné${dimKey === 'ecole' ? 'e' : ''}') AS dim, SUM(${VH_NUM}) AS vh
       FROM courses GROUP BY dim`
    ).all();
    for (const r of rows) planifieMap.set(r.dim, r.vh || 0);
  }

  const couvertMap = new Map(couvert.map(r => [r.dim, r.couvert || 0]));
  const keys = [...new Set([...planifieMap.keys(), ...couvertMap.keys()])];
  res.json({
    dimension: { key: dimKey, label: DIMENSIONS[dimKey].label },
    rows: keys.map(k => ({
      dim: k,
      planifie: Math.round((planifieMap.get(k) || 0) * 10) / 10,
      couvert: Math.round((couvertMap.get(k) || 0) * 10) / 10,
    })).sort((a, b) => String(a.dim).localeCompare(String(b.dim), 'fr')),
  });
});

/* -------------------------- Qualité des données ------------------------ *
 * Rend visible ce qui peut fausser les chiffres, au lieu de le laisser
 * silencieusement dégrader les moyennes.
 * ---------------------------------------------------------------------- */
router.get('/quality', async (req, res) => {
  const one = async (sql) => (await db.prepare(sql).get()).c;

  const total = await one(`SELECT COUNT(*) c FROM pointage`);
  const sansEtudiant = await one(`SELECT COUNT(*) c FROM pointage WHERE student_id IS NULL`);
  const sansCours = await one(`SELECT COUNT(*) c FROM pointage WHERE cours_id IS NULL`);
  const orphelins = await one(`
    SELECT COUNT(*) c FROM pointage p
    WHERE p.student_id IS NULL AND p.heure_arrivee IS NULL
      AND EXISTS (SELECT 1 FROM pointage q WHERE q.id <> p.id AND q.student_id IS NOT NULL
                  AND q.nom = p.nom AND q.prenom = p.prenom AND q.cours = p.cours
                  AND q.date = p.date AND q.ecole = p.ecole)
  `);
  const sansHoraire = await one(
    `SELECT COUNT(*) c FROM pointage WHERE heure_debut IS NULL OR TRIM(heure_debut) = '' OR heure_fin IS NULL OR TRIM(heure_fin) = ''`
  );
  const classeNonResolue = await one(`
    SELECT COUNT(*) c ${FROM_RESOLVED}
    WHERE COALESCE(NULLIF(TRIM(p.classe),''), NULLIF(TRIM(s.classe),'')) IS NULL
  `);
  const coursSansVh = await one(`SELECT COUNT(*) c FROM courses WHERE vh IS NULL OR ${VH_NUM} <= 0`);
  const entitesHtml = await one(
    `SELECT COUNT(*) c FROM courses WHERE cours LIKE '%&amp;%' OR cours LIKE '%&lt;%' OR cours LIKE '%&gt;%' OR cours LIKE '%&quot;%'`
  );

  res.json({
    total,
    issues: [
      { key: 'orphelins', label: 'Lignes fantômes en doublon', count: orphelins, severity: 'danger',
        hint: 'Doublons exacts sans lien étudiant ni présence — ils gonflent le taux d’absence.', fixable: true },
      { key: 'sans_etudiant', label: 'Pointages non reliés à un étudiant', count: sansEtudiant, severity: 'warning',
        hint: 'Classe et niveau ne peuvent pas être résolus pour ces lignes.' },
      { key: 'classe_non_resolue', label: 'Classe impossible à déterminer', count: classeNonResolue, severity: 'warning',
        hint: 'Regroupées sous « Non renseignée » dans les analyses par classe.' },
      { key: 'sans_cours', label: 'Pointages non reliés à un cours', count: sansCours, severity: 'warning',
        hint: 'Le volume horaire planifié ne peut pas être rapproché.' },
      { key: 'sans_horaire', label: 'Séances sans heure de début ou de fin', count: sansHoraire, severity: 'warning',
        hint: 'Exclues du volume horaire couvert et du calcul des retards.' },
      { key: 'cours_sans_vh', label: 'Cours sans volume horaire', count: coursSansVh, severity: 'warning',
        hint: 'Faussent la comparaison planifié / couvert.' },
      { key: 'entites_html', label: 'Libellés de cours mal encodés', count: entitesHtml, severity: 'warning',
        hint: 'Caractères « & » enregistrés sous forme « &amp; ».', fixable: true },
    ].filter(i => i.count > 0),
  });
});

// Corrections ciblées, explicitement déclenchées depuis le panneau Qualité des données.
router.post('/quality/fix', async (req, res) => {
  const { key } = req.body;
  if (key === 'orphelins') {
    const info = await db.prepare(`
      DELETE FROM pointage WHERE id IN (
        SELECT p.id FROM pointage p
        WHERE p.student_id IS NULL AND p.heure_arrivee IS NULL
          AND EXISTS (SELECT 1 FROM pointage q WHERE q.id <> p.id AND q.student_id IS NOT NULL
                      AND q.nom = p.nom AND q.prenom = p.prenom AND q.cours = p.cours
                      AND q.date = p.date AND q.ecole = p.ecole)
      )
    `).run();
    return res.json({ ok: true, removed: info.changes });
  }
  if (key === 'entites_html') {
    const info = await db.prepare(`
      UPDATE courses SET cours = REPLACE(REPLACE(REPLACE(REPLACE(cours,'&amp;','&'),'&lt;','<'),'&gt;','>'),'&quot;','"')
      WHERE cours LIKE '%&amp;%' OR cours LIKE '%&lt;%' OR cours LIKE '%&gt;%' OR cours LIKE '%&quot;%'
    `).run();
    return res.json({ ok: true, updated: info.changes });
  }
  res.status(400).json({ error: 'Correction non disponible pour cet élément' });
});

/* --------- Compatibilité : ancien format consommé par d'autres vues -------- */
router.get('/', async (req, res) => {
  const range = await dataRange();
  const start = req.query.start || range.start;
  const end = req.query.end || range.end;
  const { where, params } = buildWhere({ ...req.query, start, end });
  const base = await db.prepare(`
    SELECT COUNT(*) AS total, ${SUM_IF(IS_PRESENT)} AS presents, ${SUM_IF(IS_EXPULSE)} AS expulsions,
           ${metricsFor(DEFAULT_TOLERANCE).seances.sql} AS seances
    ${FROM_RESOLVED} WHERE ${where}
  `).get(...params);
  const students = await db.prepare(`SELECT COUNT(*) c FROM students`).get();
  const courses = await db.prepare(`SELECT COUNT(*) c FROM courses`).get();
  res.json({
    students: students.c,
    courses: courses.c,
    sessionsSemestre: base.seances,
    expulsionsSemestre: base.expulsions,
    presenceRate: base.total > 0 ? Math.round((base.presents / base.total) * 1000) / 10 : 0,
    semester: { start, end, label: 'Période analysée' },
  });
});

module.exports = router;
