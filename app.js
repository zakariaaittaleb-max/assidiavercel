/**
 * Construction de l'application Express, partagée entre l'exécution locale (`server.js`)
 * et l'exécution serverless sur Vercel (`api/index.js`).
 */

// Doit précéder toute manipulation de Date : les heures de séance sont saisies en heure locale de
// l'établissement, alors qu'un hébergeur tourne en UTC. Sans ce réglage, les retards calculés côté
// JavaScript seraient décalés du fuseau de l'établissement.
process.env.TZ = process.env.TZ || process.env.APP_TZ || 'Africa/Casablanca';

const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');

const app = express();

// Derrière le proxy de Vercel, l'adresse cliente et le caractère HTTPS de la requête ne sont
// connus que par les en-têtes X-Forwarded-* : sans cela `req.ip` vaudrait l'IP du proxy (rendant
// l'anti-bruteforce inopérant) et le cookie `secure` ne serait jamais émis.
app.set('trust proxy', 1);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

/**
 * Session dans un cookie signé plutôt qu'en mémoire serveur.
 * En serverless, chaque requête peut être servie par une instance différente : un magasin de
 * sessions en mémoire déconnecterait les utilisateurs au hasard. La session ne contient que
 * l'identifiant et le nom de l'utilisateur ; la signature empêche toute falsification.
 */
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error('SESSION_SECRET manquant : définissez une chaîne aléatoire longue en variable d’environnement.');
}
app.use(cookieSession({
  name: 'ptg.sid',
  keys: [sessionSecret],
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
}));

// Les routes de connexion doivent rester accessibles sans être déjà authentifié.
app.use('/api/auth', require('./routes/auth'));

// Portail d'authentification : protège toutes les pages et toutes les API, sauf la page de connexion
// elle-même et les ressources statiques partagées (CSS/JS, dont login.js n'a pas besoin d'être authentifié).
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentification requise' });
  if (req.path === '/login.html' || req.path.startsWith('/css/') || req.path.startsWith('/js/')) return next();
  return res.redirect('/login.html');
}
app.use(requireAuth);

app.use('/api/students', require('./routes/students'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/pointage', require('./routes/pointage'));
app.use('/api/excel', require('./routes/excel'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/fields', require('./routes/fields'));
app.use('/api/meta', require('./routes/meta'));

// Le dossier des pages s'appelle `client` et non `public` : Vercel sert automatiquement tout
// dossier `public/` en statique, ce qui court-circuiterait le portail d'authentification ci-dessus.
app.use(express.static(path.join(__dirname, 'client')));

// Toutes les routes étant asynchrones, leurs rejets remontent ici (cf. routes/_async.js).
// Le détail de l'erreur reste dans les logs : le client ne reçoit qu'un message générique.
app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Erreur serveur' });
});

module.exports = app;
