// Insert/update génériques qui s'adaptent au schéma réel de la table (via information_schema),
// pour ne jamais échouer après la suppression d'une colonne native par l'utilisateur.
async function insertRow(db, table, candidate) {
  const cols = await db.tableColumns(table);
  const fields = Object.keys(candidate).filter(k => cols.includes(k));
  const stmt = db.prepare(`INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`);
  return stmt.run(...fields.map(f => candidate[f]));
}

async function updateRow(db, table, id, candidate) {
  const cols = await db.tableColumns(table);
  const fields = Object.keys(candidate).filter(k => cols.includes(k));
  if (!fields.length) return { changes: 0 };
  const setParts = fields.map(f => `${f} = ?`);
  if (cols.includes('updated_at')) setParts.push(`updated_at = datetime('now')`);
  const stmt = db.prepare(`UPDATE ${table} SET ${setParts.join(', ')} WHERE id = ?`);
  return stmt.run(...fields.map(f => candidate[f]), id);
}

module.exports = { insertRow, updateRow };
