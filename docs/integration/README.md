# Intégration privée — VDS Intelligence 360°

## État du développement au 20 octobre 2026

Branche de travail : `feat/vds-live-portal-integration`. Le frontend React utilise désormais les routes privées du serveur : lecture des 500 dossiers, recherche, filtres, sélection, pagination et accès aux fiches pilotes documentées. Le code ne remplace pas le portail actuellement publié.

Une lecture réelle et datée de Google Sheets portant sur 500 dossiers est conservée dans une archive privée. Les dix fiches issues de l'audit documentaire sont également conservées hors du dépôt. Les nouvelles données réelles ne sont ni codées dans les composants, ni copiées dans `src/`, `public/` ou `dist/`. Elles sont transmises à l'interface par une réponse privée authentifiée, puis conservées en mémoire pour la session. Aucun secret serveur ne doit parvenir au navigateur.

Le fichier historique des 500 dossiers reste conservé ; Vite est configuré avec `publicDir: false` et ne le copie pas dans la nouvelle compilation. La passerelle n'autorise pas l'accès à ce fichier, aux exports JSON ou aux répertoires privés. Aucun jeu de démonstration ne remplace une source absente.

**L'intégration n'est pas déployée et la connexion Google durable du serveur n'est pas active.** Le mode vérifiable est une lecture de l'archive réelle privée, avec un état explicite « Source non connectée ». La connexion Google utilisée dans la conversation n'est pas une identité du serveur. Les dix fiches restent un audit privé à vérifier ; elles ne constituent pas une validation humaine ni une modification des sources.

La chaîne transport React → API → adaptateurs est testable dans un même processus sur ces fichiers privés. Cela ne démontre pas l'existence d'un domaine HTTPS, d'une session d'hébergement vérifiée ou d'un consentement OAuth opérationnel. Aucun e-mail, facture, événement Agenda ou document source n'est créé, modifié ou supprimé par cette intégration.

## Hébergement Sites : Workers

La cible Sites utilise désormais `worker/index.ts` : Web Fetch, stockage privé R2 et identité injectée par Sites Dispatch. Le navigateur reçoit les mêmes projections que le serveur Node. `server/web-gateway.ts` reste un adaptateur Node local et n'est pas utilisé par le déploiement Workers. La préparation hors ligne réutilise ses fournisseurs et contrôles d'identité.

La procédure actuelle et les blocages sont décrits dans [workers-release.md](workers-release.md). Les indications Node qui suivent concernent exclusivement l'adaptateur générique local, pas le nouveau Site.

## Chaîne prévue pour l'hébergement

```text
Navigateur authentifié
  → passerelle HTTPS de même origine
    → vérification et autorisation de la session de l'hébergeur
      → API interne en lecture seule
        → archive native privée OU Google Sheets via OAuth serveur
        → fiches pilotes et référence d'identité privées
```

`server/web-gateway.ts` fournit `createWebGateway`. Son callback `authenticate(request)` doit vérifier ET autoriser la véritable session de l'hébergement à chaque requête. Aucun flux de connexion, cookie de session, connexion à un fournisseur d'identité ou retour OAuth utilisateur n'est livré dans cette passerelle. Le callback utilisé par les tests est exclusivement un contrôle de test : il ne doit jamais devenir celui de l'hébergement.

Après vérification de la session, la passerelle injecte un Bearer interne côté serveur. Elle élimine les cookies, Bearer et en-têtes d'identité fournis par le navigateur avant d'appeler l'API. L'API compare l'empreinte SHA-256 de ce Bearer. Le navigateur n'obtient jamais ce secret. La passerelle exige une origine HTTPS exacte, refuse les autres origines et interdit les écritures. Ses réponses privées utilisent `Cache-Control: private, no-store`.

`server/index.ts` démarre uniquement l'API Node sur `127.0.0.1`, avec `npm run api:readonly`. Il ne crée ni ne démarre la passerelle et n'intègre aucun login. L'hébergement doit fournir le point d'entrée de la passerelle, le callback de session, le domaine HTTPS et la terminaison TLS. Ne pas exposer directement le port interne sur Internet. `npm run dev` et `npm run preview` ne constituent pas un aperçu privé prêt à partager.

## Deux fournisseurs pour le portail

| `VDS_PORTAL_PROVIDER` | Comportement |
|---|---|
| `none` ou absent | Les routes du portail répondent « Source non connectée » ; aucune source de remplacement n'est chargée. |
| `private_native_read` | Charge une archive réelle datée et explicitement configurée. La date Google provient de l'archive et ne change pas à chaque visite. `sheetReady=false`, `status=not_connected`, `stale=true`. |
| `google_sheets` | Utilise une identité OAuth serveur avec renouvellement du jeton et lit la plage autorisée. Ce mode exige les secrets, les permissions Google et l'accès réseau avant de fonctionner. |

