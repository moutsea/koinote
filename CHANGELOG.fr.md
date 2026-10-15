# Journal des modifications

Ce fichier présente les changements de Koinote les plus utiles aux utilisateurs.

## [Unreleased]

## [1.1.6] - 2026-10-15

### Changed

- Supprimer un dossier supprime aussi ses sous-dossiers et met les documents qu’ils contiennent à la corbeille ; une fois restaurés, ils reviennent dans le dossier parent. La confirmation indique le nombre de documents concernés.
- Le classement IA supprime les dossiers qu’il vide, ainsi que les dossiers parents devenus vides, et les restaure à l’annulation. Les dossiers vides sans rapport sont conservés.

### Fixed

- Après l’application ou l’annulation du classement IA, la fenêtre affiche le résultat avec « Terminé » et « Nouveau classement » au lieu de revenir à « Générer l’aperçu ».
- Sur le bureau, supprimer des documents dont des modifications ne sont pas encore synchronisées les synchronise d’abord ; si c’est impossible (hors ligne ou échec de synchronisation), l’application explique ce qui serait perdu et demande confirmation, au lieu de perdre silencieusement de nouveaux documents ou des modifications.
- La synchronisation du bureau ne reste plus bloquée lorsqu’un document supprimé a été modifié sur un autre appareil ; la dernière version est mise à la corbeille.

## [1.1.5] - 2026-10-14

### Added

- Le classement IA s’ouvre sur une arborescence permettant de choisir précisément les documents à organiser. Cocher un dossier sélectionne tout son contenu ; les documents non organisés et ceux des dossiers automatiques de dates ou d’activité sont cochés par défaut, y compris ceux déjà organisés.

### Fixed

- Le classement IA ne conserve plus les dossiers automatiques de dates ou d’activité. Ils ne sont plus proposés comme destination : les nouveaux thèmes que le modèle y créerait sont créés à l’extérieur, et les suggestions qui se contentent d’y laisser un document doivent être vérifiées manuellement. Les dossiers vidés sont supprimés à l’application et restaurés à l’annulation.

## [1.1.4] - 2026-10-14

### Changed

- L’aperçu du classement IA montre le nettoyage des dossiers de date automatiques vides et explique leur suppression à l’application et leur restauration à l’annulation.

### Fixed

- L’aperçu et l’application du classement IA suppriment les dossiers de date automatiques vides, restaurés en cas d’annulation. Les dossiers manuels, réutilisés par thème ou contenant des articles exclus ou dans la corbeille sont conservés. Les aperçus existants en bénéficient sans nouvelle génération.

## [1.1.3] - 2026-10-14

### Added

- Les annonces de version proposent un bouton « Mettre à jour » donnant directement accès à la mise à jour du client. Il apparaît uniquement pour une version plus récente sur les clients compatibles ; les clics pendant le chargement ou une vérification en arrière-plan sont conservés.

### Fixed

- L’organisation IA distingue désormais les dossiers automatiques par date ou activité des classements thématiques, afin de ne plus traiter un ancien rangement automatique comme un exemple de classification confirmé.

## [1.1.2] - 2026-10-14

### Changed

- L’organisation IA affiche l’arborescence prévue, avec recherche, dossiers repliables, déplacement des articles par glisser-déposer, réorganisation et création de sous-dossiers. Des boutons haut/bas permettent aussi l’utilisation au clavier et au toucher.
- Développez un article pour modifier ses tags et sa destination ou consulter les suggestions. La gestion des tags permet les ajouts, retraits, renommages et fusions en lot pour les articles cochés. Les changements sont enregistrés lors de l’application de l’aperçu.

### Fixed

- La réorganisation dans la barre latérale ne bloque plus l’annulation des dossiers et des tags. La restauration des positions compare l’ordre relatif et préserve les modifications manuelles ultérieures.
- L’application vérifie uniquement l’ordre relatif des articles de référence décochés et signale un conflit si cet ordre change. Un simple réordonnancement ne modifie plus la date d’activité des articles.
- Les modifications de l’aperçu utilisent des mises à jour fonctionnelles, et les boutons de réorganisation conservent le focus clavier.

