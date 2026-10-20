# Publication séparée — correction Workers

État vérifié le 20 octobre 2026. Cette note décrit les changements effectués et la reprise exacte ; elle ne constitue pas une preuve de publication.

## Résultat livré dans le code

Vérifications : 116 tests réussis, zéro échec et zéro test ignoré ; compilation TypeScript/Vite/ESM réussie. Le module Worker compilé a été exécuté via Web Fetch avec les vraies archives et un stockage R2 simulé. Aucun test distant Cloudflare ou Safari n’est revendiqué.

- Le frontend React existant, les analyses et les fiches 360° sont réutilisés.
- `worker/index.ts` remplace le serveur HTTP Node à l'exécution par un handler Web `fetch`. Les lectures `fs` restent exclusivement dans la préparation hors ligne ; R2 fournit le stockage privé hébergé. Les empreintes utilisent Web Crypto.
- L'export réutilise `PortalStore` et ses rapprochements d'identité : 500 dossiers, 10 fiches enrichies, 146 événements et 32 contradictions. Les dates originales et les finances non vérifiées sont conservées. Aucune écriture Google n'est effectuée.
- Le Worker authentifie chaque route métier et chaque asset derrière Sites Dispatch. Un import administratif séparé exige le jeton de service Sites, un second secret, le digest préautorisé, puis une validation stricte avant activation atomique.
- Le build ESM est autonome, sans import Node, sans JSON métier public et sans fichier client joint au déploiement. `/api/v1/release` expose le commit et la version réellement construits.
- Les couleurs bleu, marine et jaune du logo joint sont appliquées. `BrandLogo` accepte l'actif original local ; aucun fichier de cette image n'a été fourni au système de fichiers. Le repli actuel est typographique, sans emblème de remplacement inventé.

## Séparation de la version 2

| Élément | Sauvegarde V2 | Nouvelle validation |
| --- | --- | --- |
| Site | `appgprj_6ad69a1b2ae88191b3275efe48c3b1ae` | `appgprj_6ad6cce3add881918a7fa5758e7b7ef7` |
| Version hébergée observée | 2 | 0, aucune publication |
| Manifeste conservé | `.openai/hosting.v2-backup.json` | `.openai/hosting.json`, identique à `hosting.preview.json` |
| Remote local | `v2-backup`, aucune écriture | `origin`, source pas encore transférée |

Le nouveau Site est privé, limité au propriétaire, sans visiteur externe ni groupe. Les variables serveur ont été configurées sur ce nouveau Site uniquement : origine HTTPS, mode privé, digest attendu et empreinte secrète du jeton d'import (révision 1). Aucun token n'est enregistré dans le dépôt.

L'origine réservée du nouveau Site est `https://vds-intelligence-360-validation.spiffyswan35.chatgpt.site`. **Il ne s'agit pas encore d'un lien fonctionnel de prévisualisation.** Ne pas le présenter comme publié.

## Diagnostic précis du blocage

Une connexion au proxy et une connexion à `127.0.0.1` échouent toutes deux avec `errno 1 / EPERM`, avant toute requête HTTP vers Cloudflare. Le processus affiche `NoNewPrivs: 1` et `Seccomp: 2`. Cela situe l'échec observé au niveau des permissions d'exécution réseau de l'environnement ; ces seules valeurs ne permettent pas d'identifier la règle système exacte qui le provoque.

La demande d'autorisation réseau par l'outil dédié n'a accordé aucune permission supplémentaire. Aucun refus d'authentification Cloudflare ni refus de publication distant n'a donc été observé. Le code ne peut pas corriger cette restriction d'exécution. Les helpers officiels Sites ne sont pas présents dans les emplacements accessibles recherchés. Le navigateur local est également bloqué ; les tests Fetch et rendus React ne sont pas des tests Safari/iPad.

