# Analyses Railway : synthèses et pièces paginées

## Cause du rejet

L’ancienne page appelait `GET /api/v1/analytics`, puis `validateAnalytics()` dans `src/data/useAnalytics.ts`. Une réponse HTTP 200 pouvait être refusée : le producteur acceptait les liens VosFactures et le navigateur n’acceptait que les sources Google. Une fiche contenant une source VosFactures valide suffisait à déclencher « Les données d’analyse reçues ne sont pas exploitables ». Le test de reproduction utilise une archive privée extérieure au dépôt et une référence comptable de test.

Un second problème existait : `/api/v1/intelligence360` renvoyait le registre comptable complet, tandis que les agrégats et les filtres étaient recalculés dans le navigateur. L’ancienne analyse construisait aussi les observations financières détaillées de toutes les fiches. Le Node HTTP natif utilisé ici ne définit pas de limite Next.js/body-parser pour ces réponses ; la limite de 4 Mio du serveur porte sur les corps entrants, et le navigateur interrompait ses lectures après 20 secondes.

Le bandeau « Copie périmée » était également affiché pour une copie Sheets disponible dont la transmission automatique n’était pas active, même lorsque l’API répondait. Ce cas porte désormais un libellé distinct d’un véritable échec réseau.

## Contrats de lecture

- `GET /api/v1/analytics` : synthèse par défaut, schéma `business-analytics-2`.
- `GET /api/analyses` : alias court de cette synthèse.
- `POST /api/v1/analytics/query` : même synthèse avec filtres. Aucun enregistrement métier modifié.
- `GET /api/v1/intelligence360` : alias de la synthèse ; aucun registre brut.
- `POST /api/v1/accounting360/documents` : pièces filtrées, schéma `business-documents-1`, 50 par page au maximum.
- `GET /api/documents?page=1&limit=50` : liste du compte avec pagination numérique uniquement. Les recherches restent dans les corps POST privés.
- `POST /api/v1/analytics/dossiers` : dossiers d’un segment, schéma `business-dossiers-1`, 50 par page au maximum.
- `GET /api/v1/accounting360` : vue de compatibilité limitée à 50 pièces ; les index internes et la totalité des contacts ne sont plus transmis.

Les appels POST de lecture utilisent le même contrôle de session et d’origine que les autres routes privées. Ils évitent d’inscrire la recherche d’un nom ou d’une référence dans les URL des journaux HTTP. Les paramètres sont stricts : `scope`, `year`, `from`, `to`, `model`, `status`, `financialStatus`, `search`, `chart`, `point`, `page`, `pageSize`. Les pages commencent à 1. `scope=account` inclut explicitement les pièces non rattachées ; le périmètre par défaut reste celui des dossiers rattachés. Les dates financières portent sur l’émission des pièces.

## Taille, cache et cohérence

Tous les KPIs, totaux, séries, filtres et rapprochements sont calculés côté serveur. La synthèse ne contient ni `ledger`, ni liste de factures/paiements, ni contenu d’e-mails. Elle contient les compteurs, les options de filtres, les séries et jusqu’à 100 identités de dossiers rapprochés ; les autres détails restent paginés. Le serveur refuse une synthèse dépassant 256 Kio. La validation partagée plafonne également les nombres de graphiques et de points. Les séries longues sont regroupées en au maximum 120 périodes (mois, années, décennies ou siècles). Les répartitions de plus de 32 catégories comportent un segment « Autres catégories » avec détail paginé.

Le jeu de données dérivé est lié aux versions exactes des sources et des décisions. Les pièces sont triées une seule fois par version. Un cache borné de 30 synthèses évite de répéter les calculs pour les mêmes filtres. L’actualisation comptable continue en arrière-plan. Pendant une nouvelle projection, la dernière synthèse complète est conservée et son état `projectionPending/refreshing`, ses dates et ses erreurs restent explicites. Au premier démarrage, l’API renvoie un état de préparation léger plutôt que de bloquer la requête.

Les deux synthèses par défaut (dossiers et compte) sont préparées en arrière-plan, avec le jeu de données dérivé, dans le volume privé existant. Aucun nouveau service de base de données n’est nécessaire. Le cache compressé et vérifié SHA-256 est lié au propriétaire, au compte et au mode Paiements ; il reste séparé des versions sources. Un pointeur atomique ne change qu’après l’écriture de la version complète. Une version identique n’est pas dupliquée. Au redémarrage, les graphiques et les pages peuvent être servis depuis cette copie même si les sources sont indisponibles. Les lectures ordinaires ne parcourent plus les fichiers comptables. Les synthèses filtrées sont calculées à leur première demande, puis réutilisées pour cette révision. Les compteurs dépendant du jour sont recalculés lors du passage quotidien suivant.

Le traitement planifié est exécuté dans le processus Node du service Railway (une réplique avec verrou de volume), sans appel externe dans les routes de consultation. La compression utilise le pool asynchrone Node. La première préparation locale démarre indépendamment de la lecture externe. Les données sources restent conservées ; seuls les index et synthèses dérivés sont ajoutés au volume privé. L’ingestion et la préparation sont chacune coalescées, pour éviter les lectures concurrentes identiques.

Planification VosFactures, sans nouvelle variable obligatoire :

