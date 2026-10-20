# Préparer VDS Intelligence 360° sur un Worker Cloudflare séparé

Cette procédure cible uniquement le nouveau Worker `moteur-de-recherche-vds-prive` et l'origine prévue `https://moteur-de-recherche-vds-prive.meert-val.workers.dev`. La présence de cette adresse dans la configuration ne prouve pas que le Worker existe ou que le portail est accessible. Le Worker actuel `moteur-de-recherche-vds`, son application Access et l'ancien aperçu Sites V2 restent inchangés. Le fichier `wrangler.jsonc` utilise `worker/cloudflare.ts` : ne jamais publier `worker/index.ts` directement sur workers.dev, car cet adaptateur interne attend l'authentification Sites.

Toute publication ou import doit être autorisé par le propriétaire. La mission de livraison autorise la nouvelle cible privée ; elle n'autorise pas le remplacement de l'ancien Worker. La branche `feat/vds-live-portal-integration` est déjà reliée à l'ancien Worker (check GitHub Cloudflare confirmé). Les corrections de livraison sont donc préparées sur `release/vds-private-production` et ne doivent être reliées qu'au nouveau Worker. Ne pas modifier le déploiement automatique de l'ancien.

Le nouveau wrapper vérifie le JWT Cloudflare Access et l'adresse du propriétaire avant les assets et les API. `run_worker_first: true` impose ce passage, y compris pour `index.html`. `keep_vars: true` conserve les variables configurées dans Cloudflare et `preview_urls: false` désactive les URL de préversion. [Configuration Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/), [ordre de traitement des assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Une seule séquence de configuration

1. Préparer une application **Cloudflare Access** exclusivement pour le nouveau portail. Si le nouveau Worker existe, sélectionner uniquement **moteur-de-recherche-vds-prive**, avec protection des URL de production et d'aperçu. S'il n'existe pas encore, une application par nom d'hôte peut cibler exactement **moteur-de-recherche-vds-prive.meert-val.workers.dev** ; ne pas sélectionner l'ancien Worker ni « All Workers ». La politique doit être **Allow → Include → Emails → l'adresse exacte du propriétaire**. Utiliser le fournisseur d'identité existant ou la connexion par code e-mail. Ne pas ajouter Everyone ou Bypass. Relever le domaine de l'équipe et l'**Application Audience (AUD) Tag**. Vérifier la protection réelle après le futur déploiement. Le Worker vérifie également signature, émetteur, audience, expiration et propriétaire. [Portées de protection Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [validation du JWT et localisation de l'AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

