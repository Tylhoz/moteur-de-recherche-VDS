# VDS Intelligence 360° — validation privée Workers

Refonte du portail VDS Pools conservée sur `feat/vds-live-portal-integration`. La branche de livraison `release/vds-private-production` cible uniquement le nouveau Worker `moteur-de-recherche-vds-prive`, avec les assets Vite et Cloudflare Access. Le Worker actuel `moteur-de-recherche-vds` et l'ancien aperçu Sites version 2 restent inchangés. Aucune publication ni import ne doit être déclenché sans autorisation du propriétaire.

## Application conservée

Tableau de bord, espaces Clients / Devis / Ventes / Chantiers / Factures / SAV, recherche, filtres, sélection et pagination. Les indicateurs ouvrent cinq analyses interactives ; les dossiers documentés disposent de fiches 360° et d'une Activity Timeline avec leurs sources.

Les 500 dossiers et les 10 fiches enrichies proviennent exclusivement d'archives réelles privées. Les montants non vérifiés, contradictions, documents seulement identifiés et informations manquantes gardent leur statut. Aucun graphique financier simulé n'est affiché. Google Sheets et les autres sources ne sont pas modifiés.

## Confidentialité

Les données métier ne figurent ni dans `src`, ni dans `public`, ni dans l'artefact de déploiement. L'export réel reste hors du dépôt puis est chargé séparément dans R2 privé, avec contrôle de son empreinte. L'entrée `worker/cloudflare.ts` vérifie la signature Cloudflare Access et l'identité du propriétaire avant toute API ou tout asset. Elle réutilise `worker/index.ts` comme adaptateur interne. Ce dernier ne doit jamais être exposé directement sur une URL Worker publique.

Les données de tests isolées sous `tests/fixtures` ne sont pas importées par l'application. La copie historique demeure préservée dans l'ancien aperçu et dans le stockage privé ; elle n'est plus servie statiquement par cette branche.

## Construction et vérification

Node.js 24 pour les scripts de transfert sécurisé :

```sh
npm ci
npm run build
npm run test:foundations
npx wrangler deploy --dry-run --outdir /tmp/vds-cloudflare-dry-run
```

Suivre [la configuration Cloudflare](docs/integration/cloudflare-deployment.md) pour Access, R2, les secrets et Workers Builds. Le panneau **Données & accès** affiche les réglages disponibles, la version et les vrais comptes, puis permet l'import privé après authentification. Les tests sur archives réelles utilisent des fichiers hors dépôt ; ils sont omis si ces fichiers ne sont pas disponibles.

La [préparation automatisée de l'accès privé](docs/integration/private-production-preparation.md) inspecte R2 et Access avant toute modification. Cloudflare utilise **`npm run build`**. `build:site` reste réservé à l'ancien hébergement Sites.

Google Sheets est préparé en lecture seule avec une vérification toutes les cinq minutes et une file d'approbation des différences. Les notes de contrôle sont persistantes dans R2. La configuration de la future facturation est réservée, mais l'adaptateur VosFactures n'est pas encore activé : voir [les sources et leurs limites](docs/integration/provider-configuration.md).

`npm run build:site` reste disponible pour l'ancien packager Sites. Les scripts d'export et les chemins privés sont décrits dans [scripts/README-worker.md](scripts/README-worker.md). Les données de test ne deviennent jamais des données de production.

## État de publication

Le déploiement statique effectué par le propriétaire affiche l'interface ; cela ne prouve pas le fonctionnement de l'API. Le serveur Cloudflare direct est maintenant implémenté. Le propriétaire a confirmé la création du bucket R2 privé `vds-intelligence-360-private` : il doit être réutilisé. L'existence du nouveau Worker, sa configuration Access, le binding R2, l'import privé et les credentials Google restent à vérifier dans l'environnement distant. Les succès de compilation et de tests ne constituent pas une preuve de publication.

La preuve des modifications, la séparation de V2 et la procédure de reprise se trouvent dans [docs/integration/workers-release.md](docs/integration/workers-release.md). Ne fournir un lien comme fonctionnel qu'après le déploiement et la vérification de la véritable version HTTPS.

Déclenchement du déploiement Cloudflare — 20 octobre 2026
