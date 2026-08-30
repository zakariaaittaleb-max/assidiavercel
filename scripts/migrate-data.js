/**
 * Migration des données de l'ancienne base SQLite locale vers Postgres (schéma `assidia`).
 *
 *   npm run migrate:data -- [--replace] [chemin/vers/pointage.db]
 *
 * Par défaut, seules les tables encore vides sont chargées (relance sans risque).
 * `--replace` vide d'abord les tables ciblées puis recharge tout.
 *
 * Les lignes transitent par un paramètre JSON confié à json_to_recordset : aucune valeur n'est
 * concaténée dans le SQL, donc aucune apostrophe (fréquente dans les noms) ne peut le casser.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const args = process.argv.slice(2);
const REPLACE = args.includes('--replace');
const SQLITE_DB = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'pointage.db');
const BATCH = 500;

// Colonnes migrées et leur type Postgres. L'ordre définit celui du json_to_recordset.
// Les tables sont listées dans l'ordre d'insertion : les clés étrangères de `pointage`
// exigent que `students` et `courses` existent déjà.
const TABLES = [
  ['students', {
    id: 'bigint', external_id: 'text', nom: 'text', prenom: 'text', classe: 'text', niveau: 'text',
    created_at: 'text', updated_at: 'text', ecole: 'text', extra: 'text', code: 'text',
  }],
  ['courses', {
    id: 'bigint', ecole: 'text', cours: 'text', niveau: 'text', vh: 'text', nb_seances: 'text',
    created_at: 'text', updated_at: 'text', extra: 'text', code: 'text',
  }],
  ['pointage', {
    id: 'bigint', student_id: 'bigint', nom: 'text', prenom: 'text', classe: 'text', ecole: 'text',
    cours: 'text', niveau: 'text', date: 'text', heure_debut: 'text', heure_fin: 'text',
    heure_arrivee: 'text', heure_expulsion: 'text', raison_expulsion: 'text', created_at: 'text',
    updated_at: 'text', extra: 'text', code: 'text', cours_id: 'bigint',
  }],
  ['field_defs', {
    id: 'bigint', table_name: 'text', field_key: 'text', label: 'text', created_at: 'text',
    linked_table: 'text', linked_field: 'text', is_builtin: 'integer', format: 'text',
    link_local_key: 'text', link_target_key: 'text',
  }],
  ['app_users', { id: 'bigint', username: 'text', password_hash: 'text', created_at: 'text' }],
];

function readSqlite(sql) {
  const out = execFileSync('sqlite3', ['-json', SQLITE_DB, sql], { maxBuffer: 512 * 1024 * 1024 })
    .toString().trim();
  return out ? JSON.parse(out) : [];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant (voir .env.example)');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Source SQLite : ${SQLITE_DB}`);

  try {
    await client.query('BEGIN');

    if (REPLACE) {
      // Ordre inverse des dépendances : pointage référence students et courses.
      for (const [table] of [...TABLES].reverse()) {
        await client.query(`DELETE FROM assidia.${table}`);
      }
      console.log('Tables vidées (--replace)');
    }

    for (const [table, cols] of TABLES) {
      const { rows: [{ n }] } = await client.query(`SELECT COUNT(*)::int AS n FROM assidia.${table}`);
      if (n > 0) {
        console.log(`${table.padEnd(11)} ignorée (${n} lignes déjà présentes)`);
        continue;
      }

      const names = Object.keys(cols);
      const source = readSqlite(`SELECT ${names.join(', ')} FROM ${table} ORDER BY id`);
      const colList = names.join(', ');
      const typeDef = names.map(c => `${c} ${cols[c]}`).join(', ');

      for (let i = 0; i < source.length; i += BATCH) {
        await client.query(
          `INSERT INTO assidia.${table} (${colList})
           SELECT ${colList} FROM json_to_recordset($1::json) AS x(${typeDef})`,
          [JSON.stringify(source.slice(i, i + BATCH))]
        );
      }

      // Les identifiants ont été insérés explicitement : la séquence d'identité doit repartir
      // au-delà du maximum, sinon la première création depuis l'application violerait la clé primaire.
      await client.query(
        `SELECT setval(pg_get_serial_sequence('assidia.${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM assidia.${table}), 1))`
      );
      console.log(`${table.padEnd(11)} ${String(source.length).padStart(6)} lignes chargées`);
    }

    await client.query('COMMIT');

    console.log('\nVérification :');
    for (const [table] of TABLES) {
      const pg = (await client.query(`SELECT COUNT(*)::int AS n FROM assidia.${table}`)).rows[0].n;
      const sqlite = readSqlite(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;
      const ok = pg === sqlite ? 'OK' : 'ÉCART';
      console.log(`  ${table.padEnd(11)} SQLite ${String(sqlite).padStart(6)}  ->  Postgres ${String(pg).padStart(6)}  ${ok}`);
      if (pg !== sqlite) process.exitCode = 1;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('\nÉchec de la migration :', err.message);
  process.exit(1);
});
