# Recto

**Recto** est une application de flashcards toute simple, pensée pour le téléphone.

- Tu importes tes cartes en **JSON**, rangées en dossiers et sous-dossiers (un dossier par chapitre, par exemple).
- Chaque carte a un **recto** (« Résultat net ») et un **verso** (la définition, la formule…). Dans l'app, tu peux
  compléter une face avec une **photo** (que tu recadres) ou un **enregistrement audio**.
- Tu crées des **méthodes de révision** à partir des chapitres que tu as vus, et tu en ajoutes au fil du temps.
- Les cartes défilent : **Je sais** / **Je ne sais pas**. Ce que tu ne sais pas revient vite, ce que tu sais
  revient de plus en plus tard.

C'est un site statique (HTML, CSS, JavaScript, sans dépendance) qui s'installe comme une application et fonctionne
hors ligne. Toutes les données restent sur ton téléphone.

## Mettre en ligne

Le site est publié avec GitHub Pages par le workflow `.github/workflows/pages.yml`.

1. Sur GitHub, dans le dépôt : **Settings → Pages**, puis dans « Build and deployment », choisis la source
   **« GitHub Actions »** (à faire une seule fois).
2. À chaque push sur la branche par défaut, les tests sont lancés puis le dossier `app/` est publié.
   Tu peux suivre l'avancement dans l'onglet **Actions** (ou relancer à la main avec « Run workflow »).
3. L'application est ensuite disponible à l'adresse `https://<utilisateur>.github.io/<repo>/`.

Selon ton offre GitHub, Pages peut nécessiter que le dépôt soit public.

Les mises à jour arrivent toutes seules : quand le téléphone est en ligne, l'app charge la dernière version publiée ;
hors ligne, elle utilise la copie gardée en cache.

## Installer sur le téléphone

Ouvre l'adresse du site une première fois avec une connexion, puis :

- **iPhone** : dans Safari, touche **Partager**, puis **« Sur l'écran d'accueil »**.
- **Android** : dans Chrome, ouvre le menu **⋮**, puis **« Installer l'application »** (ou **« Ajouter à l'écran
  d'accueil »**).

Recto s'ouvre alors en plein écran, comme une application, et fonctionne sans connexion.

## Format JSON

