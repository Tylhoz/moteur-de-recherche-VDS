# Analyses Railway : synthèses et pièces paginées

## Cause du rejet

L’ancienne page appelait `GET /api/v1/analytics`, puis `validateAnalytics()` dans `src/data/useAnalytics.ts`. Une réponse HTTP 200 pouvait être refusée : le producteur acceptait les liens VosFactures et le navigateur n’acceptait que les sources Google. Une fiche contenant une source VosFactures valide suffisait à déclencher « Les données d’analyse reçues ne sont pas exploitables ». Le test de reproduction utilise une archive privée extérieure au dépôt et une référence comptable de test.

Un second problème existait : `/api/v1/intelligence360` renvoyait le registre comptable complet, tandis que les agrégats et les filtres étaient recalculés dans le navigateur. L’ancienne analyse construisait aussi les observations financières détaillées de toutes les fiches. Le Node HTTP natif utilisé ici ne définit pas de limite Next.js/body-parser pour ces réponses ; la limite de 4 Mio du serveur porte sur les corps entrants, et le navigateur interrompait ses lectures après 20 secondes.

Le bandeau « Copie périmée » était également affiché pour une copie Sheets disponible dont la transmission automatique n’était pas active, même lorsque l’API répondait. Ce cas porte désormais un libellé distinct d’un véritable échec réseau.

## Contrats de lecture

- `GET /api/v1/analytics` : synthèse par défaut, schéma `business-analytics-2`.
- `POST /api/v1/analytics/query` : même synthèse avec filtres. Aucun enregistrement métier modifié.
- `GET /api/v1/intelligence360` : alias de la synthèse ; aucun registre brut.
- `POST /api/v1/accounting360/documents` : pièces filtrées, schéma `business-documents-1`, 50 par page au maximum.
- `POST /api/v1/analytics/dossiers` : dossiers d’un segment, schéma `business-dossiers-1`, 50 par page au maximum.
- `GET /api/v1/accounting360` : vue de compatibilité limitée à 50 pièces ; les index internes et la totalité des contacts ne sont plus transmis.

Les appels POST de lecture utilisent le même contrôle de session et d’origine que les autres routes privées. Ils évitent d’inscrire la recherche d’un nom ou d’une référence dans les URL des journaux HTTP. Les paramètres sont stricts : `scope`, `year`, `from`, `to`, `model`, `status`, `financialStatus`, `search`, `chart`, `point`, `page`, `pageSize`. Les pages commencent à 1. `scope=account` inclut explicitement les pièces non rattachées ; le périmètre par défaut reste celui des dossiers rattachés. Les dates financières portent sur l’émission des pièces.

## Taille, cache et cohérence

Tous les KPIs, totaux, séries, filtres et rapprochements sont calculés côté serveur. La synthèse ne contient ni `ledger`, ni liste de factures/paiements, ni contenu d’e-mails. Elle contient les compteurs, les options de filtres, les séries et jusqu’à 100 identités de dossiers rapprochés ; les autres détails restent paginés. Le serveur refuse une synthèse dépassant 256 Kio. La validation partagée plafonne également les nombres de graphiques et de points. Les séries longues sont regroupées en au maximum 120 périodes (mois, années, décennies ou siècles). Les répartitions de plus de 32 catégories comportent un segment « Autres catégories » avec détail paginé.

Le jeu de données dérivé est lié aux versions exactes des sources et des décisions. Les pièces sont triées une seule fois par version. Un cache borné de 30 synthèses évite de répéter les calculs pour les mêmes filtres. L’actualisation comptable continue en arrière-plan. Pendant une nouvelle projection, la dernière synthèse complète est conservée et son état `projectionPending/refreshing`, ses dates et ses erreurs restent explicites. Au premier démarrage, l’API renvoie un état de préparation léger plutôt que de bloquer la requête.

Le contrat et le contrôle des liens sont partagés entre serveur et navigateur. Les erreurs de schéma indiquent un code et un chemin structurel ; les erreurs HTTP indiquent un endpoint fixe et un statut. Aucun journal applicatif ne reçoit les réponses brutes, les recherches, des noms clients, des clés API ou des URL avec jeton. Les pointages déclarés payés restent distincts des encaissements bancaires confirmés.

## Vérifications

Les tests couvrent le volume de 20 161 documents, l’exactitude des centimes, la taille de la synthèse, les pages disjointes, la recherche, les segments et les filtres, les valeurs absentes, les contrôles de session et d’origine, les sources corrompues et la consultation d’une synthèse pendant une projection bloquée. Les jeux comptables volumineux utilisés dans ces tests sont synthétiques et ne sont pas des données de production.

Contrôle navigateur reproductible : `node --import tsx tests/analytics-browser.e2e.mjs`. Utilise Chromium Playwright ou `VDS_TEST_CHROMIUM_PATH` (détecte aussi `/usr/bin/chromium`). Le serveur de test écoute uniquement sur la boucle locale, avec des données synthétiques et des réponses d’API interceptées ; aucun service externe n’est sollicité.
