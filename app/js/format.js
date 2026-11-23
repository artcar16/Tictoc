// Import format documentation shown in the « Données » tab: example JSON, help text and AI prompt.
// Pure ES module (no DOM access), importable from Node.

/** Canonical example of the import format (spec §6.1), pretty-printed with 2 spaces. */
export const FORMAT_EXAMPLE = `{
  "dossiers": [
    {
      "nom": "Comptabilité",
      "dossiers": [
        {
          "nom": "Chapitre 1 - Le bilan",
          "cartes": [
            { "recto": "Bilan", "verso": "Photographie du patrimoine de l'entreprise à une date donnée" },
            { "recto": "Actif", "verso": "Ensemble des biens et des droits contrôlés par l'entreprise" }
          ]
        },
        {
          "nom": "Chapitre 2 - Le compte de résultat",
          "cartes": [
            { "recto": "Résultat net (formule)", "verso": "Résultat net = Total des produits - Total des charges" }
          ]
        }
      ]
    }
  ]
}`;

/** Short French explanation of the format and of the merge behaviour (plain text). */
export const FORMAT_HELP = [
  'Chaque dossier a un « nom » et peut contenir des « cartes » et des sous-dossiers (« dossiers »), sur autant de niveaux que tu veux.',
  'Chaque carte a un « recto » (la notion, le terme ou la question) et un « verso » (la définition, la formule ou la réponse). Pour aller à la ligne dans un texte, écris \\n.',
  'Les photos et les enregistrements audio s’ajoutent ensuite dans l’application, en modifiant une carte.',
  'Tu peux réimporter le même fichier enrichi (par exemple avec un nouveau chapitre) : les dossiers de même nom et les cartes de même recto sont reconnus, seuls les nouveaux éléments sont ajoutés, les versos modifiés sont mis à jour et ta progression est conservée.',
].join('\n');

/**
 * Prompt to paste into an AI chat (ChatGPT, Claude…) together with a course,
 * so that it answers with ONLY a valid JSON in the import format.
 */
export function buildAIPrompt() {
  return `Tu vas transformer mon cours en flashcards pour l'application de révision « Recto ».

Réponds UNIQUEMENT avec un JSON valide, sans aucun texte avant ou après, sans explication et sans bloc de code Markdown (pas de \`\`\`). Ta réponse doit commencer par { et finir par }.

Format exact à respecter :
- La racine est un objet avec la clé "dossiers".
- Chaque dossier a un "nom" et peut contenir "cartes" (liste de cartes) et/ou "dossiers" (sous-dossiers).
- Chaque carte est un objet { "recto": "...", "verso": "..." } et rien d'autre.

Règles :
1. Crée un dossier par chapitre, nommé avec son numéro et son titre (ex. "Chapitre 1 - Le bilan"). Si le cours a un titre général, place tous les chapitres dans un dossier racine portant ce titre. Utilise des sous-dossiers seulement pour les grandes parties d'un chapitre.
2. Recto : court et précis — une notion, un terme ou une question (ex. "Résultat net (formule)").
3. Verso : la définition, la formule ou la réponse, claire, concise et fidèle au cours.
4. Texte brut uniquement : pas de Markdown, pas de LaTeX, pas de HTML. Écris les formules en ligne avec des symboles simples (ex. "Résultat net = Total des produits - Total des charges").
5. Pour un retour à la ligne dans un texte, écris \\n.
6. Jamais deux cartes avec le même recto dans un même dossier. Si une notion a une définition et une formule, fais deux cartes (ex. "Résultat net (définition)" et "Résultat net (formule)").
7. Couvre toutes les notions importantes du cours (définitions, formules, mécanismes, distinctions, chiffres clés), sans rien inventer qui ne soit pas dans le cours.
8. Le JSON doit être strictement valide : guillemets droits ("), virgule entre deux éléments, pas de virgule après le dernier élément d'une liste ou d'un objet, guillemets à l'intérieur d'un texte échappés (\\").
9. Si le cours est trop long pour une seule réponse, traite entièrement les premiers chapitres et ferme correctement le JSON (toujours sans texte autour). Quand je te demanderai « la suite », continue avec les chapitres suivants dans le même format, en reprenant les mêmes noms de dossiers parents : l'application fusionne les imports.

Exemple du format attendu :
${FORMAT_EXAMPLE}

Voici mon cours (ci-dessous ou en pièce jointe) :
`;
}
