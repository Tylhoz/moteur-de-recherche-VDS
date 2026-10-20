# Refonte visuelle et interactive — VDS Intelligence 360°

État de développement au 20 octobre 2026. Branche conservée : `feat/vds-live-portal-integration`.

## Résultat intégré

- Tableau de bord : cartes d’indicateurs pastel, grandes valeurs lisibles, graphiques de couverture, accès aux analyses et liste des fiches enrichies. La navigation principale et les espaces métier sont conservés.
- Identité : menu marine, accents jaunes et bleus issus du logo joint, surfaces claires ; transitions discrètes, prise en compte des préférences de réduction des animations.
- Cinq analyses : clients et dossiers, contrats HT, soldes à encaisser, dossiers à vérifier, activité documentée. Routes `#analysis?metric=clients|contracts|balances|review|activity`.
- Parcours : indicateur → analyse dédiée → segment/barre/point → dossiers concernés → fiche. Le premier clic sur un indicateur n’ouvre jamais directement un client. La fermeture d’une fiche conserve sa page d’analyse.
- Filtres : recherche insensible aux accents, période de communication, couverture de l’enrichissement ; sélection graphique et pagination de quinze dossiers.
- Fiches 360° : dix onglets conservés, historique vertical par jour, icônes de source, cartes dépliables, dates et statuts, recherche, filtres, ordre chronologique et liens vers les pièces d’origine. Les prochaines actions proposées restent séparées des événements passés.
- Documents : cartes distinguant contenu lu, inspection visuelle et document seulement identifié. Les contradictions restent visibles avec les deux observations et leurs sources.

## Références utilisées

Les deux images visibles dans la conversation ont inspiré respectivement la grille de graphiques et cartes pastel du tableau financier, puis les cartes dépliables et la ligne verticale de l’Activity Timeline. Leurs exemples, noms et chiffres n’ont pas été importés.

Le logo bleu, marine et jaune joint à la demande de correction a fourni la palette. Son fichier original n'est pas monté dans cet environnement : `BrandLogo` est prêt à le charger, avec un repli typographique honnête. Aucun logo provenant d’un ancien support ou document client n’a été substitué.

## Données et périmètre

L’application consomme exclusivement les archives réelles privées déjà auditées par son API : 500 dossiers, 10 fiches enrichies, 146 événements retrouvés, 32 contradictions et 46 documents identifiés, dont 35 lus ou inspectés. Les données métier restent hors de `src`, `public` et `dist`.

Les graphiques portent sur la couverture, la qualité documentaire et les dates explicites des communications. Ils ne transforment pas les mentions de prix ou de paiement en écritures comptables. Les montants originaux restent consultables comme observations sourcées ; les totaux de contrats et soldes restent « Non vérifié ». Aucune courbe financière ni attribution à un commercial n’est inventée. Une période sans événement documenté n’est pas assimilée à une activité nulle.

Le classeur XLSX de 510 lignes et 18 onglets transmis par Drive reste une référence séparée, sans fusion automatique : 64 noms diffèrent pour les identifiants historiques et ses 158 paiements sont signalés sans confirmation comptable. Il n’est pas présenté comme 510 personnes distinctes validées. Aucun nouvel audit global ni aucune écriture Google Sheets n’ont été déclenchés par la refonte.

## Architecture conservée et complétée

`GET /api/v1/analytics` projette les dossiers et les seules fiches éligibles après les contrôles d’identité du magasin privé. Les observations gardent leur valeur et leur provenance ; les compteurs sont recalculés depuis les éléments sources, sans extraction de montants depuis du texte.

Le navigateur interroge l’API sur la même origine, avec la session existante, toutes les trente secondes quand la page est visible. ETag, requêtes partagées et annulation des réponses après déconnexion évitent les lectures inutiles et la réapparition d’un cache privé. Une erreur de transport conserve la dernière lecture avec son état périmé ; une expiration de session la supprime. La révision source doit correspondre au tableau des clients avant d’autoriser l’analyse et son ouverture de dossier.

Les graphiques et leurs feuilles de style sont chargés à la demande. Aucun service externe de graphiques, police distante ou nouvel outil de suivi n’a été ajouté. Les liens sources sont limités aux services Google autorisés, en HTTPS, sans paramètres de secrets. Les sources ne sont jamais modifiées par cette interface.

## Validation et limites des essais

Résultat final : `npm run build` réussi ; `npm run test:foundations` avec les trois chemins d’archives privées configurés donne **116 tests réussis, 0 échec et 0 test ignoré**. Aucun avertissement React dans cette exécution. `git diff --check` ne signale aucune erreur.

Contrôle des 27 fichiers compilés : aucun nom ni e-mail correspondant aux archives privées retrouvé, aucun motif de clé recherché retrouvé, aucun JSON métier ni fichier de source map. Le seul point d’entrée HTML est `index.html`. Ce contrôle ciblé complète les tests de confidentialité ; il ne prétend pas constituer un audit de sécurité exhaustif. L’empreinte SHA-256 du snapshot du site d’origine reste `e67e523397497efec2d87bc76fdaebbe3a1146a365572b2294c31c41f0ae70f7`.

Les tests utilisent les véritables archives privées pour l’intégration et le rendu React, sans les recopier dans le dépôt. Les cas techniques isolés restent dans les tests et ne sont jamais importés par l’application.

- Contrôles existants : recherche, filtres, pagination, cohérence, identité, stockage privé, authentification, synchronisation et lecture seule.
- Nouveaux contrôles : cinq destinations d’indicateurs, activation réelle des callbacks de barres et segments (dont clavier), sélection des dossiers, retour de fiche, filtres combinés, révision source, réponse API réelle, ETag, expiration de session, réponse tardive après déconnexion, liens dangereux et données mal formées.
- Chronologie : vérification des 146 événements réels, filtres de sources/statuts/catégories, ordre, regroupement par jour, conservation des preuves, cartes dépliables dans le rendu initial, date inconnue et date impossible.
- Rendu : cinq analyses et les dix espaces de chacune des dix fiches. Ce sont des rendus serveur et des appels de callbacks, pas un parcours tactile dans Safari.

La validation visuelle dans Chromium/Safari et les clics DOM complets restent à effectuer : le lancement de Chromium et l’ouverture de sockets dans cet environnement ont été refusés avec `EPERM`. Aucune capture de navigateur ni réussite de test iPad n’est annoncée. Les adaptations CSS pour ordinateur, tablette et smartphone sont implémentées mais attendent cette vérification visuelle.

## Aperçu privé et raccordements requis

La correction Workers est désormais implémentée dans `worker/index.ts`, et les scripts exportent séparément les 500 dossiers / 10 fiches vers une archive privée. Les tests exécutent aussi le module ESM réellement compilé. La passerelle Node est conservée comme adaptateur local ; elle n'est plus la cible de publication Sites.

Voir [workers-release.md](workers-release.md) pour les changements, le diagnostic EPERM, la nouvelle identité privée distincte et la procédure de reprise. L'ancienne version 2 n'est pas modifiée. Le nouveau Site est créé mais non publié ; le réseau d'exécution est bloqué et le binding R2 déclaré reste à provisionner lors du déploiement. Aucun lien n'est présenté comme accessible et aucun test navigateur distant n'est annoncé.
