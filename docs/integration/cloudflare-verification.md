# Vérifications du déploiement direct Cloudflare

État constaté le 20 octobre 2026 pour la branche `feat/vds-live-portal-integration`.

## Vérifications réalisées

- Suite complète : **154 tests réussis, 0 échec, 0 test omis**, en fournissant les archives privées hors dépôt.
- Compilation TypeScript et production Vite : réussies.
- Preflight : 31 assets génériques contrôlés, aucun export privé intégré.
- `npx wrangler deploy --dry-run` : réussi ; entrée `worker/cloudflare.ts`, bindings `ASSETS` et `BUCKET`, Worker empaqueté pour Cloudflare.
- Signature et validation de JWT RSA réels dans les tests ; transport JWKS et stockage R2 simulés.
- Import privé des 500 dossiers et 10 fiches, validation du digest, refus des accès anonymes et des identités différentes, archives inchangées.
- Google Sheets : configuration absente sans appel réseau, comparaison et approbation, contrôle d'identité, relecture de la source et concurrence testés avec un transport isolé.
- Notes et marqueurs : persistance, idempotence, historique, erreurs de stockage et écritures concurrentes testés.
- Après approbation, une proposition déjà appliquée disparaît de la file. Une version active corrompue ne se présente pas comme disponible.

Les différences créées dans certains tests n'existent que dans leur mémoire isolée. Les données métier originales ne sont pas modifiées et aucun service Google ou de facturation n'est écrit.

## Limites constatées

`wrangler whoami` indique qu'aucun compte Cloudflare n'est authentifié dans l'environnement d'exécution. Le dry-run n'a donc effectué aucune publication ni création de bucket.

La vérification Playwright a été préparée hors dépôt, mais n'a pas pu ouvrir de navigateur : le serveur local est refusé avec `EPERM` sur `listen(127.0.0.1)`. Une seconde tentative sans serveur, en interceptant les requêtes en mémoire, s'arrête avant création de page : Chromium reçoit `Operation not permitted` sur une opération de socket puis `SIGTRAP`. Aucune capture ni validation visuelle ordinateur/iPad n'est revendiquée.

L'état distant de Cloudflare Access, de R2, des secrets Google et du Worker publié n'est pas confirmé par ces tests. Les comptes réels ne seront visibles sur le domaine qu'après configuration et import privés. L'API VosFactures est préparée au niveau des paramètres, mais son adaptateur reste à implémenter après confirmation du fournisseur.

## Réception dans le compte autorisé

Suivre [la procédure de déploiement](cloudflare-deployment.md). Après publication, vérifier `/api/v1/release`, puis l'accès propriétaire, les 500 dossiers et 10 fiches, les recherches, la pagination, les analyses, les fiches 360°, la chronologie, l'enregistrement des notes après rechargement et l'usage sur iPad. Un test local réussi ne remplace pas cette réception HTTPS.
