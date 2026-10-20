# VDS Pools — déploiement privé Railway

Cette variante conserve l'application et ses API métier. Elle n'utilise ni
Cloudflare Access ni R2. L'ancien Worker et ses branches restent inchangés.

## Configuration du service

- Dépôt `Tylhoz/moteur-de-recherche-VDS`, branche `release/vds-railway-private`.
- Nouveau projet/service Railway séparé, Dockerfile fourni, une seule réplique.
- Volume persistant monté en `/data`, jamais sous `/app` ou `dist`.
- Domaine HTTPS généré par Railway. `RAILWAY_PUBLIC_DOMAIN` définit l'origine ;
  pour un domaine personnalisé, définir `VDS_PUBLIC_ORIGIN=https://...`.
- Railway fournit le commit de construction via `RAILWAY_GIT_COMMIT_SHA`.
  Aucune donnée privée n'est requise pendant la construction.
- `/healthz` confirme le démarrage ; il ne confirme pas l'import des dossiers.
  `/api/v1/setup`, après connexion, indique les vrais nombres et la version.

## Connexion et secrets

Générer une seule fois, dans un répertoire privé extérieur au dépôt :

```sh
npm run railway:credentials -- /chemin/prive/vds-railway votre-adresse@example.com
```

Ajouter dans les variables privées du service les valeurs du fichier
`railway-secrets.private.json`, sans les publier ou les copier dans un ticket.
Conserver `railway-login.private.txt` dans un gestionnaire de mots de passe.
Seul l'e-mail propriétaire configuré peut ouvrir une session. Mot de passe
aléatoire, empreinte scrypt, cookie HttpOnly/Secure, expiration huit heures,
limitation des tentatives et contrôle d'origine sur chaque écriture.
Changer `VDS_SESSION_SECRET` révoque toutes les sessions.

Ajouter `VDS_EXPECTED_BUNDLE_SHA256`, calculé sur l'archive privée approuvée.
L'import exige à la fois une session propriétaire et l'empreinte attendue.
Importer le JSON privé depuis Données & accès, uniquement après vérification de
l'authentification HTTPS. Les octets sont vérifiés avant activation ; aucune
archive client ne doit être ajoutée au dépôt ou à l'image Docker.

Le lancement utilise `flock` : deux processus ne peuvent écrire simultanément
sur le même volume. Les écritures sont atomiques, synchronisées sur disque,
avec comparaison d'ETag. Un arrêt brutal libère le verrou du système.
Une seule réplique est prise en charge. Sauvegarder le volume avant de le
supprimer ; une sauvegarde Git du code ne contient pas les dossiers.

## Connexions métier existantes

Variables Google : `VDS_GOOGLE_CLIENT_ID`, `VDS_GOOGLE_CLIENT_SECRET`,
`VDS_GOOGLE_REFRESH_TOKEN`, `VDS_LEGACY_SPREADSHEET_ID`,
`VDS_GOOGLE_SHEET_RANGE`. L'autorisation doit être limitée à
`https://www.googleapis.com/auth/spreadsheets.readonly`.
La lecture automatique a lieu toutes les cinq minutes. Les changements
restent proposés à validation ; les identités ne sont pas remplacées.
L'interface relit les informations sans rechargement complet.

VosFactures : `VDS_INVOICING_PROVIDER=vosfactures`,
`VDS_VOSFACTURES_ACCOUNT`, `VDS_VOSFACTURES_API_TOKEN`.
**L'adaptateur de lecture VosFactures reste à réaliser.** Ces variables
préparent la connexion, elles ne la rendent pas opérationnelle. Aucun
encaissement ne devient confirmé par la simple présence d'un secret.

## Vérification

`npm run build:railway` compile et contrôle les fichiers statiques.
`npm run test:foundations` vérifie les API et la sécurité.
Les tests de dossiers réels nécessitent les archives privées hors dépôt.
Le conteneur écoute `PORT` sur `0.0.0.0`. Ne pas lancer le serveur sans le
script de verrouillage. Ni mots de passe ni corps des requêtes ne sont journalisés.
Vérifier sur le domaine final : refus des API anonymes, connexion propriétaire,
500 dossiers, 10 fiches enrichies, navigation, validation et persistance après
redéploiement. Une validation locale n'est pas une preuve de publication.