Le mode Google lit uniquement l'onglet vérifié `Base_Centrale_360`, plage `A1:H501`. Les métadonnées doivent confirmer la grille de 501 lignes et 8 colonnes avant et après chaque passe. Deux lectures de valeurs identiques sont nécessaires. Toute extension de grille, changement d'en-tête, dossier absent ou dupliqué ou modification pendant la lecture bloque l'actualisation. Les huit colonnes restent des observations textuelles ; les montants non certifiés sont `null` et la catégorie est `non_verifie`.

La configuration OAuth est détaillée dans [google-connection.md](./google-connection.md). Le serveur accepte le seul scope `https://www.googleapis.com/auth/spreadsheets.readonly`, refuse un scope plus large, les redirections et les réponses trop volumineuses. Le consentement initial, son retour HTTPS et l'enregistrement du jeton de renouvellement restent à intégrer avec l'hébergement. L'accès public du classeur n'est pas nécessaire.

## Variables serveur

`server/env.example` répertorie les noms de variables sans secret. Il n'est pas chargé automatiquement. Les valeurs sont injectées dans le processus par la configuration privée de l'hébergeur ou son gestionnaire de secrets. Aucun secret ne doit avoir un nom `VITE_*`, figurer dans une URL ou être commité.

| Variable | Usage |
|---|---|
| `VDS_API_BEARER_SHA256` | Empreinte SHA-256 du Bearer interne : 64 caractères hexadécimaux. Le Bearer brut reste dans la configuration privée de la passerelle, qui le reçoit comme option `internalBearer`. |
| `VDS_API_PORT` | Port interne, 8787 par défaut ; écoute sur l'interface locale. |
| `VDS_ALLOWED_ORIGIN` | Facultatif : origine HTTPS exacte autorisée par l'API directe. Ce réglage ne crée pas une session. La passerelle vérifie séparément son option `publicOrigin`. |
| `VDS_PORTAL_PROVIDER` | `none`, `private_native_read` ou `google_sheets`. |
| `VDS_PRIVATE_DATA_ROOT` | Répertoire privé hors du dépôt, permissions 0700. Les chemins des données doivent se résoudre dans cette racine. |
| `VDS_NATIVE_READ_FILE` | Archive réelle au format `native-sheet-read-1`, permissions 0600 ; requis en mode `private_native_read`. |
| `VDS_PILOT_FILE` | Fiches normalisées au format `pilot-1`, permissions 0600 ; requis pour les deux fournisseurs du portail. |
| `VDS_IDENTITY_BASELINE_FILE` | Référence privée des 500 identités auditées, permissions 0600 ; requise pour contrôler le rattachement des fiches. |
| `VDS_SYNC_JOURNAL_FILE` | Facultatif : journal JSONL privé dans la racine autorisée, permissions 0600. Dates, révisions, compteurs et codes d'erreur, sans valeurs clients ni secrets. |
| `VDS_GOOGLE_CLIENT_ID` | Client OAuth dédié au serveur ; requis en mode portail `google_sheets`. |
| `VDS_GOOGLE_CLIENT_SECRET` | Secret de ce client OAuth, conservé par le serveur. |
| `VDS_GOOGLE_REFRESH_TOKEN` | Jeton obtenu avec le consentement professionnel autorisé et le seul scope de lecture Sheets. |

Le Bearer interne aléatoire doit compter 32 à 256 caractères parmi lettres, chiffres, `_` et `-`. Le code ne le génère ni ne le publie. La passerelle n'a pas de chargeur de variables : son point d'entrée d'hébergement doit transmettre `api`, `staticRoot` correspondant au build générique, `authenticate`, `internalBearer` et `publicOrigin` à `createWebGateway`.

Les fichiers privés sont contrôlés avant chargement : permissions, taille, localisation réelle et exclusions des répertoires publics. Le bundle pilote est également refusé dans le dépôt, ou s'il contient un chemin local, un lien signé, un secret ou des sources incohérentes. Prévoir une rotation du journal privé avant sa limite de 4 Mio. Une erreur du journal configuré bloque la publication de la nouvelle copie en mémoire.

## Routes du portail

Toutes les routes exigent l'authentification avant toute lecture de données. Elles refusent les méthodes autres que GET, les corps et les paramètres non pris en charge.

La refonte ajoute `GET /api/v1/analytics`, une projection privée en lecture seule des mêmes dossiers et fiches éligibles. Les pages, interactions, références visuelles et limites de l’aperçu sont décrites dans [visual-redesign.md](./visual-redesign.md).

