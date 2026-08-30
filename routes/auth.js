const bcrypt = require('bcryptjs');
const { asyncRouter } = require('./_async');
const db = require('../db');

const router = asyncRouter();

/**
 * Amorçage du compte administrateur.
 *
 * Il était fait au chargement du module, ce qui n'est plus possible : l'accès à Postgres est
 * asynchrone, et en environnement serverless ce code s'exécuterait à chaque démarrage à froid.
 * Il est donc devenu paresseux — tenté uniquement lors d'une connexion, et seulement si la table
 * des utilisateurs est vide (déploiement neuf sur une base vierge).
 *
 * Le mot de passe n'est jamais écrit dans le code source ni stocké en clair : il provient des
 * variables d'environnement, et seul son hash bcrypt est conservé.
 */
async function ensureAdminExists() {
  const { c } = await db.prepare(`SELECT COUNT(*)::int AS c FROM app_users`).get();
  if (c > 0) return true;

  const username = process.env.PTG_ADMIN_USER;
  const password = process.env.PTG_ADMIN_PASSWORD;
  if (!username || !password) return false;

  await db.prepare(`INSERT INTO app_users (username, password_hash) VALUES (?, ?)`)
    .run(username, bcrypt.hashSync(password, 12));
  return true;
}

/**
 * Anti-bruteforce léger, en mémoire, par adresse IP.
 * En serverless le compteur est propre à chaque instance : il freine un attaquant sans le bloquer
 * absolument. C'est une défense d'appoint, la protection réelle restant le hash bcrypt à coût 12.
 */
const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  const rec = failedAttempts.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    const wait = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${wait}s.` });
  }
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

  const seeded = await ensureAdminExists();
  if (!seeded) {
    return res.status(503).json({
      error: "Aucun compte n'existe encore. Définissez PTG_ADMIN_USER et PTG_ADMIN_PASSWORD dans les variables d'environnement.",
    });
  }

  const user = await db.prepare(`SELECT * FROM app_users WHERE username = ?`).get(username);
  const ok = user && bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    const next = { count: (rec?.count || 0) + 1, lockedUntil: 0 };
    if (next.count >= MAX_ATTEMPTS) next.lockedUntil = Date.now() + LOCK_MS;
    failedAttempts.set(ip, next);
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }
  failedAttempts.delete(ip);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

// La session vit désormais dans un cookie signé (cookie-session), sans stockage serveur :
// la détruire consiste à effacer le cookie.
router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  res.json({ username: req.session.username });
});

// Changer son mot de passe : nécessite d'être connecté ET de fournir le mot de passe actuel.
router.post('/change-password', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });
  }
  const user = await db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(req.session.userId);
  if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  }
  await db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(newPassword, 12), user.id);
  res.json({ ok: true });
});

module.exports = router;
