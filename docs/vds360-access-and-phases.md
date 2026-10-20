# VDS Pools 360° — plan d'exécution et accès nécessaires

> Mise à jour — aperçu privé réel : le propriétaire a corrigé son instruction et demandé explicitement ses vrais dossiers. La livraison utilise les 500 dossiers de la copie déjà autorisée dans le Site privé. Les jeux fictifs restent isolés dans les tests ; aucune pièce ou divergence réelle n’est inventée. Les limitations de non-publication ci-dessous décrivent la phase préparatoire antérieure. Aucun service externe n’est connecté et aucune donnée de production n’est modifiée.

## Périmètre immédiat

La branche de fondations conserve l'interface et ses fonctions actuelles. Elle prépare les modèles, le contrôle de cohérence et les contrats de connexion. Le site privé publié reste la version de référence. Ce travail préparatoire ne publie rien, ne connecte aucun service et ne modifie aucune donnée de production.

Trois états doivent rester visibles dans les livraisons :

- **Existant** : portail React, recherche, filtres, fiches et copie des dossiers en lecture seule. Le code actuel relit un snapshot ; ce n'est pas une synchronisation Google Sheets.
- **Préparé** : architecture, modèles, règles, composants et tests présents dans la branche de développement, selon les vérifications effectivement exécutées.
- **À connecter / à valider** : sources externes, autorisations, règles métier et intégrations non activées. Aucun élément préparé ne doit être présenté comme une action déjà réalisée en production.

Les données synthétiques sont réservées aux tests isolés. Elles ne sont pas ajoutées à vos dossiers ni à l'aperçu réel. Les valeurs absentes restent inconnues.

## Phase 0 — Fondations et cohérence

**Travaux :** conserver les composants existants ; définir clients et dossiers distincts, quatre statuts indépendants, provenance par champ, observations immuables et valeurs validées. Préparer un centre « À vérifier » et un journal de décisions. Isoler les connecteurs derrière des interfaces serveur et définir l'outbox des actions proposées.

**Contrôle de cohérence :** chaque alerte doit répondre à cinq questions : chez quel client, quelle divergence, quelles sources, pourquoi c'est important et quelle action effectuer. Les montants comparés incluent devise, HT/TTC, version et date. Aucune décision financière n'est automatiquement prise par l'IA.

**Acceptation :** deux observations contradictoires ne changent pas une valeur validée ; une source absente ne devient pas zéro ; une décision portant sur une ancienne version est refusée ; un même événement ne crée pas plusieurs alertes. La recherche, les filtres et la sélection restent utilisables.

**Livraison :** modèles documentés, composants disponibles localement, résultat exact des tests et inventaire des éléments non connectés. Aucun audit des données réelles n'est prétendu dans cette phase.

## Phase 1 — Identité VDS Pools

**Entrées :** logo officiel dans son meilleur format disponible, capture du site actuel, éventuellement police et règles de marque. Un fichier graphique n'est pas une autorisation de connexion à un service.

**Travaux :** extraire une palette proposée, préparer logo complet et compact, navigation, cartes, tableaux, statuts et états de focus. Présenter une planche avant remplacement global, conformément au blueprint. Le mode sombre est optionnel et secondaire.

**Acceptation :** validation visuelle de la proposition ; lisibilité et contrastes ; logo non déformé ; absence de débordement à 375, 390, 820, 1024 et 1440 px ; interactions tactiles et clavier. L'identité n'est appliquée globalement qu'après validation de cette proposition.

**Restant à connecter :** aucun service nécessaire pour cette phase.

## Phase 2 — Google Sheets, en lecture seule

**Entrées :** liste des classeurs et principales feuilles, exemple anonymisé de leurs colonnes, signification des statuts, clé stable, types des montants, base HT/TTC, devise et format des dates. Ne pas transmettre les 500 lignes dans le chat.

**Travaux :** confirmer le mapping colonne/champ avec validation des types ; connecter uniquement les ressources autorisées ; importer en zone de préparation ; détecter doublons et écarts ; publier un snapshot versionné privé ; afficher dernière réussite et erreurs. Prévoir un objectif de 30 secondes adapté aux quotas, sans promesse de temps réel.

