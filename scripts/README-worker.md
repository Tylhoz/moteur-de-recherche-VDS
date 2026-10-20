# Préparer le nouvel aperçu Workers

Ces commandes se lancent depuis la racine du dépôt. Elles n'appellent aucun service externe et ne publient rien.

## 1. Export privé des sources réelles

```sh
node --import tsx scripts/prepare-worker-data.ts /chemin/prive/sources /chemin/prive/export/worker-preview.private.json
```

Le répertoire de sources contient `native-sheet-read.private.json`, `pilot-10.private.json` et `portal-original.private.json`. Le répertoire de sortie doit rester hors du dépôt, avec des permissions `0700`. Le fichier dérivé est écrit en `0600` ; les sources sont inchangées.

L'export réutilise `PortalStore`, `PrivateNativeReadProvider` et `buildAnalytics`. Il exige les 500 dossiers et les 10 fiches rapprochées, conserve les dates de lecture originales et les valeurs financières non vérifiées. Le rapport affiche uniquement des compteurs et le SHA-256 exact de l'archive. Ce fichier ne doit jamais entrer dans `public`, `dist`, `worker-dist`, Git, une migration ou une archive de déploiement.

## 2. Compiler l'application et l'adaptateur Worker

```sh
npm run build
node scripts/build-worker.mjs --release-id vds-360-workers-preview
```

Le commit est lu depuis les métadonnées Git, sans lancer de sous-processus Node. Pour une construction CI, utiliser `--commit` avec le SHA complet du commit effectivement construit, ou `VDS_COMMIT_SHA` / `GITHUB_SHA`. Après le commit final, reconstruire l'artefact pour que `/api/v1/release` indique la bonne révision.

Le manifeste `.openai/hosting.preview.json` doit contenir l'identifiant réel du nouveau Site. La construction refuse l'identifiant V2 conservé dans `.openai/hosting.v2-backup.json`. Elle crée seulement `worker-dist/.openai/hosting.json` et `worker-dist/server/index.js`, conformément au format Worker ESM de Sites. Les assets génériques sont intégrés à ce module serveur ; le runtime authentifie la requête avant de les servir. Les imports Node sont interdits dans le module compilé.

## 3. Vérifier l'artefact, sans réseau

```sh
node scripts/verify-worker-artifact.mjs --private-bundle /chemin/prive/export/worker-preview.private.json
```

Cette vérification importe le module réellement compilé, contrôle le refus des accès non authentifiés, recherche les noms et e-mails clients dans les assets décodés, puis charge l'export dans un adaptateur de stockage uniquement en mémoire. Elle vérifie que le Worker sert les 500 dossiers, les 10 fiches et les graphiques sans altérer les projections. Elle ne valide pas une connexion à Cloudflare ni une authentification dans un navigateur.

## Stockage et publication

Le runtime attend un binding R2 nommé `BUCKET`, un Site propriétaire privé et les variables serveur `VDS_PUBLIC_ORIGIN`, `VDS_OWNER_PRIVATE=true`, `VDS_EXPECTED_BUNDLE_SHA256` et `VDS_IMPORT_TOKEN_SHA256`. Le token d'import privé est distinct du token de service Sites. Les données arrivent séparément par `POST /api/internal/import` après vérification de l'identité et de la configuration de l'hébergement.

Le binding est déclaré sous la forme `"r2": "BUCKET"` dans les manifestes. Cette forme correspond aux noms de bindings décrits par [la documentation Sites](https://learn.chatgpt.com/docs/sites/managing-a-site) et au manifeste du [starter D1/R2](https://github.com/j-256/d1-r2-starter-openai/blob/main/.openai/hosting.json), consultés le 20 octobre 2026. La construction refuse un binding absent ou différent. `storageBindingDeclared: true` prouve cette déclaration locale, pas le provisionnement distant : Sites doit encore créer/raccorder la ressource lors du déploiement.

Le helper natif Sites doit synchroniser le commit et empaqueter les deux fichiers compilés, puis déployer sur le nouveau Site privé. Ne pas publier l'export privé avec les assets. La version 2 demeure une sauvegarde séparée ; aucune de ces commandes ne la modifie.