2. Réutiliser le bucket **vds-intelligence-360-private**, dont le propriétaire a confirmé la création et l'accès public désactivé. Ne pas créer de deuxième bucket. Conserver l'accès public désactivé, sans domaine personnalisé ni URL publique r2.dev. `BUCKET` est son binding serveur dans `wrangler.jsonc`. La lecture réelle du binding reste à vérifier après déploiement. [Accès public R2](https://developers.cloudflare.com/r2/buckets/public-buckets/).

3. Dans **Worker → Settings → Variables and Secrets**, renseigner les variables ci-dessous. Ces valeurs restent dans Cloudflare ; ne pas les coller dans une conversation, dans Git ou dans le frontend.

   | Nom | Valeur à renseigner |
   | --- | --- |
   | `VDS_ACCESS_TEAM_DOMAIN` | Origine réelle `https://…cloudflareaccess.com`, sans `/` final |
   | `VDS_ACCESS_AUD` | AUD exact de l'application Access de ce domaine |
   | `VDS_OWNER_EMAIL` | Même adresse exacte que la politique Access ; variable secrète conseillée |
   | `VDS_EXPECTED_BUNDLE_SHA256` | Digest de l'export privé réellement retenu pour l'import |
   | `VDS_IMPORT_TOKEN` | Secret d'import aléatoire de 32 à 256 caractères base64url, généré et conservé dans le coffre Cloudflare ; jamais saisi dans le navigateur |
   | `VDS_IMPORT_TOKEN_SHA256` | Facultatif pour l'import depuis l'interface ; SHA-256 du même secret si l'import administratif direct est utilisé |

   `VDS_PUBLIC_ORIGIN` et `VDS_RELEASE_ID` sont déjà définis dans le manifeste. Le commit affiché est généré depuis le commit du build ; aucune saisie manuelle n'est nécessaire. Il ne faut pas définir `VDS_OWNER_PRIVATE` : le wrapper le fixe après validation du JWT. Les paramètres locaux absents sont signalés par le preflight sans afficher leurs valeurs.

4. Dans les réglages de build du **nouveau Worker seulement**, connecter le dépôt GitHub **moteur-de-recherche-VDS**, choisir la branche **release/vds-private-production**, le répertoire racine du projet, la commande de construction **`npm run build`** et la commande de déploiement **`npx wrangler deploy`**. **Ne pas utiliser `npm run build:site` : cette commande produit le format de l'ancien hébergement Sites et remplace `dist` par une structure incompatible avec les assets Cloudflare.** Vérifier que le commit distant contient bien la nouvelle cible avant de connecter la branche. Ne modifier ni le build ni le déploiement de l'ancien Worker. Désactiver les builds des autres branches sur le nouveau Worker. Cloudflare utilise la version Wrangler fixée dans `package.json`. Les variables de build sont distinctes des variables d'exécution. Le script `prebuild` récupère `WORKERS_CI_COMMIT_SHA`, puis `GITHUB_SHA` ou le HEAD Git local, et génère une constante de version dans le Worker ; `postbuild` contrôle les assets et bloque les substitutions de cible de Workers Builds. [Configuration Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

5. Uniquement après validation de la publication, lancer **Save and Deploy** sur le nouveau Worker, puis ouvrir sa nouvelle URL workers.dev sur l'iPad. L'identification Access doit précéder l'application. Vérifier `/api/v1/setup` après connexion : l'état du stockage et les réglages absents sont indiqués sans secret. Un écran de configuration incomplet ne signifie pas que les données ont été importées.

6. Après vérification de l'authentification et validation distincte de l'import par le propriétaire, ouvrir **Données & accès** puis **Importer l'archive privée**. Sélectionner l'export JSON privé `worker-preview.private.json` depuis un poste autorisé. Il reste hors GitHub et hors des assets publics. Le navigateur transmet le fichier à **`POST /api/v1/setup/import`** ; le serveur utilise le secret d'import sans le révéler au navigateur. Le Worker vérifie le digest préautorisé, les 500 dossiers et les 10 fiches avant activation. Le panneau confirme les comptes réellement relus dans R2. Cette opération reste séparée du déploiement du code. Le script historique `scripts/import-worker-data.mjs`, limité à Sites, ne doit pas être utilisé pour ce domaine Cloudflare.

7. Pour Google Sheets, suivre [la configuration des sources](provider-configuration.md). Une lecture automatique toutes les cinq minutes prépare les différences ; le bouton **Contrôler Google Sheets** permet une lecture immédiate. Le propriétaire examine puis approuve les différences dans **Données & accès**. Les modifications d'identité sont bloquées pour vérification dédiée. Le portail relit les données toutes les trente secondes sans rechargement. Aucune écriture dans Google Sheets n'est effectuée.

## Contrôles locaux reproductibles

Avec Node 24 et les dépendances du lockfile installées :

```sh
npm ci
npm run build
node scripts/cloudflare-preflight.mjs
npx wrangler deploy --dry-run --outdir /tmp/vds-cloudflare-dry-run
```

Le preflight refuse une publication des seuls assets, une autre entrée Worker, des assets servis avant authentification, un autre domaine, les exports JSON privés, les cartes de sources et les liens symboliques. Il refuse aussi `WRANGLER_CI_OVERRIDE_NAME` lorsqu'il désigne un autre Worker et `CLOUDFLARE_ENV` lorsqu'il sélectionne un autre environnement. Il ne contacte aucun service et ne lit aucun dossier client. Il rapporte seulement des noms de variables et des états. `--require-runtime` exige en plus les variables présentes dans l'environnement local ; cela ne prouve pas la configuration distante. `.dev.vars.example` contient uniquement des champs vides, et une éventuelle `.dev.vars` remplie doit rester ignorée par Git.

Pour le déploiement CLI autorisé depuis un environnement déjà connecté au compte, exécuter `npx wrangler deploy`. Ne pas utiliser d'option `--name`, `--env`, `--config`, `--no-build` ou `--assets` qui substituerait une autre cible, sa vérification ou un autre répertoire : le preflight contrôle le manifeste, pas les substitutions passées ensuite à Wrangler. Ne pas substituer une publication Pages. L'archive privée reste hors du dépôt et du répertoire `dist`. Le Worker refuse les API métier lorsque les paramètres, le binding ou l'import validé manquent ; aucune donnée fictive n'est utilisée pour remplir ces absences.

## Critères de réception

Après déploiement et import effectifs : un navigateur non connecté ne doit lire ni fiche ni asset ; le propriétaire doit retrouver les 500 dossiers et 10 fiches, le tableau de bord, les pages Contrats HT/Soldes, les segments, les documents et l'Activity Timeline. `/api/v1/release` doit indiquer le commit réellement déployé. Les totaux financiers non vérifiés restent absents ou signalés. Une compilation locale ou un dry-run réussi ne suffit pas à déclarer le lien privé opérationnel.
