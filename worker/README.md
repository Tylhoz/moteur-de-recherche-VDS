# Adaptateur privé Cloudflare Workers

Ce point d’entrée réutilise les projections existantes du portail, du pilote et des graphiques. Il ne lance aucun serveur Node.js et ne lit aucun fichier local à l’exécution. L’export hors ligne conserve les vérifications d’identité de `PortalStore` et les calculs de `buildAnalytics`. `shared/worker-bundle.ts` vérifie à nouveau les identités sourcées, les références et les compteurs avant l’import.

| Ancien composant Node.js | Exécution Workers |
| --- | --- |
| Serveur `http` et réponses Node | `fetch(Request, env)` et `Response` standards |
| Lecture privée `fs` | Objet R2 privé, immuable, désigné par un pointeur actif |
| `crypto.createHash` | `crypto.subtle.digest('SHA-256', ...)` |
| Passerelle de session | Session native Sites Dispatch et contrôle d’origine à chaque requête |
| Fichiers frontend | `env.ASSETS.fetch`, après authentification, uniquement chemins génériques autorisés |

## Frontière d’authentification

**Déployer exclusivement derrière Sites Dispatch, dans un nouveau Site dont la politique d’accès est privée et limitée au propriétaire.** Ne pas exposer cet adaptateur via une URL Worker publique : sur une telle URL, un appelant pourrait forger les en-têtes d’identité. Le réglage `VDS_OWNER_PRIVATE=true` confirme la configuration attendue ; il ne remplace pas la politique d’accès de la plateforme.

Dispatch vérifie la session et injecte `oai-authenticated-user-id` ainsi que `oai-authenticated-user-email`. Toutes les API métier et tous les fichiers frontend exigent ces deux en-têtes. Les requêtes vers une autre origine ou issues d’un autre site sont refusées. Aucun identifiant client, jeton, nom de fichier privé ou diagnostic interne n’est inclus dans les messages d’erreur.

Seule exception au contrôle `Sec-Fetch-Site` : une navigation standard GET/HEAD vers la page générique `/` ou `/index.html`, sans en-tête `Origin`, reste possible après authentification. Cela permet d’ouvrir le lien depuis ChatGPT ou son aperçu intégré. Cette exception ne donne accès à aucune API ni route d’import.

L’import administratif peut passer par l’accès de service natif Sites. Il exige en plus un jeton propre à l’import et le digest attendu du fichier. Ce jeton ne permet pas, à lui seul, de lire les API métier. Le navigateur n’en reçoit jamais la valeur.

## Bindings et configuration

| Variable | Valeur attendue |
| --- | --- |
| `BUCKET` | Bucket R2 privé appartenant au nouvel aperçu, jamais public |
| `ASSETS` | Fonction `fetch` des fichiers génériques préparés par le build |
| `VDS_PUBLIC_ORIGIN` | Origine HTTPS exacte du nouvel aperçu, sans barre finale |
| `VDS_OWNER_PRIVATE` | `true`, après configuration effective de la politique privée propriétaire |
| `VDS_EXPECTED_BUNDLE_SHA256` | SHA-256 hexadécimal du fichier exporté, calculé sur ses octets UTF-8 exacts |
| `VDS_IMPORT_TOKEN_SHA256` | SHA-256 hexadécimal d’un jeton aléatoire base64url de 32 à 256 caractères |
| `VDS_RELEASE_ID` | Identifiant non confidentiel de cette publication |
| `VDS_COMMIT_SHA` | SHA Git complet, 40 caractères hexadécimaux |

## Import privé atomique

Envoyer le fichier privé à `POST /api/internal/import` avec `Content-Type: application/json` et `Authorization: Bearer <jeton-import>`, en plus de l’authentification native Sites. La taille réelle du corps est limitée à 4 Mio, même sans `Content-Length`.

L’import compare le digest, vérifie le schéma et les 500 dossiers / 10 fiches, écrit `vds/private/bundles/<digest>.json` avec condition de non-écrasement, relit l’objet pour contrôler son intégrité, puis remplace atomiquement `vds/private/active.json`. Une erreur avant cette dernière écriture conserve le pointeur précédent. Un réimport identique ne réécrit pas l’objet immuable. Aucun fichier source Google, document, e-mail ni ancien aperçu n’est modifié.

`GET /api/internal/import-status`, protégé par le même jeton, expose uniquement l’état de disponibilité, le digest et les nombres de dossiers/fiches. Le digest configuré doit correspondre à la version active ; une version non approuvée ou corrompue est refusée.

La dernière projection validée est conservée dans la mémoire privée de l’isolate pour éviter de répéter toute la validation métier à chaque requête. Le pointeur et les octets R2 restent relus et leur SHA-256 vérifié à chaque accès ; ce cache n’autorise donc pas à servir un objet devenu corrompu ou une version différente.

## Routes disponibles

Les routes authentifiées existantes sont conservées : `/api/v1/portal-snapshot`, `/api/v1/pilot`, `/api/v1/pilot/<id>`, `/api/v1/connections` et `/api/v1/analytics`. Les écritures métier sont refusées. `/release` et `/api/v1/release` donnent uniquement la version, le commit, le runtime et le mode d’accès, sans lecture de R2 ni données personnelles. La politique privée Sites demeure applicable à l’ensemble du domaine.

Les données publiées dans R2 sont des lectures réelles datées. Leur date de consultation, leur statut périmé et l’absence de connexion continue sont conservés. Une actualisation du navigateur ne simule pas une synchronisation Google. Les finances non vérifiées ne deviennent pas des totaux certifiés.

## Vérification sans serveur réseau

```sh
VDS_REAL_CHAIN_DATA_ROOT=/chemin/prive node --import tsx --test --test-isolation=none tests/worker-runtime.test.ts
npm run check
```

Les tests utilisent les vraies archives privées hors du dépôt pour vérifier le passage des 500 dossiers et des 10 fiches à l’identique, les refus d’accès, l’import borné, les erreurs de stockage, les sources et l’absence de certification financière. Ils ne prouvent pas à eux seuls une publication distante ni la politique d’authentification effectivement configurée : celles-ci doivent être vérifiées sur le nouvel aperçu HTTPS.