## [1.1.1] - 2026-10-14

### Changed

- L’organisation IA est limitée à deux requêtes par lot, avec une limite de sortie augmentée en cas de troncature. Un délai dépassé, trois lots consécutifs sans suggestion valide ou au moins la moitié de lots en échec après six lots conservent un aperçu partiel ; les documents inachevés restent désélectionnés et seules les suggestions valides sont facturées.
- L’organisation par IA rejoint les options existantes du menu d’organisation des documents, avec un seul bouton dans la barre latérale.

### Fixed

- Les aperçus d’organisation IA distinguent les requêtes refusées, les limites de fréquence et l’indisponibilité du fournisseur, avec des indications de dépannage. Seuls les codes d’état sont affichés, jamais le contenu brut des erreurs du fournisseur.
- L’organisation IA conserve les autres résultats lorsqu’un lot est refusé par la modération ou une limite de requête (400/413/422), sans facturer de credits pour ce lot. Les nouvelles tentatives après une réponse OpenAI vide sont limitées à l’organisation, sans augmenter les appels des autres fonctions IA.
- L’organisation des documents accepte désormais un résultat JSON complet entouré de texte explicatif, de références ou de liens Markdown, et réessaie les lots au format incorrect. Si la nouvelle tentative échoue, les autres aperçus sont conservés ; les documents concernés gardent leurs dossiers et tags d’origine et restent décochés pour vérification. Les appels échoués ne consomment aucun credit de la plateforme. L’état de suppression est aussi vérifié avant les tentatives automatiques internes.

## [1.1.0] - 2026-10-14

### Added

- L’organisation par contenu propose des dossiers et des tags dans un aperçu modifiable, ignore par défaut les documents déjà organisés et permet de les inclure explicitement. Le contenu et les couvertures sont préservés. L’annulation ignore les modifications ultérieures et affiche les titres concernés ; les lots sans suggestion valide ne coûtent aucun credit de la plateforme. Les clients synchronisent avant analyse et conservent les tags hors ligne.

### Changed

- Les suggestions de titres IA exploitent le corps de l’article, comparent plusieurs angles au titre original et présentent des citations vérifiées ainsi que les compromis concrets. Une note élevée ne bloque plus les alternatives ; les longs articles sont échantillonnés sur toute leur longueur dans une limite définie, dans le panneau de révision existant.

### Fixed

- Les titres IA invalides ou dupliqués sont désormais écartés individuellement, sans perdre les alternatives valides ni interrompre la révision du texte et de sa structure, même si tous les titres sont rejetés.
- L'application des suggestions d'optimisation IA conserve désormais l'image de couverture actuelle, son mode, son ratio et sa consigne, y compris lors d'une application individuelle, globale ou répétée. Les modifications suivantes n'enregistrent plus une couverture effacée.
- La découverte du Skills/Agent Hub dispose désormais de cinq créneaux quotidiens pour reprendre les exécutions manquées ou interrompues. Les imports continuent au-delà des 100 premiers candidats jusqu'à la limite de 20 ajouts par jour, à partir des résultats enregistrés et avec les mêmes contrôles de sécurité et de licence. L'aperçu reste limité à 100 candidats.

## [1.0.0] - 2026-10-12

Koinote 1.0.0 est la première version stable du site et des clients macOS / Windows.

### Added

