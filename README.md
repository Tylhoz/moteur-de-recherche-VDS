# VDS Intelligence 360° — validation privée Workers

Refonte du portail VDS Pools, conservée sur la branche `feat/vds-live-portal-integration`. La nouvelle cible est un Site privé distinct ; la version 2 reste la sauvegarde et n'est pas remplacée.

## Application conservée

Tableau de bord, espaces Clients / Devis / Ventes / Chantiers / Factures / SAV, recherche, filtres, sélection et pagination. Les indicateurs ouvrent cinq analyses interactives ; les dossiers documentés disposent de fiches 360° et d'une Activity Timeline avec leurs sources.

Les 500 dossiers et les 10 fiches enrichies proviennent exclusivement d'archives réelles privées. Les montants non vérifiés, contradictions, documents seulement identifiés et informations manquantes gardent leur statut. Aucun graphique financier simulé n'est affiché. Google Sheets et les autres sources ne sont pas modifiés.

## Confidentialité

Les données métier ne figurent ni dans `src`, ni dans `public`, ni dans l'artefact de déploiement. L'export réel reste hors du dépôt puis est chargé séparément dans R2 privé, avec contrôle de son empreinte. L'API et les assets sont servis par `worker/index.ts`, derrière l'authentification native Sites et une politique limitée au propriétaire. Cet adaptateur ne doit jamais être exposé directement sur une URL Worker publique.

Les données de tests isolées sous `tests/fixtures` ne sont pas importées par l'application. La copie historique demeure préservée dans l'ancien aperçu et dans le stockage privé ; elle n'est plus servie statiquement par cette branche.

## Construction et vérification

Node.js 24 pour les scripts de transfert sécurisé :

```sh
npm ci
npm run check
npm run worker:build
npm run worker:verify -- --private-bundle /chemin/prive/worker-preview.private.json
```

`npm run build:site` prépare l'artefact Worker pour le packager Sites. Les scripts d'export, leurs permissions et les chemins de tests réels sont décrits dans [scripts/README-worker.md](scripts/README-worker.md). Les tests d'intégration utilisent les archives privées hors dépôt ; les tests techniques isolés ne deviennent jamais des données de production.

## État de publication

Le serveur Workers est implémenté et compilable. **Aucune nouvelle version n'est publiée** : les connexions de l'environnement échouent avec EPERM avant Cloudflare, les helpers officiels de publication ne sont pas installés. Le binding R2 est déclaré, son provisionnement reste à vérifier au déploiement. La création d'un nouveau Site privé ne vaut pas publication. La synchronisation continue Google n'est pas connectée.

La preuve des modifications, la séparation de V2 et la procédure de reprise se trouvent dans [docs/integration/workers-release.md](docs/integration/workers-release.md). Ne fournir un lien comme fonctionnel qu'après le déploiement et la vérification de la véritable version HTTPS.
