import type { Messages } from "./types";

export const fr: Messages = {
  nav: {
    editor: "Éditeur",
    pricing: "Tarifs",
    docs: "Documentation",
    mcpGuide: "Intégration MCP",
    versionHistoryGuide: "Contrôle de version",
    dashboard: "Tableau de bord",
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
        { title: "Limiter les droits", desc: "Créez des jetons en lecture seule ou lecture-écriture, consultables et révocables à tout moment." },
        { title: "Écrire sans écraser", desc: "Chaque modification vérifie la révision du document et signale les conflits." },
        { title: "Garder un point de secours", desc: "Les membres règlent l'historique complet et conservent toujours le dernier instantané de sécurité." },
      ],
      cta: "Voir les avantages membre",
    },
  },
  pricing: {
    eyebrow: "Des tarifs simples et transparents",
    title: "Une mise à niveau, une écriture sereine",
    subtitle: "L'offre gratuite couvre l'écriture quotidienne. L'accès à vie ajoute stockage, MCP et historique en un seul paiement.",
    freeName: "Gratuit",
    freeDescription: "Tout ce qu'il faut pour commencer à écrire et découvrir l'éditeur.",
    freePrice: "Gratuit",
    freePeriod: "Utilisable sans limite de durée",
    lifetimeName: "À vie",
    lifetimeDescription: "Pour l'écriture au long cours et la collaboration avec les agents.",
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
      "Accès aux futures fonctions d'IA",
      "Toutes les fonctions de l'offre gratuite",
    ],
    loginToUpgrade: "Se connecter pour passer membre",
    manageMembership: "Gérer l'abonnement et MCP",
    active: "Votre accès à vie est actif",
    loading: "Chargement des tarifs actuels…",
    loadFailed: "Impossible de charger les tarifs. Réessayez.",
    unavailable: "Le paiement en ligne n'est pas configuré sur ce déploiement.",
    faqTitle: "Questions fréquentes",
    faqs: [
      { question: "Est-ce un abonnement ?", answer: "Non. L'accès à vie est un paiement unique sans renouvellement automatique." },
      { question: "Que permet MCP ?", answer: "Les agents autorisés peuvent rechercher, lire, créer, compléter, modifier, restaurer et mettre des documents à la corbeille. La suppression définitive reste réservée au Web." },
      { question: "Puis-je restaurer après avoir désactivé l'historique MCP complet ?", answer: "Oui. Les écritures Agent des membres conservent toujours au moins le dernier instantané de sécurité." },
      { question: "Les fonctions d'IA sont-elles déjà disponibles ?", answer: "Pas encore. L'accès à vie inclut l'éligibilité aux futures fonctions d'IA lors de leur lancement." },
    ],
  },
  mcpGuide: {
    eyebrow: "Guide d’intégration MCP",
    title: "Autorisez vos agents à travailler avec vos documents",
    subtitle: "Connectez Codex, Claude Code, OpenCode, OpenClaw ou tout client MCP Streamable HTTP compatible à Koinote.",
    overviewTitle: "Fonctionnement",
    overviewBody: "Le modèle est fourni par votre agent. Koinote n’appelle aucun LLM : il gère l’autorisation, les outils documentaires, les conflits et l’audit.",
    setupTitle: "Avant de commencer",
    setupSteps: [
      { title: "Activez l’offre à vie", desc: "MCP est un avantage de l’offre à vie." },
      { title: "Créez un jeton", desc: "Choisissez lecture seule ou lecture/écriture, avec une durée limitée ou permanente." },
      { title: "Configurez le client", desc: "Utilisez la méthode correspondante pour https://koinote.app/mcp." },
    ],
    clientsTitle: "Connexion des agents",
    clientsSubtitle: "Un jeton est un identifiant de compte. Gardez-le dans une variable d’environnement ou un stockage sécurisé, jamais dans Git.",
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
    usageBody: "Aucune syntaxe spéciale n’est requise. Demandez simplement à l’agent d’utiliser Koinote et précisez le document pour les remplacements ou la corbeille.",
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
    subtitle: "Découvrez comment Koinote conserve les versions, coordonne le navigateur et les agents, puis restaure un contenu après une erreur.",
    overviewTitle: "Fonctionnement de l’historique",
    overviewBody: "Les modifications du navigateur et de MCP partagent les mêmes révisions et règles d’historique. Les versions facilitent la récupération, tandis que les révisions empêchent un ancien contenu d’écraser silencieusement le nouveau.",
    availabilityTitle: "Adhésion et limites",
    availabilityBody: "L’historique est réservé aux membres à vie. Chaque document peut conserver 1 à 100 versions, avec une limite commune de 100 pour tout le compte ; les plus anciennes sont supprimées en premier.",
    featuresTitle: "Fonctions principales",
    features: [
      { title: "Instantanés regroupés", desc: "Les modifications web sont regroupées dans le temps au lieu de créer une version à chaque sauvegarde automatique." },
      { title: "Limites flexibles", desc: "Activez ou désactivez l’historique et choisissez de 1 à 100 versions par document." },
      { title: "Instantané de sécurité", desc: "Même sans historique MCP complet, le dernier état récupérable est gardé avant un remplacement par un agent." },
      { title: "Détection des conflits", desc: "Une écriture exige la dernière révision ; une version périmée échoue au lieu d’écraser le contenu récent." },
      { title: "Restauration réversible", desc: "L’état actuel est sauvegardé avant de restaurer une ancienne version." },
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
    safetyBody: "Gardez l’historique et l’historique MCP complet pour les documents importants. Ajustez la limite par document en tenant compte des 100 versions partagées par le compte, et demandez à l’agent de lire la dernière révision avant un remplacement.",
    settingsCta: "Régler l’historique",
    mcpCta: "Voir l’intégration MCP",
    pricingCta: "Voir les avantages",
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
      "Une mise à niveau unique pour plus d'espace d'écriture et l'accès aux futures fonctions d'IA.",
    oneTimePayment: "Paiement unique, valable à vie",
    currencyLabel: "Devise de paiement",
    currencyHint: "Stripe Checkout vous facturera dans la devise sélectionnée.",
    storageBenefit: "10 Go de stockage cloud",
    aiBenefit: "Accès aux futures fonctions d'IA",
    aiComingSoon: "Les fonctions d'IA arriveront plus tard",
    purchase: "Obtenir l'accès à vie",
    redirecting: "Ouverture du paiement sécurisé…",
    activeTitle: "Abonnement à vie débloqué",
    activeDescription:
      "Votre compte bénéficie de 10 Go de stockage cloud et de l'accès futur à l'IA.",
    unavailable:
      "Le paiement des abonnements n'est pas configuré sur ce déploiement.",
    loadFailed: "Impossible de charger le statut de l'abonnement.",
    checkoutSuccess: "Paiement confirmé. Votre abonnement à vie est actif.",
    checkoutPending:
      "Le paiement est encore en cours de confirmation. Vos droits seront mis à jour automatiquement.",
    checkoutCancelled: "Le paiement a été annulé. Vous n'avez pas été débité.",
    checkoutFailed: "Le paiement n'a pas abouti. Veuillez réessayer.",
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
  },
  documentHistorySettings: {
    title: "Historique des versions",
    description: "Choisissez si les documents conservent des versions et comment les écritures Web et Agent sont enregistrées.",
    membersOnly: "L’historique est réservé aux membres à vie. Passez membre pour configurer la conservation.",
    enabled: "Activer l’historique",
    enabledHint: "La désactivation arrête les instantanés Web sans supprimer les versions conservées ; l’Agent garde toujours le dernier instantané de sécurité.",
    perDocumentMax: "Versions par document",
    limitHint: "Cette limite s’applique à chaque document ; tous les documents partagent le plafond de {accountMax} versions du compte. La réduire supprime immédiatement les plus anciennes versions.",
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
  documentsPage: {
    title: "Mes documents",
    subtitle:
      "Consultez et poursuivez l’édition des documents enregistrés dans le cloud.",
    emptyHint: "Aucun document cloud pour l’instant. ",
    emptyLinkText: "Créer votre premier document",
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
    actionFailed:
      "L’action a échoué. Vérifiez le texte de confirmation ou réessayez.",
  },
  invitationsPage: {
    title: "Inviter des amis",
    subtitle:
      "Partagez votre lien personnel et suivez vos invitations et récompenses.",
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
    user: "Utilisateur",
    status: "Statut",
    joinedAt: "Inscription",
    verified: "E-mail vérifié",
    unverified: "E-mail non vérifié",
    free: "Gratuit",
    lifetime: "À vie",
    amount: "Montant",
    paidAt: "Paiement",
    generatedAt: "Mis à jour {time} · {timeZone}",
  },
  editor: {
    placeholder:
      "Commencez à écrire… tapez « # » pour un titre, « - » pour une liste, « ``` » pour un bloc de code",
    saving: "Enregistrement…",
    saved: "Enregistré",
    charCount: "{n} caractères",
    saveFailed: "Échec de l'enregistrement",
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
    historyDescription: "Consultez et restaurez les versions actuellement conservées pour ce document.",
    historyEmpty: "Aucune version à restaurer.",
    historyLoadFailed: "Impossible de charger l'historique",
    historyRestoreFailed: "Impossible de restaurer cette version",
    historyConflict:
      "Le document a encore changé. Fermez puis rouvrez l'historique.",
    restoreVersion: "Restaurer cette version",
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
    exportLabel: "Exporter",
    exportMarkdown: "Markdown (.md)",
    exportHTML: "Page web (.html)",
    exportPDF: "PDF",
    exportDOCX: "Word (.docx)",
    exportPDFHint: "Téléchargement direct ; le texte devient une image",
    exportPrint: "Imprimer / Enregistrer en PDF",
    exportPrintHint:
      "Texte sélectionnable et recherchable — choisissez « Enregistrer au format PDF »",
    mediaExport: "Exporter vers les médias",
    mediaExportHint: "Adapté à WeChat, Zhihu et Juejin",
    mediaTitle: "Exporter vers une plateforme",
    mediaSubtitle: "Choisissez la destination ; nous copierons le format le mieux adapté.",
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
    mediaRichTextNote: "La coloration, les légendes et les formules deviennent du texte enrichi. La plateforme peut nettoyer certains styles.",
    mediaMarkdownNote: "Copie le Markdown complet avec le titre, prêt à être collé dans Juejin.",
    mediaImagesUnreachable: "{n} image(s) pourraient être inaccessibles ({hosts}). Vérifiez l’aperçu après collage.",
    wechatThemeLabel: "Thème",
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
  footer: {
    tagline:
      "Koinote est un éditeur Markdown en ligne WYSIWYG : rendu au fil de la frappe, images envoyées directement vers votre hébergeur, export et partage en un clic.",
    brandCn: "锦鲤笔记",
    product: "Produit",
    editor: "Éditeur",
    pricing: "Tarifs",
    dashboard: "Tableau de bord",
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
            "Journaux d’exploitation : horodatage, IP et User-Agent, nécessaires au débogage et à la lutte contre les abus",
          ],
        },
        {
          title: "Ce que nous ne collectons pas",
          body: [
            "Aucun SDK publicitaire ni d’analyse comportementale tierce. Nous ne établissons pas de profil publicitaire et n’utilisons pas le contenu de vos documents pour entraîner des modèles.",
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
            "Pour supprimer l’intégralité de votre compte et de ses données, écrivez-nous.",
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
            "Vous pouvez consulter et modifier les informations de votre compte, exporter tous vos documents, et supprimer des documents ou votre compte à tout moment. Si votre droit local vous accorde des droits d’accès, de rectification, de portabilité ou d’effacement, vous pouvez les exercer via l’adresse ci-dessous.",
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
    storage_quota_exceeded:
      "Stockage cloud plein — supprimez définitivement les documents inutiles depuis la corbeille",
    image_empty: "L'image est vide",
    share_not_found: "Ce lien est invalide ou a été révoqué",
    share_access_invalid: "Niveau de partage invalide",
    share_password_too_short:
      "Le mot de passe doit comporter au moins 6 caractères",
    share_password_invalid: "Mot de passe incorrect",
    too_many_requests: "Trop de tentatives — veuillez réessayer plus tard",
  },
};
