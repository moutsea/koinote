import type { Messages } from "./types";

export const fr: Messages = {
  nav: {
    editor: "Éditeur",
    download: "Télécharger",
    pricing: "Mettre à niveau",
    docs: "Documentation",
    docsHome: "Centre de documentation",
    aiGuide: "Optimisation IA",
    mcpGuide: "Intégration MCP",
    versionHistoryGuide: "Contrôle de version",
    dashboard: "Tableau de bord",
    aiSettings: "Paramètres IA",
    documents: "Mes documents",
    trash: "Corbeille",
    invitations: "Inviter des amis",
    admin: "Administration",
    login: "Se connecter",
    logout: "Se déconnecter",
    userMenu: "Menu du compte",
  },
  home: {
    badge: "Markdown × Agents, conçu pour l'écriture",
    title: "L'écriture, sous sa forme la plus pure",
    subtitle:
      "Koinote est un éditeur Markdown en ligne façon Typora. Rendu en temps réel, images intégrées et agents autorisés à travailler avec vos documents en toute sécurité.",
    ctaStart: "Commencer à écrire",
    ctaDownload: "Télécharger l’application",
    ctaRegister: "Créer un compte",
    features: [
      {
        title: "Ce que vous voyez est ce que vous obtenez",
        desc: "Édition en volet unique façon Typora. Rendu en temps réel, sans séparation source/aperçu.",
      },
      {
        title: "Fidélité Markdown",
        desc: "CommonMark au cœur. Import et export sans perte, migration à tout moment.",
      },
      {
        title: "Hébergement d'images intégré",
        desc: "Glisser-déposer pour téléverser. Utilisez votre propre hébergeur ; liens propres dans le corps.",
      },
      {
        title: "Collaboration avec les agents",
        desc: "Connectez Codex, Claude Code, OpenCode et d'autres agents via MCP avec des accès limités.",
      },
      {
        title: "Export et partage faciles",
        desc: "Export Markdown / HTML d'origine. Partage par lien en lecture seule en un clic.",
      },
      {
        title: "Sauvegarde automatique",
        desc: "Sauvegarde au fil de la frappe et contrôle des révisions pour éviter les écrasements silencieux entre navigateur et Agent.",
      },
    ],
    mcp: {
      eyebrow: "Accès MCP ouvert",
      title: "Intégrez les agents à votre écriture",
      description:
        "Aucune extension requise. Créez un jeton personnel révocable et à durée limitée pour permettre à Codex, Claude Code, OpenCode et aux autres clients MCP compatibles de rechercher, lire et modifier vos documents selon les droits accordés.",
      agents: "Compatible avec les clients MCP Streamable HTTP",
      steps: [
        {
          title: "Limiter les droits",
          desc: "Créez des jetons en lecture seule ou lecture-écriture, consultables et révocables à tout moment.",
        },
        {
          title: "Écrire sans écraser",
          desc: "Chaque modification vérifie la révision du document et signale les conflits.",
        },
        {
          title: "Garder un point de secours",
          desc: "Les membres règlent l'historique complet et conservent toujours le dernier instantané de sécurité.",
        },
      ],
      cta: "Voir les avantages membre",
    },
  },
  pricing: {
    eyebrow: "Des tarifs simples et transparents",
    title: "Une mise à niveau, une écriture sereine",
    subtitle:
      "L'offre gratuite couvre l'écriture quotidienne. L'accès à vie ajoute stockage, MCP et historique en un seul paiement.",
    freeName: "Gratuit",
    freeDescription:
      "Tout ce qu'il faut pour commencer à écrire et découvrir l'éditeur.",
    freePrice: "Gratuit",
    freePeriod: "Utilisable sans limite de durée",
    lifetimeName: "À vie",
    lifetimeDescription:
      "Pour l'écriture au long cours et la collaboration avec les agents.",
    lifetimePeriod: "Un paiement, accès à vie",
    recommended: "Recommandé",
    included: "Inclus",
    freeFeatures: [
      "{storage} de stockage cloud pour documents et images",
      "Édition Markdown complète, sauvegarde automatique et synchronisation",
      "Hébergement d'images, exports et partage en lecture seule",
      "Stockage supplémentaire grâce aux invitations",
    ],
    lifetimeFeatures: [
      "{storage} de stockage cloud pour documents et images",
      "Accès MCP pour Codex, Claude Code, OpenCode et d'autres agents",
      "Historique configurable et restauration par instantané de sécurité",
      "Optimisation IA avec 1 000 credits, ou utilisation de votre propre LLM",
      "Dix modèles avancés pour le pilotage, l’écriture, le produit, la recherche et la technique",
      "Toutes les fonctions de l'offre gratuite",
    ],
    loginToUpgrade: "Se connecter pour passer membre",
    manageMembership: "Gérer l’IA et MCP",
    active: "Votre accès à vie est actif",
    loading: "Chargement des tarifs actuels…",
    loadFailed: "Impossible de charger les tarifs. Réessayez.",
    unavailable: "Le paiement en ligne n'est pas configuré sur ce déploiement.",
    creditsTitle: "Credits IA",
    creditsDescription:
      "Les analyses avec le modèle intégré consomment des credits. Votre propre canal LLM n’en consomme aucun.",
    creditsMembersOnly:
      "Les credits sont réservés aux membres à vie. Activez d’abord l’offre ci-dessus avant d’acheter un pack.",
    creditsNote:
      "Les credits achetés sont ajoutés automatiquement au compte ; le solde et l’historique sont visibles dans les paramètres IA.",
    buyCredits: "Acheter",
    faqTitle: "Questions fréquentes",
    faqs: [
      {
        question: "Est-ce un abonnement ?",
        answer:
          "Non. L'accès à vie est un paiement unique sans renouvellement automatique.",
      },
      {
        question: "Que permet MCP ?",
        answer:
          "Les agents autorisés peuvent rechercher, lire, créer, compléter, modifier, restaurer et mettre des documents à la corbeille. La suppression définitive reste réservée au Web.",
      },
      {
        question:
          "Puis-je restaurer après avoir désactivé l'historique MCP complet ?",
        answer:
          "Oui. Les écritures Agent des membres conservent toujours au moins le dernier instantané de sécurité.",
      },
      {
        question: "Comment l’optimisation IA est-elle facturée ?",
        answer:
          "L’accès à vie inclut 1 000 credits. Le modèle intégré consomme des credits selon l’utilisation réelle ; votre propre canal compatible OpenAI ou Anthropic n’en consomme aucun.",
      },
    ],
  },
  mcpGuide: {
    eyebrow: "Guide d’intégration MCP",
    title: "Autorisez vos agents à travailler avec vos documents",
    subtitle:
      "Connectez Codex, Claude Code, OpenCode, OpenClaw ou tout client MCP Streamable HTTP compatible à Koinote.",
    overviewTitle: "Fonctionnement",
    overviewBody:
      "Le modèle est fourni par votre agent. Koinote n’appelle aucun LLM : il gère l’autorisation, les outils documentaires, les conflits et l’audit.",
    setupTitle: "Avant de commencer",
    setupSteps: [
      {
        title: "Activez l’offre à vie",
        desc: "MCP est un avantage de l’offre à vie.",
      },
      {
        title: "Créez un jeton",
        desc: "Choisissez lecture seule ou lecture/écriture, avec une durée limitée ou permanente.",
      },
      {
        title: "Configurez le client",
        desc: "Utilisez la méthode correspondante pour https://koinote.app/mcp.",
      },
    ],
    clientsTitle: "Connexion des agents",
    clientsSubtitle:
      "Un jeton est un identifiant de compte. Gardez-le dans une variable d’environnement ou un stockage sécurisé, jamais dans Git.",
    clientDescriptions: [
      "Déclarez le MCP dans ~/.codex/config.toml, lisez le jeton depuis l’environnement, puis redémarrez Codex.",
      "Ajoutez le serveur HTTP et son en-tête Bearer avec la CLI Claude Code.",
      "Déclarez un MCP remote dans opencode.json et injectez l’en-tête depuis l’environnement.",
      "Enregistrez le serveur avec la CLI OpenClaw, puis vérifiez-le avec doctor.",
      "WorkBuddy et les autres clients doivent accepter Streamable HTTP et un en-tête Authorization.",
    ],
    tokenPlaceholder: "Remplacez l’exemple par le jeton du tableau de bord",
    verifyLabel: "Exemples à essayer",
    usageTitle: "Utilisation depuis un agent",
    usageBody:
      "Aucune syntaxe spéciale n’est requise. Demandez simplement à l’agent d’utiliser Koinote et précisez le document pour les remplacements ou la corbeille.",
    prompts: [
      "Liste mes cinq documents Koinote modifiés le plus récemment.",
      "Rédige un article sur le travail à distance et enregistre-le dans Koinote.",
      "Trouve « Checklist de lancement » et ajoute une section de bilan.",
      "Place « Ancien brouillon » dans la corbeille sans suppression définitive.",
    ],
    permissionsTitle: "Permissions et suppression",
    permissions: [
      "Les jetons en lecture seule peuvent lister, rechercher et lire les documents et l’historique.",
      "Les jetons en écriture peuvent créer, ajouter, mettre à jour, restaurer et gérer la corbeille.",
      "Un agent ne peut pas supprimer définitivement un document ; cette action reste dans l’interface web.",
      "Chaque jeton peut être révoqué et cesse de fonctionner à son expiration ou à la fin de l’adhésion.",
    ],
    tokensCta: "Créer un jeton MCP",
    historyCta: "Comprendre le versionnage",
    pricingCta: "Voir les avantages",
  },
  versionGuide: {
    eyebrow: "Guide du contrôle de version",
    title: "Gardez chaque modification importante récupérable",
    subtitle:
      "Découvrez comment Koinote conserve les versions, coordonne le navigateur et les agents, puis restaure un contenu après une erreur.",
    overviewTitle: "Fonctionnement de l’historique",
    overviewBody:
      "Les modifications du navigateur et de MCP partagent les mêmes révisions et règles d’historique. Les versions facilitent la récupération, tandis que les révisions empêchent un ancien contenu d’écraser silencieusement le nouveau.",
    availabilityTitle: "Adhésion et limites",
    availabilityBody:
      "L’historique est réservé aux membres à vie. Chaque document peut conserver 1 à 100 versions, avec une limite commune de 100 pour tout le compte ; les plus anciennes sont supprimées en premier.",
    featuresTitle: "Fonctions principales",
    features: [
      {
        title: "Instantanés regroupés",
        desc: "Les modifications web sont regroupées dans le temps au lieu de créer une version à chaque sauvegarde automatique.",
      },
      {
        title: "Limites flexibles",
        desc: "Activez ou désactivez l’historique et choisissez de 1 à 100 versions par document.",
      },
      {
        title: "Instantané de sécurité",
        desc: "Même sans historique MCP complet, le dernier état récupérable est gardé avant un remplacement par un agent.",
      },
      {
        title: "Détection des conflits",
        desc: "Une écriture exige la dernière révision ; une version périmée échoue au lieu d’écraser le contenu récent.",
      },
      {
        title: "Restauration réversible",
        desc: "L’état actuel est sauvegardé avant de restaurer une ancienne version.",
      },
    ],
    webTitle: "Consulter et restaurer sur le Web",
    webSteps: [
      "Ouvrez l’historique depuis la barre d’outils de l’éditeur pour voir les versions du document courant.",
      "Chaque version indique son heure et sa source : éditeur web, agent MCP ou restauration.",
      "Une restauration rend l’ancienne version courante tout en conservant l’état précédent comme point de récupération.",
    ],
    mcpTitle: "Règles pour les écritures MCP",
    mcpRules: [
      "Choisissez séparément si les écritures des agents conservent l’historique complet.",
      "Désactiver l’historique complet ne supprime pas l’instantané de sécurité avant un remplacement intégral.",
      "Les clients MCP autorisés en écriture peuvent lire et modifier ces règles ; les jetons en lecture seule peuvent seulement les consulter.",
    ],
    safetyTitle: "Réglages recommandés",
    safetyBody:
      "Gardez l’historique et l’historique MCP complet pour les documents importants. Ajustez la limite par document en tenant compte des 100 versions partagées par le compte, et demandez à l’agent de lire la dernière révision avant un remplacement.",
    settingsCta: "Régler l’historique",
    mcpCta: "Voir l’intégration MCP",
    pricingCta: "Voir les avantages",
  },
  aiGuide: {
    eyebrow: "Guide de l’optimisation IA",
    title: "Un éditeur IA relit votre texte et détaille chaque suggestion",
    subtitle:
      "L’IA relit automatiquement le titre, le texte, la structure et la mise en page, puis présente des modifications vérifiables comme une revue de code.",
    checks: [
      {
        title: "Force du titre",
        desc: "Évalue clarté, précision, crédibilité et curiosité ; sous 60 points, le modèle est invité à proposer deux ou trois alternatives.",
      },
      {
        title: "Qualité du texte",
        desc: "Repère les longueurs, références ambiguës, ruptures de ton, détails typographiques et problèmes de rythme sur mobile, avec une raison pour chaque correction.",
      },
      {
        title: "Structure et mise en page",
        desc: "Évalue hiérarchie, lisibilité, emphase, rythme, modularité et lecture mobile, puis suggère titres, séparateurs, listes ou citations.",
      },
      {
        title: "Application contrôlée",
        desc: "Chaque proposition montre l’original et la version suggérée. Appliquez-la seule, en lot, ou ignorez-la : rien ne change en arrière-plan sans accord.",
      },
    ],
    caseEyebrow: "Une revue réelle",
    caseTitle:
      "Cas réel : « L’éditeur Markdown à 1 000 $ devient open source »",
    caseIntro:
      "Cet article d’annonce produit contenait 18 paragraphes. La revue a conservé sa voix personnelle et son message central, corrigé quelques détails d’expression et ajouté la hiérarchie qui manquait. Les chiffres et exemples suivants proviennent d’une revue réelle effectuée le 19 août 2026.",
    caseSourceCta: "Lire l’original avant la revue",
    caseCarouselLabel: "Cas de revue réel",
    casePrevious: "Afficher la dimension précédente",
    caseNext: "Afficher la dimension suivante",
    caseFacts: [
      { label: "Force du titre", value: "76 / 100" },
      { label: "Suggestions de texte", value: "3" },
      { label: "Suggestions de structure", value: "6" },
      { label: "Coût réel", value: "3 credits" },
    ],
    caseTitleReviewTitle:
      "76 points : précis, intrigant et confirmé par l’article",
    caseTitleReviewBody:
      "Le chiffre concret de 1 000 $ crée une forte curiosité et l’article explique réellement cette dépense en tokens, sans exagération. « Open source » ajoute un second bénéfice. Ne pas nommer directement l’IA conserve un suspense raisonnable : le titre reste clair, précis et crédible sans nécessiter de réécriture forcée.",
    caseContentTitle: "Suggestion de texte : alléger une phrase surchargée",
    caseContentBody:
      "La phrase initiale relie par des virgules trois idées : pourquoi le service est gratuit, l’absence de frais de bande passante et la capacité de stockage qui en résulte. Couper après les frais de bande passante clarifie le lien de cause à effet sur mobile sans changer les mots de l’auteur.",
    beforeLabel: "Original",
    afterLabel: "Suggestion",
    caseBefore:
      "所以目前是完全免费的，感谢赛博菩萨 cloudflare 低廉的存储价格，并且还免流量费，让我能为每个用户设置 500MB 的存储空间，对于大多数轻量级用户来说，这个容量应该完全够用了。",
    caseAfter:
      "所以目前是完全免费的，感谢赛博菩萨 cloudflare 低廉的存储价格，并且还免流量费。这让我能为每个用户设置 500MB 的存储空间，对于大多数轻量级用户来说，这个容量应该完全够用了。",
    caseStructureTitle:
      "Suggestion de structure : diagnostiquer avant de hiérarchiser",
    caseStructureBody:
      "Les 18 paragraphes étaient initialement au même niveau. L’analyse en six dimensions a identifié la hiérarchie et l’emphase comme points les plus faibles, puis proposé des sections distinctes pour le lancement, l’open source et la suite.",
    caseDimensions: [
      { label: "Hiérarchie", score: 30 },
      { label: "Lisibilité", score: 68 },
      { label: "Emphase", score: 40 },
      { label: "Rythme", score: 58 },
      { label: "Modularité", score: 55 },
      { label: "Mobile", score: 72 },
    ],
    caseChangesTitle: "Suggestions concrètes et différences Markdown",
    caseChanges: [
      {
        before:
          "今天非常欣喜地宣布，koinote（锦鲤笔记）的 1.0 已经完成并且上线了，欢迎大家试用，多提意见。",
        after:
          "## 今天非常欣喜地宣布，koinote（锦鲤笔记）的 1.0 已经完成并且上线了，欢迎大家试用，多提意见。",
        reason:
          "Cette phrase est le cœur de l’annonce de la version 1.0. La transformer en H2 permet de repérer immédiatement le début de la section de lancement.",
      },
      {
        before: "并且完整的代码库也都开源了：",
        after: "### 并且完整的代码库也都开源了：",
        reason:
          "Le dépôt est un sous-thème de l’annonce. Un H3 le place sous la section 1.0 et rend la hiérarchie parent-enfant explicite.",
      },
      {
        before: "欢迎各位大佬多提 issue 和 PR。",
        after: "欢迎各位大佬多提 issue 和 PR。\n\n---",
        reason:
          "L’invitation à contribuer se termine ici et le paragraphe suivant passe au bilan des coûts. Un séparateur marque clairement ce changement de sujet.",
      },
      {
        before: "下一步打算完善一下会员体系，之后就是大家都期待的 AI 能力了。",
        after:
          "## 下一步打算完善一下会员体系，之后就是大家都期待的 AI 能力了。",
        reason:
          "Le texte passe de l’état actuel du produit aux projets d’adhésion et d’IA. Un H2 sépare la feuille de route de la présentation précédente.",
      },
      {
        before: "关于 AI 这块，不知道大家都有哪些点子呢？",
        after: "> **关于 AI 这块，不知道大家都有哪些点子呢？**",
        reason:
          "C’est la question la plus directe de l’article. Une citation mise en valeur évite qu’elle disparaisse lors d’une lecture rapide et encourage les réponses.",
      },
      {
        before:
          "所以欢迎给我留言，说说你们想要的功能，如果评估合理的话，一定都会加上的。",
        after:
          "> **所以欢迎给我留言，说说你们想要的功能，如果评估合理的话，一定都会加上的。**",
        reason:
          "Cette dernière phrase est le véritable appel à l’action. L’isoler transforme une explication ordinaire en demande finale claire.",
      },
    ],
    caseSafetyTitle:
      "Les neuf suggestions ont été appliquées après confirmation",
    caseSafetyBody:
      "La revue a produit trois suggestions de texte et six de structure. Koinote a conservé le résultat sans modifier le brouillon avant la confirmation de l’auteur ; les neuf suggestions ont finalement été appliquées pour 3 credits.",
    caseSafetyItems: [
      "Chaque proposition montre l’original, la modification et sa raison, sans changement silencieux.",
      "Si le document évolue après la revue, l’ancien résultat expire au lieu d’écraser le nouveau contenu.",
      "L’application des changements IA crée un point de récupération complet pour comparer ou restaurer.",
      "L’historique garde le résumé, les notes, l’état des suggestions et les credits réellement consommés.",
    ],
    caseOriginalEyebrow: "Article source de l’optimisation IA",
    caseOriginalTitle: "烧了一千刀的在线 markdown，开源了",
    caseOriginalDescription:
      "L’article source est en chinois. Voici la version enregistrée juste avant la revue IA du 19 août 2026. Hiérarchie, espaces, séparateurs et mises en valeur sont conservés afin de comparer chaque proposition du guide.",
    caseOriginalBack: "Retour au guide d’optimisation IA",
    faqTitle: "Questions fréquentes",
    faqs: [
      {
        question: "L’optimisation IA réécrit-elle directement tout l’article ?",
        answer:
          "Non. Le titre, le corps et la mise en page sont analysés par étapes en arrière-plan, puis Koinote fournit un résumé, des scores, les raisons et une comparaison avant/après. Seules les suggestions approuvées modifient le document.",
      },
      {
        question:
          "L’IA vérifie-t-elle les faits et préserve-t-elle totalement mon style ?",
        answer:
          "L’IA repère les problèmes d’écriture, mais ne vérifie pas les faits, chiffres ni sources citées. Les suggestions cherchent à préserver votre voix ; vérifiez néanmoins chacune d’elles par rapport à votre intention.",
      },
      {
        question:
          "Une ancienne revue peut-elle écraser des changements plus récents ?",
        answer:
          "Non. Les contrôles de revision et de conflit protègent chaque application. Si le document change après le début de la revue, l’ancien résultat expire au lieu d’écraser le nouveau contenu.",
      },
      {
        question:
          "Puis-je annuler les changements et que conserve l’historique ?",
        answer:
          "Oui. L’application des suggestions crée un point de récupération complet pour comparer ou restaurer la version précédente. L’historique conserve aussi les résumés, notes, états des suggestions et credits réellement consommés.",
      },
      {
        question:
          "Qui peut l’utiliser et comment le modèle intégré est-il facturé ?",
        answer:
          "L’optimisation IA est réservée aux membres à vie, qui reçoivent 1 000 credits lors du passage à cette offre. Le modèle intégré consomme des credits selon l’utilisation réelle de la revue.",
      },
      {
        question: "Puis-je utiliser mon propre canal de modèle ?",
        answer:
          "Oui. Connectez un canal compatible OpenAI ou Anthropic Messages dans les paramètres IA pour utiliser votre propre service sans consommer de credits Koinote. Le contenu relu est envoyé à ce service ; vérifiez donc la politique de données du fournisseur.",
      },
      {
        question:
          "La fonction marche-t-elle en mode local ou dans l’application ?",
        answer:
          "Le mode local bloque tout accès réseau et ne peut donc pas l’utiliser. L’application de bureau connectée à un compte y accède normalement lorsqu’elle est en ligne.",
      },
    ],
    pricingCta: "Voir l’offre et les credits",
  },
  docsCenter: {
    eyebrow: "Documentation produit",
    title: "Du premier document à un flux de rédaction complet",
    subtitle:
      "Retrouvez l’édition, la migration, le partage, l’application de bureau, l’optimisation IA et la sécurité des données. MCP et le versionnage disposent de guides détaillés.",
    quickStartTitle: "Commencer à écrire en cinq minutes",
    quickStartSteps: [
      {
        title: "Créer ou importer du contenu",
        desc: "Créez un document vide ou importez des fichiers .md, des dossiers et une archive ZIP Koinote depuis Mes documents.",
      },
      {
        title: "Organiser documents et dossiers",
        desc: "Utilisez l’arborescence, les onglets et les dossiers. Appuyez sur ⌘K / Ctrl+K pour rechercher dans tous les titres et contenus.",
      },
      {
        title: "Rédiger et ajouter des images",
        desc: "L’éditeur affiche le rendu et enregistre automatiquement. Collez, déposez ou choisissez une image pour insérer un lien hébergé stable.",
      },
      {
        title: "Partager, exporter ou publier",
        desc: "Créez un lien en lecture seule, exportez en Markdown, HTML, Word ou PDF, ou préparez le contenu pour WeChat, Zhihu et Juejin.",
      },
    ],
    workflowsTitle: "Parcourir par flux de travail",
    workflows: [
      {
        title: "Édition et organisation",
        desc: "Une expérience Markdown à panneau unique pensée pour les textes longs.",
        items: [
          "Rendu direct, sauvegarde automatique et raccourci de sauvegarde",
          "Dossiers, onglets, plan et organisation intelligente des documents racine",
          "Recherche globale dans les titres et le contenu avec surlignage",
          "Corbeille de 30 jours avec restauration ou suppression définitive",
        ],
      },
      {
        title: "Images et migration",
        desc: "Importez ou exportez les documents avec leurs images, sans verrouillage.",
        items: [
          "Coller, déposer ou sélectionner des images à envoyer",
          "Importer des .md, dossiers et ZIP contenant des images",
          "Compresser les grandes images dans le navigateur avant l’envoi",
          "Exporter tous les documents et images dans un ZIP de migration",
        ],
      },
      {
        title: "Partage et publication",
        desc: "Passez d’un brouillon privé à la lecture publique et à la diffusion.",
        items: [
          "Lien aléatoire ou mot de passe d’au moins six caractères",
          "Titre dynamique, carte OpenGraph et compteur de lectures",
          "Copie indépendante d’un document vers le Koinote du lecteur",
          "Export adapté à WeChat Official Accounts, Zhihu et Juejin",
        ],
      },
      {
        title: "Application de bureau",
        desc: "Édition locale, synchronisation et mises à jour sur macOS et Windows.",
        items: [
          "Versions Apple Silicon, Mac Intel et Windows x64",
          "Édition et collage d’images hors ligne, puis synchronisation automatique",
          "Détection des changements distants et choix de la version en cas de conflit",
          "Vérification périodique des mises à jour GitHub Releases",
        ],
      },
      {
        title: "Optimisation IA",
        desc: "Relisez un article comme une modification de code, puis choisissez les suggestions à appliquer.",
        items: [
          "Score d’attractivité du titre et alternatives générées par le modèle",
          "Contrôle du texte, de la structure, de la mise en page et de la lecture mobile",
          "Application suggestion par suggestion, en bloc, ou rejet",
          "Credits intégrés ou canal OpenAI / Anthropic personnel",
        ],
      },
      {
        title: "Compte et sécurité des données",
        desc: "Contrôlez les sessions, récupérez l’accès et déplacez ou supprimez vos données.",
        items: [
          "Réinitialiser ou modifier le mot de passe et fermer les autres sessions",
          "Historique configurable et protection contre les conflits",
          "Exporter une archive avant de supprimer le compte",
          "Limiter, expirer, afficher et révoquer les jetons MCP",
        ],
      },
    ],
    modesTitle: "Le mode local n’est pas le mode hors ligne",
    modesSubtitle:
      "Les deux permettent d’écrire sans connexion, mais l’identité, le réseau et la propriété des données diffèrent.",
    modes: [
      {
        title: "Mode hors ligne",
        desc: "Vous êtes connecté au compte mais sans réseau. Documents et images restent sur l’appareil, puis sont envoyés et synchronisés au retour de la connexion.",
      },
      {
        title: "Mode local",
        desc: "Aucune connexion au compte ni requête réseau. Un mot de passe local chiffre documents, noms de dossiers et images avant stockage dans SQLite.",
      },
      {
        title: "Importer les données locales",
        desc: "Après connexion, vérifiez le mot de passe local pour copier ces données dans le compte. Les deux ensembles restent ensuite indépendants.",
      },
    ],
    deepDiveTitle: "Guides détaillés",
    aiTitle: "Relire un article avec l’optimisation IA",
    aiDescription:
      "Découvrez, à partir d’une revue réelle, la note du titre, les suggestions de texte, l’analyse structurelle en six dimensions, les tâches de fond, les credits et votre propre canal de modèle.",
    mcpTitle: "Autoriser les agents à utiliser les documents Koinote",
    mcpDescription:
      "Configurez MCP Streamable HTTP pour Codex, Claude Code, OpenCode, OpenClaw et d’autres clients, avec permissions et exemples d’utilisation.",
    versionTitle: "Historique, différences et restauration",
    versionDescription:
      "Comprenez les limites, instantanés de sécurité, conflits de révision et la comparaison ou restauration des versions web et Agent.",
    readGuide: "Lire le guide",
    safetyTitle: "Conseil de migration",
    safetyBody:
      "La synchronisation et l’historique ne remplacent pas votre propre sauvegarde longue durée. Exportez régulièrement un ZIP avec les images ; le mode local n’ayant aucune copie cloud, cette précaution y est essentielle.",
    openEditor: "Ouvrir l’éditeur",
    manageDocuments: "Gérer et migrer les documents",
    downloadDesktop: "Télécharger l’application",
  },
  auth: {
    loginTitle: "Bon retour",
    loginSubtitle: "Connectez-vous pour continuer à écrire",
    registerTitle: "Créer votre compte",
    registerSubtitle: "Inscrivez-vous et commencez à écrire",
    username: "Nom d'utilisateur",
    usernamePlaceholder: "Choisissez un nom",
    email: "E-mail",
    emailPlaceholder: "vous@exemple.com",
    identifier: "Nom d'utilisateur ou e-mail",
    identifierPlaceholder: "Nom d'utilisateur ou e-mail",
    password: "Mot de passe",
    passwordPlaceholderLogin: "Saisissez votre mot de passe",
    passwordPlaceholderRegister: "Au moins 6 caractères",
    confirmPassword: "Confirmer le mot de passe",
    confirmPasswordPlaceholder: "Saisissez à nouveau le mot de passe",
    verificationCode: "Code de vérification de l’e-mail",
    verificationCodePlaceholder: "Code à 6 chiffres",
    sendVerificationCode: "Envoyer le code",
    resendVerificationCode: "Renvoyer",
    sendingVerificationCode: "Envoi…",
    verificationSent: "Code envoyé. Consultez votre boîte de réception.",
    verificationMockFilled:
      "Le code de test local a été saisi automatiquement.",
    emailVerificationRequired:
      "Votre mot de passe est correct. Vérifiez votre e-mail pour continuer.",
    verifyEmailTitle: "Adresse e-mail non vérifiée",
    verifyEmailDescription:
      "Envoyez un code à l’adresse ci-dessous. Vous serez connecté après la vérification.",
    verifyAndLogin: "Vérifier et se connecter",
    backToLogin: "Retour à la connexion",
    submitLogin: "Se connecter",
    submitRegister: "S'inscrire",
    processing: "Traitement…",
    noAccount: "Pas encore de compte ?",
    hasAccount: "Vous avez déjà un compte ?",
    toRegister: "S'inscrire",
    toLogin: "Se connecter",
    passwordMismatch: "Les deux mots de passe ne correspondent pas",
    requestFailed: "Échec de la requête, veuillez réessayer",
    orDivider: "ou",
    continueWithGoogle: "Continuer avec Google",
    continueWithGitHub: "Continuer avec GitHub",
    emailRegistration: "S’inscrire par e-mail",
    collapseEmailRegistration: "Masquer l’inscription par e-mail",
    invitationCode: "Code d’invitation (facultatif)",
    invitationCodePlaceholder: "Saisissez un code de 16 caractères",
    invitationRewardTitle: "Un ami vous offre 500 Mo de stockage",
    invitationBonusHint:
      "Valable avec Google, GitHub ou l’e-mail. Votre ami recevra également 500 Mo après votre inscription.",
    haveInvitationCode: "Vous avez un code d’invitation ?",
    forgotPassword: "Mot de passe oublié ?",
    resetPasswordTitle: "Réinitialiser le mot de passe",
    resetPasswordDescription:
      "Saisissez l’adresse e-mail du compte. Le résultat affiché reste identique, que cette adresse existe ou non.",
    newPassword: "Nouveau mot de passe",
    resetPasswordSubmit: "Réinitialiser le mot de passe",
    resetPasswordSuccess:
      "Mot de passe réinitialisé. Connectez-vous avec le nouveau mot de passe ; les anciennes sessions sont invalidées.",
    resetCodeSent:
      "Si cette adresse correspond à un compte avec mot de passe, un code a été envoyé. Consultez votre boîte de réception.",
  },
  security: {
    title: "Sécurité du compte",
    description:
      "Changer le mot de passe conserve cette session et invalide immédiatement les anciennes sessions ailleurs.",
    desktopDescription:
      "Le changement de mot de passe et la révocation des sessions sont des actions sensibles qui s’ouvrent dans le navigateur système.",
    manageOnWeb: "Gérer sur le Web",
    oauthOnly:
      "Ce compte utilise actuellement Google ou GitHub et ne possède pas de mot de passe Koinote à modifier.",
    currentPassword: "Mot de passe actuel",
    newPassword: "Nouveau mot de passe",
    confirmPassword: "Confirmer le nouveau mot de passe",
    changePassword: "Changer le mot de passe",
    changingPassword: "Modification…",
    passwordChanged:
      "Mot de passe modifié. Les anciennes sessions sur les autres appareils ont été déconnectées.",
    sessionsTitle: "Sessions de connexion",
    sessionsDescription:
      "Conservez ce navigateur connecté et déconnectez immédiatement les autres appareils.",
    invalidateSessions: "Déconnecter les autres appareils",
    invalidatingSessions: "Déconnexion…",
    sessionsInvalidated:
      "Les anciennes sessions sur les autres appareils ont été déconnectées.",
  },
  accountDeletion: {
    title: "Supprimer le compte",
    description:
      "Cette action est irréversible. Exportez d’abord les documents et images à conserver.",
    immediate:
      "Le compte, les documents, versions, partages, jetons MCP et images synchronisées sont immédiatement mis en suppression.",
    membership:
      "L’abonnement à vie prend fin avec le compte. La suppression ne déclenche pas de remboursement automatique ; vos droits légaux restent applicables.",
    paymentRecords:
      "Les données de paiement minimales nécessaires à la fiscalité, aux litiges et à la lutte contre la fraude sont dissociées du compte et conservées conformément à la loi.",
    feedbackRecords:
      "Le texte des commentaires, la page source et les informations client sont dissociés du compte puis conservés pour le diagnostic et l’amélioration du produit ; ils peuvent toujours contenir les données personnelles que vous avez saisies.",
    confirmLabel: "Saisissez l’adresse actuelle {email} pour confirmer",
    finalConfirmation:
      "Supprimer ce compte immédiatement ? Cette action est irréversible.",
    deleteButton: "Supprimer définitivement le compte",
    deleting: "Suppression…",
    mismatch: "L’adresse saisie ne correspond pas à ce compte.",
    paymentPending:
      "Un paiement est encore en cours. Attendez sa fin ou contactez l’assistance avant de supprimer le compte.",
    unavailable:
      "Impossible de fermer le paiement en toute sécurité pour le moment. Réessayez plus tard.",
    failed: "La suppression du compte a échoué. Réessayez plus tard.",
    localCleanupFailed:
      "Le compte cloud a été supprimé, mais certaines données hors ligne n’ont pas pu être effacées de cet appareil. Les jetons serveur sont invalides ; quittez l’application et supprimez manuellement ses données locales.",
  },
  storage: {
    title: "Stockage cloud",
    documents: "Documents",
    images: "Images",
    usedOf: "{used} sur {quota} utilisés",
    remaining: "{remaining} restants",
    nearLimitHint:
      "Il vous reste peu d'espace cloud. Supprimez définitivement les documents inutiles depuis la corbeille pour en libérer.",
    fullHint:
      "Le stockage cloud est plein : impossible d'enregistrer de nouveaux documents ou images. Supprimez définitivement les documents inutiles depuis la corbeille.",
    loading: "Chargement…",
    loadFailed: "Impossible de charger l'utilisation du stockage",
    quotaDialogTitle: "Stockage cloud plein",
    quotaDialogBody:
      "Vous avez utilisé {used} sur {quota} de stockage cloud, l'opération n'a donc pas abouti.",
    quotaDialogHint:
      "Les documents dans la corbeille occupent encore de l’espace. Après suppression définitive, les images non référencées sont nettoyées en arrière-plan.",
    quotaDialogDismiss: "J'ai compris",
    quotaDialogManage: "Voir l'utilisation",
  },
  membership: {
    title: "Koinote à vie",
    lifetimeBadge: "À vie",
    activeBadge: "Actif",
    description:
      "Une mise à niveau unique pour 10 Go de stockage, MCP, l’historique, l’optimisation IA et 1 000 credits.",
    oneTimePayment: "Paiement unique, valable à vie",
    currencyLabel: "Devise de paiement",
    currencyHint: "Stripe Checkout vous facturera dans la devise sélectionnée.",
    storageBenefit: "10 Go de stockage cloud",
    aiBenefit: "Optimisation IA",
    aiComingSoon:
      "Inclut 1 000 credits, ou utilisez votre propre fournisseur LLM",
    purchase: "Obtenir l'accès à vie",
    redirecting: "Ouverture du paiement sécurisé…",
    activeTitle: "Abonnement à vie débloqué",
    activeDescription:
      "Votre compte bénéficie de 10 Go fixes de stockage cloud, de l’optimisation IA et de tous les avantages à vie.",
    unavailable:
      "Le paiement des abonnements n'est pas configuré sur ce déploiement.",
    loadFailed: "Impossible de charger le statut de l'abonnement.",
    checkoutSuccess: "Paiement confirmé. Votre abonnement à vie est actif.",
    checkoutPending:
      "Le paiement est encore en cours de confirmation. Vos droits seront mis à jour automatiquement.",
    checkoutDelayed:
      "Stripe traite encore ce paiement. Ne payez pas une seconde fois ; revenez plus tard ou contactez l’assistance si le débit reste sans effet.",
    checkoutCancelled: "Le paiement a été annulé. Vous n'avez pas été débité.",
    checkoutFailed: "Le paiement n'a pas abouti. Veuillez réessayer.",
  },
  agentCredits: {
    title: "Credits IA",
    description:
      "Les analyses avec le modèle intégré consomment des credits. Votre propre canal LLM n’en consomme aucun.",
    membersOnly:
      "L’optimisation IA est réservée aux membres à vie et inclut 1 000 credits lors de la mise à niveau.",
    available: "{count} disponibles",
    estimatedCharge: "Débit estimé : {count} credits",
    loading: "Chargement des credits…",
    loadFailed: "Impossible de charger les credits. Réessayez.",
    balance: "Solde",
    reserved: "Débit estimé",
    availableLabel: "Disponibles",
    purchaseUnavailable:
      "L’achat de credits n’est pas configuré sur ce déploiement.",
    redirecting: "Ouverture du paiement sécurisé…",
    history: "Activité récente",
    checkoutSuccess: "Les credits ont été ajoutés à votre solde.",
    checkoutPending:
      "Paiement en cours de confirmation. Ne payez pas une seconde fois.",
    checkoutDelayed:
      "Stripe traite encore ce paiement. Ne payez pas une seconde fois ; revenez plus tard.",
    checkoutCancelled: "Achat annulé. Aucun débit n’a été effectué.",
    checkoutFailed: "L’achat n’a pas abouti. Réessayez.",
    transactionKinds: {
      membership_grant: "Bonus membre",
      purchase: "Achat",
      agent_usage: "Optimisation IA",
      adjustment: "Ajustement du solde",
      refund: "Remboursement",
    },
  },
  agentModelSettings: {
    title: "Modèle IA",
    description:
      "Choisissez si l’optimisation IA utilise le modèle intégré ou votre propre LLM. L’éditeur appliquera ce réglage sans redemander.",
    membersOnly: "L’optimisation IA est réservée aux membres à vie.",
    builtIn: "Modèle intégré",
    builtInHint: "Consomme des credits selon l’utilisation réelle.",
    byok: "Votre propre LLM",
    byokUnavailable: "Ajoutez d’abord un canal de modèle ci-dessous.",
    loading: "Chargement des paramètres du modèle…",
    loadFailed: "Impossible de charger les paramètres du modèle. Réessayez.",
    saveFailed: "Impossible d’enregistrer les paramètres du modèle. Réessayez.",
  },
  llmChannels: {
    title: "Vos canaux LLM",
    description:
      "Configurez une API compatible OpenAI ou l’API Anthropic Messages. Les analyses utilisent le canal par défaut ; les clés sont chiffrées et BYOK ne consomme aucun credit.",
    membersOnly:
      "Les canaux LLM personnalisés sont réservés aux membres à vie.",
    add: "Ajouter un canal",
    loading: "Chargement des canaux…",
    loadFailed: "Impossible de charger les canaux. Réessayez.",
    empty: "Aucun canal personnalisé n’est encore configuré.",
    defaultBadge: "Par défaut",
    edit: "Modifier le canal",
    delete: "Supprimer le canal",
    deleteConfirm:
      "Les analyses utilisant ce canal ne fonctionneront plus. Le supprimer ?",
    addTitle: "Ajouter un canal LLM",
    editTitle: "Modifier le canal LLM",
    cancel: "Annuler",
    name: "Nom du canal",
    protocol: "Protocole API",
    baseUrl: "URL de base",
    model: "Modèle",
    apiKey: "Clé API",
    apiKeyOptional: "Clé API (laisser vide pour ne pas la modifier)",
    makeDefault: "Définir comme canal par défaut",
    save: "Enregistrer le canal",
    saving: "Enregistrement…",
    saveFailed:
      "Impossible d’enregistrer le canal. Vérifiez la configuration puis réessayez.",
    deleteFailed: "Impossible de supprimer le canal. Réessayez.",
  },
  agentReview: {
    button: "Optimisation IA",
    title: "Optimisation IA",
    description:
      "Analysez le titre, le corps et la mise en page Markdown comme une modification de code ; rien ne change sans votre accord.",
    membersOnly: "Cette fonction est réservée aux membres à vie.",
    upgrade: "Devenir membre à vie",
    localModeUnavailable:
      "Le mode local ne se connecte jamais au réseau ; l’optimisation IA est indisponible.",
    provider: "Méthode d’analyse",
    builtIn: "Modèle intégré",
    builtInHint: "Consomme des credits selon le nombre réel de tokens.",
    byok: "Votre canal",
    byokHint: "Utilise votre clé API sans consommer de credits.",
    channel: "Canal par défaut",
    configureChannels: "Gérer les canaux de modèles",
    availableCredits: "{count} credits disponibles",
    start: "Lancer l’analyse",
    running: "L’IA analyse votre article…",
    progress: "{completed}/{total} sous-tâches terminées",
    partialResults:
      "Des résultats partiels sont disponibles. Les modifications pourront être appliquées à la fin.",
    stageTitle: "Titre et introduction",
    stageDocument: "Révision globale",
    stageBody: "Analyse du contenu",
    stageLayout: "Structure et mise en page",
    backgroundRunning: "L’optimisation IA s’exécute en arrière-plan",
    backgroundRunningDescription:
      "Vous pouvez continuer à écrire ou changer de page. Koinote vous avertira lorsque l’analyse sera prête.",
    backgroundReady: "L’optimisation IA est terminée",
    backgroundReadyDescription:
      "Les suggestions pour le titre, le contenu et la mise en page sont prêtes.",
    backgroundFailed: "L’optimisation IA n’a pas abouti",
    backgroundFailedDescription:
      "Le canal du modèle ou le réseau est peut-être temporairement indisponible. Ouvrez le document et réessayez.",
    backgroundTimeoutDescription:
      "L’analyse a expiré ou le service a redémarré. Ouvrez le document et relancez-la.",
    viewBackgroundResult: "Voir les suggestions",
    dismissNotification: "Fermer la notification",
    saveFailed:
      "Impossible d’enregistrer le document actuel. Corrigez le problème puis réessayez.",
    loading: "Chargement de l’analyse…",
    loadFailed: "Impossible de charger l’historique des analyses. Réessayez.",
    noPreviousReviews: "Aucune analyse pour le moment.",
    previousReviews: "Analyses précédentes",
    newReview: "Nouvelle analyse",
    summary: "Résumé de l’analyse",
    titleReview: "Suggestions de titre",
    contentReview: "Expression du texte",
    layoutReview: "Structure et mise en page",
    layoutAssessment: "Radar à six dimensions",
    layoutShowCards: "Tout déployer",
    layoutShowRadar: "Afficher le radar",
    layoutRadarHint:
      "Survolez une dimension pour l’examiner. Cliquez pour filtrer les suggestions, puis recliquez pour annuler.",
    deepAnalysis: "Analyse approfondie",
    deepAnalysisTarget: "Cible de l’analyse approfondie",
    deepAnalysisStarting: "Démarrage…",
    deepReviewBadge: "Analyse approfondie · {dimension}",
    titleScore: "Attractivité du titre : {score}/100",
    suggestions: "Modifications proposées",
    before: "Avant",
    after: "Après",
    apply: "Appliquer",
    applying: "Application…",
    dismiss: "Ignorer",
    applyAll: "Tout appliquer",
    applyingAll: "Application de tout…",
    dismissAll: "Tout ignorer",
    dismissAllConfirm:
      "Cette action ferme l’analyse. Ignorer toutes les suggestions restantes ?",
    applied: "Appliquée",
    dismissed: "Ignorée",
    staleTitle: "Cette analyse n’est plus à jour",
    staleDescription:
      "Le document a changé après l’analyse. Lancez-en une nouvelle pour ne pas écraser les modifications récentes.",
    failedTitle: "L’IA n’a pas pu terminer l’analyse",
    retry: "Relancer l’analyse",
    noSuggestions:
      "L’article est en bon état ; aucune modification n’est proposée.",
    noTitleSuggestions:
      "Aucune alternative assez fiable pour remplacer le titre actuel n’a été trouvée.",
    noTitleSuggestionsLowScore:
      "Le titre obtient une note faible, mais aucune alternative étayée n’a été trouvée : l’article ne porte pas encore de promesse plus forte. Ajoutez un résultat ou un public concret, puis relancez la revue.",
    noContentSuggestions:
      "Le texte est déjà solide. Aucune modification éditoriale n’est nécessaire.",
    noLayoutSuggestions:
      "La structure actuelle fonctionne déjà. Aucun changement de mise en page sûr n’est nécessaire.",
    noFilteredLayoutSuggestions:
      "Cette analyse ne contient aucun changement pour « {dimension} ». Lancez une analyse approfondie ciblée.",
    usage: "{credits} credits consommés",
    close: "Fermer",
    categories: {
      title: "Titre",
      clarity: "Clarté",
      structure: "Structure",
      engagement: "Attractivité",
      accuracy: "Exactitude",
      style: "Style",
      conversion: "Appel à l’action",
      hierarchy: "Hiérarchie",
      readability: "Lisibilité",
      emphasis: "Mise en valeur",
      rhythm: "Rythme",
      modules: "Modules",
      mobile: "Mobile",
    },
    statuses: {
      running: "Analyse en cours",
      ready: "Prête",
      partially_applied: "Partiellement appliquée",
      applied: "Appliquée",
      dismissed: "Ignorée",
      failed: "Échec",
      stale: "Obsolète",
    },
  },
  mcp: {
    title: "Accès Agent aux documents (MCP)",
    description:
      "Autorisez Codex, Claude Code, OpenCode et d'autres agents MCP standard à lire ou modifier vos documents Koinote selon la portée choisie.",
    membersOnly:
      "L'accès MCP est réservé aux membres payants. Passez membre pour créer des jetons révocables, temporaires ou permanents.",
    upgrade: "Devenir membre à vie",
    tokenName: "Nom du jeton",
    scope: "Portée",
    readOnly: "Lecture seule",
    readWrite: "Lecture et écriture",
    expiry: "Expiration",
    days: "{n} jours",
    neverExpires: "Permanent",
    editExpiry: "Modifier l’expiration",
    saveExpiry: "Enregistrer l’expiration",
    cancelExpiry: "Annuler la modification",
    expiryUpdateFailed: "Impossible de modifier l’expiration. Réessayez.",
    create: "Créer le jeton",
    createFailed: "Impossible de créer le jeton. Réessayez.",
    secretStored:
      "Le jeton est stocké chiffré et peut être consulté ou copié à nouveau ci-dessous.",
    activeTokens: "Jetons actifs",
    loading: "Chargement…",
    loadFailed: "Impossible de charger les jetons",
    empty: "Aucun jeton actif.",
    expires: "Expire le",
    lastUsed: "Dernière utilisation",
    reveal: "Afficher",
    hide: "Masquer",
    revealFailed: "Impossible d’afficher le jeton. Réessayez.",
    legacyNotRevealable:
      "Cet ancien jeton ne peut pas être récupéré. Il reste utilisable, ou vous pouvez le révoquer et le recréer.",
    revoke: "Révoquer",
    revokeConfirm:
      "Les agents connectés perdront immédiatement l'accès. Révoquer ce jeton ?",
    activity: "Journal d’activité",
  },
  mcpActivity: {
    title: "Journal d’activité MCP",
    description:
      "Consultez les outils appelés par l’Agent, les documents concernés et le résultat. Les journaux sont conservés 180 jours sans contenu de document ni de jeton.",
    back: "Retour aux paramètres MCP",
    membersOnly: "Le journal d’activité MCP est réservé aux membres à vie.",
    loading: "Chargement de l’activité…",
    loadFailed: "Impossible de charger l’activité MCP. Réessayez.",
    retry: "Réessayer",
    empty:
      "Aucune activité MCP. Les appels apparaîtront après la première utilisation d’un outil par un Agent.",
    loadMore: "Charger plus",
    success: "Réussi",
    error: "Échec",
    deletedToken: "Jeton révoqué ou supprimé",
    deletedDocument: "Document supprimé",
  },
  documentHistorySettings: {
    title: "Historique des versions",
    description:
      "Choisissez si les documents conservent des versions et comment les écritures Web et Agent sont enregistrées.",
    membersOnly:
      "L’historique est réservé aux membres à vie. Passez membre pour configurer la conservation.",
    enabled: "Activer l’historique",
    enabledHint:
      "La désactivation arrête les instantanés Web sans supprimer les versions conservées ; l’Agent garde toujours le dernier instantané de sécurité.",
    perDocumentMax: "Versions par document",
    limitHint:
      "Cette limite s’applique à chaque document ; tous les documents partagent le plafond de {accountMax} versions du compte. La réduire supprime immédiatement les plus anciennes versions.",
    mcpEnabled: "Conserver l’historique MCP complet",
    mcpEnabledHint:
      "Si cette option est désactivée, les écritures de l’Agent conservent quand même le dernier instantané de sécurité. Il compte dans les limites de versions.",
    loading: "Chargement des paramètres d’historique…",
    loadFailed: "Impossible de charger les paramètres d’historique",
    save: "Enregistrer",
    saved: "Paramètres enregistrés",
    saveFailed: "Impossible d’enregistrer. Réessayez.",
  },
  invitations: {
    title: "Récompenses d’invitation",
    headline: "Invitez un ami : chacun reçoit {reward}",
    description:
      "Lorsqu’un ami s’inscrit avec votre lien personnel, vos deux comptes gagnent définitivement {reward} de stockage cloud.",
    copyLink: "Copier le lien d’invitation",
    copied: "Copié",
    successful: "Invitations réussies",
    earned: "Gagné par invitation",
    totalBonus: "Stockage bonus total",
    note: "Les récompenses sont accordées à la création du nouveau compte, dans la limite de {limit} par compte. Un compte existant ne peut pas les réclamer ni les recevoir plusieurs fois.",
    loading: "Chargement des invitations…",
    loadFailed: "Impossible de charger les invitations",
  },
  dashboard: {
    greeting: "Bonjour, {name}",
    subtitle: "Voici votre tableau de bord d'écriture.",
    newDoc: "Nouveau document",
    account: "Compte",
    username: "Nom d'utilisateur",
    notSet: "Non défini",
    joinedAt: "Inscrit le",
    loading: "Chargement…",
    loginRequired: "Veuillez vous connecter",
    loginRequiredHint:
      "Vous devez vous connecter pour accéder aux pages de votre compte.",
    goLogin: "Aller à la connexion",
  },
  aiSettings: {
    title: "Paramètres IA",
    subtitle:
      "Gérez les credits IA, vos canaux LLM et l’accès MCP aux documents au même endroit.",
  },
  documentsPage: {
    title: "Mes documents",
    subtitle:
      "Consultez vos documents ou importez du Markdown, des dossiers et des archives ZIP.",
    emptyHint:
      "Aucun document cloud. Importez du contenu existant ou créez votre premier document.",
    emptyLinkText: "Créer votre premier document",
  },
  search: {
    button: "Rechercher",
    title: "Rechercher dans tous les documents",
    placeholder: "Titres et contenu…",
    hint: "Appuyez sur ⌘K / Ctrl+K",
    quickOpenTitle: "Ouvrir rapidement un document",
    quickOpenPlaceholder: "Saisissez un titre pour accéder au document…",
    quickOpenHint: "Appuyez sur ⌘P / Ctrl+P",
    quickOpenEmpty: "Aucun document à ouvrir.",
    quickOpenMore:
      "D’autres documents correspondent ; continuez à saisir pour affiner",
    startTyping:
      "Saisissez un mot-clé pour rechercher dans vos titres et votre contenu Markdown.",
    noResults: "Aucun document correspondant.",
    loadFailed: "La recherche a échoué. Réessayez.",
    titleMatch: "Titre",
    contentMatch: "Contenu",
  },
  keyboardShortcuts: {
    title: "Raccourcis clavier",
    description:
      "Recherchez, naviguez et modifiez vos documents depuis le clavier.",
    close: "Fermer les raccourcis clavier",
    or: "ou",
    searchAndNavigation: "Recherche et navigation",
    documents: "Documents",
    panels: "Panneaux",
    editing: "Édition",
    panelHint:
      "Les raccourcis des panneaux fonctionnent hors des champs de saisie. Dans l’éditeur, ⌘/Ctrl+B met toujours le texte en gras.",
    actions: {
      showKeyboardShortcuts: "Afficher les raccourcis clavier",
      searchDocuments: "Rechercher des documents",
      quickOpen: "Ouvrir rapidement un document",
      searchAllDocuments: "Rechercher dans tous les documents",
      findInDocument: "Rechercher dans le document actuel",
      previousDocument: "Onglet de document précédent",
      nextDocument: "Onglet de document suivant",
      selectTab: "Accéder à l’onglet 1–9",
      newDocument: "Nouveau document",
      saveDocument: "Enregistrer maintenant",
      closeDocument: "Fermer le document actuel",
      toggleDocumentsPanel: "Afficher ou masquer les documents",
      toggleOutlinePanel: "Afficher ou masquer le plan",
      undo: "Annuler",
      redo: "Rétablir",
      bold: "Gras",
      italic: "Italique",
    },
  },
  transfer: {
    importButton: "Importer des fichiers",
    importFolderButton: "Importer un dossier",
    exportButton: "Tout exporter",
    importing: "Importation des documents et images…",
    exporting: "Création de l’archive…",
    importSuccess: "{count} documents importés.",
    importGifFlattened:
      "{count} GIF de plus de 10 Mo ont été convertis en images WebP statiques ; l’animation n’a pas été conservée.",
    exportSuccess: "L’archive de migration est prête.",
    importFailed:
      "Échec de l’import. Vérifiez le format, la taille des images et le quota.",
    unsupportedImportFormat:
      "{filename} n’est pas pris en charge. Choisissez un fichier Markdown (.md) ou une archive ZIP de migration Koinote.",
    importTooManyFiles:
      "Vous pouvez importer jusqu’à 1 000 fichiers à la fois. Fractionnez l’importation et réessayez.",
    importTooLarge:
      "L’importation dépasse la limite de 250 Mo. Fractionnez-la et réessayez.",
    importDocumentTooLarge:
      "{filename} dépasse la limite de 1 Mo par document Markdown.",
    importImageTooLarge:
      "Les dimensions de {filename} sont trop grandes pour une compression sûre dans le navigateur.",
    exportFailed: "Échec de l’export. Réessayez.",
    importHint:
      "Prend en charge les fichiers .md, les dossiers et les archives ZIP ; les images référencées sont aussi migrées.",
  },
  trashPage: {
    title: "Corbeille",
    subtitle:
      "Les documents sont conservés 30 jours et continuent d’occuper l’espace cloud.",
    backToDocuments: "Retour aux documents",
    empty: "La corbeille est vide.",
    deletesOn: "Suppression définitive le {date}",
    restore: "Restaurer",
    deletePermanently: "Supprimer définitivement",
    permanentWarning:
      "La suppression définitive efface aussi l’historique et ne peut pas être annulée. Continuer ?",
    typeToConfirm:
      "Saisissez « {title} » pour confirmer la suppression définitive :",
    loadFailed: "Impossible de charger la corbeille. Réessayez.",
    actionFailed: "L’action a échoué. Veuillez réessayer.",
  },
  invitationsPage: {
    title: "Inviter des amis",
    subtitle:
      "Partagez votre lien personnel et suivez vos invitations et récompenses.",
  },
  feedback: {
    menuLabel: "Commentaires",
    title: "Partagez votre avis",
    description:
      "Signalez un bug ou suggérez une amélioration d’expérience. Chaque message est consulté dans l’administration.",
    categoryLabel: "Type de commentaire",
    categoryBug: "Bug",
    categoryExperience: "Expérience",
    messageLabel: "Votre commentaire",
    messagePlaceholder: "Décrivez ce qui s’est passé et ce que vous attendiez…",
    privacyHint:
      "Le commentaire est lié à votre compte et inclut la page actuelle ainsi que les informations client. Après suppression du compte, ces données sont dissociées du compte et conservées pour le diagnostic et l’amélioration du produit.",
    discardConfirm:
      "Ce commentaire n’a pas été envoyé. Abandonner le texte saisi ?",
    cancel: "Annuler",
    close: "Fermer la fenêtre de commentaires",
    submit: "Envoyer",
    submitting: "Envoi…",
    submitFailed: "Impossible d’envoyer le commentaire. Réessayez.",
    successTitle: "Commentaire reçu",
    successDescription: "Merci. Nous allons examiner votre message.",
    done: "Terminer",
  },
  admin: {
    title: "Administration",
    subtitle:
      "Suivez la croissance, les membres, les revenus et l’activité du site.",
    refresh: "Actualiser",
    loading: "Chargement des indicateurs…",
    loginRequired: "Connectez-vous d’abord avec un compte administrateur.",
    goLogin: "Se connecter",
    forbidden: "Cette page est réservée aux administrateurs.",
    loadFailed: "Impossible de charger les indicateurs. Réessayez plus tard.",
    tabOverview: "Vue d’ensemble",
    tabGrowth: "Croissance et rétention",
    tabRevenue: "Revenus et commandes",
    tabUsers: "Utilisateurs",
    tabServer: "Serveur",
    tabAnnouncements: "Annonces",
    tabFeedback: "Commentaires",
    feedbackTitle: "Commentaires utilisateurs",
    feedbackSubtitle:
      "Signalements de bugs et suggestions d’expérience par ordre d’envoi.",
    feedbackLoading: "Chargement des commentaires…",
    feedbackLoadFailed: "Impossible de charger les commentaires. Réessayez.",
    feedbackEmpty: "Aucun commentaire n’a encore été envoyé.",
    feedbackLoadMore: "Charger plus",
    feedbackLoadingMore: "Chargement…",
    feedbackBug: "Bug",
    feedbackExperience: "Expérience",
    feedbackFrom: "Envoyé par",
    feedbackPage: "Page source",
    feedbackSubmittedAt: "Envoyé le",
    feedbackUserAgent: "Informations client",
    serverStatusLoading: "Chargement de l’état du serveur…",
    serverStatusLoadFailed:
      "Impossible de charger l’état du serveur. Réessayez plus tard.",
    serverStatusUnavailable:
      "Cet environnement n’expose pas les indicateurs de l’hôte Linux. Si ce message apparaît en production, vérifiez les montages de supervision en lecture seule.",
    serverStatusTitle: "État du serveur",
    serverStatusSubtitle:
      "Utilisation des ressources de l’ensemble du serveur Linux.",
    serverStatusAutoRefresh: "Actualisation toutes les 30 secondes",
    serverResources: "Vue d’ensemble des ressources",
    serverCPU: "CPU du serveur",
    serverMemoryUsage: "Utilisation mémoire",
    serverDiskUsage: "Utilisation disque",
    serverUptime: "Durée de fonctionnement",
    notAvailable: "Indisponible",
    notConfigured: "Non configuré",
    uptimeValue: "{days} j {hours} h {minutes} min",
    serverCPUHint:
      "Le CPU représente l’utilisation globale du serveur ; 100 % signifie que tous les cœurs logiques sont occupés.",
    serverLoad: "Charge système",
    logicalCPUs: "CPU logiques",
    load1: "Charge sur 1 minute",
    load5: "Charge sur 5 minutes",
    load15: "Charge sur 15 minutes",
    loadHint:
      "Comparez la charge moyenne au nombre de CPU logiques ; une valeur durablement supérieure indique généralement une file d’attente.",
    serverMemoryStorage: "Mémoire et stockage",
    memoryTotal: "Mémoire physique",
    memoryAvailable: "Mémoire disponible",
    swapUsage: "Utilisation du swap",
    diskAvailable: "Espace disque disponible",
    serverNetwork: "Trafic réseau principal",
    networkUnavailable:
      "Impossible d’identifier l’interface réseau principale du serveur.",
    downloadRate: "Réception actuelle",
    uploadRate: "Envoi actuel",
    receivedTotal: "Total reçu",
    sentTotal: "Total envoyé",
    networkInterface: "Interface : {interface}",
    serverGeneratedAt: "Indicateurs serveur actualisés à {time}",
    today: "Aujourd’hui",
    trafficUnavailable: "Les indicateurs Cloudflare sont indisponibles",
    trafficNotConfigured:
      "Aucun jeton Analytics en lecture seule n’est configuré. Les données métier restent disponibles.",
    trafficUpstreamError:
      "Cloudflare Analytics est inaccessible. Les données métier restent disponibles.",
    trafficNote:
      "Les UV et PV proviennent de Cloudflare HTTP Analytics et peuvent inclure des robots légitimes et du trafic automatisé autorisé.",
    pageViews: "Pages vues",
    uniqueVisitors: "Visiteurs uniques",
    requests: "Requêtes HTTP",
    bandwidth: "Bande passante edge",
    newUsers: "Nouveaux utilisateurs",
    newMembers: "Nouveaux membres",
    orders: "Commandes",
    overview: "Indicateurs métier cumulés",
    totalUsers: "Utilisateurs",
    verifiedUsers: "Utilisateurs vérifiés",
    lifetimeMembers: "Membres à vie",
    conversionRate: "Conversion membres",
    documents: "Documents",
    images: "Objets image",
    storageUsed: "Stockage utilisé",
    totalOrders: "Commandes totales",
    revenue: "Revenus par devise",
    noRevenue: "Aucun paiement finalisé.",
    todayRevenue: "Revenus du jour",
    orderCount: "{count} commandes",
    trend: "30 derniers jours",
    trendHint:
      "Nouveaux utilisateurs, membres et commandes par jour dans le fuseau du site.",
    recentUsers: "Utilisateurs récents",
    recentPayments: "Paiements récents",
    noUsers: "Aucun utilisateur.",
    noPayments: "Aucun paiement.",
    deletedAccount: "Compte supprimé",
    user: "Utilisateur",
    status: "Statut",
    client: "Dernier client",
    webClient: "Web",
    desktopClient: "Application de bureau",
    clientUnknown: "Aucune activité",
    joinedAt: "Inscription",
    verified: "E-mail vérifié",
    unverified: "E-mail non vérifié",
    free: "Gratuit",
    lifetime: "À vie",
    amount: "Montant",
    paidAt: "Paiement",
    generatedAt: "Mis à jour {time} · {timeZone}",
    funnel: "Entonnoir produit",
    funnelHint:
      "Seuls les premiers jalons sont comptés ; aucun contenu, titre, terme de recherche ou nom de fichier n’est enregistré.",
    registered: "Inscription",
    firstDocument: "Premier document",
    firstUpload: "Premier envoi",
    firstExport: "Premier export",
    mcpConnected: "MCP connecté",
    checkoutStarted: "Checkout démarré",
    checkoutCompleted: "Paiement terminé",
    retention: "Rétention",
    retentionHint:
      "Taux D1 / D7 / D30 exacts selon la date UTC d’inscription, après le début du suivi.",
    day1Retention: "Rétention D1",
    day7Retention: "Rétention D7",
    day30Retention: "Rétention D30",
    retentionSample: "{returned} / {eligible} utilisateurs",
    announcementsTitle: "Annonces intégrées",
    announcementsSubtitle:
      "Informez tous les utilisateurs connectés ; Koinote génère automatiquement les versions française, anglaise, chinoise et japonaise.",
    announcementSourceLanguage: "Langue source",
    announcementTitleLabel: "Titre",
    announcementSummaryLabel: "Résumé",
    announcementHighlightsLabel: "Points clés",
    announcementHighlightsPlaceholder: "Un point par ligne, 8 au maximum",
    announcementTranslationNote:
      "Lors de la publication, le LLM côté serveur traduit les autres langues sans modifier le texte source.",
    announcementTranslationUnavailable:
      "Le service de traduction des annonces n’est pas configuré ; la publication manuelle est indisponible.",
    announcementTranslationFailed:
      "La traduction a échoué et aucune annonce n’a été publiée. Réessayez plus tard.",
    announcementPublish: "Traduire et publier",
    announcementPublishing: "Traduction…",
    announcementPublishSuccess:
      "Annonce publiée. Elle apparaîtra à la prochaine ouverture de Koinote.",
    announcementPublishFailed:
      "Impossible de publier l’annonce. Vérifiez le contenu et réessayez.",
    announcementContentInvalid:
      "Le titre, le résumé ou les points clés dépassent la longueur autorisée. Vérifiez le contenu et réessayez.",
    announcementHighlightTooLong:
      "Chaque point clé peut contenir au maximum 500 caractères.",
    announcementHistory: "Annonces récentes",
    announcementHistoryEmpty: "Aucune annonce publiée pour le moment.",
    announcementLoadFailed: "Impossible de charger les annonces.",
    announcementKindRelease: "Version",
    announcementKindManual: "Annonce manuelle",
    announcementWithdraw: "Retirer",
    announcementWithdrawConfirm:
      "Retirer cette annonce ? Les utilisateurs ne la verront plus, mais son historique sera conservé dans l’administration.",
    announcementWithdrawFailed:
      "Impossible de retirer l’annonce. Réessayez plus tard.",
    announcementWithdrawn: "Retirée",
  },
  announcements: {
    releaseBadge: "Nouveautés de Koinote {version}",
    manualBadge: "Annonce",
    viewChangelog: "Voir le journal complet",
    acknowledge: "Compris",
    close: "Fermer l’annonce",
    markReadFailed:
      "Koinote n’a pas pu enregistrer la lecture. Vous pouvez fermer cette annonce et réessayer plus tard.",
  },
  documentTemplates: {
    eyebrow: "Commencer par une structure",
    title: "Créer depuis un modèle",
    subtitle:
      "Choisissez une trame adaptée puis modifiez-la librement. Le modèle est copié dans un document Markdown normal.",
    close: "Fermer les modèles",
    blankTitle: "Document vierge",
    blankDescription:
      "Commencez par une page vide et construisez votre propre structure.",
    freeBadge: "Gratuit",
    memberBadge: "À vie",
    upgradeHint: "Passez membre à vie pour utiliser ce modèle",
    localModeLocked:
      "Connectez-vous avec un compte à vie pour utiliser ce modèle",
    sourceNote:
      "Inspiré de structures Markdown GitHub bien notées et sous licences claires, puis réécrit pour Koinote.",
    createFailed: "Le document n’a pas pu être créé. Réessayez.",
    categories: {
      everyday: "Travail quotidien",
      management: "Objectifs et pilotage",
      writing: "Écriture et recherche",
      product: "Produit et projets",
      technical: "Décisions techniques",
    },
    templates: {
      "meeting-notes": {
        name: "Compte rendu",
        description:
          "Transformez la discussion en décisions, responsables et actions suivies.",
      },
      "daily-note": {
        name: "Note quotidienne",
        description:
          "Réunissez priorités, observations, idées et bilan de la journée.",
      },
      "weekly-review": {
        name: "Plan et bilan hebdomadaire",
        description:
          "Planifiez trois résultats et terminez la semaine par un bilan concret.",
      },
      "todo-list": {
        name: "Liste de tâches",
        description:
          "Gérez trois priorités, la collecte, les contextes, les délégations et la clôture quotidienne.",
      },
      table: {
        name: "Tableau polyvalent",
        description:
          "Définissez les champs puis organisez données, vues, synthèses et historique des changements.",
      },
      "daily-report": {
        name: "Rapport quotidien",
        description:
          "Présentez résultats, indicateurs, blocages, collaborations et plan du lendemain.",
      },
      "weekly-report": {
        name: "Rapport hebdomadaire",
        description:
          "Résumez résultats, écarts, risques, apprentissages et objectifs de la semaine suivante.",
      },
      okr: {
        name: "Plan et bilan OKR",
        description:
          "Reliez la stratégie aux objectifs, KR mesurables, niveaux de confiance et scores de fin de cycle.",
      },
      kpi: {
        name: "Suivi des KPI",
        description:
          "Définissez formules, sources, cibles, garde-fous, seuils d’alerte et actions correctives.",
      },
      "article-outline": {
        name: "Plan d’article",
        description:
          "Structurez public, titres, accroche, preuves, contenu, appel à l’action et vérification.",
      },
      "project-readme": {
        name: "README de projet",
        description:
          "Présentez valeur, démarrage, usage, architecture, feuille de route et contribution.",
      },
      "product-requirements": {
        name: "Exigences produit",
        description:
          "Définissez problème, périmètre, récits, critères, indicateurs et lancement.",
      },
      "research-paper": {
        name: "Lecture scientifique",
        description:
          "Consignez méthode, preuves, limites, liens et travaux à poursuivre.",
      },
      "decision-record": {
        name: "Registre de décision",
        description:
          "Conservez contexte, options, compromis, conséquences et validation.",
      },
      "technical-design": {
        name: "Conception technique",
        description:
          "Couvrez interfaces, données, cohérence, sécurité, capacité, migration et tests.",
      },
    },
  },
  editor: {
    placeholder:
      "Commencez à écrire… tapez « # » pour un titre, « - » pour une liste, « ``` » pour un bloc de code",
    saving: "Enregistrement…",
    saved: "Enregistré",
    charCount: "{n} caractères",
    saveFailed: "Échec de l'enregistrement",
    saveFailedBackedUp: "Brouillon sauvegardé",
    saveBackupFailed: "Sauvegarde impossible ; copiez le texte immédiatement",
    retrySave: "Réessayer",
    remoteUpdated:
      "Les dernières modifications d’un autre appareil ont été appliquées",
    remoteUpdateAvailable:
      "Une version cloud plus récente est disponible. Votre brouillon local ne sera pas écrasé.",
    reviewRemoteUpdate: "Examiner les modifications",
    resolveConflict: "Résoudre le conflit",
    conflictTitle: "Ce document a été modifié ailleurs",
    conflictDescription:
      "Votre brouillon local est à gauche et la dernière version cloud à droite. Modifiez la fusion à gauche ou acceptez la version cloud.",
    localDraft: "Brouillon local (modifiable)",
    remoteVersion: "Dernière version cloud",
    useRemote: "Utiliser la version cloud",
    saveMerged: "Enregistrer la fusion",
    conflictLoadFailed:
      "Impossible de charger la version cloud. Votre brouillon local reste enregistré dans ce navigateur.",
    conflictSaveFailed:
      "Le document a encore changé pendant l'enregistrement. Rechargez et fusionnez à nouveau.",
    history: "Historique",
    historyTitle: "Historique des versions",
    historyDescription:
      "Consultez et restaurez les versions actuellement conservées pour ce document.",
    historyEmpty: "Aucune version à restaurer.",
    historyLoadFailed: "Impossible de charger l'historique",
    historyRestoreFailed: "Impossible de restaurer cette version",
    historyConflict:
      "Le document a encore changé. Fermez puis rouvrez l'historique.",
    restoreVersion: "Restaurer cette version",
    historyCompareWith: "Comparer avec",
    historyCurrent: "Version actuelle",
    historyLoadingDiff: "Création du diff…",
    historyNoChanges: "Ces versions sont identiques.",
    historyLinesOmitted: "{n} lignes inchangées ou trop longues masquées",
    historyTitleChanged: "Titre : {before} → {after}",
    historySource: {
      web: "Éditeur web",
      mcp: "Agent MCP",
      restore: "Restauration",
    },
    historySafetySnapshot: "Instantané de sécurité",
    untitled: "Sans titre",
    titlePlaceholder: "Titre du document",
    loginRequired: "Veuillez vous connecter",
    loginRequiredHint: "Connectez-vous pour créer et gérer vos documents",
    goLogin: "Se connecter",
    loading: "Chargement…",
    notFound: "Ce document n'existe pas ou a été supprimé",
    backToList: "Retour aux documents",
    documentsPanel: "Documents",
    outlinePanel: "Plan",
    newDocument: "Nouveau document",
    deleteDocument: "Mettre à la corbeille",
    deleteConfirm:
      "Mettre « {title} » à la corbeille ? Vous pourrez le restaurer pendant 30 jours.",
    deleteSaveFailed:
      "Les dernières modifications n’ont pas pu être enregistrées. Le document n’a pas été supprimé. Vérifiez votre connexion et réessayez.",
    emptyDocuments: "Aucun document — créez-en un ci-dessus",
    emptyOutline: "Tapez « # » pour ajouter un titre ; le plan apparaîtra ici",
    collapsePanel: "Replier le panneau",
    expandPanel: "Déplier le panneau",
    resizeDocuments: "Redimensionner le panneau des documents",
    resizeOutline: "Redimensionner le panneau du plan",
    uploadFailed: "Échec du téléversement de l'image",
    uploadingImages: "Téléversement de {n}…",
    rehostFailed:
      "Certaines images n'ont pas pu être copiées dans votre stockage et pointent toujours vers le site d'origine",
    imageClickToEdit:
      "Cliquez pour modifier le Markdown de l'image (légende et URL)",
    imageMarkdownLabel: "Source Markdown de l'image",
    imageBroken: "Échec du chargement — cliquez pour modifier l'URL",
    imageRetrying: "Chargement de l'image, nouvelle tentative…",
    share: "Partager",
    shareTitle: "Partager ce document",
    shareAccessLink: "Toute personne ayant le lien",
    shareAccessLinkHint:
      "Le lien est aléatoire et indevinable, mais fonctionne pour quiconque l'obtient",
    shareTokenRotated:
      "Un nouveau lien a été généré : la suppression du mot de passe a invalidé immédiatement l'ancien lien. Si vous l'avez déjà envoyé, partagez à nouveau.",
    shareAccessPassword: "Mot de passe requis",
    shareAccessPasswordHint:
      "Les visiteurs doivent saisir un mot de passe, au moins 6 caractères",
    sharePasswordPlaceholder: "Définir un mot de passe d'accès",
    shareEnable: "Activer le partage",
    shareUpdate: "Mettre à jour",
    shareSaving: "Traitement…",
    shareRevoke: "Arrêter le partage",
    shareRevokeConfirm:
      "Les liens existants cesseront immédiatement de fonctionner et une réactivation en créera un nouveau. Continuer ?",
    shareCopyLink: "Copier le lien",
    shareCopied: "Copié",
    shareCopyFailed: "Échec de la copie — sélectionnez le lien manuellement",
    shareNotShared: "Non partagé",
    shareActive: "Partagé",
    shareClose: "Fermer",
    sharedBy: "Partagé par {name}",
    sharedNotFound: "Ce lien est invalide ou a été révoqué",
    sharedPasswordPrompt: "Ce document nécessite un mot de passe",
    sharedPasswordSubmit: "Afficher",
    sharedOpenApp: "À propos de Koinote",
    sharedViews: "{count} lectures",
    copyToMine: "Copier dans mon Koinote",
    copyingToMine: "Copie…",
    copiedToMine: "Copié. Ouverture du document…",
    copyToMineFailed: "Échec de la copie. Vérifiez le quota et les images.",
    loginToCopy: "Se connecter pour copier dans mon Koinote",
    exportLabel: "Exporter",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "Page web (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPrintHint:
      "Enregistrement direct sur ordinateur, texte sélectionnable et recherchable",
    find: {
      button: "Rechercher",
      placeholder: "Rechercher dans ce document…",
      previous: "Résultat précédent",
      next: "Résultat suivant",
      close: "Fermer la recherche",
      noResults: "Aucun résultat",
      resultCount: "{current} / {total}",
    },
    mediaExport: "Exporter vers les médias",
    mediaExportHint: "Adapté à WeChat, Zhihu et Juejin",
    mediaTitle: "Exporter vers une plateforme",
    mediaSubtitle:
      "Choisissez la destination ; nous copierons le format le mieux adapté.",
    mediaPlatformLabel: "Plateforme",
    mediaWechat: "WeChat",
    mediaWechatHint: "Texte enrichi stylé",
    mediaZhihu: "Zhihu",
    mediaZhihuHint: "Texte enrichi adapté",
    mediaJuejin: "Juejin",
    mediaJuejinHint: "Markdown natif",
    mediaCopy: "Copier",
    mediaCopied: "Copié — vous pouvez coller",
    mediaWorking: "Traitement…",
    mediaRichTextNote:
      "La coloration, les légendes et les formules deviennent du texte enrichi. La plateforme peut nettoyer certains styles.",
    mediaMarkdownNote:
      "Copie le Markdown complet avec le titre, prêt à être collé dans Juejin.",
    mediaImagesUnreachable:
      "{n} image(s) pourraient être inaccessibles ({hosts}). Vérifiez l’aperçu après collage.",
    wechatThemeLabel: "Thème",
    wechatGeoExperiment: "Résumé GEO masqué généré par IA",
    wechatGeoExperimentHint:
      "Réservé aux membres. Le résumé est enregistré avec le document et l’export ajoute un séparateur sous le titre. WeChat peut supprimer le texte masqué ou considérer cette mise en page comme non conforme ; aucun effet sur le classement n’est garanti. Le modèle intégré consomme des credits.",
    wechatGeoGenerate: "Générer avec l’IA",
    wechatGeoRegenerate: "Régénérer",
    wechatGeoLoading: "Chargement du résumé enregistré…",
    wechatGeoGenerating: "Génération…",
    wechatGeoSaving: "Enregistrement…",
    wechatGeoLoadFailed:
      "Impossible de charger le résumé enregistré. Réessayez plus tard",
    wechatGeoGenerateFailed:
      "Impossible de générer le résumé. Réessayez plus tard",
    wechatGeoSaveFailed:
      "Impossible d’enregistrer le résumé. Réessayez plus tard",
    wechatGeoStale:
      "L’article a changé. Vous pouvez conserver le résumé enregistré ou le régénérer.",
    wechatGeoPlaceholder:
      "Vérifiez et modifiez le résumé masqué après sa génération par l’IA.",
    themeNone: "Style par défaut",
    tabsLabel: "Documents ouverts",
    closeTab: "Fermer l'onglet",
    newFolder: "Nouveau dossier",
    renameFolder: "Renommer",
    deleteFolder: "Supprimer le dossier",
    deleteFolderConfirm:
      "Supprimer le dossier « {name} » ? Les documents et sous-dossiers seront remontés d'un niveau, pas supprimés.",
    untitledFolder: "Dossier sans titre",
    folderNamePlaceholder: "Nom du dossier",
    dropToRoot: "Déposer ici pour sortir du dossier",
    cannotDropIntoSelf:
      "Impossible de déplacer un dossier dans son sous-dossier",
    newSubfolder: "Nouveau sous-dossier",
    newDocumentHere: "Nouveau document ici",
    treeMenu: "Actions sur l'arborescence",
    organizer: {
      button: "Organiser les documents",
      rootOnly:
        "Inclut les documents à la racine et ceux déjà classés automatiquement. Les dossiers créés ou importés manuellement, ainsi que leur contenu, restent intacts.",
      smartTitle: "Organisation intelligente",
      smartDescription:
        "Classement par mois de création, puis par semaine au-delà de 20 documents, et enfin par date si nécessaire.",
      activityTitle: "Organisation par activité",
      activityDescription:
        "Classement selon la dernière modification, avec subdivision des groupes chargés par mois, semaine ou date.",
      unknownDate: "Date inconnue",
      weekOfMonth: "Semaine {n}",
      activityRecent7: "7 derniers jours",
      activityRecent30: "8–30 jours",
      activityRecent90: "31–90 jours",
      activityInactive: "91–365 jours",
      activityArchive: "Plus d’un an",
      confirmSummary:
        "Déplacer {documents} documents en utilisant environ {folders} dossiers automatiques.",
      upToDate:
        "Les documents correspondent déjà à cette stratégie. Aucune réorganisation n’est nécessaire.",
      cancel: "Annuler",
      apply: "Organiser maintenant",
      organizing: "Organisation…",
      success: "{count} documents organisés",
      partial:
        "{moved} documents organisés ; {failed} n’ont pas pu être déplacés et pourront être réessayés.",
      failed:
        "Échec de l’organisation. Vérifiez le réseau ou le stockage local, puis réessayez.",
    },
    wechatMathConverted: "{n} formule(s) converties en images",
    wechatMathFailed: "{n} formule(s) en échec ; repli sur le source LaTeX",
    wechatMathTemporaryQuotaExceeded:
      "Le stockage temporaire des images de formules est plein. {n} formule(s) utilisent le source LaTeX ; réessayez après l'expiration d'anciennes images exportées.",
    exportFailed: "Échec de l'export",
    exporting: "Export en cours…",
    importedLocalDraft: "Brouillon local importé",
    toolbar: {
      bold: "Gras",
      italic: "Italique",
      strike: "Barré",
      code: "Code en ligne",
      heading1: "Titre 1",
      heading2: "Titre 2",
      heading3: "Titre 3",
      bulletList: "Liste à puces",
      orderedList: "Liste numérotée",
      taskList: "Liste de tâches",
      blockquote: "Citation",
      codeBlock: "Bloc de code",
      link: "Lien",
      linkPrompt: "Saisissez l'URL",
      hint: "Barre de mise en forme",
    },
    sample: `# Bienvenue sur Koinote

Voici un éditeur Markdown WYSIWYG **façon Typora** — rendu en temps réel, sans séparation source/aperçu.

## Essayez ceci

- Tapez \`# \` pour créer un titre
- Tapez \`- \` pour créer une liste
- Tapez \`> \` pour créer une citation
- Tapez trois accents graves pour créer un bloc de code

> Tout est stocké en Markdown fidèle, prêt à exporter à tout moment.

\`\`\`js
function hello(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Fonctionnalité | Prise en charge |
|----------------|-----------------|
| Titre | ✅ |
| Tableau | ✅ |
| Coloration du code | ✅ |

- [x] Listes de tâches prises en charge
- [ ] Quelque chose encore à faire
`,
  },
  common: {
    theme: "Changer de thème",
    language: "Langue",
  },
  changelog: {
    eyebrow: "En amélioration continue",
    title: "Journal des modifications",
    subtitle:
      "Découvrez les nouveautés, améliorations et corrections de chaque version de Koinote.",
    unreleased: "À venir",
    newLabel: "Nouveau",
    sourceLink: "Voir la source sur GitHub",
    sourceNote:
      "Cette page reste synchronisée avec le journal français du dépôt open source.",
    categories: {
      Added: "Ajouts",
      Changed: "Modifications",
      Fixed: "Corrections",
      Security: "Sécurité",
      Deprecated: "Obsolescence",
      Removed: "Suppressions",
    },
  },
  desktopAuth: {
    eyebrow: "Application de bureau",
    title: "Autoriser l’application Koinote",
    description:
      "L’application conserve des copies hors ligne des documents et images sur cet appareil, puis synchronise les modifications au retour du réseau.",
    permissionsTitle: "Après autorisation, l’application peut :",
    permissionDocuments:
      "Lire, créer, organiser, partager et placer vos documents et dossiers dans la corbeille",
    permissionOffline:
      "Conserver les documents, les images en attente et jusqu’à 512 Mo de cache d’images sur cet appareil",
    permissionIdentity:
      "Lire les informations de base du compte actuellement connecté",
    approve: "Autoriser et revenir à l’application",
    cancel: "Annuler",
    signIn: "Se connecter pour continuer",
    invalid:
      "Ce lien d’autorisation est invalide. Revenez dans l’application et réessayez.",
    failed: "L’autorisation n’a pas pu aboutir. Veuillez réessayer.",
  },
  desktopLocalMode: {
    badge: "Mode local",
    title: "Écrire uniquement sur cet appareil",
    description:
      "Aucun compte requis. Les documents et images sont chiffrés sur cet appareil, jamais envoyés, et les fonctions distantes sont désactivées.",
    setupTitle: "Définir un mot de passe local",
    setupDescription:
      "Ce mot de passe chiffre et déverrouille les données locales. Il n’est jamais envoyé et ne peut pas être récupéré.",
    unlockTitle: "Déverrouiller le mode local",
    unlockDescription:
      "Saisissez le mot de passe local pour accéder aux documents de cet appareil.",
    password: "Mot de passe du mode local",
    confirmPassword: "Confirmer le mot de passe",
    passwordHint:
      "Au moins 8 caractères. Il sera redemandé après la fermeture de l’application.",
    create: "Créer et ouvrir le mode local",
    unlock: "Déverrouiller",
    creating: "Création…",
    unlocking: "Déverrouillage…",
    useAccount: "Utiliser un compte Koinote",
    enterLocalMode: "Passer en mode local",
    lock: "Verrouiller le mode local",
    encrypted:
      "Documents, noms de dossiers et images sont chiffrés en AES-GCM avant leur stockage dans SQLite.",
    networkDisabled:
      "Le mode local bloque synchronisation, mises à jour, partage, paiement, MCP et toute autre requête distante.",
    passwordMismatch: "Les mots de passe ne correspondent pas.",
    invalidPassword: "Le mot de passe est incorrect.",
    genericError:
      "Le mode local est indisponible. Redémarrez l’application et réessayez.",
    localSubtitle:
      "Vous êtes en mode local. Les modifications restent sur cet appareil et ne sont pas synchronisées.",
    localStorageTitle: "Stockage entièrement local",
    localStorageDescription:
      "Il n’existe aucune copie cloud ni récupération automatique. Exportez régulièrement une sauvegarde ZIP.",
    trashRetention:
      "Les documents de la corbeille locale ne sont jamais supprimés automatiquement.",
    importTitle: "Importer les données locales",
    importDescription:
      "Après vérification du mot de passe, copiez les documents, dossiers et images référencées vers ce compte. Cette copie reste indépendante.",
    importButton: "Vérifier et importer",
    importing: "Importation…",
    importSuccess:
      "{documents} documents, {folders} dossiers et {images} images importés. Ils suivent maintenant la synchronisation normale.",
    importEmpty: "Le mode local ne contient encore aucun document à importer.",
    importPassword: "Saisissez le mot de passe local",
    importWarning:
      "Une nouvelle importation crée une autre copie indépendante sans écraser la précédente.",
  },
  desktopBilling: {
    successTitle: "Paiement terminé",
    cancelledTitle: "Paiement annulé",
    description:
      "Retour à l’application Koinote. L’application va confirmer cet achat et actualiser automatiquement l’avantage correspondant.",
    openApp: "Ouvrir l’application Koinote",
    invalid:
      "Ce lien de retour de paiement est invalide. Revenez dans l’application et réessayez.",
    dismiss: "Fermer l’état du paiement",
  },
  desktopHome: {
    eyebrow: "Espace de travail",
    welcome: "Bon retour, {name}",
    subtitle:
      "Reprenez là où vous vous étiez arrêté. Les modifications sont d’abord enregistrées sur cet appareil, puis synchronisées en ligne.",
    newDocument: "Nouveau document",
    importDocuments: "Importer du Markdown",
    createFailed: "Impossible de créer le document. Réessayez.",
    loadFailed:
      "Impossible de lire les documents locaux. Redémarrez l’application et réessayez.",
    continueTitle: "Continuer à écrire",
    recentTitle: "Documents récents",
    allDocuments: "Tout afficher",
    updated: "Mis à jour le {date}",
    emptyTitle: "Commencez votre premier document",
    emptyDescription:
      "Créez un document vierge ou ouvrez Mes documents pour importer des fichiers Markdown et des archives ZIP.",
    syncTitle: "État de la synchronisation",
    syncDescription:
      "Les modifications locales sont synchronisées automatiquement en ligne. En cas de conflit, vous choisissez la version à conserver.",
    offlineTitle: "Prêt pour le mode hors ligne",
    offlineDescription:
      "Les documents et images sont conservés sur cet appareil. Vous pouvez coller des images et écrire hors ligne ; elles seront envoyées et remplacées par leurs URL au retour du réseau.",
    documentCount: "{count} documents disponibles localement",
    imageCacheUsage:
      "Images locales {total} ; cache hébergé {cached} / {limit}, en attente {pending}",
    clearImageCache: "Vider le cache d’images hébergées",
    clearingImageCache: "Nettoyage…",
    imageCacheCleared:
      "Le cache d’images a été vidé. Les images seront remises en cache à l’ouverture des documents.",
    imageMaintenanceDelayed:
      "La maintenance des images est retardée. Vos documents sont synchronisés et l’application réessaiera automatiquement.",
  },
  desktopUpdate: {
    check: "Rechercher des mises à jour",
    checking: "Recherche d’une mise à jour",
    checkingDescription:
      "Connexion à GitHub Releases pour obtenir la dernière version.",
    availableTitle: "Mise à jour disponible",
    availableDescription:
      "Koinote {next} est disponible. Vous utilisez la version {current}.",
    downloadAndRestart: "Télécharger et redémarrer",
    downloading: "Téléchargement et installation de la mise à jour",
    currentTitle: "Koinote est à jour",
    currentDescription: "Ce client utilise déjà la dernière version.",
    failedTitle: "Échec de la mise à jour",
    failedDescription:
      "Le service de mise à jour est indisponible. Vérifiez votre connexion et réessayez.",
    saveFailedDescription:
      "Les modifications actuelles n’ont pas pu être enregistrées en toute sécurité. Copiez le contenu avant de réessayer.",
    retry: "Réessayer",
    later: "Plus tard",
    close: "Fermer",
  },
  desktopSync: {
    synced: "Synchronisé",
    syncing: "Synchronisation",
    offline: "Modification hors ligne",
    pending: "modifications en attente",
    error: "Échec de la synchronisation ; cliquez pour réessayer",
    conflicts: "conflits à résoudre",
    conflictsTitle: "Résoudre les conflits",
    conflictsDescription:
      "Ces documents ont changé localement et dans le cloud. Choisissez la copie à conserver ; aucune ne sera écrasée silencieusement.",
    keepLocal: "Garder la copie locale",
    useCloud: "Utiliser la copie cloud",
    close: "Résoudre plus tard",
    logoutWarning:
      "Cet appareil contient {pending} modifications non synchronisées, dont {conflicts} conflits. Continuer supprimera définitivement ce contenu local. Se déconnecter quand même ?",
    logoutSaveFailed:
      "Les modifications actuelles n’ont pas pu être enregistrées localement ; la déconnexion a été annulée. Réessayez ou copiez le contenu avant de vous déconnecter.",
  },
  footer: {
    tagline:
      "Koinote est un éditeur Markdown en ligne WYSIWYG : rendu au fil de la frappe, images envoyées directement vers votre hébergeur, export et partage en un clic.",
    brandCn: "锦鲤笔记",
    product: "Produit",
    editor: "Éditeur",
    download: "Télécharger l’application",
    pricing: "Tarifs",
    dashboard: "Tableau de bord",
    docsCenter: "Documentation",
    aiGuide: "Guide d’optimisation IA",
    mcpGuide: "Guide MCP",
    versionHistoryGuide: "Guide du versionnage",
    home: "Accueil",
    built: "Nous avons aussi créé",
    company: "Société",
    companyName: "Fomalhaut Labs",
    legal: "Mentions légales",
    privacy: "Politique de confidentialité",
    terms: "Conditions d’utilisation",
    cookies: "Politique de cookies",
    copyright: "Koinote",
    allRightsReserved: "Tous droits réservés",
    contact: "Contact",
    changelog: "Journal des modifications",
  },
  legal: {
    updatedLabel: "Mis à jour le",
    effectiveLabel: "En vigueur le",
    backHome: "Retour à l’accueil",
    relatedTitle: "Textes associés",
    terms: {
      title: "Conditions d’utilisation",
      summary:
        "Ces conditions encadrent votre utilisation de Koinote. En continuant à utiliser le service, vous les acceptez.",
      sections: [
        {
          title: "Acceptation des conditions",
          body: [
            "En accédant à Koinote ou en l’utilisant, vous acceptez d’être lié par ces conditions. Si vous n’en acceptez pas une partie, veuillez cesser d’utiliser le service.",
          ],
        },
        {
          title: "Description du service",
          body: [
            "Koinote fournit l’écriture, le stockage, l’export et le partage de Markdown en ligne.",
          ],
          items: [
            "Édition Markdown WYSIWYG avec sauvegarde automatique",
            "Gestion des documents et des dossiers",
            "Envoi et hébergement d’images",
            "Export en Markdown, HTML, PDF, DOCX et formats adaptés à WeChat, Zhihu et Juejin",
            "Liens de partage en lecture seule, protégés par mot de passe si vous le souhaitez",
          ],
        },
        {
          title: "Votre compte",
          body: [
            "Vous êtes responsable de toute activité sur votre compte, y compris de la protection de votre mot de passe et de vos sessions. Si vous pensez que votre compte est compromis, contactez-nous rapidement.",
          ],
          items: [
            "Ne pas s’inscrire sous l’identité d’autrui",
            "Ne pas partager vos identifiants",
            "Signaler les problèmes de sécurité de manière responsable plutôt que de les exploiter publiquement",
          ],
        },
        {
          title: "Vos contenus",
          body: [
            "Les documents que vous écrivez et les images que vous envoyez restent les vôtres. Nous n’en revendiquons aucune propriété et ne les utilisons pas à des fins étrangères au fonctionnement du service.",
            "Pour faire fonctionner le service, nous devons stocker, transmettre et afficher ces contenus dans la mesure nécessaire : écrire les documents en base, placer les images dans le stockage objet, et les montrer aux visiteurs lorsque vous activez le partage.",
          ],
        },
        {
          title: "Usage acceptable",
          body: [
            "Les comportements suivants peuvent entraîner une suspension ou une résiliation.",
          ],
          items: [
            "Envoyer ou partager des contenus illicites, y compris contrefaisants",
            "Utiliser l’hébergement d’images comme service général de distribution de fichiers ou de hotlinking",
            "Contourner les quotas par automatisation, ou effectuer des tests de charge sur le service",
            "Tenter d’accéder sans autorisation aux documents ou liens de partage d’autrui",
          ],
        },
        {
          title: "Liens de partage",
          body: [
            "Une fois le partage activé, toute personne disposant du lien peut consulter le document sans se connecter. Un mot de passe ajoute une protection, mais un lien divulgué équivaut à un document divulgué : jugez vous-même de ce qu’il est approprié de partager.",
            "Vous pouvez révoquer le partage ou régénérer le lien à tout moment ; les anciens liens cessent immédiatement de fonctionner.",
          ],
        },
        {
          title: "Disponibilité",
          body: [
            "Nous visons la stabilité mais ne garantissons pas un accès ininterrompu. Maintenances, mises à niveau et pannes de tiers peuvent provoquer des indisponibilités temporaires. Conservez une sauvegarde exportée de ce qui compte.",
          ],
        },
        {
          title: "Accès à vie",
          body: [
            "« À vie » désigne un statut membre payé une seule fois, sans renouvellement et non transférable, tant que votre compte et le service Koinote existent. Ce n’est pas une promesse d’exploitation perpétuelle du service.",
            "L’offre inclut actuellement 10 Go fixes de stockage cloud partagés entre documents et images ; les bonus d’invitation sont distincts. Aucune augmentation automatique future de ce quota de base n’est promise.",
            "Les avantages IA futurs signifient une éligibilité membre si et quand les fonctions concernées sont lancées. Aucune date, fonction, modèle ou fournisseur n’est garanti, et cela ne signifie pas une inférence gratuite illimitée. Des limites raisonnables d’usage, de coût, de région, de modèle ou de fournisseur peuvent s’appliquer et seront précisées au lancement.",
            "La suppression du compte met immédiatement fin au statut membre. Elle ne déclenche pas automatiquement de remboursement, sans limiter les droits légaux au remboursement ou ceux du consommateur.",
          ],
        },
        {
          title: "Résiliation",
          body: [
            "Nous pouvons suspendre ou résilier l’accès en cas d’abus, de fraude, de risque de sécurité ou de violation de ces conditions. Vous pouvez cesser d’utiliser le service à tout moment.",
            "Les documents passent d’abord par une corbeille de 30 jours. Les images associées ne sont supprimées en arrière-plan qu’après suppression définitive ou expiration, si aucun autre document ne les référence.",
          ],
        },
        {
          title: "Avertissement et limitation de responsabilité",
          body: [
            "Le service est fourni « en l’état ». Dans la limite maximale permise par la loi applicable, nous ne sommes pas responsables des pertes indirectes, pertes de données ou pertes de profits résultant de l’utilisation ou de l’impossibilité d’utiliser le service.",
          ],
        },
        {
          title: "Modification des conditions",
          body: [
            "Nous pouvons mettre à jour ces conditions. Les changements substantiels seront reflétés par la date de mise à jour de cette page ; l’usage continu vaut acceptation.",
          ],
        },
        {
          title: "Contact",
          body: [
            "Les questions sur ces conditions peuvent être envoyées à cfjwlchangji@gmail.com.",
          ],
        },
      ],
    },
    privacy: {
      title: "Politique de confidentialité",
      summary:
        "Cette politique explique quelles informations Koinote collecte, pourquoi, comment elles sont utilisées et protégées, et comment vous pouvez les contrôler.",
      sections: [
        {
          title: "Informations collectées",
          body: [
            "Nous ne collectons que ce qui est nécessaire pour fournir le service.",
          ],
          items: [
            "Données de compte : e-mail, nom d’utilisateur, nom affiché et mot de passe haché",
            "En cas de connexion sociale, le profil de base renvoyé par Google ou GitHub (e-mail, nom d’utilisateur, avatar)",
            "Vos contenus : titres et corps des documents, arborescence des dossiers, images envoyées",
            "Paramètres de partage : jetons de partage et mots de passe d’accès hachés",
            "Commentaires des utilisateurs : texte du commentaire, page source et informations client",
            "Journaux d’exploitation : horodatage, IP et User-Agent, nécessaires au débogage et à la lutte contre les abus",
            "Mesures produit internes : date du premier accomplissement pour l’inscription, le premier document, l’envoi d’image, l’export, l’appel MCP et le paiement ; au plus une date d’activité par compte et par jour ; les pages partagées ne conservent qu’un compteur agrégé de lectures",
          ],
        },
        {
          title: "Ce que nous ne collectons pas",
          body: [
            "Aucun SDK publicitaire ni d’analyse comportementale tierce. Nous n’établissons pas de profil publicitaire et n’utilisons pas le contenu de vos documents pour entraîner des modèles. Les mesures produit ne stockent jamais les titres, le corps des documents, les recherches, les noms de fichiers importés ni l’identité des lecteurs d’un partage.",
          ],
        },
        {
          title: "Utilisation des informations",
          body: [
            "Les informations collectées servent uniquement aux finalités suivantes.",
          ],
          items: [
            "Fournir les fonctions essentielles : sauvegarde et synchronisation des documents, hébergement des images, génération des liens de partage",
            "Vous authentifier et maintenir votre session",
            "Diagnostiquer les pannes et prévenir les abus ou attaques",
            "Comprendre de façon agrégée l’inscription, la première création, l’envoi d’image, l’export, MCP, la conversion de paiement et la rétention J1/J7/J30",
            "Répondre lorsque vous nous contactez",
          ],
        },
        {
          title: "Lieu de stockage",
          body: [
            "Le corps des documents et les données de compte résident dans notre base PostgreSQL auto-hébergée. Les images résident dans Cloudflare R2 et sont servies via notre Worker, ce qui signifie que les identifiants de stockage ne sont jamais transmis au navigateur.",
          ],
        },
        {
          title: "Tiers",
          body: [
            "Le fonctionnement de Koinote repose sur un petit nombre de fournisseurs d’infrastructure, chacun ne traitant les données que dans son propre rôle.",
          ],
          items: [
            "Cloudflare : CDN, Workers et stockage objet R2",
            "Google et GitHub : vérification d’identité, uniquement si vous choisissez de vous connecter avec eux",
            "Stripe : traitement du paiement de l’abonnement, avec l’adresse e-mail, le montant, la devise et les identifiants de paiement nécessaires au règlement",
            "Feishu : canal facultatif de notification interne des paiements ; seuls l’identifiant utilisateur Koinote, le montant, la devise et les identifiants de commande sont transmis, jamais l’e-mail ni le contenu des documents",
          ],
        },
        {
          title: "Conservation et suppression",
          body: [
            "Les documents passent d’abord par une corbeille de 30 jours ; contenu, versions, images et utilisation du stockage restent conservés. Après suppression définitive ou expiration, les images non référencées ailleurs sont mises en file d’attente de suppression.",
            "Vous pouvez supprimer immédiatement tout le compte depuis le tableau de bord en saisissant l’adresse actuelle puis en confirmant. Le compte, les documents, versions, partages, jetons MCP et le registre d’images sont supprimés ; les images associées sont retirées du stockage objet en arrière-plan. Cette action est irréversible.",
            "Les données de paiement Stripe minimales nécessaires à la fiscalité, aux litiges et à la lutte contre la fraude sont dissociées du compte et conservées conformément à la loi. Les données supprimées présentes dans les sauvegardes expirent avec leur cycle de conservation et ne servent pas à restaurer un compte supprimé.",
            "Le texte des commentaires, la page source et les informations client que vous avez envoyés sont dissociés du compte puis conservés pour le diagnostic et l’amélioration du produit ; ils peuvent toujours contenir les données personnelles que vous avez saisies.",
            "Si vous ne pouvez pas vous connecter ou souhaitez exercer un autre droit légal, contactez-nous à l’adresse ci-dessous.",
          ],
        },
        {
          title: "Sécurité",
          body: [
            "Nous utilisons HTTPS en transit, le stockage haché des mots de passe et l’isolation des permissions en base. Aucun système ne peut être garanti parfaitement sûr : évitez de conserver dans vos notes des éléments très sensibles comme des numéros de carte ou des pièces d’identité.",
          ],
        },
        {
          title: "Vos droits",
          body: [
            "Vous pouvez consulter et modifier les informations du compte, exporter tous les documents, et supprimer des documents ou le compte directement depuis le tableau de bord. Si votre droit local accorde d’autres droits d’accès, de rectification, de portabilité ou d’effacement, vous pouvez les exercer via l’adresse ci-dessous.",
          ],
        },
        {
          title: "Enfants",
          body: [
            "Le service ne s’adresse pas aux enfants de moins de 14 ans. Si nous découvrons un tel compte, nous le supprimons.",
          ],
        },
        {
          title: "Contact",
          body: [
            "Les demandes relatives à la confidentialité peuvent être envoyées à cfjwlchangji@gmail.com.",
          ],
        },
      ],
    },
    cookies: {
      title: "Politique de cookies",
      summary:
        "Cette politique explique quels cookies et quel stockage navigateur Koinote utilise, et à quoi chacun sert.",
      sections: [
        {
          title: "Cookies essentiels",
          body: [
            "Nous utilisons un unique cookie de session pour mémoriser votre connexion. Il est HttpOnly et SameSite, donc illisible par les scripts de la page. Le bloquer rend la connexion impossible.",
          ],
        },
        {
          title: "Stockage local du navigateur",
          body: [
            "Les préférences suivantes sont conservées dans le localStorage de votre navigateur et ne sont jamais envoyées au serveur. Effacer les données du navigateur les réinitialise.",
          ],
          items: [
            "koinote-theme : choix du thème clair ou sombre",
            "koinote-locale : langue de l’interface",
            "Brouillons locaux écrits hors connexion, importés dans votre compte après connexion",
          ],
        },
        {
          title: "Ce que nous n’utilisons pas",
          body: [
            "Pas de cookies publicitaires, pas de pixels de suivi intersites, pas de scripts d’analyse comportementale tiers.",
          ],
        },
        {
          title: "Cookies tiers",
          body: [
            "Choisir de se connecter avec Google ou GitHub vous redirige vers leur site, qui peut déposer ses propres cookies. Cela relève de leurs politiques de confidentialité respectives.",
          ],
        },
        {
          title: "Gérer les cookies",
          body: [
            "La plupart des navigateurs permettent d’inspecter, bloquer ou supprimer les cookies. Notez que bloquer le cookie de session vous empêchera de rester connecté.",
          ],
        },
        {
          title: "Contact",
          body: [
            "Les questions sur les cookies peuvent être envoyées à cfjwlchangji@gmail.com.",
          ],
        },
      ],
    },
  },
  errors: {
    bad_request: "Requête invalide",
    feedback_category_invalid: "Choisissez Bug ou Expérience.",
    feedback_message_required: "Saisissez votre commentaire.",
    feedback_message_invalid:
      "Le commentaire contient des caractères non pris en charge. Supprimez-les puis réessayez.",
    feedback_message_too_long:
      "Le commentaire ne peut pas dépasser 4 000 caractères.",
    feedback_page_invalid:
      "La page actuelle est invalide. Actualisez puis réessayez.",
    missing_fields:
      "Le nom d'utilisateur, l'e-mail et le mot de passe sont tous requis",
    invalid_email: "Format d’e-mail invalide",
    invalid_invitation_code:
      "Ce code d’invitation est invalide. Vérifiez-le puis réessayez",
    email_already_registered: "Cette adresse e-mail est déjà inscrite",
    verification_code_required:
      "Saisissez le code de vérification reçu par e-mail",
    invalid_verification_code: "Le code de vérification est incorrect",
    verification_code_expired: "Le code a expiré. Demandez-en un nouveau",
    verification_attempts_exceeded:
      "Trop de tentatives incorrectes. Demandez un nouveau code",
    verification_rate_limited: "Trop de demandes de code. Réessayez plus tard",
    email_send_failed:
      "Impossible d’envoyer l’e-mail de vérification. Réessayez",
    email_not_verified: "Cette adresse e-mail n’a pas été vérifiée",
    email_already_verified:
      "Cette adresse e-mail est déjà vérifiée. Revenez à la connexion normale",
    password_too_short: "Le mot de passe doit comporter au moins 6 caractères",
    conflict: "L'e-mail ou le nom d'utilisateur est déjà pris",
    invalid_credentials: "Compte ou mot de passe incorrect",
    current_password_incorrect: "Le mot de passe actuel est incorrect",
    password_not_available: "Ce compte ne possède pas de mot de passe Koinote",
    unauthorized: "Non connecté",
    session_expired: "Session expirée",
    server_error: "Erreur serveur, veuillez réessayer plus tard",
    oauth_unsupported: "Fournisseur de connexion non pris en charge",
    oauth_not_configured:
      "Cette méthode de connexion n'est pas encore configurée",
    oauth_denied: "Autorisation annulée",
    oauth_missing_params: "Paramètres de rappel OAuth manquants",
    oauth_invalid_state: "Session de connexion expirée, veuillez réessayer",
    oauth_exchange_failed: "Échec de la connexion, veuillez réessayer",
    oauth_profile_failed:
      "Impossible de lire votre profil auprès du fournisseur",
    oauth_sync_failed:
      "Échec de la synchronisation du compte, veuillez réessayer",
    title_too_long: "Le titre est trop long",
    content_too_large: "Document trop volumineux pour être enregistré",
    pdf_path_must_be_absolute: "Choisissez un emplacement valide pour le PDF",
    pdf_path_must_end_with_pdf:
      "Le nom du fichier PDF doit se terminer par .pdf",
    pdf_parent_directory_missing:
      "Le dossier sélectionné n’existe plus. Choisissez un autre emplacement",
    pdf_path_invalid_unicode:
      "Le chemin contient des caractères non pris en charge. Modifiez le nom ou l’emplacement",
    pdf_output_too_large:
      "Le PDF exporté dépasse 512 Mo. Retirez les grandes images puis réessayez",
    pdf_output_invalid: "Le PDF généré est incomplet. Veuillez réessayer",
    pdf_export_timed_out:
      "L’export PDF a expiré. Réduisez le document ou les images puis réessayez",
    pdf_export_window_missing:
      "La fenêtre du document est indisponible. Rouvrez le document puis réessayez",
    pdf_export_channel_closed:
      "L’export PDF s’est interrompu de façon inattendue. Réessayez",
    pdf_export_unsupported_platform:
      "L’export PDF en un clic n’est pas pris en charge sur ce système",
    image_fetch_rejected: "Cette adresse d'image n'est pas autorisée",
    image_fetch_failed:
      "Impossible de récupérer cette image depuis son site d'origine",
    too_deep:
      "Les dossiers sont trop imbriqués pour en créer un autre à l'intérieur",
    name_too_long: "Nom de dossier trop long",
    invalid_move: "Impossible de déplacer ce dossier ici",
    not_found: "Cet élément n'existe pas ou a été supprimé",
    image_type_unsupported: "Seuls PNG, JPEG, GIF et WebP sont pris en charge",
    image_type_mismatch: "Le contenu du fichier ne correspond pas à son format",
    image_svg_rejected:
      "Les images SVG ne sont pas prises en charge, pour raisons de sécurité",
    image_too_large: "L'image dépasse la limite de 10 Mo",
    image_quota_exceeded:
      "Stockage d'images plein — supprimez définitivement les documents inutiles depuis la corbeille",
    image_upload_failed:
      "Impossible de synchroniser l’image locale. Vérifiez la connexion puis réessayez.",
    document_save_pending:
      "Le brouillon n’est pas encore dans le stockage des documents. Réessayez d’abord de l’enregistrer.",
    image_cache_full:
      "Le cache d’images local est plein. Videz-le depuis l’accueil de l’application.",
    local_image_missing:
      "Une image locale est introuvable. Retirez-la du document puis insérez-la de nouveau.",
    storage_quota_exceeded:
      "Stockage cloud plein — supprimez définitivement les documents inutiles depuis la corbeille",
    image_empty: "L'image est vide",
    share_not_found: "Ce lien est invalide ou a été révoqué",
    share_access_invalid: "Niveau de partage invalide",
    share_password_too_short:
      "Le mot de passe doit comporter au moins 6 caractères",
    desktop_share_sync_required:
      "Le document doit finir sa synchronisation avant le partage. Vérifiez l’état de synchronisation puis réessayez",
    desktop_share_cache_failed:
      "Le partage est actif en ligne, mais son état local n’a pas pu être enregistré. Réappliquez les réglages de partage plus tard",
    share_password_invalid: "Mot de passe incorrect",
    too_many_requests: "Trop de tentatives — veuillez réessayer plus tard",
    insufficient_credits:
      "Credits insuffisants. Achetez-en ou utilisez votre propre canal LLM",
    agent_llm_not_configured: "Le modèle IA intégré n’est pas configuré",
    agent_invalid_response:
      "Le modèle a renvoyé une analyse invalide. Relancez-la",
    agent_provider_error:
      "Le fournisseur a refusé la requête. Vérifiez le modèle et la clé API",
    agent_provider_unavailable:
      "Le fournisseur est temporairement indisponible. Réessayez plus tard",
    agent_review_stale: "Le document a changé. Lancez une nouvelle analyse",
    agent_review_closed: "Cette analyse est déjà fermée",
    agent_review_in_progress: "Une autre analyse est en cours. Patientez",
    invalid_agent_review_source:
      "Le document ou l’analyse source a changé. Relancez d’abord une analyse standard",
    invalid_agent_provider: "Fournisseur de modèle IA invalide",
    invalid_llm_channel_name: "Nom de canal invalide",
    invalid_llm_channel_url: "L’URL de base du canal est invalide ou non sûre",
    invalid_llm_channel_model: "Nom de modèle invalide",
    invalid_llm_channel_api_key: "Clé API invalide",
    llm_channel_not_found: "Canal LLM introuvable",
    llm_channel_limit_reached:
      "Nombre maximal de canaux LLM atteint. Supprimez-en un",
    llm_channel_name_exists: "Un canal porte déjà ce nom",
    credit_billing_not_configured:
      "L’achat de credits n’est pas configuré sur ce déploiement",
  },
};
