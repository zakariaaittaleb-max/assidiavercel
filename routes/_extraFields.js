const db = require('../db');

// Ajoute PATCH /:id/extra { key, value } à un routeur : fusionne une valeur
// de champ personnalisé dans la colonne JSON `extra` d'une table.
function attachExtraFieldRoute(router, table) {
  router.patch('/:id/extra', async (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key requis' });
    const row = await db.prepare(`SELECT extra FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Introuvable' });
    let extra = {};
    try { extra = JSON.parse(row.extra || '{}'); } catch { extra = {}; }
    extra[key] = value;
    await db.prepare(`UPDATE ${table} SET extra = ? WHERE id = ?`).run(JSON.stringify(extra), req.params.id);
    res.json(await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
  });
}

module.exports = { attachExtraFieldRoute };
