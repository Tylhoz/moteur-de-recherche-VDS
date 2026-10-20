# VDS Pools 360° — architecture des fondations

## État de référence et portée

Le portail React existant est conservé. Le code examiné charge une copie de dossiers en lecture seule depuis `/vds-snapshot.json` et vérifie cette copie toutes les 30 secondes lorsque l'onglet est visible. Cette vérification ne synchronise pas Google Sheets. La protection actuelle de cet actif dépend de l'hébergement privé ; le navigateur ne constitue pas une barrière d'accès.

Le modèle historique regroupe encore les informations dans 11 champs et une catégorie unique. Il ne permet pas de représenter séparément les états commercial, chantier, financier et SAV. Les nouveaux modèles doivent le compléter par un adaptateur, sans supprimer ni réinterpréter les données historiques.

Ce document décrit une architecture cible. Aucun connecteur, serveur métier, rôle collaborateur, envoi, paiement ou synchronisation de production n'est activé par cette préparation. Les fichiers de clients et les documents réels n'ont pas été consultés pour rédiger cette architecture. Les contrôles proposés ne constituent donc pas un audit des montants existants.

## Architecture cible proportionnée

```text
Interface React existante
  └── API privée / BFF : session, rôles, autorisations par dossier
        ├── SQL : dossiers, observations, valeurs validées, propositions, journal
        ├── Synchronisation serveur en lecture seule
        │     └── Google Sheets, puis VosFactures, Gmail, Drive, Agenda
        └── Actions proposées → validation explicite → exécution contrôlée future
```

Un BFF est un petit serveur dédié à l'interface : il authentifie chaque requête, filtre les données autorisées et conserve les secrets hors du navigateur. Une base SQL suffit pour ce volume ; aucun moteur de recherche distribué ni système de microservices n'est nécessaire.

La cible possible dans Sites est un Worker avec D1, sous réserve de vérifier la compatibilité de l'authentification, des tâches planifiées et du stockage privé. Ces services ne sont pas provisionnés ici. Le modèle reste utilisable avec un serveur Node et une base SQL équivalente.

Le futur serveur doit remplacer l'actif contenant les dossiers par une API authentifiée. Aucune route de données, pièce jointe ou export ne doit être accessible en contournant la session. Le catalogue public de fichiers, les sources téléversées, les journaux et les cartes de sources ne doivent pas contenir les dossiers. Les documents restent des liens soumis aux permissions d'origine ; une copie n'est créée qu'après autorisation distincte.

## Modèle de données

