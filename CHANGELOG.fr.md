# Journal des modifications

Ce fichier présente les changements de Koinote les plus utiles aux utilisateurs.

## [Unreleased]

### Added

- Ajout de l’optimisation IA réservée aux membres : diffs Git pour le titre et le corps, application ou rejet individuel et global, score du titre sur 100 et 2 à 3 alternatives sous 60. L’analyse sépare désormais le contenu de la structure, avec des modifications Markdown validées par AST et six scores pour la hiérarchie, la lisibilité, la mise en valeur, le rythme, les modules et le mobile.
- L’adhésion à vie accorde 1 000 credits. Le modèle intégré consomme 1 credit par tranche de 2 000 tokens réellement utilisés, avec des packs Stripe de 3 000, 10 000 et 30 000 credits.
- Ajout de canaux BYOK chiffrés pour les API compatibles OpenAI et Anthropic Messages ; les revues BYOK ne consomment aucun credit.
- Ajout du rangement intelligent par date et par activité pour les documents hors dossiers gérés manuellement, avec regroupement adaptatif par mois ou semaine et confirmation avant les déplacements en masse.
- Ajout d’un tableau de bord administrateur pour le CPU, la mémoire, la charge, le disque, la durée de fonctionnement et le débit réseau de l’hôte, à partir de métriques montées en lecture seule en production.
- Ajout d’une galerie multilingue de 15 modèles : cinq modèles hors ligne sont gratuits, dont la liste de tâches et le tableau polyvalent, tandis que les membres à vie disposent de dix modèles avancés avec rapports quotidien et hebdomadaire, OKR, KPI, écriture, produit, recherche et technique.

### Changed

- Après son lancement, l’optimisation IA ferme le panneau et continue comme tâche d’arrière-plan persistante. Le titre et l’introduction, les sections du corps et la mise en page deviennent des sous-tâches à concurrence limitée ; chaque étape conserve sa progression et ses résultats partiels, et seule la sous-tâche invalide est relancée.

### Fixed

- Les webhooks Stripe provenant d’autres applications sur le compte partagé sont désormais acquittés et ignorés, y compris avec une autre version d’API Stripe, tout en conservant la validation stricte des paiements Koinote.
- Amélioration de l’export Word avec une mise en page A4 explicite, une hiérarchie de titres, des listes imbriquées, de vrais hyperliens et des styles cohérents pour citations, code, légendes d’images, tableaux et numéros de page.
- Les titres placés juste après une image de bloc restent séparés après plusieurs sauvegardes Markdown, et les anciens titres échappés sont réparés à l’ouverture.
- L’export PDF utilise désormais une seule action claire et enregistre directement sur ordinateur un PDF paginé et consultable dans le fichier choisi, sans ouvrir la boîte de dialogue d’impression.
- Correction du périmètre d’autorisation du client qui refusait les paramètres IA, les canaux de modèles, les credits, les analyses et l’achat de credits.
- Le paiement des credits utilise désormais un Product Stripe en mode production, avec une validation au déploiement contre les mélanges test/production.
- L’achat de credits prend désormais en charge les mêmes devises USD, CNY, EUR et JPY que l’adhésion, afin que Stripe puisse proposer les moyens locaux éligibles comme WeChat Pay en CNY.
- Après application d’une optimisation IA, le client aligne désormais sa révision et son instantané distant, évitant un faux échec de synchronisation alors que le contenu a bien été envoyé.
- Le remplacement d’une image locale par son URL après téléversement conserve désormais la position de défilement de l’éditeur.
- Le partage sur ordinateur synchronise d’abord le brouillon courant puis conserve immédiatement son état localement, afin que l’activation ou la révocation ne semble plus sans effet.

## [0.6.0] - 2026-08-17

### Added

- Ajout d’annonces multilingues intégrées : chaque version met automatiquement en avant les améliorations visibles, et l’administration peut publier des annonces manuelles traduites côté serveur en français, anglais, chinois et japonais.
- Ajout d’un mode bureau entièrement local, sans compte : documents, dossiers et images sont chiffrés avec une clé dérivée du mot de passe et toute connexion réseau est bloquée. Après connexion, une nouvelle vérification permet d’en copier un instantané indépendant vers le compte.
- Ajout d’une version alpha macOS / Windows avec Tauri 2 : connexion PKCE dans le navigateur système,
  jetons dans le trousseau, documents et images local-first, envoi différé, cache d’images limité et résolution des conflits.
- Ajout d’un lien de téléchargement vers les GitHub Releases pour macOS Apple Silicon, macOS Intel
  et Windows x64.
- Le client vérifie les mises à jour toutes les six heures, réessaie après 30 minutes en cas d’échec temporaire et se remet à jour au retour au premier plan ou après reconnexion.
- Détection des modifications distantes dans l’éditeur web et le client : mise à jour automatique
  des documents propres et demande explicite en cas de brouillon local concurrent.
- Sauvegardes PostgreSQL chiffrées toutes les six heures vers un R2 privé, avec rétention, contrôle de santé, alertes et procédure de restauration.
- Suppression autonome du compte avec confirmation de l’e-mail, nettoyage asynchrone des images et conservation dissociée des données financières requises, toujours visibles par l’administration comme compte supprimé.
- Journal d’activité MCP paginé indiquant outil, jeton, document, résultat et durée, sans enregistrer le contenu des documents ni des jetons.
- Diff ligne par ligne avec la version actuelle ou une autre version, avec calcul borné et repli des zones inchangées pour les grands documents.

