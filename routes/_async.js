const express = require('express');

/**
 * Routeur Express dont les handlers peuvent être `async`.
 *
 * Express 4 n'attrape pas les promesses rejetées : une erreur dans un handler asynchrone
 * laisserait la requête pendante jusqu'au timeout, sans jamais atteindre le middleware d'erreur.
 * Toutes les routes de cette application interrogent Postgres (donc sont asynchrones) : on
 * enveloppe systématiquement leurs handlers pour rediriger les rejets vers `next()`.
 */
function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) =>
      original(...args.map(arg =>
        typeof arg === 'function'
          ? (req, res, next) => Promise.resolve(arg(req, res, next)).catch(next)
          : arg
      ));
  }
  return router;
}

module.exports = { asyncRouter };
