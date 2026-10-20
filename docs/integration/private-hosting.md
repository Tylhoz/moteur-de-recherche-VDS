# Hébergement privé du portail — adaptateur même origine

`server/web-gateway.ts` relie le navigateur à l'API existante avec une session vérifiée par l'hébergement. Il ne crée aucun compte, formulaire de connexion ou flux OAuth. Sur Sites, le vérificateur doit utiliser **l'identité native Sites**. Une identité déclarée dans un en-tête envoyé par le navigateur ne constitue jamais une preuve.

## Contrat d'intégration

`createWebGateway({ api, staticRoot, authenticate, internalBearer, publicOrigin })` retourne un serveur Node non démarré. `api` accepte le serveur créé par `createApi` ou son gestionnaire de requêtes. Le dispatch vers l'API se fait directement en mémoire : aucun appel réseau à `localhost` n'est nécessaire.

- `authenticate(request)` est obligatoire. Il vérifie la session native de l'hébergeur, son expiration, sa révocation et l'autorisation de cet utilisateur à consulter VDS. Il renvoie `{ subject }` uniquement pour un utilisateur autorisé ; sinon `null`. Les cookies sont lus exclusivement par ce vérificateur. Il ne faut pas remplacer ce contrôle par la présence d'un cookie ni par `x-user-id`, `x-forwarded-user` ou une adresse e-mail déclarée.
- `internalBearer` est un secret exclusivement serveur. Son SHA-256 doit correspondre au `bearerSha256` de `createApi`. Le navigateur ne reçoit jamais ce secret et ne l'envoie pas dans ses appels. L'API interne ne doit pas être exposée sur un port public parallèle.
- `publicOrigin` est l'origine HTTPS exacte de l'aperçu privé. Le proxy d'hébergement doit conserver le `Host` public. Les valeurs `X-Forwarded-Host` non vérifiées ne sont pas utilisées. Les requêtes interorigines sont refusées ; CORS n'est pas nécessaire pour ce montage.
- `staticRoot` pointe sur la compilation du frontend générique. Ce répertoire ne doit contenir aucune donnée client intégrée à du JavaScript ou à du HTML. L'adaptateur ne lit que `index.html` et les fichiers autorisés directement sous `assets/`. Il n'expose ni JSON, ni cartes de sources, ni répertoires de code, ni fichiers privés, ni liens symboliques. Le parcours `/vds-snapshot.json` reste refusé même si un ancien fichier existe encore dans la compilation.
- `spaPaths` permet de déclarer des chemins exacts de navigation supplémentaires ; il ne sert pas à ouvrir des chemins de fichiers. Les routes classiques Clients, Devis, Ventes, Chantiers, Factures, SAV et Validation sont prévues par défaut.

Le navigateur peut appeler `fetch('/api/v1/status', { credentials: 'same-origin' })`. L'authentification native protège HTML, scripts, styles et chaque réponse API. Le Bearer est injecté côté serveur **après** vérification de la session ; les cookies, identités déclarées et en-têtes de proxy ne sont pas transmis à l'API interne.

L'absence de vérificateur bloque la construction du serveur. Une session absente/expirée produit une réponse 401 ; une panne du vérificateur produit une réponse 503 générique. Il n'existe aucun retour automatique vers un fichier de données public ni vers une démonstration. Le fournisseur natif de l'hébergement reste responsable de l'écran de connexion et du retour à l'application.

## Confidentialité HTTP

Toutes les réponses utilisent `Cache-Control: private, no-store, max-age=0` et `Vary: Cookie, Origin`. Les ressources externes sont exclues par la CSP ; les attributs de style React restent autorisés. Les paramètres d'URL nommés comme des jetons, mots de passe ou signatures sont refusés. Le journal d'hébergement doit également omettre cookies, en-têtes d'autorisation, paramètres sensibles et réponses métier ; le refus par l'application ne peut pas effacer un journal écrit en amont.

La CSP et le contrôle d'origine complètent l'authentification, sans la remplacer. Un utilisateur autorisé peut lire les données qui lui sont servies. Si plusieurs niveaux d'accès métier sont introduits, ils doivent être appliqués au vérificateur et aux routes API avant d'ouvrir ces rôles.

## Vérification réalisée et raccordements restants

Les tests `tests/web-gateway.test.ts` exécutent le véritable gestionnaire API derrière le gateway sans ouvrir de socket. Ils couvrent notamment l'absence de session, les identités forgées, l'injection serveur du secret, l'origine, les fichiers privés, les liens symboliques, les requêtes en écriture et les erreurs du fournisseur d'identité.

L'adaptateur seul ne constitue **pas** un aperçu HTTPS en ligne. Restent à fournir par l'hébergement : son vérificateur de session natif, le secret serveur, le routage HTTPS même origine, le processus Node et son identité Google en lecture seule. Aucun secret ou identifiant Google de la conversation n'est réutilisé automatiquement. Après raccordement, vérifier dans un navigateur réel : accès non connecté refusé, connexion native, expiration/révocation de session, lecture des données réelles et actualisation de l'interface. Aucun déploiement n'est déclenché par ce module.