### Changed

- Clarification dans les conditions de l’accès à vie, des 10 Go fixes, de l’éligibilité IA future, des limites d’usage raisonnables, de la suppression du compte et des remboursements.
- L’import Markdown vérifie les gros lots, décompresse les ZIP en arrière-plan, limite les envois,
  compresse en WebP les images de plus de 10 Mo (avec avertissement GIF statique) et libère les envois orphelins après un échec.
- macOS 26 utilise une ressource Icon Composer native ; les anciennes versions de macOS et Windows conservent leurs icônes de secours.

### Fixed

- Une annonce intégrée invalide ne bloque plus le démarrage du serveur ; elle peut être fermée localement si l’enregistrement de lecture échoue, et l’administration peut la retirer sans effacer l’historique. La traduction optionnelle ne bloque plus les déploiements sans rapport.
- Dans le titre, Entrée confirme désormais un candidat IME chinois, japonais ou coréen sans déplacer le curseur vers le corps ; hors composition, le raccourci vers le corps reste inchangé.
- La suppression de compte et le nettoyage Checkout revérifient désormais auprès de Stripe les sessions expirées localement et conservent les paiements terminés jusqu’à leur webhook. L’import du mode local passe par des lots temporaires bornés avec validation atomique, et les textes utilisateur contenant `$` ne sont plus altérés dans les messages de compte ou d’historique.
- Correction du CORS des exports Word/PDF.
- Stripe Checkout ne conserve qu’une session payable par utilisateur et le retour sécurisé `koinote://` permet au client de confirmer le paiement et d’actualiser l’abonnement.
- Correction du refus des statistiques d’administration et des jetons MCP par la liste d’autorisation
  Bearer du client, retour des entrées Documentation et Tarifs, et ouverture dans le navigateur système
  des opérations de sécurité du compte réservées au Web au lieu d’un échec 403.
  Les liens d’invitation et de partage copiés utilisent aussi l’URL publique plutôt qu’une adresse Tauri locale.
- La corbeille du client permet désormais une suppression définitive après une seule confirmation native ;
  le Web conserve la saisie du titre, et les brouillons locaux ainsi que les images hors ligne inutilisées sont nettoyés.
- L’échec d’une image ne bloque plus toute la synchronisation : l’erreur est affichée, les sources du cache sont vérifiées et les images locales sont incluses dans l’export.

## [0.5.0] - 2026-08-15

### Added

- Recherche globale dans les titres et le contenu avec `⌘K` / `Ctrl+K`, surlignage et extraits MCP.
- Import Markdown, dossier ou ZIP et export réimportable des documents, dossiers et images.
- Pages partagées enrichies avec OpenGraph, compteur de lectures et « Copier dans mon Koinote ».
- Récupération et modification du mot de passe, révocation des sessions et tiroir mobile des documents.
- Pages publiques MCP, historique des versions, Tarifs et Journal des modifications.

### Changed

- Les jetons MCP peuvent être permanents ou modifiés ; le guide couvre Codex, Claude Code, OpenCode, OpenClaw et WorkBuddy.
- L’export prend en charge WeChat, Zhihu et Juejin, avec historique, corbeille et instantanés de sécurité Agent pour les membres.
- L’administration affiche désormais les entonnoirs et la rétention D1/D7/D30 sans collecter le contenu des documents.

### Fixed

- Les caractères `$` des titres et résumés partagés ne peuvent plus endommager les métadonnées OpenGraph.

## [0.4.0] - 2026-08-13

### Added

- Les membres à vie peuvent lire et modifier leurs documents via MCP avec permissions et contrôle de revision.
- Ajout de l’historique, des instantanés de récupération, de la corbeille et de la restauration.
- Les paiements Stripe peuvent produire des notifications Feishu durables et respectueuses de la vie privée.
- Mes documents et Inviter des amis disposent de pages séparées.

### Fixed

- Correction du titre Juejin, des légendes et décorations WeChat, de la protection des images et de Cloudflare Analytics.

## [0.3.0] - 2026-08-12

### Added

- Paiement Stripe multidevise pour un abonnement à vie avec 10 Go de stockage.
- Les deux participants d’une invitation reçoivent 500 Mo, dans la limite de 5 Go par compte.
- Ajout du stockage, de la mise à niveau, des statistiques administrateur et de Cloudflare Analytics.

### Security

- Renforcement de la validation des paiements, OAuth, invitations, jetons internes et créations Checkout.

## [0.2.0] - 2026-08-11

### Added

- Inscription par code e-mail, Cloudflare Email Sending, déploiement automatique et quotas d’images.

### Fixed

- Correction du nettoyage et des quotas d’images, de la reprise de chargement et de la consommation des codes d’inscription.

### Security

- Les codes utilisent un HMAC, une consommation transactionnelle et des limites de débit.

## [0.1.0] - 2026-08-10

### Added

- Première version open source basée sur React, TipTap, Go, PostgreSQL et Cloudflare Worker.
- Éditeur Markdown WYSIWYG, images R2, partage, exports multiples, interface en quatre langues et connexion par mot de passe ou OAuth.
