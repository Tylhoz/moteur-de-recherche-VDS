# Fondations VDS 360° — état de livraison

## Réalisé sur la branche feat/vds-360-foundations

- Architecture cible et plan des accès documentés ; aucun connecteur activé.
- Types séparant observations importées, informations validées et statuts commercial/chantier/finance/SAV.
- Contrôle pur des montants : valeur inconnue distincte de zéro, bases HT/TTC et taux de TVA explicites, provenance et versions.
- Décision de test explicite, justifiée, liée aux versions et invalidée par tout changement de preuve. La vérification du devis signé est elle-même liée à sa révision et à son montant exact ; une ancienne vérification ne peut pas être réutilisée.
- Calcul préparatoire exact de 30 % sur le montant confirmé, bloqué sans contrat signé vérifié ; aucune autorisation d'émettre, d'envoyer ou de payer.
- Validation du mapping et des imports : refus des imports incomplets ou invalides, clés dupliquées, protection contre les réponses anciennes, conservation de la dernière version valide et signalement des lignes disparues.
- Écran autonome `validation.html` utilisant uniquement l'exemple fictif 39 500 / 42 500 euros fourni dans la demande. Aucun dossier réel n'y est chargé.

## Vérifications réalisées

`npm run test:foundations` : 27 tests réussis, 0 échec (18 cohérence, 9 synchronisation).

`npm run check` : TypeScript sans erreur. `npm run build` : compilation réussie. `git diff --check` : sans erreur.

Scénario navigateur Chromium : validation désactivée sans choix, justification et confirmation ; calcul de préparation de 12 750 euros HT après choix du devis fictif vérifié ; modification de version rouvrant le contrôle ; comparaison HT/TTC bloquée ; aucune écriture réseau, aucune requête externe, aucune erreur JavaScript.

Formats vérifiés : bureau 1440 px, iPad 820 × 1180, smartphone 390 × 844. Aucun débordement horizontal. Ces tests de dimensions ne constituent pas un essai sur Safari/iPad physique.

## Limites et protection de la référence

Le centre est un prototype isolé, pas un module connecté du portail en ligne. Ses décisions vivent seulement dans la session mémoire et disparaissent au rechargement. L'identité du validateur est simulée ; une API authentifiée avec contrôle de rôle et transactions est nécessaire avant toute utilisation réelle.

Le journal de cohérence est immuable en mémoire. La synchronisation conserve le dernier état d'observations ; son journal durable et la conservation de toutes les versions restent à réaliser côté serveur. Aucune facture, note de crédit, relance ou paiement ne peut être déclenché par cette préparation.

La validation métier d'une valeur n'implique pas une correction de Google Sheets : cette écriture nécessitera ultérieurement un flux et une autorisation distincts.

Le checkout préparatoire exclut le fichier de dossiers par sparse-checkout. Le build ne contient pas `vds-snapshot.json`. Le portail principal n'est donc pas l'entrée de démonstration de ce checkout : utiliser `validation.html`. Les composants du portail de référence restent inchangés.

Aucune donnée de production consultée ou modifiée pendant cette phase. Aucune nouvelle publication, aucun envoi au dépôt distant et aucune connexion externe aux systèmes de l'entreprise. La recherche de références de marque a porté uniquement sur des pages publiques.

## Suite

Confirmer le vrai logo et les références graphiques avant proposition visuelle. Recevoir les en-têtes anonymisés, les noms des feuilles et la définition des clés pour préparer le mapping. Brancher ensuite Google Sheets en lecture seule, avec autorisation d'accès et validation du mapping. L'ordre reste : identité, Sheets, fiches enrichies, finances, Gmail/Drive/Agenda, automatisations.