**Acceptation :** import complet et comptage expliqués ; ordre des lignes modifiable sans changer l'identité d'un dossier ; ajout et modification détectés ; doublon de clé isolé ; ligne disparue signalée sans suppression ; panne ou limite de quota préservant la dernière bonne version ; retour réseau sans perte de filtre ou sélection. Vérifier qu'aucune requête d'écriture Sheets n'est émise.

**Restant à connecter :** tant que la connexion et le mapping ne sont pas vérifiés, le badge doit rester « Google Sheets non connecté ». L'accès à un classeur ne vaut pas permission de modifier sa structure.

## Phase 3 — Fiches enrichies

**Travaux :** onglets Vue générale, Historique, Devis et ventes, Technique, Chantier, Finances, SAV et Documents. Les champs facultatifs restent vides faute de preuve. Chaque événement et résumé renvoie à sa provenance. La fiche rassemble les quatre statuts sans les fusionner.

**Acceptation :** chantier terminé, impayé et SAV ouvert peuvent coexister ; source et date sont consultables pour chaque information ; document non autorisé inaccessible ; résumé sans affirmation non sourcée ; historique et versions préservés ; absence de changement de dossier involontaire lors d'une actualisation.

**Restant à connecter :** les rubriques sans source vérifiée affichent un état vide explicite, pas une histoire ou un document inventé.

## Phase 4 — Finances et graphiques

**Entrées :** règles métier validées pour TVA, HT/TTC, acompte de 30 %, facture finale, arrondis, annulations, paiements et notes de crédit. L'accès initial VosFactures est limité à la lecture lorsque le fournisseur le permet.

**Travaux :** auditer les agrégats à partir des pièces ; séparer devis, ventes signées, facturé, encaissé et créances ; rapprocher les factures et paiements ; afficher le détail derrière chaque graphique ; préparer des actions soumises à validation humaine.

**Acceptation :** un contrat n'est jamais compté comme un encaissement ; HT et TTC ne sont pas additionnés ; aucune addition de devises différentes ; paiement partiel et avoir correctement affectés ; absence de double déduction d'acompte ; doublon de facture bloqué ; total du graphique égal au détail sur le même périmètre. Un montant non vérifié reste signalé.

**Restant à connecter :** l'émission de facture, de note de crédit et de relance exige une phase d'écriture distincte, des contrôles opérationnels et une approbation humaine explicite de chaque action. Aucune émission n'est activée par la préparation de cette phase.

## Phase 5 — Gmail, Drive et Agenda

**Entrées :** boîtes professionnelles, périodes d'historique, libellés, dossiers Drive et calendriers explicitement autorisés ; méthode de rapprochement avec un dossier. Les permissions du connecteur ne remplacent pas celles de l'utilisateur final.

**Travaux :** connecter une source à la fois en lecture seule ; commencer par un périmètre limité ; conserver identifiants de message, conversation, fichier et événement ; mettre les rapprochements incertains à vérifier. Un changement de date annoncé par e-mail ne remplace pas silencieusement une date confirmée.

**Acceptation :** même message importé deux fois sans doublon ; pièces et événements liés au bon dossier ; ambiguïté signalée ; suppression de permission bloquant la consultation ; aucun message envoyé, fichier partagé, événement modifié ni invitation déclenchée.

**Restant à connecter :** toute transmission de corps d'e-mail ou document à Gemini ou à un autre moteur IA nécessite l'autorisation préalable du périmètre et du prestataire. La lecture d'une boîte n'autorise pas cette transmission.

## Phase 6 — Automatisations et pilotage

**Travaux :** centre d'actions priorisées avec responsable, preuve et prochaine action ; filtres sauvegardés ; résumés fondés sur des sources vérifiées ; préparation d'actions via Make uniquement si utile et autorisé.

**Acceptation :** absence d'alertes dupliquées ; preuve consultable ; donnée contradictoire bloquant une action financière ; approbation périmée refusée après changement du montant ; reprise après délai d'attente sans double facture ; scénario Make désactivé tant qu'il n'est pas autorisé. Les recherches en langage naturel ne contournent jamais les droits.

**Restant à connecter :** chaque capacité d'écriture ou d'envoi est activée séparément après vérification de son mécanisme d'approbation. Un score de confiance IA n'est pas une approbation.

## Accès minimum à préparer