- Skills/Agent Hub propose Clone public, Fork privé pour les membres, étoiles et import GitHub avec attribution et licences. Les dépôts système sont stockés dans R2 privé, actualisés chaque jour et enrichis de 20 nouveaux dépôts Skills populaires au maximum. Les contrôles d’identité, de licence et de données sensibles préservent la version précédente en cas d’échec et permettent une reprise.
- La synchronisation des configurations de développement/IA prend en charge DeepSeek Harness dans les agents de codage, avec les paramètres et profils `.dsh` ; les identifiants sont restaurés avec un accès réservé au propriétaire sur macOS/Linux, et les skills et AGENTS.md rejoignent le dépôt séparé.
- Les menus de synchronisation Skills/Agent et des configurations proposent de copier le point MCP, un accès en lecture seule et les instructions de fusion pour un agent IA ; les configurations utilisent un accès temporaire à une seule révision, sans partager le mot de passe de migration.
- La restauration locale des Skills/Agent et configurations de développement adapte les dossiers reconnus entre Windows, macOS et Linux, affiche les destinations et bloque les conflits avant écriture ; les anciennes sauvegardes restent utilisables.
- Le MCP des dépôts Skills/Agent permet de consulter et restaurer l’historique, de vérifier le stockage et d’envoyer des fichiers jusqu’à 5 MiB et de les lire par blocs, avec une connexion distincte du MCP des documents.
- Mon espace sépare désormais les dépôts Skills/Agent des instantanés chiffrés de configuration de développement/IA, avec envoi local en un clic, sélection et aperçu des fichiers, filtrage des données sensibles et confirmation avant la restauration locale.
- Les réglages de Mon espace permettent d’allouer directement du stockage personnel aux dépôts Agent, avec effet immédiat, et de récupérer la capacité inutilisée. Le détail du stockage du compte affiche cette allocation, tout en protégeant les fichiers existants et leur historique.
- L’export permet désormais d’activer ou désactiver WeChat, Zhihu et X séparément, ainsi que de configurer des plateformes HTTPS personnalisées avec un contrat JSON documenté ; la destination Juejin a été retirée.
- Les documents peuvent conserver une couverture par défaut, issue de l’article ou générée par IA, avec un ratio personnalisé, et la réutiliser sur X, Feishu et WeChat. Le changement de document restaure la position de lecture précédente. La génération IA accepte aussi une image de référence avec aperçu, remplacement et retrait, sans l’enregistrer dans l’article.
- Ajout de la sélection multiple avec Shift/Ctrl, de la navigation au clavier et du déplacement ou de la suppression groupés dans l’arborescence. Ajout d’actions de fermeture des onglets associés et de création d’un nouveau document.

### Changed

- L’optimisation IA enrichit l’évaluation du titre, les corrections des paragraphes et l’analyse de structure avec le lectorat visé, l’envie de cliquer, l’accroche et la promesse tenue. L’analyse globale guide des modifications concrètes des passages peu pertinents, des ruptures logiques et des formules creuses. La révision partage ses appels avec la correction, préserve la voix de l’auteur et présente la note du titre comme un jugement éditorial.
- Une configuration déverrouillée peut être resynchronisée sur la même page sans ressaisir le mot de passe ; une actualisation ou une nouvelle révision exige un nouveau déverrouillage. Le répertoire des dépôts publics porte désormais le nom Skills/Agent Hub. Skills/Agent Hub propose une navigation par thème, des filtres système/communauté, une recherche globale et 12 dépôts par page. Les cartes privilégient l’usage et l’auteur ; les thèmes défilent horizontalement sur mobile et les détails restent centrés sur le README. Les aperçus Markdown adoptent le style GitHub : titres, tableaux, tâches et code coloré, avec HTML filtré, liens et images relatifs à la version publiée, et vue du code source. Les filtres du Hub sont conservés au retour des détails et après rechargement ; le retrait puis la republication préservent la catégorie enregistrée. La recherche du Hub traite les paramètres URL invalides sans erreur ; après un échec d’actualisation, une nouvelle tentative recharge la liste actuelle au lieu de charger la page suivante. Dans Mon espace, le bouton Skills/Agent Hub se trouve près des paramètres ; le menu Nouveau dépôt propose Créer directement et Importer depuis GitHub, même lorsque la liste est vide.
- L’activation des dépôts Skills/Agent ne nécessite plus de jeton. Les jetons de dépôt se gèrent dans Mon espace, séparément des jetons MCP des documents ; Copier pour l’Agent IA y redirige uniquement lorsqu’un jeton en lecture-écriture utilisable manque. Les fichiers Skills/Agent, leur historique, les instantanés publics et les imports GitHub utilisent désormais un stockage privé Cloudflare R2. Les contenus existants migrent après vérification ; PostgreSQL conserve les métadonnées et les droits, et les Forks gardent leurs propres références. Les dépôts GitHub Skills sélectionnés appartiennent désormais au catalogue système, sans utiliser les quotas personnels des administrateurs. Les auteurs, sources et liens publics sont conservés ; le panneau d’administration permet de les consulter, retirer et republier.
- Le client de bureau vérifie les mises à jour cloud au démarrage, à la reconnexion, au retour à la fenêtre et toutes les 30 secondes lorsque celle-ci est visible. Seules les modifications locales déclenchent des envois ; les vérifications sans changement ou en échec restent discrètes, et les fenêtres masquées ne lancent pas de vérifications périodiques.
- La mise à jour d’un ancien instantané de configuration de développement/IA retire de cet instantané les fichiers Agent tels que `CLAUDE.md` et `.claude/skills/*`. Exportez ces fichiers ou envoyez-les vers un dépôt Agent avant la mise à jour ; les fichiers locaux restent inchangés.
- La synchronisation des brouillons WeChat réutilise les images déjà envoyées selon le compte et leur contenu, réduisant l’attente lors des synchronisations répétées et des nouvelles tentatives, sans modifier la qualité ni les couvertures. Aucune mise à jour du client n’est nécessaire.

