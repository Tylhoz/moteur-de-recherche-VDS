# Reprise du code sauvegardé

Cette branche conserve tout le code de la refonte issue du commit local `8d59042610eb89ce0be43cb64f58779d8181d23e`. L'historique local contenant un ancien snapshot client ne doit pas être poussé vers GitHub. La sauvegarde publique utilise un nouveau commit et uniquement l'arbre de fichiers nettoyé ; la branche `main` n'est pas remplacée.

Les seuls changements nécessaires à la confidentialité sont l'externalisation de la référence du classeur dans `VDS_LEGACY_SPREADSHEET_ID`, son exemple de configuration vide et la suppression de sa valeur dans la documentation. Cette variable reste côté serveur ; sans configuration valide, le fournisseur refuse de lire des données ou de demander des credentials. Les fichiers source, tests, styles, scripts, manifestes et dépendances verrouillées sont conservés.

## Retrouver le code

Dans le nouvel environnement, sélectionner le dépôt `Tylhoz/moteur-de-recherche-VDS` et la branche `feat/vds-live-portal-integration`. Vérifier le commit affiché sur GitHub. Un téléchargement ZIP de cette branche récupère aussi tous les fichiers, y compris les dossiers commençant par un point.

Pour une récupération Git :

```sh
git clone --branch feat/vds-live-portal-integration --single-branch https://github.com/Tylhoz/moteur-de-recherche-VDS.git
cd moteur-de-recherche-VDS
npm ci
npm run worker:build
npm run worker:verify
```

Node.js 24 est requis par le script de transfert privé. La construction et la vérification générique ne demandent aucune donnée client. Les tests réels, l'export des sources et la consultation des dossiers demandent leurs archives/configurations privées, à rétablir séparément dans un stockage protégé. Les exemples techniques sous `tests/fixtures` ne sont jamais déployés comme données du portail.

## Rétablir les données privées

Ne pas placer les archives privées dans Git, `src`, `public` ou `dist`. Les 500 dossiers et les 10 fiches enrichies demeurent dans le stockage privé de l'ancien environnement ; la sauvegarde publique du code ne remplace pas leur transfert privé. Conserver l'ancien environnement jusqu'à la vérification de ce transfert.

L'archive d'import Workers déjà préparée peut être utilisée directement : elle contient les réponses validées, leurs dates et leurs sources. Pour régénérer cette archive à partir des sources originales, fournir `VDS_LEGACY_SPREADSHEET_ID` dans la configuration serveur privée, avec les trois fichiers décrits dans `scripts/README-worker.md`. La valeur est conservée dans l'archive native privée du propriétaire. Ne pas remplacer une donnée manquante par une démonstration.

## Publier après restauration

Les étapes de déploiement restent dans `docs/integration/workers-release.md`. Réutiliser le nouveau Site privé déjà créé, son binding `BUCKET` et ses secrets serveur ; ne pas recréer un projet ni remplacer la version 2. Le stockage sera provisionné à la publication, puis les données seront importées séparément par l'accès de service protégé.

Le transfert du code par le connecteur GitHub ne démontre pas que le terminal dispose du réseau. Avant de publier, vérifier les connexions HTTPS d'exécution dans le nouvel environnement, la disponibilité des helpers Sites et l'authentification propriétaire. Confirmer le commit réellement affiché par `/api/v1/release`, les refus d'accès anonymes, les 500 dossiers et les 10 fiches, puis les parcours ordinateur/iPad. Aucune publication ne doit être annoncée sur la seule base de la sauvegarde GitHub.
