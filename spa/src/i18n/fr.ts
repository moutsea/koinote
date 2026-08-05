import type { Messages } from "./types";

export const fr: Messages = {
  nav: {
    editor: "Éditeur",
    dashboard: "Tableau de bord",
    login: "Se connecter",
    logout: "Se déconnecter",
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
    imageClickToEdit: "Cliquez pour modifier le Markdown de l'image (légende et URL)",
    imageMarkdownLabel: "Source Markdown de l'image",
    imageBroken: "Échec du chargement — cliquez pour modifier l'URL",
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
    not_found: "Cet élément n'existe pas ou a été supprimé",
    image_type_unsupported: "Seuls PNG, JPEG, GIF et WebP sont pris en charge",
    image_type_mismatch: "Le contenu du fichier ne correspond pas à son format",
    image_svg_rejected: "Les images SVG ne sont pas prises en charge, pour raisons de sécurité",
    image_too_large: "L'image dépasse la limite de 10 Mo",
    image_empty: "L'image est vide",
  },
};