| Entité                               | Rôle et contraintes principales                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Client`                             | Identifiant interne stable, identité, coordonnées vérifiées et adresses distinctes.                                                   |
| `Dossier`                            | Identifiant stable distinct du client ; plusieurs dossiers possibles par client. Référence historique conservée.                      |
| `SourceBinding`                      | Source, ressource autorisée, identifiant externe stable, identifiant interne. Unicité par source/ressource/identifiant externe.       |
| `Observation`                        | Valeur brute immuable, champ visé, type, unité, devise, référence source, version source, date source, date de collecte et empreinte. |
| `ValidatedValue`                     | Valeur retenue, observations justificatives, validateur, date, version et motif. Une modification produit une nouvelle version.       |
| `ValidationCase`                     | Divergence, éléments comparés, priorité, responsable, état et décision motivée.                                                       |
| `QuoteVersion` / `ContractVersion`   | Versions distinctes, état réel, signature vérifiée et dates ; aucune fusion entre devis envoyé et vente signée.                       |
| `Invoice` / `CreditNote` / `Payment` | Références externes, statut réel, devise, base HT/TTC, dates, montants et liens entre pièces.                                         |
| `PaymentAllocation`                  | Affectation d'un paiement à une ou plusieurs factures ; évite de compter plusieurs fois un encaissement.                              |
| `Construction` / `ServiceCase`       | Étapes et dates de chantier, incidents et interventions SAV indépendants.                                                             |
| `Event` / `DocumentReference`        | Historique, auteur, identifiant d'origine, droits et lien vers la preuve.                                                             |
| `ProposedAction`                     | Charge utile préparée, preuves, version des données, validation et clé d'idempotence.                                                 |
| `SyncRun` / `AuditEvent`             | Exécutions et décisions traçables, résultat, versions, erreurs expurgées et identité de l'acteur.                                     |

Les quatre statuts `commercialStatus`, `constructionStatus`, `financialStatus` et `serviceStatus` sont indépendants. « Chantier terminé » n'implique ni « payé » ni « SAV résolu ». L'ancienne catégorie reste consultable comme information historique.

Tout champ sans preuve est `null`, affiché « Non renseigné ». Zéro, chaîne vide et « inconnu » ne sont pas interchangeables. Les adresses de chantier et de facturation ne sont pas déduites l'une de l'autre. Les dates conservent leur précision et leur fuseau d'origine lorsqu'ils existent.

Les montants utilisent des unités monétaires entières et une devise explicite, avec une politique d'arrondi documentée. Pour l'euro, les calculs utilisent les centimes. HT, TVA et TTC sont des champs distincts ; une base ou un taux absent bloque un calcul fiscal engageant. Un taux de TVA ne doit pas être présumé.

## Contrôle de cohérence : centre « À vérifier »

Une information reçue est une observation, pas une instruction de remplacement. La valeur validée reste distincte de toutes les observations, y compris de la dernière information reçue.

1. Le connecteur collecte une nouvelle version et l'enregistre sans altérer la précédente.
2. Le moteur compare des valeurs comparables : même dossier, champ, devise, base HT/TTC et période/version contractuelle.
3. En cas de divergence ou de rapprochement incertain, il ouvre ou actualise un seul contrôle pour le même événement.
4. La fiche affiche le client, le motif, les sources, les dates, les valeurs et l'action attendue. La valeur validée précédente reste visible avec son état.
5. Une personne autorisée examine les preuves et accepte, rejette ou demande un complément, avec justification.
6. Le serveur vérifie que les versions examinées n'ont pas changé, puis enregistre la décision dans une transaction. Une décision périmée doit être réexaminée.

L'exemple pédagogique de deux montants différents n'est jamais injecté dans un dossier réel. Les tests utilisent des identifiants synthétiques isolés.

Google Sheets reste la source principale des dossiers commerciaux de la première phase. Un contrat signé vérifié constitue la référence contractuelle, mais une IA ne détermine jamais seule quelle version signée est applicable, si un avenant prévaut ou si un montant remplace celui de Sheets. Cette hiérarchie oriente la vérification humaine ; elle ne déclenche pas d'écrasement automatique.

Une nouvelle observation Sheets peut actualiser l'affichage de la source. Elle ne devient pas silencieusement une valeur financière validée. Les règles permettant d'accepter automatiquement certains champs non sensibles devront être explicites, limitées et approuvées avant activation.

## Contrôles financiers indispensables

| Contrôle                                                           | Conséquence en cas d'échec                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Contrat signé, actif, identifié et version applicable vérifiée     | Aucune proposition de facture fondée sur ce contrat avant vérification.                               |
| Même devise, base HT/TTC explicite et TVA déterminée               | Montants non comparables ou calcul incomplet signalés ; aucune conversion implicite.                  |
| Cohérence HT + TVA = TTC selon la règle d'arrondi retenue          | Écart tracé ; aucun montant corrigé silencieusement.                                                  |
| Acompte de 30 % sur la base contractuelle applicable               | Proposition détaillant base, taux, arrondi, TVA et acompte déjà facturé ; validation humaine requise. |
| Facture finale tenant compte des factures d'acompte et des avoirs  | Pas de double facturation du même montant ; règle métier à confirmer.                                 |
| Note de crédit liée à une facture et motif justifié                | Proposition uniquement, avec contrôle du montant et de l'incidence sur le solde.                      |
| Identifiant de facture externe unique et recherche préalable       | Une facture déjà créée est rattachée ; une référence incertaine passe à vérifier.                     |
| Paiements réellement enregistrés et affectations contrôlées        | Un e-mail disant « payé » est une observation ; il ne crée pas un encaissement.                       |
| Solde réconcilié par pièces et affectations, sans double déduction | Total historique et montant réconcilié restent distincts jusqu'à validation.                          |

Ne pas confondre devis, contrats signés, montants facturés et encaissements. Une note de crédit réduit la créance concernée ; un remboursement et un paiement reçu ont des effets distincts et doivent être réconciliés. Les écritures annulées, impayées, partiellement payées et échues sont distinguées à partir des états réels.

Chaque indicateur comporte sa définition, son périmètre, sa devise, ses exclusions, sa source, la dernière synchronisation réussie et le nombre d'éléments encore à vérifier. Les montants non validés ne sont pas présentés comme un chiffre d'affaires encaissé fiable.

## Synchronisation sans rechargement

- Un traitement serveur mutualisé collecte les sources ; chaque iPad ne lance pas sa propre lecture Google.
- L'objectif d'environ 30 secondes est conditionné aux quotas, au nombre de feuilles et au mécanisme de planification disponible. Google Sheets ne fournit pas ici un véritable flux de modifications en temps réel.
- Le worker utilise un verrou avec expiration par ressource pour éviter les exécutions concurrentes. Un nouveau lancement rejoint ou reporte une exécution en cours.
- L'import valide la structure, les identifiants, types et unités en zone de préparation, puis publie atomiquement une version cohérente. Un lot partiel ou invalide ne remplace pas la dernière bonne version.
- Sheets est lu par plages et `batchGet`, en lots bornés avec points de reprise. Les connecteurs disposant de jetons de pagination les suivent jusqu'au bout ; une seule page ne vaut jamais import complet.
- Le rapprochement emploie une clé source stable existante. Un numéro de ligne, un nom ou une adresse ne sert pas d'identifiant. Si aucune clé stable n'existe, la connexion est bloquée pour définition d'une stratégie ; aucune colonne n'est ajoutée sans accord.
- Des empreintes détectent les changements et les relectures. Les curseurs incrémentaux sont utilisés seulement lorsqu'ils sont réellement disponibles ; sinon la lecture bornée est comparée au dernier état.
- Une ligne disparue crée un signal de vérification, pas une suppression automatique du dossier. Les doublons de clés sont mis en quarantaine.
- Les réponses `429` et les erreurs temporaires déclenchent une reprise progressive avec aléa et respect de `Retry-After`. Les erreurs d'autorisation bloquent le connecteur et appellent une intervention.
- Le navigateur demande la version du snapshot via ETag ou curseur, interrompt les requêtes périmées et conserve recherche, filtres, sélection et pagination. La fréquence diminue lorsque l'onglet est masqué.
- Le badge distingue « dernière vérification » de « dernière synchronisation réussie avec Sheets ». Une erreur réseau conserve la dernière version valide, marquée ancienne ; une perte d'autorisation masque les données et demande une reconnexion.

## API cible et droits

Contrats proposés, non connectés : `GET /api/snapshot`, `GET /api/clients/:id`, `GET /api/validation-cases`, `POST /api/validation-cases/:id/decisions`, `GET /api/sync-runs` et `GET /api/actions`. Une décision doit porter la version examinée et être protégée contre les requêtes intersites et les rejouements.

Le serveur vérifie la session et l'autorisation à chaque appel. Les rôles futurs peuvent être direction, commercial, chantier, SAV et finance, avec accès explicite aux dossiers et documents. L'authentification privée de l'aperçu actuel ne démontre pas que ces rôles existent déjà. Les exports sont autorisés, limités et journalisés comme les autres accès.

Les secrets restent dans le coffre de l'hébergement. Aucun jeton, corps d'e-mail ou document client dans les logs de diagnostic. Les sauvegardes chiffrées et leur restauration sont testées ; durées de conservation, révocation des accès et suppression réglementaire restent à définir avec le responsable métier.

## Actions proposées et journal

Le pipeline futur est : `proposée → à vérifier → approuvée → en exécution → réussie/échouée`. Un refus ou une modification de la proposition est historisé. Préparer, approuver et envoyer sont des opérations différentes.

L'approbation référence exactement la charge utile et les versions des preuves. Une modification du contrat, du destinataire, du montant ou des pièces invalide cette approbation. Aucun envoi de facture, note de crédit, relance, e-mail ou invitation, ni aucun paiement, ne découle d'une simple extraction IA.

Une clé d'idempotence et une contrainte unique empêchent les doubles traitements internes. Après un délai d'attente externe, l'exécuteur recherche le résultat existant avant toute nouvelle tentative ; il ne suppose pas que l'action a échoué. Si l'API externe ne garantit pas l'idempotence, un rapprochement et éventuellement une vérification humaine sont nécessaires avant reprise.

Les observations et décisions sont append-only dans le fonctionnement métier, avec journal des versions, acteur, motif et références. Cette immutabilité applicative ne signifie pas qu'une base SQL est inviolable : droits serveur, sauvegardes et contrôles d'intégrité restent nécessaires.

## Critères transversaux d'acceptation

Les tests utilisent des données synthétiques hors aperçu réel. Ils doivent vérifier les divergences, les décisions périmées, les imports interrompus, les doublons, les arrondis et l'absence d'envoi avant approbation. Les tests de confidentialité doivent refuser l'accès sans session, avec session expirée et avec rôle insuffisant, y compris aux documents et exports.

Les régressions doivent préserver recherche normalisée, filtres, compteurs, sélection, fiches, pagination, navigation clavier et affichage Mac/iPad/mobile. Un contrôle sur Safari iPad réel complète l'émulation de tailles d'écran avant mise en production.
