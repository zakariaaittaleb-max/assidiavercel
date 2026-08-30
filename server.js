// Point d'entrée pour l'exécution locale. Sur Vercel, c'est `api/index.js` qui est utilisé :
// la plateforme gère elle-même l'écoute réseau.
const app = require('./app');

const PORT = process.env.PORT || 3210;

app.listen(PORT, () => {
  console.log(`Assidia démarré sur http://localhost:${PORT}`);
});
