# Vérifications du déploiement direct Cloudflare

État constaté le 20 octobre 2026 pour la livraison `release/vds-private-production`.
La branche historique `feat/vds-live-portal-integration` reste inchangée sur GitHub afin de préserver son déploiement automatique vers l'ancien Worker.

## Vérifications réalisées

- Suite complète : **159 tests réussis, 0 échec, 0 test omis**, en fournissant les archives privées hors dépôt.
- Préparation Cloudflare : **15 tests Python réussis** avec API simulée, notamment les refus d'une politique Access élargie et d'un stockage public.
- Compilation TypeScript et production Vite : réussies.
- Preflight : 32 assets génériques contrôlés, aucun export privé intégré. Le favicon est désormais résolu et empaqueté par Vite.
- `npx wrangler deploy --dry-run` : réussi ; entrée `worker/cloudflare.ts`, bindings `ASSETS` et `BUCKET`, Worker empaqueté pour Cloudflare.
- Signature et validation de JWT RSA réels dans les tests ; transport JWKS et stockage R2 simulés.
- Import privé des 500 dossiers et 10 fiches, validation du digest, refus des accès anonymes et des identités différentes, archives inchangées.
- Google Sheets : configuration absente sans appel réseau, comparaison et approbation, contrôle d'identité, relecture de la source et concurrence testés avec un transport isolé.
- Notes et marqueurs : persistance, idempotence, historique, erreurs de stockage et écritures concurrentes testés.
- Après approbation, une proposition déjà appliquée disparaît de la file. Une version active corrompue ne se présente pas comme disponible.

Les différences créées dans certains tests n'existent que dans leur mémoire isolée. Les données métier originales ne sont pas modifiées et aucun service Google ou de facturation n'est écrit.

## Vérification interactive locale

Les 13 parcours ont été vérifiés sur deux formats Chromium : ordinateur 1440 × 1000 et tablette tactile 1024 × 1366. Cela couvre les comptes de dossiers, les liens Contrats HT et Soldes, la pagination, la recherche avec ouverture du dossier, une recherche vide, les filtres de statut, les 10 fiches enrichies, la chronologie, les modules métier, la sélection d'un segment graphique, le centre de validation et l'absence de débordement horizontal.

Le premier passage a réussi 25 contrôles sur 26. Le clic sur le graphique ordinateur était calculé hors de la zone visible par le script de test ; après défilement du graphique dans la fenêtre, ce seul contrôle a été relancé et a réussi. Aucun correctif de l'application n'a été nécessaire pour ce clic. Aucun message d'erreur du navigateur ni réponse API en erreur n'a été relevé lors du passage final et de cette reprise ciblée.

Le navigateur utilise les véritables 500 dossiers et 10 fiches par l'intermédiaire du gestionnaire Cloudflare réel, avec transport intercepté, JWT de test et stockage en mémoire. Les archives et captures restent privées, hors dépôt ; leur empreinte est inchangée. Les montants non vérifiés restent signalés et ne produisent pas de courbes financières inventées.

Ces contrôles ne constituent ni un déploiement distant ni un test Safari sur un iPad physique.

## Limites constatées

`wrangler whoami` indique qu'aucun compte Cloudflare n'est authentifié dans l'environnement d'exécution. Le dry-run n'a donc effectué aucune publication ni création de bucket.

L'environnement courant autorise désormais Chromium ; l'ancien blocage local `EPERM` n'empêche plus ces vérifications. En revanche, sa politique réseau reste restrictive : `api.cloudflare.com` n'est pas autorisé, aucun jeton Cloudflare ni identité sortante n'est configuré. La demande d'autorisation réseau effectuée pendant la tâche n'a accordé aucun accès supplémentaire.

Le dernier contrôle GitHub consulté sur le commit `2a52ce6106adcb711e46e7ac5a7fcec9692fa009` indique un build réussi de l'ancien Worker à 05:10:12 UTC, version `c6970862-0cff-41c7-b3ec-2065270b983a`. Cela ne confirme pas la version actuellement servie.

L'état distant de Cloudflare Access, de R2, des secrets Google et du Worker publié reste **non vérifié**. Le bucket existe selon le propriétaire ; aucun second bucket n'a été créé. Le domaine d'équipe et l'AUD ne sont pas récupérables sans accès au compte. L'import distant n'a pas eu lieu depuis cette tâche : **portail non encore opérationnel avec les données réelles**.

Le connecteur Google Sheets permet une lecture dans cette conversation, mais ne fournit pas au Worker ses propres identifiants OAuth. La copie métier disponible date du 20 octobre 2026 à 00:39 UTC ; aucune synchronisation continue en production n'est confirmée. Gmail et Agenda alimentent les enrichissements déjà extraits, sans synchronisation continue installée. L'API VosFactures est préparée au niveau des paramètres, mais son adaptateur reste à implémenter après confirmation du fournisseur.

## Réception dans le compte autorisé

Suivre [la procédure de déploiement](cloudflare-deployment.md). Après publication, vérifier `/api/v1/release`, puis l'accès propriétaire, les 500 dossiers et 10 fiches, les recherches, la pagination, les analyses, les fiches 360°, la chronologie, l'enregistrement des notes après rechargement et l'usage sur iPad. Un test local réussi ne remplace pas cette réception HTTPS.