| Besoin                | Accès minimum et limite                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identité graphique    | Logo et capture fournis par le propriétaire ; aucun compte ni secret requis.                                                                                                               |
| Structure Sheets      | Échantillon anonymisé avec en-têtes, types et quelques lignes artificielles ; liste des feuilles utiles.                                                                                   |
| Google Sheets réel    | OAuth `spreadsheets.readonly`, ou compte de service lecteur partagé sur les seuls classeurs concernés. Liste de ressources autorisées côté serveur obligatoire.                            |
| VosFactures           | Identifiant du compte et capacité API de lecture, stockés dans le coffre de secrets. Vérifier les permissions effectivement proposées avant utilisation.                                   |
| Gmail                 | OAuth `gmail.readonly`, boîte professionnelle et période limitées par configuration. Aucun droit d'envoi ni de modification.                                                               |
| Drive                 | Lecture des métadonnées si suffisante ; lecture des contenus seulement pour les fichiers autorisés et nécessaires. Pour un compte de service, partager uniquement les ressources requises. |
| Google Agenda         | Lecture des événements des calendriers autorisés, par exemple `calendar.events.readonly`, avec ACL du compte correspondant. Aucun droit d'écriture.                                        |
| Hébergement           | Gestion du projet privé et de son authentification ; stockage serveur des secrets ; aucun accès administrateur au site actuel nécessaire.                                                  |
| Utilisateurs et rôles | Liste des rôles, périmètres des collaborateurs et personnes autorisées à approuver les données financières ; invitation par le fournisseur d'identité.                                     |
| Make / moteur IA      | Ultérieurement : environnement de test, scénarios désactivés, périmètre des données transmissibles et autorisation du prestataire.                                                         |

Les scopes Google peuvent être plus larges que les ressources utiles : un libellé Gmail ou une sélection de feuille dans l'application ne réduit pas techniquement le scope OAuth. Limiter aussi l'identité utilisée, les partages disponibles et la liste de ressources autorisées côté serveur. Le scope Drive permettant de lire tous les contenus exige une justification ; la portée doit être choisie selon le flux réel, pas par défaut.

Si VosFactures ne propose pas de jeton strictement en lecture seule, documenter cette limite avant connexion. Le connecteur doit bloquer les méthodes d'écriture ; cette restriction applicative ne réduit pas les pouvoirs intrinsèques du jeton. Aucun jeton complet ne doit être placé dans le navigateur.

Ne jamais demander de mot de passe, clé privée, jeton ou secret dans le chat. Les connexions se font via le parcours OAuth officiel ou une saisie directe dans le coffre de secrets de l'hébergement. Les identifiants de ressources et le mapping peuvent être communiqués par un canal approprié, sans valeurs clients.

## Exemple de mapping anonymisé attendu

| Colonne d'exemple | Champ cible                  | Points à confirmer                                                           |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `ID_DOSSIER`      | `Dossier.externalId`         | Stable, unique, non réutilisé ; ne pas utiliser le numéro de ligne.          |
| `ID_CLIENT`       | `Client.externalId`          | Distinct du dossier ; comment traiter plusieurs chantiers d'un même client.  |
| `MONTANT_HT`      | Observation du contrat HT    | Devise, version du devis/contrat et caractère signé ou estimé.               |
| `DATE_PLACEMENT`  | Observation de date chantier | Date prévisionnelle ou confirmée ; format et fuseau si heure.                |
| `STATUT`          | Catégorie historique         | Définition exacte ; ne pas la transformer automatiquement en quatre statuts. |

Cet exemple décrit une structure possible et ne prétend pas reproduire les colonnes existantes. Les informations non disponibles sont laissées sans correspondance jusqu'à clarification.

## Livraison à la fin de chaque phase

Présenter un aperçu fonctionnel, les fonctions effectivement opérationnelles, les tests réellement exécutés avec leur résultat, les limites et les éléments restant à connecter. Vérifier l'absence de régression sur les fonctions existantes et de données sensibles dans les artefacts destinés à être partagés.

Toute publication ultérieure doit préserver l'authentification et respecter le périmètre de données autorisé pour cette livraison. L'autorisation antérieure d'un aperçu privé n'est pas interprétée comme une autorisation permanente de publier de nouvelles sources, de transmettre des e-mails ou d'écrire dans les systèmes de production.