### Fixed

- Correction de la restauration pour les alias HOME, la casse Windows et les dossiers de configuration externes ; les noms Unix valides sont préservés, tous les fichiers sont privés dès leur écriture temporaire et les chemins sont vérifiés avant création des dossiers.
- La synchronisation IA ne copie plus les jetons de dépôt de longue durée ; les autorisations temporaires sont révocables et liées aux sessions, la copie manuelle est disponible et les grandes archives utilisent le téléchargement complet.
- Correction de la synchronisation DeepSeek Harness : exclusion du répertoire de données d’exécution `storages` et conservation des permissions Unix `0600` des identifiants dans les ZIP téléchargés et chiffrés.
- Fiabilisation de la synchronisation : détection des cookies concaténés sur plusieurs lignes, rejet des chemins Unicode équivalents, nouvelle tentative de copie sans recréer les identifiants, actualisation de la version après déverrouillage et lots de transfert limités avec prise en charge des noms ZIP spéciaux.
- Correction du déplacement des boutons et de l’état d’envoi peu clair lors de la synchronisation Skills/Agent, ainsi que des fausses alertes de contenu sensible pour les exemples de suppression de cookies des skills Cloudflare.
- La restauration web demande une confirmation pour les contenus sensibles et affiche les erreurs, y compris les conflits de révision. Les mises à jour MCP consignent le dépôt et les révisions ; OpenClaw enregistre les références d’environnement avant de tester la connexion.
- La restauration refuse les contenus sensibles avec un jeton Agent ; le remplacement MCP complet exige `replaceAll`, les requêtes trop volumineuses renvoient 413 et les configurations Claude Code/OpenClaw conservent les références aux variables d’environnement.
- Lorsque la limite de jetons est atteinte, précisez que les documents MCP et les dépôts Agent partagent 20 jetons actifs et proposez un lien vers la gestion de l’autre type de jeton.
- La synchronisation sur ordinateur conserve les déplacements de documents effectués pendant une actualisation cloud, relance les synchronisations initiales échouées à la reconnexion et exécute les demandes manuelles reçues pendant une synchronisation automatique. La connexion peut reprendre un renouvellement interrompu ; les mises à jour du profil et les requêtes retardées ne remplacent plus les identifiants récents. Une aide avec nouvelle tentative apparaît si le gestionnaire d’identifiants est indisponible. Les utilisateurs déconnectés peuvent toujours accéder à la connexion et au mode local hors ligne ou pendant une panne du serveur. Les anciens jetons d’accès expirent au plus tard 60 secondes après le renouvellement ; une réautorisation est proposée en cas de compte incohérent, sans supprimer les documents locaux.
- La synchronisation vers les plateformes personnalisées omet désormais le champ de couverture facultatif lorsqu’aucune couverture n’est définie, évitant les erreurs de validation d’URL vide. La synchronisation API envoie le titre séparément, sans l’ajouter au corps Markdown ou HTML, pour éviter les titres en double.
- Les couvertures choisies dans les réglages des brouillons WeChat sont désormais enregistrées avec l’article. Les nouvelles tentatives réutilisent les images déjà envoyées, et le nettoyage du client conserve les images encore référencées par une couverture, le corps ou une version en conflit après synchronisation.
- Correction des délais d’expiration des brouillons WeChat riches en images grâce aux envois parallèles limités, aux signaux de maintien de la passerelle et aux connexions relais qui expirent uniquement lorsqu’elles sont inactives. Les clients existants restent compatibles.
- Correction des titres masqués lors d’un échec de chargement de couverture, des titres obsolètes sur les couvertures par défaut, des couvertures dupliquées dans le corps sur X, des anciennes couvertures dans les brouillons WeChat et du blocage de la synchronisation du corps sur Feishu. Les métadonnées de couverture respectent désormais des limites de taille et de stockage.
- Les opérations groupées sur l’arborescence réutilisent désormais le contrôle de révision et préservent la récupération des images lors de la suppression définitive.