| Endpoint | Réponse |
|---|---|
| `/api/v1/portal-snapshot` | 500 dossiers, révision, état de la source et identifiants des fiches pilotes accessibles. Les enregistrements commerciaux structurés restent une liste vide. |
| `/api/v1/pilot` | Synthèse du pilote, couverture, date de l'audit et liste des fiches accessibles après contrôle d'identité. |
| `/api/v1/pilot/{id}` | Fiche documentaire privée : dix espaces, sources, documents, chronologie, inconnues et contradictions. L'identifiant historique ne prouve pas l'identité à lui seul. |
| `/api/v1/analytics` | Couverture et activité sourcées, observations financières textuelles, révision des identités ; aucun total monétaire non vérifié. |
| `/api/v1/connections` | État réel du fournisseur Sheets et du pilote ; Gmail/Agenda en copie d'audit, Drive en références documentaires, VosFactures non connecté. |

Sans configuration ou première lecture valide, les données métier répondent 503. Une fiche indisponible ou dont l'identité exige une vérification produit 404. L'authentification absente produit 401 ; une configuration d'authentification absente produit 503. Les réponses incluent un ETag, `X-VDS-Last-Read-At`, `X-VDS-Last-Attempt-At` et `X-VDS-Source-Stale`. Une réponse 304 reste soumise à l'authentification.

## Identité, fiches et fiabilité

Les dix fiches sont des observations issues de sources réelles. « Documentée » signifie que la source a été lue ; cela ne signifie pas qu'un humain a approuvé le fait métier. Les inconnues affichent « Information non retrouvée ». Les rapprochements incertains et contradictions restent « À vérifier ». Un paiement reste non certifié sans preuve comptable adaptée. Les anciennes versions et les valeurs contradictoires demeurent visibles.

Le rattachement confronte explicitement les identités et les coordonnées à la référence privée. Aucun changement d'identifiant n'est résolu automatiquement et aucun rapprochement ne repose sur un nom seul. L'audit a trouvé 42 correspondances proposées sous un autre identifiant et 7 dossiers sans correspondance exacte : la migration globale exige une validation de cette table de correspondance. Une fiche dont l'identité ne passe pas les contrôles n'est pas disponible par la route détaillée.

Les dix espaces couvrent vue d'ensemble, commercial, technique, chantier, finances, communications, Agenda, SAV, documents et historique. Le centre de contrôle présente les observations comparées et leurs sources. Aucun bouton ne corrige une feuille, ne valide un encaissement, ne supprime une preuve ou ne transmet de message. La persistance des décisions humaines et les écritures métier restent à réaliser dans une phase autorisée distincte.

Les liens des sources restent protégés chez Google et exigent les autorisations du compte qui les ouvre. Connaître leur URL ne rend pas les documents accessibles. Aucun PDF ni fichier joint n'est distribué comme ressource statique publique.

## Actualisation dans l'interface

Le client React interroge la route de même origine avec la session du navigateur, sans Bearer Google ni secret partagé. Il valide la réponse avant remplacement, réutilise l'ETag et regroupe les lectures simultanées. Il vérifie les données toutes les 30 secondes lorsque l'application est visible et au retour au premier plan. Recherche, filtres, pagination et sélection restent conservés dans les limites de la nouvelle liste valide ; un changement d'identité invalide la sélection concernée.

Le magasin serveur relit son fournisseur au maximum une fois toutes les 30 secondes, à la demande. En mode archive, cela relit un fichier privé, pas Google. En mode OAuth, cela déclenche les lectures Google bornées. Ce mécanisme n'est ni une notification push, ni un import différentiel, ni un traitement permanent en arrière-plan.

Lors d'une panne de transport, la dernière copie authentifiée reste en mémoire avec son état périmé et sa vraie date de source. Une visite ne fabrique pas une nouvelle date de synchronisation. Une réponse 401/403 efface les données et caches mémoire ; l'interface demande une nouvelle authentification. Aucun fallback vers le fichier historique, une démo ou un export public n'est activé.

Le journal privé facultatif retrace les tentatives et révisions ; il n'est pas un registre de décisions humaines. Le pilote n'est pas réenrichi depuis Gmail ou Agenda à chaque actualisation. Encaissements et soldes restent non certifiés tant que la comptabilité et ses affectations ne sont pas reliées.

## API canonique complémentaire

L'API des 17 tables structurées reste séparée. `VDS_DATA_PROVIDER` sélectionne `none` par défaut, `private_file` ou `google_sheets`. Les huit colonnes textuelles et les fiches pilotes ne l'alimentent pas automatiquement.