Le binding R2 est désormais déclaré : `"r2": "BUCKET"`. Le format de nom de binding a été confirmé dans [la documentation Sites](https://learn.chatgpt.com/docs/sites/managing-a-site) et un [manifeste du starter D1/R2](https://github.com/j-256/d1-r2-starter-openai/blob/main/.openai/hosting.json). La construction le contrôle explicitement. Le provisionnement effectif reste à vérifier lors du déploiement ; aucune donnée n'a encore été importée sur le nouveau Site.

## Reprise reproductible dans un environnement autorisé

Cette procédure est destinée à Codex ou au développeur qui reprend la session ; elle n'impose pas à l'utilisateur de manipuler des secrets.

1. Conserver cette branche et les archives privées hors du dépôt. Utiliser un environnement avec accès réseau d'exécution et helpers officiels Sites disponibles. Lire les instructions de la skill Sites et ouvrir le **nouveau** projet via son helper de source. Ne pas recréer un Site ni pousser vers `v2-backup`.
2. Conserver `r2: "BUCKET"` dans les deux manifestes du nouveau Site et vérifier le provisionnement privé par Sites. Ne jamais activer un accès public au bucket. La politique propriétaire privée est une condition obligatoire : ne jamais déployer ce handler sur une URL Worker publique qui accepterait des en-têtes d'identité forgés.
3. Installer les dépendances avec `npm ci` sur une nouvelle copie. L'ancien lien absolu `node_modules` a été retiré du suivi Git. Préparer l'archive réelle hors dépôt avec `npm run worker:export -- /chemin/prive/sources /chemin/prive/export/worker-preview.private.json`. Relever uniquement son SHA-256 et ses compteurs.
4. Exécuter les tests avec les chemins privés configurés (voir ci-dessous), puis `npm run build:site`. Le résultat `dist/` contient uniquement `.openai/hosting.json` et `server/index.js`. `worker-dist/` conserve le même artefact pour les contrôles. Lancer `npm run worker:verify -- --private-bundle /chemin/prive/export/worker-preview.private.json`.
5. Enregistrer les changements source, puis reconstruire afin d'injecter le SHA exact. Utiliser `site-workflow.mjs --project-id appgprj_6ad6cce3add881918a7fa5758e7b7ef7` avec son credential natif par stdin, les commandes ordonnées restantes et un `archivePath` absolu. Le helper doit confirmer commit/push/package. Si son SHA diffère du SHA intégré, reconstruire depuis ce commit et refaire le package avant de publier. Ne pas associer l'ancien commit à de nouveaux fichiers.
6. Renouveler le secret d'import en mémoire si nécessaire ; configurer son hash et le digest du fichier privé via les variables serveur natives. Utiliser `save_version_and_deploy_private` avec le projet, le commit poussé et l'archive retournés par le helper. Attendre `succeeded` ; conserver un éventuel `saved_version_id` pour reprendre sans créer de doublon.
7. Charger séparément les données dans R2 avec `node --use-env-proxy scripts/import-worker-data.mjs /chemin/prive/export/worker-preview.private.json`. Transmettre le JSON de credentials exclusivement par stdin caché : `{ "siteBearer": "<jeton-service-Sites>", "importBearer": "<jeton-import>" }`. Le script contrôle HTTPS, absence de redirection, digest, 500 dossiers, 10 fiches et disponibilité après import. Ne jamais copier ce JSON dans un fichier, un ticket ou le terminal visible.
8. Vérifier sur le véritable domaine : refus anonyme, session propriétaire, release/commit exacts, 500/10, dashboard, contrats HT et soldes vers analyses, clics graphiques, filtres et ouverture des bonnes fiches, chronologie et liens sources. Vérifier ordinateur et iPad. Donner le lien HTTPS seulement après réussite ; conserver V2 jusqu'à validation de l'utilisateur.

Commande de tests réels dans cet espace (les chemins ne doivent pas être publiés comme URL) :

```sh
VDS_REAL_CHAIN_DATA_ROOT=/workspace/work/vds-integration-private \
VDS_PILOT_UI_DATA=/workspace/work/vds-integration-private/pilot-10.private.json \
VDS_PILOT_AUDIT_TEST_INPUT=/workspace/work/vds-execution-20261020/summary/pilot-10.private.json \
npm run test:foundations
```

La synchronisation continue Google reste distincte de cet aperçu daté. Elle n'est pas nécessaire pour afficher ces vraies données, et son absence ne doit jamais être masquée par une fausse date de mise à jour.
