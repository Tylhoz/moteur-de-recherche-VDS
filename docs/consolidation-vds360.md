# Consolidation et synchronisation privées VDS 360°

Cette version conserve les observations brutes. Elle n'est pas un enrichissement par des données inventées.

## Sauvegarde et restauration

Au démarrage Railway, le serveur crée et vérifie une sauvegarde du volume **avant** l'import initial ou le démarrage des synchronisations. Le volume et les sauvegardes restent privés. L'export complet est accessible au propriétaire connecté dans Données & accès. Cet export comprend les observations, les versions et les décisions persistées, contrairement à un simple export du frontend.

L'archive JSON gzip contient un inventaire SHA-256 des objets. La restauration contrôle tous les objets avant écriture et exige un volume vide : elle ne remplace jamais un volume existant. Restaurer dans un environnement isolé, comparer les comptes, puis seulement décider d'une bascule. Les identifiants et secrets serveur ne sont pas inclus dans cet export et doivent être réinstallés séparément.

La sauvegarde externe préparée pendant le développement couvre les copies locales de la dernière importation connue ; elle ne certifie pas les modifications ultérieures sur le volume de production, inaccessible au réseau de cet environnement.

## Présentation des fiches

Les rubriques offrent une vue condensée et un bouton pour consulter toutes les observations. Les sources des champs regroupés sont réunies ; les originaux restent disponibles. Les documents financiers gardent leur identité propre. Une similarité de récit ou de date ne suffit pas pour fusionner deux événements.

Les valeurs antérieures des classeurs restent dans des versions immuables. Les anciennes valeurs différentes ou remplacées par un vide restent présentées comme antérieures. Les nouveaux identifiants client découverts sont conservés à partir de leurs versions historiques, même si une nouvelle cellule d'identité devient vide.

Le taux du cercle mesure les fiches au format 360°. Les audits historiques, rattachements, réceptions automatiques et validations humaines ont des indicateurs distincts.

## VosFactures — lecture seule

Référence : https://github.com/vosfactures/API et https://vosfactures.fr/api/doc

Variables serveur à installer, sans les publier :

- `VDS_INVOICING_PROVIDER=vosfactures`
- `VDS_VOSFACTURES_ACCOUNT` : sous-domaine du compte, sans `https://` ni `.vosfactures.fr`.
- `VDS_VOSFACTURES_API_TOKEN` : clé API confidentielle.
- `VDS_VOSFACTURES_ENABLED=true` : activer seulement après validation de la configuration.

Le lecteur utilise exclusivement GET sur `/clients.json`, `/invoices.json` et `/banking/payments.json`. Il parcourt les pages de 100 avec `period=all`, puis relit les modifications clients/documents avec un recouvrement de 24 heures et refait une lecture complète quotidienne. Les paiements sont reparcourus : aucun filtre incrémental non documenté n'est inventé. Un échec conserve l'état précédent. Les erreurs ne contiennent ni URL d'authentification ni réponse client brute.

Les enregistrements absents d'une lecture complète sont conservés pour contrôle et exclus des agrégats concernés. L'import est validé globalement avant activation de ses index. Une lecture vide inattendue nécessite une vérification.

Les webhooks `client:create/update/destroy` et `invoice:create/update/destroy` sont documentés par le fournisseur. Cette version n'en crée aucun : la configuration dans le compte et le format réel d'authentification à la livraison restent à vérifier avant d'activer un récepteur. La vérification périodique toutes les cinq minutes assure le fonctionnement de base après activation. Aucun endpoint ne crée, ne modifie, ne supprime ou n'envoie une facture.

## Google Sheets

Le lecteur Apps Script signé existant reste le mécanisme de transmission. Le bouton de synchronisation pose une demande de relecture ; le script mis à jour la détecte via sa réponse de contrôle et relit les classeurs au passage suivant. Les quotas et délais Google s'appliquent. Sans autorisation initiale Google, une demande ne constitue pas une synchronisation réussie.

Le fichier Excel d'origine et sa copie native sont deux sources distinctes : une modification de l'Excel n'actualise pas la copie native.

## Rapprochement et décisions

Un identifiant externe explicite ou des coordonnées corroborées peuvent établir une correspondance certaine. Un nom seul ou une adresse commune ne la permettent pas. Les coordonnées contradictoires et les égalités entre plusieurs dossiers restent à contrôler. Les décisions sont associées au contenu exact du contact source ; une modification de ce contact invalide la décision applicable sans effacer son historique.

Les rattachements existants à partir d'un e-mail unique dans l'import Sheets sont des observations historiques, sans validation humaine automatique. Le centre expose les lignes encore non rattachées ; une décision humaine rattache l'observation sans modifier la feuille source.

## Finances et graphiques

Les calculs utilisent des centimes entiers. Les ventes, devis et documents comptables ne sont pas confondus. Les familles acompte/finale dont la ventilation n'est pas établie sont exclues des totaux et signalées. Les paiements pointés sur les factures ne sont pas additionnés aux mouvements de paiement.

La comparaison facturation/encaissements exige des documents TTC éligibles et des transactions affectées aux mêmes documents. Les montants d'une autre devise, non exploitables ou non vérifiés ne deviennent pas zéro.

Les dix vues métier proposent les filtres de période, modèle et statut. Une série sans preuves suffisantes affiche « Données insuffisantes ». Les statuts issus de Sheets restent décrits comme déclarés dans les sources ; ils ne prouvent pas la réalisation d'un chantier ou une signature. L'acompte théorique standard de 30 % ne devient jamais une facture ou un paiement ; les conditions particulières de chaque dossier sont configurables dans son onglet Finances, avec motif et historique. Ces paramètres n’autorisent aucune création de document ni de paiement.

## Déploiement

La branche de travail ne déclenche pas de publication : le service Railway existant reste épinglé à sa version validée. Toute publication en production exige l'accord explicite du propriétaire. Avant bascule, contrôler le checkpoint, les 510 identifiants, les notes et le statut réel des deux connexions. Une clé configurée ne constitue pas un test de connexion réussi.