- `VDS_ACCOUNTING_SYNC_SCHEDULE=hourly` par défaut ; intervalle `VDS_ACCOUNTING_SYNC_INTERVAL_SECONDS=3600` (minimum 300, maximum 86400).
- `VDS_ACCOUNTING_SYNC_SCHEDULE=nightly` et `VDS_ACCOUNTING_SYNC_UTC_HOUR=2` pour une lecture nocturne à 02 h UTC.
- La première lecture de démarrage est immédiate. Une panne attend l’échéance suivante ; la commande manuelle reste possible. Les nouvelles données ne remplacent pas une version complète tant que la lecture n’est pas validée.
- Les copies Google Sheets reçues déclenchent la préparation locale. Le mécanisme Google existant reste contrôlé toutes les cinq minutes, mais il nécessite toujours l’autorisation et le script Google pour devenir continu ; aucune autorisation Google n’est créée par cette planification.

Le navigateur normalise les anomalies facultatives : lien absent ou non autorisé, libellé manquant, date illisible, montant non numérique. Un montant douteux devient « non renseigné », jamais zéro. Une ligne sans identifiant ou un point inexploitable est écarté avec un avertissement explicite de vue partielle ; les totaux serveur ne sont pas recalculés depuis ces lignes. La version de schéma, les bornes de pagination, les totaux structurels et le mode lecture seule restent stricts. Une panne globale conserve la dernière synthèse, avec un avertissement sur les filtres non actualisés. Une session expirée purge les informations affichées.

La limite de 256 Kio est contrôlée côté serveur. Un temps inférieur à 100 ms en 4G ne peut être garanti par cette taille : les mesures locales ne comprennent ni la latence réseau ni le démarrage du conteneur. Le contrôle préalable du volume au démarrage reste inchangé et peut retarder la disponibilité initiale.

## Démarrage et taille de la sauvegarde privée

Le contrôle de sauvegarde complet utilisait une limite de décompression de 128 Mio, indépendante du volume monté de 500 MB. Un volume valide de 132 Mio reproduit `ERR_BUFFER_TOO_LARGE` et empêchait l'ouverture du serveur. Cette limite est portée à 1 Gio pour la sauvegarde et sa restauration, avec une borne explicite à l'export ; les objets restent limités à 4 Mio, chaque empreinte SHA-256 reste vérifiée et toute restauration sur un volume non vide reste refusée. Aucun historique n'est supprimé. Cette limite interne ne modifie pas la réponse des graphiques, toujours plafonnée à 256 Kio.

Les journaux de démarrage indiquent désormais l'étape fixe (`private_checkpoint`, configuration, import, etc.) et le code d'erreur autorisé, sans exception brute, chemin privé ou valeur de configuration. Le message générique de l'ancienne version ne permettait pas de confirmer le code précis sur Railway ; le défaut de taille est reproduit en test et le prochain démarrage doit encore être contrôlé. Le test `railway-checkpoint-size.test.ts` vérifie une sauvegarde dépassant 128 Mio, sa restauration complète et le refus d'écraser une destination non vide.

### Renforcement de la récupération privée

Le checkpoint est désormais écrit et vérifié en flux gzip : le JSON complet n'est plus assemblé en mémoire et ne dépend plus du plafond de chaîne Node d'environ 512 Mio. Le fichier reste un JSON v1 valide, avec une entrée par ligne ; les sauvegardes compactes v1 historiques restent lisibles avec une borne explicite. Une restauration est entièrement validée avant de créer le marqueur, puis écrite dans une seconde passe. Les temporaires sont retirés, les historiques conservés et les opérations restent sérialisées dans la queue du volume. Le scénario réel de 132 Mio passe aussi avec un heap Node limité à 96 Mio.

Si seul le pointeur du cache dérivé est un JSON invalide, ses octets sont conservés dans une quarantaine privée immuable avant reconstruction. Une erreur I/O ou d'archivage bloque toujours la publication ; aucune source originale n'est modifiée. Des événements `analytics_cache_ready`/`analytics_cache_restored` exposent uniquement les compteurs, tailles de synthèse et dates des sources pour confirmer une préparation, sans identité ni montant.

Le contrat et le contrôle des liens sont partagés entre serveur et navigateur. Les erreurs de schéma indiquent un code et un chemin structurel ; les erreurs HTTP indiquent un endpoint fixe et un statut. Aucun journal applicatif ne reçoit les réponses brutes, les recherches, des noms clients, des clés API ou des URL avec jeton. Les pointages déclarés payés restent distincts des encaissements bancaires confirmés.

## Vérifications

Les tests couvrent le volume de 20 161 documents, l’exactitude des centimes, la taille de la synthèse, les pages disjointes, la recherche, les segments et les filtres, les valeurs absentes, les contrôles de session et d’origine, les sources corrompues et la consultation d’une synthèse pendant une projection bloquée. Les jeux comptables volumineux utilisés dans ces tests sont synthétiques et ne sont pas des données de production.

Contrôle navigateur reproductible : `node --import tsx tests/analytics-browser.e2e.mjs`. Utilise Chromium Playwright ou `VDS_TEST_CHROMIUM_PATH` (détecte aussi `/usr/bin/chromium`). Le serveur de test écoute uniquement sur la boucle locale, avec des données synthétiques et des réponses d’API interceptées ; aucun service externe n’est sollicité.
