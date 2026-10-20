# Authentification du Worker Cloudflare direct

L’entrée directe est `worker/cloudflare.ts`. Elle réutilise l’API et le stockage privé de `worker/index.ts` après vérification d’une session **Cloudflare Access**. Elle ne dépend pas de Sites Dispatch et refuse les identités `oai-*` envoyées par un navigateur ou un script.

Cloudflare ajoute le jeton applicatif dans `Cf-Access-Jwt-Assertion`. Le Worker vérifie sa signature RS256 avec les clés JWKS de l’équipe, son émetteur, l’audience de l’application, sa période de validité et son type applicatif. Il exige ensuite que l’adresse e-mail signée corresponde exactement, sans distinction de casse, à `VDS_OWNER_EMAIL`. Les cookies seuls et les jetons de service dépourvus d’identité propriétaire ne suffisent pas. Voir les documents officiels [validation des JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) et [contenu du jeton applicatif](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

## Configuration serveur

| Élément | Configuration attendue |
| --- | --- |
| `VDS_PUBLIC_ORIGIN` | Origine HTTPS exacte du portail, sans chemin ni barre finale |
| `VDS_ACCESS_TEAM_DOMAIN` | `https://<équipe>.cloudflareaccess.com`, sans barre finale |
| `VDS_ACCESS_AUD` | Audience de l’application Access réellement configurée |
| `VDS_OWNER_EMAIL` | Adresse du propriétaire, conservée dans la configuration privée Cloudflare |
| `BUCKET` | Binding R2 privé contenant les archives du portail |
| `ASSETS` | Binding des fichiers génériques compilés par Vite |
| `VDS_EXPECTED_BUNDLE_SHA256` | Empreinte exacte de l’export privé autorisé |
| `VDS_IMPORT_TOKEN_SHA256` | Empreinte SHA-256 du jeton d’import administratif |
| `VDS_IMPORT_TOKEN` | Facultatif : secret serveur destiné au routeur d’import depuis l’interface ; jamais renvoyé au navigateur |
| `VDS_RELEASE_ID`, `VDS_COMMIT_SHA` | Identité réelle de la publication fournie par le build ou la configuration serveur |

Ne pas inscrire l’adresse réelle du propriétaire, les jetons ou les données clients dans le dépôt. Une variable Access manquante ou incorrecte ferme l’accès ; aucun mode dégradé anonyme n’est disponible. L’application Access doit couvrir tout le domaine avec une politique autorisant uniquement le propriétaire, sans règle de contournement.

Configurer Wrangler pour appeler le Worker **avant tous les assets**, avec `assets.run_worker_first: true`. Sans cela, Cloudflare peut servir un fichier statique avant le contrôle applicatif. Référence : [ordre de routage Worker et assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Contrôle des requêtes

Le Worker vérifie le JWT à chaque requête. Les clés publiques sont gardées au maximum cinq minutes et renouvelées via le mécanisme JWKS de `jose`. L’URL des clés provient uniquement de la configuration serveur : aucun `iss`, `jku`, `x5u` ou lien de redirection fourni par le jeton ne choisit une destination réseau.

Après authentification, les en-têtes d’identité client, proxy et cookies sont retirés. L’identité signée remplace les deux en-têtes internes attendus par l’API existante. L’origine du portail reste contrôlée, y compris pour les extensions. Une navigation classique vers `/` depuis un lien externe est autorisée après authentification ; les API intersites restent interdites.

Les erreurs sont génériques : `401` pour une session absente ou invalide, `403` pour un autre propriétaire ou une origine interdite, `503` pour une configuration absente ou une indisponibilité technique. Les réponses ne contiennent ni secret, ni jeton, ni diagnostic de stockage.

## Routes et statut de connexion

`GET /api/v1/setup` exige une session propriétaire. Son schéma `cloudflare-setup-1` expose uniquement des indicateurs de configuration, la version du build et l’état du stockage : `not_configured`, `empty`, `unavailable` ou `ready`. Les nombres de dossiers et fiches sont `null` tant qu’une lecture validée n’a pas abouti. Le statut ne révèle aucune valeur d’e-mail, d’audience, de jeton ou d’empreinte privée.

Les routes métier existantes, `/release` et `/api/v1/release` passent également par Cloudflare Access. Le marqueur d’authentification des versions est `cloudflare-access`. La connexion initiale est gérée par Access ; une navigation vers `/` permet de relancer le parcours lorsque la session expire.

`POST /api/internal/import` conserve les contrôles existants : session propriétaire **et** jeton administratif `Authorization: Bearer …`, digest autorisé, validation des 500 dossiers et 10 fiches, limite de 4 Mio, écritures R2 immuables et activation atomique. L’extension `handleAuthorized` ne peut pas intercepter ces routes internes.

## Vérification

```sh
VDS_REAL_CHAIN_DATA_ROOT=/chemin/prive node --import tsx --test --test-isolation=none tests/cloudflare-access.test.ts
npm run check
```

Les tests signent réellement des jetons avec une paire RSA temporaire, puis vérifient les signatures invalides, les audiences et dates incorrectes, les autres propriétaires, les faux en-têtes, le stockage inaccessible et le passage à l’identique des archives privées. Le transport JWKS et R2 sont simulés dans ces tests : la politique Access effective et le résultat HTTPS doivent encore être vérifiés après déploiement.
