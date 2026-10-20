# Préparation opérationnelle de l'environnement privé

La cible est `moteur-de-recherche-vds-prive`, branche `release/vds-private-production`.
La branche historique `feat/vds-live-portal-integration` reste reliée à l'ancien Worker ; ne pas la déplacer pour déployer cette livraison.
Le bucket `vds-intelligence-360-private` existe d'après le propriétaire et doit être réutilisé, jamais recréé.

## Erreur `access_configuration_required`

Cette erreur signifie qu'au moins une valeur parmi `VDS_ACCESS_TEAM_DOMAIN`, `VDS_ACCESS_AUD` et `VDS_OWNER_EMAIL` est absente ou invalide.
Le contrôle est effectué avant les assets et avant R2. La réponse seule ne permet pas d'identifier laquelle.
Créer R2, refaire le build ou désactiver l'authentification ne résout pas ce défaut de configuration.

La préparation ci-dessous récupère les vraies valeurs Access. Elle ne remplace pas leur installation dans le nouveau Worker ni le test de la session réelle.

## Script de préparation

Python 3, sans dépendance supplémentaire. Les accès doivent être autorisés dans l'environnement : HTTPS vers `api.cloudflare.com`, authentification via une variable secrète `CLOUDFLARE_API_TOKEN`, identifiant du compte dans `CLOUDFLARE_ACCOUNT_ID`, propriétaire dans `VDS_OWNER_EMAIL`. Ne jamais fournir le jeton en argument, dans Git ou dans la conversation.

Permissions du jeton limitées au compte concerné :

- Workers R2 Storage : Read pour la vérification du bucket.
- Access: Organizations, Identity Providers, and Groups : Read.
- Access: Apps and Policies : Read pour l'inspection, Write pour la création.

Le déploiement des Workers et l'import R2 nécessitent des permissions distinctes, qui ne sont pas exercées par ce script.

```sh
python3 scripts/cloudflare-prepare.py
```

Le mode par défaut ne fait que lire. Il vérifie le bucket, l'absence d'accès public, le domaine d'équipe Access, la connexion par code e-mail déjà configurée, et les applications existantes. Il ne crée ni Worker, ni bucket, ni fournisseur de connexion.

Pour appliquer une préparation autorisée, avec un répertoire privé existant hors dépôt en mode `0700` :

```sh
python3 scripts/cloudflare-prepare.py --apply --output /repertoire-prive/access.private.json
```

Ce mode crée seulement l'application Access manquante pour le nom d'hôte exact du nouveau Worker, avec une unique politique Allow pour le propriétaire fourni. Toute application existante ambiguë, règle élargie, destination supplémentaire ou stockage public provoque un arrêt sans modification de cette ressource. Un fournisseur de connexion absent est signalé ; la configuration globale du compte n'est pas modifiée automatiquement.

Le résultat est relu par l'API avant l'export. Le fichier JSON contient les trois réglages Access, reste en mode `0600` hors dépôt, et n'est jamais écrasé. Les valeurs ne sont pas affichées. Cet export est compatible avec une future commande `wrangler secret bulk`, exécutée uniquement contre le nouveau Worker après inspection de sa configuration.

## Import privé préparé séparément

L'export de production `worker-preview.private.json` doit rester hors dépôt et hors `dist`. Utiliser `validateWorkerBundle` avant l'import : vérifier les 500 dossiers, 10 fiches, identifiants, références et empreinte SHA-256. Conserver les sources originales.

Les paramètres d'import sont un digest `VDS_EXPECTED_BUNDLE_SHA256`, un secret aléatoire `VDS_IMPORT_TOKEN` et éventuellement son empreinte `VDS_IMPORT_TOKEN_SHA256`. Les conserver dans un fichier privé hors dépôt, sans remplacer des valeurs déjà en service avant d'avoir vérifié leur usage.

Après authentification réelle du propriétaire, l'import utilise `POST /api/v1/setup/import` depuis le panneau Données & accès. Une réussite locale ou un export présent ne prouve pas que l'import distant a eu lieu.

## Vérifications à exécuter

```sh
python3 tests/cloudflare-prepare.test.py
npm run build
npm run test:foundations
npx wrangler deploy --dry-run --outdir /tmp/vds-cloudflare-dry-run
```

Pour inclure les tests métier privés, fournir `VDS_REAL_CHAIN_DATA_ROOT`, `VDS_PILOT_UI_DATA` (bundle normalisé), `VDS_PILOT_AUDIT_TEST_INPUT` (audit brut) et `VDS_LEGACY_SPREADSHEET_ID`. Ces valeurs et fichiers restent hors GitHub. Sans les archives, les tests correspondants sont omis ; il faut le signaler dans le rapport.

Les tests de préparation utilisent un transport Cloudflare simulé. Ils vérifient les garde-fous et la gestion des erreurs, jamais l'état réel du compte.
La réception finale exige l'URL HTTPS réellement déployée, le refus des accès anonymes, une session propriétaire, les comptes de dossiers relus par l'API et les parcours ordinateur/iPad.
