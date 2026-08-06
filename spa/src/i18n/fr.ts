import type { Messages } from "./types";

export const fr: Messages = {
  nav: {
    editor: "Éditeur",
    dashboard: "Tableau de bord",
    login: "Se connecter",
    logout: "Se déconnecter",
    userMenu: "Menu du compte",
  },
  home: {
    badge: "Markdown × IA, conçu pour l'écriture",
    title: "L'écriture, sous sa forme la plus pure",
    subtitle:
      "Koinote est un éditeur Markdown en ligne façon Typora. Rendu en temps réel, images intégrées et IA à vos côtés — pour vous concentrer sur le contenu.",
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
        title: "L'IA pour les créateurs",
        desc: "Continuer, peaufiner, traduire, illustrer — l'assistant latéral est toujours disponible.",
      },
      {
        title: "Export et partage faciles",
        desc: "Export Markdown / HTML d'origine. Partage par lien en lecture seule en un clic.",
      },
      {
        title: "Sauvegarde automatique",
        desc: "Sauvegardé au fil de la frappe, jamais de perte. Synchro cloud multi-appareils (abonnement).",
      },
    ],
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
  },
  storage: {
    title: "Stockage cloud",
    documents: "Documents",
    images: "Images",
    usedOf: "{used} sur {quota} utilisés",
    remaining: "{remaining} restants",
    nearLimitHint:
      "Il vous reste peu d'espace cloud. Supprimer les documents dont vous n'avez plus besoin en libérera.",
    fullHint:
      "Le stockage cloud est plein : impossible d'enregistrer de nouveaux documents ou images. Supprimez les documents inutiles pour libérer de l'espace.",
    loading: "Chargement…",
    loadFailed: "Impossible de charger l'utilisation du stockage",
    quotaDialogTitle: "Stockage cloud plein",
    quotaDialogBody:
      "Vous avez utilisé {used} sur {quota} de stockage cloud, l'opération n'a donc pas abouti.",
    quotaDialogHint:
      "Supprimer les documents dont vous n'avez plus besoin libérera de l'espace — leurs images sont nettoyées par une tâche de fond, généralement en quelques minutes.",
    quotaDialogDismiss: "J'ai compris",
    quotaDialogManage: "Voir l'utilisation",
  },
  dashboard: {
    greeting: "Bonjour, {name}",
    subtitle: "Voici votre tableau de bord d'écriture.",
    newDoc: "Nouveau document",
    account: "Compte",
    username: "Nom d'utilisateur",
    notSet: "Non défini",
    joinedAt: "Inscrit le",
    myDocs: "Mes documents",
    emptyHint:
      "Aucun document cloud pour l'instant. La gestion des documents arrive bientôt — ",
    emptyLinkText: "aller à l'éditeur",
    loading: "Chargement…",
    loginRequired: "Veuillez vous connecter",
    loginRequiredHint: "Vous devez vous connecter pour accéder au tableau de bord.",
    goLogin: "Aller à la connexion",
  },
  editor: {
    placeholder:
      'Commencez à écrire… tapez « # » pour un titre, « - » pour une liste, « ``` » pour un bloc de code',
    saving: "Enregistrement…",
    saved: "Enregistré",
    charCount: "{n} caractères",
    saveFailed: "Échec de l'enregistrement",
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
    deleteDocument: "Supprimer le document",
    deleteConfirm: "Supprimer « {title} » ? Cette action est irréversible.",
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
    imageClickToEdit: "Cliquez pour modifier le Markdown de l'image (légende et URL)",
    imageMarkdownLabel: "Source Markdown de l'image",
    imageBroken: "Échec du chargement — cliquez pour modifier l'URL",
    share: "Partager",
    shareTitle: "Partager ce document",
    shareAccessLink: "Toute personne ayant le lien",
    shareAccessLinkHint: "Le lien est aléatoire et indevinable, mais fonctionne pour quiconque l'obtient",
    shareTokenRotated:
      "Un nouveau lien a été généré : la suppression du mot de passe a invalidé immédiatement l'ancien lien. Si vous l'avez déjà envoyé, partagez à nouveau.",
    shareAccessPassword: "Mot de passe requis",
    shareAccessPasswordHint: "Les visiteurs doivent saisir un mot de passe, au moins 6 caractères",
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
    exportPrintHint: "Texte sélectionnable et recherchable — choisissez « Enregistrer au format PDF »",
    wechatExport: "WeChat (compte officiel)",
    wechatExportHint: "Choisissez un thème, puis collez dans l'éditeur WeChat",
    wechatTitle: "Exporter vers WeChat",
    wechatSubtitle:
      "Les styles sont intégrés à chaque élément, la mise en page survit au collage. Les formules deviennent des images.",
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
    cannotDropIntoSelf: "Impossible de déplacer un dossier dans son sous-dossier",
    newSubfolder: "Nouveau sous-dossier",
    newDocumentHere: "Nouveau document ici",
    treeMenu: "Actions sur l'arborescence",
    wechatCopy: "Copier dans le presse-papiers",
    wechatCopied: "Copié — collez-le",
    wechatWorking: "Traitement…",
    wechatCodeNote:
      "Note : WeChat supprime les attributs class, la coloration syntaxique ne peut pas être conservée.",
    wechatMathConverted: "{n} formule(s) converties en images",
    wechatMathFailed: "{n} formule(s) en échec ; repli sur le source LaTeX",
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
    dashboard: "Tableau de bord",
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
            "Export en Markdown, HTML, PDF, DOCX et format article WeChat",
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
            "Lorsqu’un compte ou un document est supprimé, les images associées sont retirées de l’hébergement par une tâche de fond asynchrone, généralement en quelques minutes.",
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
          ],
        },
        {
          title: "Conservation et suppression",
          body: [
            "Les documents sont retirés de la base dès que vous les supprimez. Les images qu’ils référençaient — et qu’aucun de vos autres documents ne référence — sont mises en file d’attente de suppression par une tâche de fond.",
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
    missing_fields: "Le nom d'utilisateur, l'e-mail et le mot de passe sont tous requis",
    invalid_email: "Format d'e-mail invalide",
    password_too_short: "Le mot de passe doit comporter au moins 6 caractères",
    conflict: "L'e-mail ou le nom d'utilisateur est déjà pris",
    invalid_credentials: "Compte ou mot de passe incorrect",
    unauthorized: "Non connecté",
    session_expired: "Session expirée",
    server_error: "Erreur serveur, veuillez réessayer plus tard",
    oauth_unsupported: "Fournisseur de connexion non pris en charge",
    oauth_not_configured: "Cette méthode de connexion n'est pas encore configurée",
    oauth_denied: "Autorisation annulée",
    oauth_missing_params: "Paramètres de rappel OAuth manquants",
    oauth_invalid_state: "Session de connexion expirée, veuillez réessayer",
    oauth_exchange_failed: "Échec de la connexion, veuillez réessayer",
    oauth_profile_failed: "Impossible de lire votre profil auprès du fournisseur",
    oauth_sync_failed: "Échec de la synchronisation du compte, veuillez réessayer",
    title_too_long: "Le titre est trop long",
    content_too_large: "Document trop volumineux pour être enregistré",
    image_fetch_rejected: "Cette adresse d'image n'est pas autorisée",
    image_fetch_failed: "Impossible de récupérer cette image depuis son site d'origine",
    too_deep: "Les dossiers sont trop imbriqués pour en créer un autre à l'intérieur",
    name_too_long: "Nom de dossier trop long",
    invalid_move: "Impossible de déplacer ce dossier ici",
    not_found: "Cet élément n'existe pas ou a été supprimé",
    image_type_unsupported: "Seuls PNG, JPEG, GIF et WebP sont pris en charge",
    image_type_mismatch: "Le contenu du fichier ne correspond pas à son format",
    image_svg_rejected: "Les images SVG ne sont pas prises en charge, pour raisons de sécurité",
    image_too_large: "L'image dépasse la limite de 10 Mo",
    image_quota_exceeded: "Stockage d'images plein — supprimez les documents inutiles pour libérer de l'espace",
    storage_quota_exceeded: "Stockage cloud plein — supprimez les documents inutiles pour libérer de l'espace",
    image_empty: "L'image est vide",
    share_not_found: "Ce lien est invalide ou a été révoqué",
    share_access_invalid: "Niveau de partage invalide",
    share_password_too_short: "Le mot de passe doit comporter au moins 6 caractères",
    share_password_invalid: "Mot de passe incorrect",
    too_many_requests: "Trop de tentatives — veuillez réessayer plus tard",
  },
};
