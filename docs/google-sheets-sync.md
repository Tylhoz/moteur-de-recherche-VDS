# Synchronisation privée des fiches 360°

Le portail Railway peut conserver des observations de plusieurs classeurs Google Sheets dans son volume privé. Les fichiers clients et la configuration personnelle ne font pas partie du dépôt ni des fichiers statiques.

## Lecture et conservation

- L’archive initiale reste intacte. Les observations sont présentées avec leurs liens vers les lignes sources.
- Tous les dossiers utilisent les mêmes rubriques 360°. Une rubrique manquante est indiquée comme telle.
- Les rapprochements utilisent les références explicites et, à défaut, un e-mail correspondant à un seul dossier. Les lignes ambiguës restent dans la file « Données & accès ».
- Les mentions de paiements ne deviennent pas des encaissements vérifiés. Les documents et messages référencés ne sont pas considérés comme relus.
- Chaque version différente est conservée dans le volume. Un changement de structure, une suppression de référence centrale ou une requête invalide conserve la dernière version.

## Installation du lecteur Google

La copie personnelle du script et du manifeste est remise dans un fichier Drive privé. Elle contient une configuration confidentielle et ne doit pas être publiée.

1. Créer un projet Apps Script dans le compte propriétaire des classeurs.
2. Copier le script personnel dans `Code.gs` et le manifeste dans `appsscript.json`.
3. Exécuter `installerSynchronisationVDS` et accepter les autorisations Google.
4. Vérifier la réception de tous les classeurs dans « Données & accès ».

Aucun déploiement public Apps Script n’est nécessaire. Le manifeste active les services avancés Sheets et Drive pour le projet Google par défaut, conformément à la [documentation Google](https://developers.google.com/apps-script/guides/services/advanced). Un projet Google Cloud standard nécessite leur activation explicite.

Le déclencheur vérifie les modifications chaque minute. Les valeurs sont relues après une modification et au moins une fois par heure pour les recalculs de formules. Le portail interroge son serveur toutes les 30 secondes. Les délais et quotas Google s’appliquent : ce mécanisme n’est pas un flux instantané.

Une copie native issue d’un fichier Excel devient une source distincte : modifier l’Excel ne met pas automatiquement cette copie à jour.

## Réception et authentification

`POST /api/sheets-sync` accepte uniquement les charges JSON signées HMAC-SHA256 avec `VDS_SHEETS_PUSH_SECRET`. La signature couvre l’horodatage et le corps exact. Les sources et schémas doivent avoir été autorisés par l’import initial privé.

Les API de consultation restent protégées par la session du propriétaire. L’état « synchronisation active » exige une réception récente de chaque classeur ; le script non autorisé ne peut pas être présenté comme actif.

L’import initial comprimé utilise les variables temporaires `VDS_SHEETS_BOOTSTRAP_*`. Elles doivent être vidées après confirmation de l’écriture dans le volume. Conserver le secret de signature pour les transmissions suivantes.

Le script n’écrit dans aucune feuille, n’envoie aucun e-mail et ne crée aucune facture.
