# Connexion Google Sheets du serveur — lecture seule

Le connecteur de cette conversation et l'identité du serveur sont deux accès distincts. Les modules sont préparés et testés avec des réponses structurelles en mémoire. Ils ne constituent pas une connexion durable active : aucun appel externe ni consentement OAuth n'a été effectué pendant leur préparation.

## Source bornée et comportement

- Classeur vérifié : variable serveur privée `VDS_LEGACY_SPREADSHEET_ID` (valeur conservée dans la configuration privée du propriétaire).
- Onglet vérifié : `Base_Centrale_360`, `sheetId=768819879`, plage exacte `'Base_Centrale_360'!A1:H501`.
- Les métadonnées natives relues constatent une grille de 501 lignes et 8 colonnes : en-tête en ligne 1 et 500 dossiers en lignes 2 à 501. Le serveur contrôle cette grille, l'identifiant et le titre de l'onglet avant ET après chaque lecture de valeurs ; tout ajout, retrait ou renommage déclenche une erreur. Il ne lit aucune ligne hors de la grille vérifiée. Toute variation exige une nouvelle validation du périmètre.
- Le serveur lit uniquement cette plage avec `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values:batchGet` et les métadonnées restreintes `spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`. Il effectue deux lectures de valeurs égales, accompagnées de quatre contrôles de métadonnées, avant de publier une révision. Ce contrôle ne remplace pas une transaction de base de données.
- Les huit colonnes restent du texte, dans l'ordre vérifié. Les montants numériques inconnus restent `null`, les données métier dérivées restent vides et les fiches enrichies ne sont pas rattachées automatiquement. Chaque catégorie devient « Non vérifié » ; une phrase de la feuille n'est pas une preuve de vente, d'encaissement ou de résolution.
- Le fournisseur ne fusionne jamais une ligne avec le portail historique sur le seul identifiant `VDS-…`. La table de correspondance d'identités reste un contrôle distinct.
- La révision SHA-256 dépend du contenu et du périmètre, pas de l'heure d'une requête navigateur. `sourceState.lastReadAt` indique l'heure de fin de la seconde lecture réussie ; `lastAttemptAt`, dans le fournisseur, correspond à cette même lecture. Le magasin d'actualisation conserve séparément la véritable heure des tentatives échouées et signale les données périmées.
- Une erreur rejette la lecture entière. Aucun remplacement par des données fictives ou un fichier public n'est prévu.

## Identité serveur à configurer

Les trois variables suivantes sont nécessaires dans le gestionnaire de secrets de l'hébergeur, accessibles au processus serveur uniquement :

| Variable | Utilisation |
|---|---|
| `VDS_GOOGLE_CLIENT_ID` | Identifiant du client OAuth Google dédié |
| `VDS_GOOGLE_CLIENT_SECRET` | Secret de ce client OAuth |
| `VDS_GOOGLE_REFRESH_TOKEN` | Jeton de renouvellement obtenu par consentement du compte professionnel autorisé |

Ne pas les préfixer par `VITE_`, les inclure dans Git, les placer dans `public/`, les écrire dans une URL ou les transmettre au navigateur. Le module de diagnostic retourne seulement les noms des variables manquantes.

1. Dans le projet Google Cloud professionnel approprié, activer Google Sheets API et préparer un client OAuth dédié à ce serveur. Le choix du projet et du compte autorisé doit être établi avant le consentement.
2. Utiliser un flux OAuth serveur avec URI de retour HTTPS enregistrée, `state` imprévisible et vérifié, PKCE, accès hors connexion et consentement au seul périmètre `https://www.googleapis.com/auth/spreadsheets.readonly`. Le gestionnaire de consentement/retour HTTPS reste à fournir par l'hébergement ; aucun formulaire ne doit demander de coller un secret Google dans le portail.
3. Vérifier que ce compte a accès au classeur à titre explicite. La connexion OAuth fonctionne avec un classeur restreint ; son accès public n'est pas nécessaire. Aucun changement de partage n'est effectué par le module.
4. Enregistrer le jeton de renouvellement dans le gestionnaire de secrets. Les applications OAuth externes laissées en mode test peuvent perdre leurs jetons après sept jours ; utiliser une configuration interne ou un statut de publication approprié pour une connexion durable, selon le compte et les règles Google.
5. Autoriser les sorties HTTPS serveur vers `oauth2.googleapis.com:443` et `sheets.googleapis.com:443`. La politique réseau de l'environnement de travail actuel ne permet pas de considérer ces accès comme opérationnels. Aucun contournement de cette politique n'est prévu.
6. Brancher `GoogleRefreshTokenProvider.getAccessToken` sur `GoogleLegacySheetsProvider`, puis ce fournisseur sur le magasin de snapshots privé. Authentifier la session du portail avant toute lecture. Les jetons OAuth ne sont jamais une session du navigateur.
7. Effectuer deux lectures réelles sur l'hébergement, constater 500 dossiers et le SHA, puis vérifier une mise à jour autorisée de la source dans le cycle d'actualisation. Tester aussi l'expiration du jeton, la révocation, l'accès interdit et le mode périmé.

## Renouvellement et erreurs

Le renouvellement utilise exclusivement `POST https://oauth2.googleapis.com/token`, sous forme encodée, avec un délai maximal de 12 secondes et les redirections interdites. Les demandes simultanées partagent un renouvellement. Le jeton d'accès est conservé en mémoire jusqu'à une minute avant son expiration ; aucun jeton n'est écrit sur disque.

La réponse doit déclarer un jeton Bearer et exactement le périmètre Sheets en lecture seule. Les consentements plus larges ou sans périmètre déclaré sont refusés. Une autorisation révoquée déclenche `google_oauth_reauthorization_required` ; une erreur réseau déclenche un code générique sans contenu de réponse Google, données clients ou secrets.

Les requêtes de lecture ont également un délai maximal de 12 secondes, aucune redirection et une réponse plafonnée à 12 Mio. Les liens intégrés non protégés ou contenant un secret sont refusés avant toute transmission au portail. Aucun appel `append`, `update`, `batchUpdate`, facturation, envoi d'e-mail ou mutation Agenda n'existe dans ces modules.

## Vérification locale sans réseau

`node --import tsx --test --test-isolation=none tests/google*.test.ts`

Les tests créent uniquement des lignes structurelles et des identifiants OAuth factices en mémoire. Ils couvrent les autorisations, les erreurs sans fuite, le renouvellement, les limites de lecture, les en-têtes, les doublons, l'absence de certification financière et les modifications concurrentes. Ils ne sont pas des dossiers de démonstration et ne sont jamais chargés dans le portail.

`normalizeLegacyRows(values, readAt)` permet en outre de contrôler une réponse réelle obtenue par un connecteur natif, à condition de conserver ces données dans l'espace privé. `normalizeLegacySheetResponse` contrôle l'enveloppe officielle `values:batchGet`. Une telle vérification ponctuelle ne signifie pas que le renouvellement OAuth du serveur ou son accès réseau sont configurés.
