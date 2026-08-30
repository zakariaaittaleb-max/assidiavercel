/**
 * Accès base de données — Postgres (Supabase), schéma `assidia`.
 *
 * L'application a été écrite pour better-sqlite3, dont l'API est SYNCHRONE. Postgres n'offre
 * pas d'équivalent synchrone : ce module reproduit donc la même surface d'API
 * (`prepare().get()/all()/run()`, `transaction()`, `exec()`) mais en asynchrone, afin que les
 * routes gardent leur SQL brut d'origine et n'aient qu'à ajouter `await`.
 *
 * Deux différences de dialecte sont absorbées ici de façon transparente :
 *   - les paramètres `?` deviennent `$1..$n` ;
 *   - `LIKE` devient `ILIKE`, car LIKE est insensible à la casse en SQLite mais sensible en
 *     Postgres — sans cela toutes les recherches de l'application changeraient de comportement.
 * Les tournures SQLite plus profondes (strftime, sous-requêtes sans alias, CAST permissifs)
 * sont corrigées directement dans les routes concernées, où le sens métier est visible.
 */
const pg = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// node-postgres renvoie par défaut les BIGINT et NUMERIC sous forme de chaînes (pour ne pas perdre
// de précision). L'application les traite comme des nombres (COUNT(*), moyennes, taux) : sans ces
// convertisseurs, `total > 0` ou `Math.ceil(total / pageSize)` opéreraient sur du texte.
pg.types.setTypeParser(pg.types.builtins.INT8, v => (v === null ? null : parseInt(v, 10)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, v => (v === null ? null : parseFloat(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL manquant : renseignez la chaîne de connexion Postgres (Supabase).');
}

// En environnement serverless chaque instance ouvre son propre pool : on le garde étroit pour ne
// pas épuiser le pooler Supabase quand plusieurs instances tournent en parallèle.
const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX || 2),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', err => console.error('Erreur inattendue du pool Postgres', err));

// Client de la transaction en cours, propagé implicitement aux `prepare()` imbriqués — c'est ce qui
// permet à `db.transaction(() => { ... })` de fonctionner sans passer le client à chaque appel.
const txStore = new AsyncLocalStorage();
const currentClient = () => txStore.getStore() || pool;

/* ------------------------- Traduction SQLite -> Postgres ------------------------- */

const NOW_TEXT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// Tables possédant une colonne `id` : pour elles, `.run()` d'un INSERT doit pouvoir renvoyer
// `lastInsertRowid`, ce que Postgres n'expose que via RETURNING.
const TABLES_WITH_ID = ['students', 'courses', 'pointage', 'field_defs', 'app_users'];

/**
 * Réécrit `?` en `$n` et `LIKE` en `ILIKE`, en ignorant tout ce qui se trouve à l'intérieur d'une
 * chaîne littérale, d'un dollar-quoting ou d'un commentaire — sans quoi un `?` ou le mot « like »
 * présent dans une donnée (une raison d'expulsion, par exemple) casserait la requête.
 */
function rewriteBody(sql) {
  let out = '';
  let param = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") { // chaîne littérale, '' = apostrophe échappée
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '$') { // dollar-quoting $tag$ ... $tag$
      const open = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (open) {
        const tag = open[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === '-' && sql[i + 1] === '-') { // commentaire ligne
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') { // commentaire bloc
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '?') { out += `$${++param}`; i++; continue; }

    // LIKE isolé (pas NOT_LIKE ni un identifiant contenant « like »)
    if ((ch === 'l' || ch === 'L') && /^like\b/i.test(sql.slice(i)) && !/[A-Za-z0-9_]/.test(sql[i - 1] || '')) {
      out += 'ILIKE';
      i += 4;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function translate(sql) {
  // Appliqué avant le parcours : le motif contient lui-même une chaîne littérale ('now').
  let out = String(sql).replace(/datetime\(\s*'now'\s*\)/gi, NOW_TEXT);
  out = rewriteBody(out);

  // `.run()` sur un INSERT doit exposer lastInsertRowid, absent du protocole Postgres.
  if (/^\s*INSERT\s+INTO/i.test(out) && !/\bRETURNING\b/i.test(out)) {
    const m = /^\s*INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(out);
    if (m && TABLES_WITH_ID.includes(m[1].toLowerCase())) {
      out = out.replace(/;\s*$/, '') + ' RETURNING id';
    }
  }
  return out;
}

/* ------------------------------ Surface better-sqlite3 ------------------------------ */

class Statement {
  constructor(sql) {
    this.source = sql;
    this.text = translate(sql);
  }

  async _exec(params) {
    try {
      return await currentClient().query(this.text, params);
    } catch (err) {
      // Sans le SQL fautif, une erreur Postgres sur du SQL généré dynamiquement est indébogable.
      err.message = `${err.message}\n--- SQL ---\n${this.text}\n--- params ---\n${JSON.stringify(params)}`;
      throw err;
    }
  }

  async all(...params) {
    return (await this._exec(params)).rows;
  }

  async get(...params) {
    return (await this._exec(params)).rows[0];
  }

  async run(...params) {
    const res = await this._exec(params);
    return {
      changes: res.rowCount,
      lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
    };
  }
}

const db = {
  prepare(sql) {
    return new Statement(sql);
  },

  async exec(sql) {
    await currentClient().query(sql);
  },

  /**
   * Reproduit `db.transaction(fn)` de better-sqlite3 : renvoie une fonction qui exécute `fn` dans
   * une transaction. Les `prepare()` appelés à l'intérieur empruntent automatiquement le client de
   * la transaction via AsyncLocalStorage, donc les appelants n'ont rien à changer hormis `await`.
   */
  transaction(fn) {
    return async (...args) => {
      // Transaction imbriquée : on reste dans celle déjà ouverte, comme le fait better-sqlite3.
      if (txStore.getStore()) return fn(...args);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await txStore.run(client, () => fn(...args));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connexion déjà perdue */ }
        throw err;
      } finally {
        client.release();
      }
    };
  },
};

/* --------------------------------- Schéma & helpers --------------------------------- */

// L'interface permet de supprimer une colonne native : le schéma réel doit donc être relu, mais pas
// à chaque requête. Cache court, suffisant pour absorber une rafale d'appels sans figer une
// suppression de colonne plus de quelques secondes.
const SCHEMA_TTL_MS = 15_000;
const schemaCache = new Map();

async function tableColumns(table) {
  const hit = schemaCache.get(table);
  if (hit && hit.expires > Date.now()) return hit.cols;
  const { rows } = await currentClient().query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'assidia' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const cols = rows.map(r => r.column_name);
  schemaCache.set(table, { cols, expires: Date.now() + SCHEMA_TTL_MS });
  return cols;
}

async function dropColumnIfExists(table, column) {
  const cols = await tableColumns(table);
  if (!cols.includes(column)) return;
  // `table` et `column` sont validés contre des listes blanches par la route appelante.
  await currentClient().query(`ALTER TABLE assidia.${table} DROP COLUMN ${column}`);
  schemaCache.delete(table);
}

async function getConfig(key) {
  const { rows } = await currentClient().query(`SELECT value FROM app_config WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : null;
}

async function setConfig(key, value) {
  await currentClient().query(
    `INSERT INTO app_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/* ------------------------- Identifiants lisibles (ETU-/COU-/PTG-) ------------------------- */

function pad4(n) { return String(n).padStart(4, '0'); }

function codeSlug(s, max = 12) {
  return (s == null ? '' : String(s))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, max) || 'NA';
}

async function nextStudentCode(ecole) {
  const { rows } = await currentClient().query(
    `SELECT COUNT(*)::int AS c FROM students WHERE UPPER(COALESCE(ecole,'')) = UPPER($1)`, [ecole || '']
  );
  return `ETU-${codeSlug(ecole)}-${pad4(rows[0].c + 1)}`;
}

async function nextCourseCode(ecole, niveau) {
  const { rows } = await currentClient().query(
    `SELECT COUNT(*)::int AS c FROM courses
     WHERE UPPER(COALESCE(ecole,'')) = UPPER($1) AND UPPER(COALESCE(niveau,'')) = UPPER($2)`,
    [ecole || '', niveau || '']
  );
  return `COU-${codeSlug(ecole)}-${codeSlug(niveau)}-${pad4(rows[0].c + 1)}`;
}

async function nextPointageCode(date) {
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows } = await currentClient().query(
    `SELECT COUNT(*)::int AS c FROM pointage WHERE date = $1`, [d]
  );
  return `PTG-${d}-${pad4(rows[0].c + 1)}`;
}

Object.assign(db, {
  pool,
  getConfig,
  setConfig,
  tableColumns,
  dropColumnIfExists,
  pad4,
  codeSlug,
  nextStudentCode,
  nextCourseCode,
  nextPointageCode,
});

module.exports = db;
