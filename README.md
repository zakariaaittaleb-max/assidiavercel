# Assidia

Application de gestion de pointage des étudiants (Node.js + Express + Postgres/Supabase, déployée sur Vercel).

## Pages

- **Pointage** (`/index.html`, page par défaut) — renseignez École / Cours / Niveau, la date et l'heure de début (proposée = heure ronde qui vient de passer) et l'heure de fin (proposée = début + 3h), puis ouvrez la session. Chargez les étudiants du niveau ou ajoutez-en manuellement, cliquez **Présent** pour horodater automatiquement chaque arrivée, ou **Expulser** pour enregistrer une expulsion avec sa raison. Tout reste modifiable à tout moment.
- **Tableau de bord** (`/dashboard.html`) — explorateur de statistiques : taux de présence, d'absence, de retard et d'expulsion, croisables par école, classe, niveau, cours, étudiant ou période, et comparaison du volume horaire planifié au volume réellement couvert.
- **Base de données** (`/database.html`) — gérez étudiants, cours et historique de pointage ; importez un fichier Excel (feuilles `Etudiants`, `Cours`, `Pointage`) ou exportez la base en `.xlsx`.

## Architecture

| | |
|---|---|
| Base de données | Postgres (Supabase), schéma `assidia` |
| Rôle applicatif | `assidia_app` — accès limité au seul schéma `assidia` |
| Sessions | cookie signé (`cookie-session`), sans état serveur |
| Hébergement | Vercel — `api/index.js` expose l'application Express |
| Pages statiques | `client/` (et non `public/`, que Vercel servirait hors du portail d'authentification) |

## Variables d'environnement

Voir `.env.example`. En local, elles sont lues depuis `.env.local` ; sur Vercel, depuis
Settings → Environment Variables.

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Chaîne de connexion Postgres (Supabase → Connect → **Transaction pooler**, avec l'utilisateur `assidia_app`) |
| `SESSION_SECRET` | Clé de signature des cookies. La changer déconnecte tout le monde |
| `APP_TZ` | Fuseau de l'établissement (défaut `Africa/Casablanca`) |
| `PTG_ADMIN_USER` / `PTG_ADMIN_PASSWORD` | Uniquement pour créer le premier compte sur une base vierge |

## Développement local

```bash
npm install
cp .env.example .env.local   # puis compléter DATABASE_URL et SESSION_SECRET
npm start                    # http://localhost:3210
```

## Scripts

```bash
npm run migrate:data -- --replace   # recharge les données depuis l'ancienne base SQLite
npm run check:sql                   # exerce chaque endpoint contre Postgres (CHECK_PASSWORD requis)
```

`check:sql` démarre l'application, s'authentifie et appelle chaque endpoint de lecture avec toutes
les combinaisons de dimensions et de métriques. Il ne vérifie pas les valeurs métier mais garantit
que chaque requête s'exécute réellement sur Postgres — utile après toute modification du SQL.

## Notes de portage (SQLite → Postgres)

L'application utilisait `better-sqlite3`, dont l'API est synchrone. `db.js` conserve la même
surface (`prepare().get()/all()/run()`, `transaction()`) mais en asynchrone, et absorbe deux
différences de dialecte de façon transparente : les paramètres `?` deviennent `$n`, et `LIKE`
devient `ILIKE` (LIKE est insensible à la casse en SQLite, sensible en Postgres — sans quoi toutes
les recherches auraient changé de comportement).

Trois écarts plus profonds ont été traités explicitement dans les routes :

- **Fuseau horaire.** `strftime(..., 'localtime')` suivait le fuseau de la machine. Hébergée, l'application
  tournerait en UTC, décalant d'une heure tous les retards calculés. Le fuseau est désormais explicite (`APP_TZ`).
- **Conversions permissives.** SQLite convertit `''` en `0` ; Postgres échoue. Les heures et les
  volumes horaires (saisis en texte libre) passent par des expressions gardées qui renvoient `NULL`
  sur une valeur mal formée.
- **Règles de syntaxe.** Postgres exige un alias sur les sous-requêtes de `FROM`, refuse les alias de
  sortie dans `HAVING`, et n'accepte pas `colonne IS ?` (remplacé par `IS NOT DISTINCT FROM`).

## Données

Les données personnelles des étudiants ne sont jamais versionnées : `data/` (ancienne base SQLite)
et `.env.local` sont exclus par `.gitignore`.