Dans l'onglet **Données**, l'app affiche ce format avec deux boutons : **« Copier le format »** et **« Copier le prompt
pour une IA »** (à coller dans ChatGPT, Claude… avec ton cours pour qu'il génère le JSON).

```json
{
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
}
```

- Un dossier a un `"nom"` et peut contenir des `"cartes"` **et** des sous-dossiers `"dossiers"`, sur autant de niveaux
  que tu veux.
- Une carte a un `"recto"` et un `"verso"`. Pour aller à la ligne dans un texte : `\n`.
- Le JSON ne contient que du texte : les photos et les audios s'ajoutent ensuite dans l'app, en modifiant une carte.
- La racine peut aussi être un seul dossier, une liste de dossiers ou une liste de cartes. Un bloc de code Markdown
  (`` ```json ``) ou une virgule en trop avant `}` / `]` sont tolérés.
- **Noms de clés acceptés** (majuscules et accents ignorés) :
  - sous-dossiers : `dossiers`, `folders`, `sous_dossiers`, `sousdossiers`, `subfolders`, `chapitres`, `chapters`,
    `sections`, `children`
  - cartes : `cartes`, `cards`, `flashcards`, `fiches`
  - nom du dossier : `nom`, `name`, `titre`, `title`, `dossier`, `chapitre`
  - recto : `recto`, `front`, `question`, `terme`, `term`, `notion`, `q`
  - verso : `verso`, `back`, `reponse`, `réponse`, `answer`, `definition`, `définition`, `formule`, `a`

**Importer et réimporter.** Tu choisis un dossier de destination (ou la racine), tu cliques sur « Analyser » pour voir
un aperçu, puis sur « Importer ». Tu peux réimporter le même fichier enrichi (par exemple avec le chapitre 4 en plus) :

- un dossier de même nom au même endroit est réutilisé (pas de doublon) ;
- une carte de même recto dans le même dossier est reconnue (même si tu as corrigé son recto dans l'app) : si son
  verso a changé dans le fichier, il est mis à jour (photos et audios conservés), sinon elle reste telle quelle ;
- un verso que tu as corrigé dans l'app n'est jamais remplacé par celui du fichier : l'aperçu liste les versos qui
  seront remplacés et signale les cartes corrigées qui sont conservées ;
- les nouveautés sont ajoutées à la suite, rien n'est supprimé et ta progression est conservée.

Des cartes placées directement à la racine du JSON, importées sans dossier de destination, sont rangées dans un
dossier « Import ».

## Comment marchent les révisions

**Les méthodes.** Une méthode, c'est un ensemble de cartes à réviser. Crée-la dans l'onglet **Réviser**
(« Nouvelle méthode »), puis **« Choisir les cartes »** : coche par exemple les chapitres 1 à 3. Quand tu as vu le
chapitre 4, ouvre de nouveau « Choisir les cartes » et coche-le : la méthode s'adapte. Si tu coches un dossier entier,
les cartes que tu y ajouteras plus tard en font automatiquement partie.

**Une session.** Une carte s'affiche ; touche-la (ou « Afficher la réponse ») pour voir le verso, puis réponds :

- **Je ne sais pas** : la carte revient quelques cartes plus loin dans la même session, encore et encore, jusqu'à ce
  que tu la saches. Elle repart au début de l'échelle des intervalles.
- **Je sais** : la carte revient plus tard. Une carte nouvelle (ou ratée) revient le lendemain ; ensuite, chaque
  « Je sais » l'espace davantage, selon l'échelle **1, 3, 7, 14, 30, 60, 120 jours**. À partir de 14 jours, elle
  compte comme « maîtrisée ».

Tu peux aussi balayer la carte vers la droite (je sais) ou vers la gauche (je ne sais pas), et annuler la dernière
réponse. Une nouvelle journée de révision commence à 4 h du matin.

**Nouvelles cartes par jour.** Pour ne pas tout découvrir d'un coup, chaque méthode introduit au plus 20 nouvelles
cartes par jour (réglable : 5, 10, 20, 30, 50, 100 ou illimité). En fin de session, « +10 nouvelles cartes » permet
d'en voir davantage.

**Une progression par méthode.** Chaque méthode a son propre planning : une même carte présente dans deux méthodes
avance indépendamment dans chacune. « Réinitialiser la progression » remet une méthode à zéro.

**Entraînement libre.** Pour revoir les cartes d'une méthode ou d'un dossier dans le désordre, sans aucun effet sur
le planning (pratique la veille d'un examen).

## Données et sauvegarde

- Tout reste **sur ton appareil**, dans le stockage du navigateur : pas de compte, pas de serveur, rien n'est envoyé.
  GitHub Pages ne fait que servir les fichiers de l'application.
- Il n'y a pas de synchronisation : un autre téléphone ou un autre navigateur a ses propres données. Sur iPhone, l'app
  ajoutée à l'écran d'accueil et Safari peuvent avoir des stockages séparés : utilise toujours la même.
- **Exporte régulièrement une sauvegarde** (onglet Données → « Exporter une sauvegarde ») : un fichier `.json` qui
  contient tout (dossiers, cartes, photos, audios, méthodes et progression). « Restaurer une sauvegarde » remplace
  tout le contenu de l'app par celui du fichier.
- Le navigateur peut, dans certaines conditions, effacer les données d'un site : par exemple quand l'espace de
  stockage manque, quand le site n'a pas été utilisé depuis longtemps, ou quand tu effaces les données de
  navigation. L'app demande au navigateur un stockage persistant (voir Données → Stockage), ce qui réduit ce risque
  sans forcément l'éliminer. D'où l'intérêt de la sauvegarde.

## Développement local

Il faut seulement **Node.js 22** : pas de dépendance à installer, pas d'étape de build.

```sh
npm start      # sert app/ sur http://localhost:8080 (autre port : PORT=3000 npm start)
npm test       # tests unitaires (node:test) ; équivalent : node --test tests/unit/
npm run e2e    # parcours complet sur un téléphone simulé (Playwright + Chromium installés sur la machine)
               # npm run e2e -- --shots=captures   enregistre aussi des captures d'écran
npm run icons  # régénère les icônes PNG à partir de app/icons/icon.svg (Playwright)
```

`npm start` affiche aussi une adresse pour ouvrir l'app depuis un téléphone sur le même Wi-Fi. En `http://` sur une
adresse IP, le navigateur désactive le mode hors ligne et le micro (ils exigent HTTPS ou `localhost`) : pour un vrai
essai sur téléphone, passe par GitHub Pages.

Le dossier `app/` est exactement ce qui est publié. Si tu y ajoutes un fichier, ajoute-le aussi à la liste `ASSETS`
de `app/sw.js` (le service worker le met en cache pour le hors-ligne), et un nouveau module JS aussi à la liste
`<link rel="modulepreload">` de `app/index.html` (tous les modules sont chargés en parallèle) ; `npm test` le vérifie.
