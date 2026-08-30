// Point d'entrée serverless : Vercel invoque directement l'application Express exportée ici,
// sans qu'elle ait à ouvrir un port.
module.exports = require('../app');