## [0.7.0] - 2026-09-01

### Added

- Les membres à vie peuvent désormais lier jusqu’à cinq comptes officiels WeChat vérifiés, choisir un compte par défaut et enregistrer les articles mis en forme dans sa boîte de brouillons. La couverture peut être l’image Koinote par défaut, une image de l’article ou une image générée par IA ; chaque génération réussie coûte 20 credits.
- Ajout de l’optimisation IA réservée aux membres : diffs Git pour le titre et le corps, application ou rejet individuel et global, score du titre sur 100 et 2 à 3 alternatives sous 60. L’analyse sépare désormais le contenu de la structure, avec des modifications Markdown validées par AST et six scores pour la hiérarchie, la lisibilité, la mise en valeur, le rythme, les modules et le mobile.
- L’adhésion à vie accorde 1 000 credits. Le modèle intégré consomme 1 credit par tranche de 2 000 tokens réellement utilisés, avec des packs Stripe de 3 000, 10 000 et 30 000 credits.
- Ajout de canaux BYOK chiffrés pour les API compatibles OpenAI et Anthropic Messages ; les revues BYOK ne consomment aucun credit.
- Ajout du rangement intelligent par date et par activité pour les documents hors dossiers gérés manuellement, avec regroupement adaptatif par mois ou semaine et confirmation avant les déplacements en masse.
- Ajout d’un tableau de bord administrateur pour le CPU, la mémoire, la charge, le disque, la durée de fonctionnement et le débit réseau de l’hôte, à partir de métriques montées en lecture seule en production.
- Ajout d’une galerie multilingue de 15 modèles : cinq modèles hors ligne sont gratuits, dont la liste de tâches et le tableau polyvalent, tandis que les membres à vie disposent de dix modèles avancés avec rapports quotidien et hebdomadaire, OKR, KPI, écriture, produit, recherche et technique.
- Ajout de la recherche dans le document avec `Cmd+F` sur macOS et `Ctrl+F` sur Windows/Linux, mise en évidence des résultats, compteur et navigation précédente/suivante en boucle.
- Ajout de menus natifs localisés et d’un aide-mémoire des raccourcis sur ordinateur, avec ouverture rapide, recherche globale, navigation entre onglets, sélection numérotée, création/fermeture de documents, enregistrement manuel et bascule des panneaux.
- Ajout d’un résumé GEO masqué généré par IA, réservé aux membres, pour les exports WeChat. Il est enregistré par document, reste modifiable et réutilisable, signale les changements de l’article et présente clairement le risque lié aux règles de la plateforme avant activation.

### Changed

