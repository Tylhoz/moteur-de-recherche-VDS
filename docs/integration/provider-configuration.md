# Sources réelles du portail Cloudflare

Le portail ne réutilise pas automatiquement les connexions Google ou VosFactures de ChatGPT. Les credentials doivent être configurés pour son serveur Cloudflare. Aucun secret ni fichier client n'est requis dans GitHub, le frontend ou une conversation.

## Google Sheets : lecture et proposition contrôlée

Le module `worker/integrations.ts` est compatible avec les Web APIs de Workers. Il utilise OAuth pour renouveler un jeton limité au périmètre `https://www.googleapis.com/auth/spreadsheets.readonly`. Il ne contient aucun appel d'écriture Sheets.

Configurer côté serveur :

| Nom | Type | Rôle |
| --- | --- | --- |
| `VDS_GOOGLE_CLIENT_ID` | Secret | Client OAuth Google professionnel dédié |
| `VDS_GOOGLE_CLIENT_SECRET` | Secret | Secret de ce client |
| `VDS_GOOGLE_REFRESH_TOKEN` | Secret | Jeton de renouvellement obtenu par consentement officiel |
| `VDS_LEGACY_SPREADSHEET_ID` | Secret | Identifiant du classeur privé autorisé |
| `VDS_GOOGLE_SHEET_RANGE` | Variable | Facultatif ; défaut `'Base_Centrale_360'!A1:H501` |

La plage conserve le schéma audité : exactement 500 dossiers, huit colonnes et les intitulés présents dans `SHEETS_HEADERS`. Un changement de structure, une colonne renommée, un dossier manquant, un doublon ou une modification concurrente invalide la proposition. Une extension au-delà des 500 dossiers exige d'abord une évolution explicite du mapping.

Les lectures sont bornées, refusent les redirections et sont répétées pour repérer une modification pendant la consultation. Les erreurs exposent uniquement un code générique ; les réponses Google, tokens et URLs d'authentification ne sont pas journalisés.

`integrationConfiguration()` ne fait aucune requête et distingue « configuré » de « connecté ». `createSheetsReader().readProposal(baseline)` vérifie réellement la source puis retourne les valeurs proposées et les différences. `status()` fournit la date de tentative, la dernière lecture réussie et l'état réel de ce lecteur.

Une réponse candidate n'est jamais une activation :

- aucune valeur du snapshot actuel n'est modifiée ;
- chaque différence conserve l'ancienne valeur et la proposition ;
- les changements de nom, de coordonnées ou d'adresse exigent une nouvelle vérification d'identité ;
- les dix associations de fiches enrichies ne sont jamais recopiées sur de nouvelles identités ;
- les textes financiers restent non vérifiés ; aucun montant ni encaissement n'est déduit d'un texte ;
- un premier chargement demande également une validation.

Le routeur authentifié `worker/integration-router.ts` monte la consultation, la prévisualisation et l'approbation ; toute écriture d'état exige la même origine et la session du propriétaire. Le cron Cloudflare s'exécute toutes les cinq minutes lorsque la source est configurée. Les propositions et les décisions sont conservées dans R2 privé. Les différences exigent une approbation explicite et une nouvelle lecture de la source ; les changements d'identité sont refusés. Seules les lectures sans aucune différence peuvent actualiser automatiquement la date de vérification. L'archive d'origine demeure intacte ; une version approuvée distincte est activée par une écriture conditionnelle pour prévenir les validations concurrentes.

Pour obtenir le refresh token, utiliser le parcours OAuth Google officiel avec accès hors connexion, URI HTTPS enregistrée, `state` vérifié et PKCE. Les credentials sont saisis dans le coffre de secrets Cloudflare. Le portail ne demande jamais de coller un secret Google dans son interface.

Références officielles : [OAuth Google pour serveur](https://developers.google.com/identity/protocols/oauth2/web-server), [lecture batchGet de Google Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet).

## Futur outil de facturation

Le fournisseur cité semble être VosFactures ; son identité et le compte exact restent à confirmer avec le propriétaire. La documentation officielle décrit une API de documents, contacts et paiements, avec un code API propre au compte. [Documentation VosFactures](https://github.com/vosfactures/API), [codes API du compte](https://aide.vosfactures.fr/332396-codes-api-du-compte).

Configuration réservée pour la prochaine étape :

| Nom | Type | Rôle |
| --- | --- | --- |
| `VDS_INVOICING_PROVIDER` | Variable | `vosfactures` seulement après confirmation du fournisseur |
| `VDS_VOSFACTURES_ACCOUNT` | Secret | Sous-domaine du compte confirmé, sans URL |
| `VDS_VOSFACTURES_API_TOKEN` | Secret | Code API du compte, saisi dans Cloudflare |
| `VDS_VOSFACTURES_ENABLED` | Variable | Intention d'activation future, sans effet réseau dans cette version |

Ces champs préparent la configuration. **L'adaptateur VosFactures n'est pas encore implémenté et ne se déclare jamais connecté.** Même `ENABLED=true` ne déclenche aucune requête, facture, suppression ou envoi d'e-mail. Le futur adaptateur devra autoriser seulement les lectures nécessaires, traiter la pagination et les limites, conserver les références comptables et rapprocher les dossiers avec plusieurs identifiants.

Un état de facture déclaré « payé » doit conserver sa provenance. Une confirmation d'encaissement doit reposer sur une donnée comptable appropriée ; un e-mail, une somme libre ou un rapprochement sur le seul nom ne suffit pas. Les divergences avec Sheets ou un devis signé restent dans la file de validation.