| Variable supplémentaire | Usage pour cette API uniquement |
|---|---|
| `VDS_PRIVATE_DATA_FILE` | Fichier canonique `schemaVersion: "1"`, privé sous `VDS_PRIVATE_DATA_ROOT`, permissions 0600. |
| `VDS_SHEETS_MANIFEST` | Manifeste privé des tables et plages autorisées pour le fournisseur canonique. |
| `VDS_GOOGLE_ACCESS_TOKEN` | Jeton de lecture fourni au fournisseur canonique existant. Ce chemin conserve un jeton statique ; il n'utilise pas automatiquement le renouvellement OAuth du portail. |

Routes existantes : `/api/v1/status`, `/api/v1/dossiers?page=…&limit=…`, `/api/v1/dossiers/{uuid}` et ses suffixes `/timeline`, `/documents`, `/alertes`, `/finances`, ainsi que `/api/v1/finances`. Les dossiers canoniques utilisent des UUID persistants, des relations vérifiées et les tables SOURCES et RELATIONS_SOURCE. Les montants sont des centimes entiers, avec devise et base fiscale explicites. Une observation doit prouver le champ auquel elle est reliée ; un e-mail promettant un paiement n'est pas une transaction comptable.

Les séries de paiements exigent montant, devise, sens, date comptable et rattachement au dossier corroborés par la même transaction bancaire ou comptable. Doublons, références cassées, modifications silencieuses d'observations et confirmations fondées sur une inférence IA sont refusés. VosFactures reste désactivé. Le modèle des 17 tables est préparé ; la migration complète et les nouveaux adaptateurs restent à valider.

## Vérifications locales et données réelles privées

Contrôles généraux sans connexion externe :

```sh
npm run test:foundations
npm run build
git diff --check
```

Tests OAuth et limites Google, avec réponses structurelles en mémoire :

```sh
node --import tsx --test --test-isolation=none tests/google*.test.ts
```

Les essais réels exigent trois variables déjà configurées dans l'environnement privé ; aucun chemin absolu de données n'est commité :

| Variable de test | Entrée attendue |
|---|---|
| `VDS_REAL_CHAIN_DATA_ROOT` | Répertoire privé contenant `native-sheet-read.private.json`, `pilot-10.private.json` et `portal-original.private.json`. |
| `VDS_PILOT_UI_DATA` | Bundle normalisé des dix fiches (`pilot-1`), hors du dépôt. |
| `VDS_PILOT_AUDIT_TEST_INPUT` | Fichier contenant la liste brute des dix fiches documentaires avant normalisation. |

Pour exiger leur présence et lancer les essais correspondants :

```sh
: "${VDS_REAL_CHAIN_DATA_ROOT:?Racine privee de test requise}"
: "${VDS_PILOT_UI_DATA:?Bundle pilote prive requis}"
: "${VDS_PILOT_AUDIT_TEST_INPUT:?Audit brut prive requis}"
node --import tsx --test --test-isolation=none tests/portal-private-chain.test.ts tests/pilot-ui-private.test.ts tests/pilot.test.ts
```

Sans ces variables, les essais concernés sont ignorés explicitement : un résultat « skipped » ne prouve pas le parcours des données réelles. Les tests ne copient pas les dossiers dans le dépôt et ne modifient pas Google.

La chaîne réelle en processus vérifie : archive native → magasin privé → API authentifiée → passerelle avec callback de session de test → transport React. Elle contrôle les 500 lignes, les dix fiches, les refus d'accès et l'absence de fuite du Bearer. Le test de rendu utilise les véritables fiches privées dans les dix espaces React, sans publier ce rendu. Ces essais ne constituent pas un parcours navigateur sur un hébergement HTTPS ni une preuve de session réelle vérifiée.

## Étapes restant à remplir pour un aperçu HTTPS

1. Fournir un runtime serveur privé et sa configuration de secrets, avec données privées hors des répertoires statiques.
2. Relier le callback de la passerelle à la vraie session de l'hébergeur et autoriser uniquement les utilisateurs prévus. Tester les accès anonymes, la déconnexion et l'expiration de session avant d'ouvrir les données.
3. Choisir explicitement archive datée ou connexion OAuth. Pour Google, établir le consentement de lecture seule et autoriser les sorties HTTPS vers les deux hôtes Google documentés.
4. Démarrer la passerelle sous le domaine HTTPS prévu et contrôler accès, actualisation, état périmé et journaux sans exposer secrets ou exports.
5. Vérifier le rendu Mac, iPad et smartphone sur cet hébergement. Une compilation ou un test en mémoire ne suffit pas à annoncer un lien utilisable.

Aucun déploiement ou remplacement du portail actuel n'est effectué par les commandes de test et de compilation ci-dessus.