- Après son lancement, l’optimisation IA ferme le panneau et continue comme tâche d’arrière-plan persistante. Le titre et l’introduction, les sections du corps et la mise en page deviennent des sous-tâches à concurrence limitée ; chaque étape conserve sa progression et ses résultats partiels, et seule la sous-tâche invalide est relancée.
- Les résultats de l’optimisation IA restent disponibles si l’article change pendant l’analyse, avec un avertissement indiquant qu’ils peuvent ne plus refléter la dernière version. Les suggestions dont le texte source correspond encore peuvent être appliquées séparément, sans qu’un conflit invalide toute l’analyse.
- L’export WeChat ajuste désormais les marges, le rythme des paragraphes, l’interligne, l’approche et la taille des titres et du corps pour la lecture mobile, tout en conservant la police par défaut et l’identité de chaque thème.

### Fixed

- Les webhooks Stripe provenant d’autres applications sur le compte partagé sont désormais acquittés et ignorés, y compris avec une autre version d’API Stripe, tout en conservant la validation stricte des paiements Koinote.
- Amélioration de l’export Word avec une mise en page A4 explicite, une hiérarchie de titres, des listes imbriquées, de vrais hyperliens et des styles cohérents pour citations, code, légendes d’images, tableaux et numéros de page.
- Les titres placés juste après une image de bloc restent séparés après plusieurs sauvegardes Markdown, et les anciens titres échappés sont réparés à l’ouverture.
- L’export PDF utilise désormais une seule action claire et enregistre directement un PDF paginé et consultable. Un instantané d’impression dédié empêche les longs documents d’être limités à la zone visible de l’éditeur et isole la mise en page des barres latérales et d’outils.
- Correction du périmètre d’autorisation du client qui refusait les paramètres IA, les canaux de modèles, les credits, les analyses et l’achat de credits.
- Le paiement des credits utilise désormais un Product Stripe en mode production, avec une validation au déploiement contre les mélanges test/production.
- L’achat de credits prend désormais en charge les mêmes devises USD, CNY, EUR et JPY que l’adhésion, afin que Stripe puisse proposer les moyens locaux éligibles comme WeChat Pay en CNY.
- Après application d’une optimisation IA, le client aligne désormais sa révision et son instantané distant, évitant un faux échec de synchronisation alors que le contenu a bien été envoyé.
- Le remplacement d’une image locale par son URL après téléversement conserve désormais la position de défilement de l’éditeur.
- Le partage sur ordinateur synchronise d’abord le brouillon courant puis conserve immédiatement son état localement, afin que l’activation ou la révocation ne semble plus sans effet.
- Les raccourcis et accélérateurs des menus natifs n’agissent plus sur le document derrière une fenêtre modale ; un conflit pendant l’optimisation IA remplace désormais le panneau par le résolveur de conflit visible.
- Les modifications effectuées pendant une synchronisation d’images déclenchent désormais de façon fiable une synchronisation suivante, évitant les faux retards d’enregistrement ou de synchronisation après un téléversement réussi.
- Les échecs d’enregistrement distinguent désormais les conflits de révision des erreurs hors ligne ou réseau, conservent un brouillon réessayable sans restaurer silencieusement une ancienne sauvegarde et affichent un état plus clair et accessible.
- Les synchronisations, téléversements d’images et changements d’onglet conservent désormais le curseur et le défilement, même après le remontage d’un éditeur évincé du cache.
- Les actions d’export du menu natif exécutent directement le format choisi, et `Cmd/Ctrl+/` referme désormais correctement l’aide-mémoire des raccourcis.
- Le glisser-déposer des documents et dossiers fonctionne désormais dans WKWebView et WebView2 : le gestionnaire natif de fichiers de Tauri, qui interceptait les événements HTML5 des cibles, est désactivé, ce qui rétablit aussi le téléversement d’images par glisser-déposer. Les charges de l’arborescence ne s’insèrent plus en JSON dans l’éditeur, les fichiers externes déposés hors de l’éditeur ne peuvent plus faire naviguer l’application, les charges inconnues sont refusées, les cibles interfenêtres sont surlignées et les annulations ne laissent plus d’état résiduel.
- `Cmd/Ctrl+W` et le raccourci de création fonctionnent lorsque le corps de l’éditeur est actif, tout en restant bloqués dans les champs de formulaire et derrière les fenêtres modales.

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
