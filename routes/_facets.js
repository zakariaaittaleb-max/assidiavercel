// Calcule, pour chaque champ filtrable, les valeurs distinctes encore disponibles
// compte tenu des AUTRES filtres actifs (filtres en cascade / faceted search).
async function buildFacets(db, table, fields, filters, extraWhere) {
  const result = {};
  for (const field of fields) {
    const clauses = [`${field} IS NOT NULL`, `${field} != ''`];
    const params = [];
    for (const other of fields) {
      if (other === field) continue;
      if (filters[other]) { clauses.push(`${other} = ?`); params.push(filters[other]); }
    }
    if (extraWhere && extraWhere.clause) {
      clauses.push(extraWhere.clause);
      params.push(...extraWhere.params);
    }
    const sql = `SELECT DISTINCT ${field} AS v FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY v`;
    const rows = await db.prepare(sql).all(...params);
    result[field] = rows.map(r => r.v);
  }
  return result;
}

module.exports = { buildFacets };
