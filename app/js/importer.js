// JSON import: lenient parsing (parseImport) and merge planning (planImport).
// Pure ES module: no DOM / IndexedDB access, importable from Node for unit tests.

import { normalizeText } from './util.js';

/* ------------------------------------------------------------------------ */
/* Key aliases                                                              */
/* ------------------------------------------------------------------------ */

const ALIASES = {
  folders: ['dossiers', 'folders', 'sous_dossiers', 'sousdossiers', 'subfolders', 'chapitres', 'chapters', 'sections', 'children'],
  cards: ['cartes', 'cards', 'flashcards', 'fiches'],
  name: ['nom', 'name', 'titre', 'title', 'dossier', 'chapitre'],
  front: ['recto', 'front', 'question', 'terme', 'term', 'notion', 'q'],
  back: ['verso', 'back', 'reponse', 'réponse', 'answer', 'definition', 'définition', 'formule', 'a'],
};

/** Normalised key: accents removed, lower-cased, separators (space, _ and -) dropped. */
function normKey(key) {
  return String(key)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/** kind -> Map<normalisedAlias, priority> (lower priority = preferred). */
const ALIAS_RANK = Object.fromEntries(
  Object.entries(ALIASES).map(([kind, list]) => {
    const ranks = new Map();
    list.forEach((alias, i) => {
      const k = normKey(alias);
      if (!ranks.has(k)) ranks.set(k, i);
    });
    return [kind, ranks];
  }),
);

/** Keys accepted when a face is given as an object, e.g. { "text": "…" }. */
const FACE_TEXT_KEYS = new Set(['text', 'texte']);

const DEFAULT_FOLDER_NAME = 'Sans nom';
const ROOT_IMPORT_FOLDER = 'Import';

const BACKUP_ERROR = 'Ce fichier est une sauvegarde complète : utilise « Restaurer une sauvegarde ».';
const EMPTY_ERROR = 'Aucune carte trouvée. Vérifie que le JSON suit le format attendu (voir « Format JSON »).';

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Values of the keys of `obj` matching the aliases of `kind`, in alias priority order. */
function pick(obj, kind) {
  const ranks = ALIAS_RANK[kind];
  const found = [];
  for (const key of Object.keys(obj)) {
    const rank = ranks.get(normKey(key));
    if (rank !== undefined) found.push([rank, obj[key]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return found.map((entry) => entry[1]);
}

function hasKind(obj, kind) {
  const ranks = ALIAS_RANK[kind];
  return Object.keys(obj).some((key) => ranks.has(normKey(key)));
}

/**
 * Convert a JSON value to card/folder text.
 * string → trimmed (inner line breaks kept); number/boolean → String; array → items joined with "\n";
 * { text } object → its text. Anything else → null (= missing).
 */
function toText(value) {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(toText).filter((s) => s != null && s !== '');
    return parts.join('\n');
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FACE_TEXT_KEYS.has(normKey(key))) return toText(value[key]);
    }
  }
  return null;
}

/** First non-empty text among candidate values ('' if none). */
function firstText(values) {
  for (const v of values) {
    const t = toText(v);
    if (t) return t;
  }
  return '';
}

/** Flatten the values of several alias keys into a single list of items. */
function collectItems(values, asMap) {
  const items = [];
  for (const v of values) {
    if (Array.isArray(v)) items.push(...v);
    else if (isPlainObject(v)) items.push(...asMap(v));
    // Strings, numbers… under a list key are ignored.
  }
  return items;
}

function isCardLike(obj) {
  return hasKind(obj, 'front') || hasKind(obj, 'back');
}

/** A card object: has a recto/verso key and no folder/card list (a name-like key such as "chapitre" is ignored). */
function isCardItem(obj) {
  return isCardLike(obj) && !hasKind(obj, 'folders') && !hasKind(obj, 'cards');
}

function formatPath(path, leaf) {
  const parts = [...path, leaf];
  const s = parts.join(' › ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------------ */
/* Tree parsing                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Object used as a list of cards, e.g. { "Bilan": "Photographie…" } → [{ recto, verso }].
 * A single card object ({ recto, verso }) is also accepted.
 */
function cardsFromMap(obj) {
  if (isCardLike(obj) || hasKind(obj, 'name') || hasKind(obj, 'cards') || hasKind(obj, 'folders')) return [obj];
  return Object.entries(obj).map(([front, back]) => ({ recto: front, verso: back }));
}

/**
 * Object used as a list of folders, e.g. { "Chapitre 1": { "cartes": [...] } } or { "Chapitre 1": [cards] }.
 * A single folder object ({ nom, cartes }) is also accepted.
 */
function foldersFromMap(obj) {
  if (hasKind(obj, 'name')) return [obj];
  return Object.entries(obj).map(([name, content]) => {
    if (Array.isArray(content)) return { nom: name, cartes: content };
    if (isPlainObject(content)) return hasKind(content, 'name') ? content : { nom: name, ...content };
    return null; // { "Chapitre 1": "texte" }: not a folder
  }).filter(Boolean);
}

class Parser {
  constructor() {
    this.warnings = [];
    this.stats = { folders: 0, cards: 0 };
  }

  warn(msg) {
    this.warnings.push(msg);
  }

  /** Parse the content (sub-folders + cards) of a folder-like object located at `path`. */
  content(obj, path) {
    const out = { folders: [], cards: [] };
    const cardItems = collectItems(pick(obj, 'cards'), cardsFromMap);
    const folderItems = collectItems(pick(obj, 'folders'), foldersFromMap);

    const seenFronts = new Set();
    let cardNo = 0;
    let folderNo = 0;
    const addCard = (item) => {
      cardNo += 1;
      const card = this.card(item, path, cardNo);
      if (!card) return;
      const key = normalizeText(card.front);
      if (seenFronts.has(key)) {
        this.warn(`${formatPath(path, `carte n°${cardNo}`)} : recto en double « ${card.front} »`);
      }
      seenFronts.add(key);
      out.cards.push(card);
    };
    const addFolder = (item) => {
      folderNo += 1;
      const folder = this.folder(item, path, folderNo);
      if (folder) out.folders.push(folder);
    };

    for (const item of cardItems) {
      // A folder put in a card list by mistake is still accepted as a sub-folder.
      if (isPlainObject(item) && !isCardLike(item) && (hasKind(item, 'cards') || hasKind(item, 'folders'))) addFolder(item);
      else addCard(item);
    }
    for (const item of folderItems) {
      // A card put in a folder list by mistake is still accepted as a card.
      if (isPlainObject(item) && isCardItem(item)) addCard(item);
      else addFolder(item);
    }
    return out;
  }

  /** Parse one folder item; returns an ImportFolder or null when unusable. */
  folder(item, path, index) {
    if (typeof item === 'string' || typeof item === 'number') {
      // A bare name: an empty folder.
      const name = toText(item);
      if (!name) return null;
      this.stats.folders += 1;
      return { name, folders: [], cards: [] };
    }
    if (!isPlainObject(item)) {
      this.warn(`${formatPath(path, `dossier n°${index}`)} : format non reconnu, ignoré`);
      return null;
    }
    let name = firstText(pick(item, 'name'));
    if (!name) {
      name = DEFAULT_FOLDER_NAME;
      this.warn(`${formatPath(path, `dossier n°${index}`)} : nom manquant, nommé « ${DEFAULT_FOLDER_NAME} »`);
    }
    this.stats.folders += 1;
    const { folders, cards } = this.content(item, [...path, name]);
    return { name, folders, cards };
  }

  /** Parse one card item; returns an ImportCard or null (with a warning) when invalid. */
  card(item, path, index) {
    let front = '';
    let back = '';
    if (isPlainObject(item)) {
      front = firstText(pick(item, 'front'));
      back = firstText(pick(item, 'back'));
    } else if (Array.isArray(item) && item.length >= 2) {
      // ["recto", "verso"]
      front = toText(item[0]) || '';
      back = toText(item[1]) || '';
    } else {
      this.warn(`${formatPath(path, `carte n°${index}`)} : format de carte non reconnu, ignorée`);
      return null;
    }
    if (!front || !back) {
      const what = !front && !back ? 'recto et verso manquants' : !front ? 'recto manquant' : 'verso manquant';
      this.warn(`${formatPath(path, `carte n°${index}`)} : ${what}`);
      return null;
    }
    this.stats.cards += 1;
    return { front, back };
  }

  /** Parse the JSON root, whatever its shape. */
  root(data) {
    if (Array.isArray(data)) {
      // Array of folders and/or cards ([recto, verso] pairs count as cards).
      const isCard = (item) => Array.isArray(item) || (isPlainObject(item) && isCardItem(item));
      return this.content({ cartes: data.filter(isCard), dossiers: data.filter((item) => !isCard(item)) }, []);
    }
    if (isPlainObject(data)) {
      // A single card.
      if (isCardItem(data)) {
        const card = this.card(data, [], 1);
        return { folders: [], cards: card ? [card] : [] };
      }
      // The object is itself a folder.
      if (firstText(pick(data, 'name'))) {
        const folder = this.folder(data, [], 1);
        return { folders: folder ? [folder] : [], cards: [] };
      }
      // A container with folder / card lists.
      if (hasKind(data, 'folders') || hasKind(data, 'cards')) return this.content(data, []);
      // A map { "Chapitre 1": {...} | [cards] }.
      const folders = [];
      foldersFromMap(data).forEach((item, i) => {
        const folder = this.folder(item, [], i + 1);
        if (folder) folders.push(folder);
      });
      return { folders, cards: [] };
    }
    return { folders: [], cards: [] };
  }
}

/* ------------------------------------------------------------------------ */
/* Text pre-processing & JSON repair                                        */
/* ------------------------------------------------------------------------ */

/** Trim a { text, offset } candidate while keeping the offset accurate. */
function trimCandidate(candidate) {
  const lead = candidate.text.length - candidate.text.trimStart().length;
  return { text: candidate.text.trim(), offset: candidate.offset + lead };
}

/**
 * Extract the JSON part(s) of a pasted text: the content of every markdown code fence that holds
 * JSON (an AI may split its answer into several blocks), otherwise the span from the first { / [
 * to the last } / ] when the text has prose around it.
 * Returns [{ text, offset }] where offset is the position of `text` inside the input.
 */
function extractCandidates(input) {
  // Opening fence: ``` + optional info string (json, JSON…) + optional line break.
  const openRe = /```[\w+-]*[ \t]*\r?\n?/g;
  const fences = [];
  let m;
  while ((m = openRe.exec(input)) !== null) {
    const start = m.index + m[0].length;
    const close = input.indexOf('```', start);
    const end = close < 0 ? input.length : close; // unclosed fence: take the rest
    fences.push({ text: input.slice(start, end), offset: start });
    if (close < 0) break;
    openRe.lastIndex = close + 3;
  }
  if (fences.length) {
    const json = fences.filter((f) => /^\s*[[{]/.test(f.text));
    return (json.length ? json : [fences[0]]).map(trimCandidate);
  }
  let candidate = { text: input, offset: 0 };
  const trimmed = input.trim();
  if (trimmed && !/^[[{]/.test(trimmed)) {
    const start = input.search(/[[{]/);
    const end = Math.max(input.lastIndexOf('}'), input.lastIndexOf(']'));
    if (start >= 0 && end > start) candidate = { text: input.slice(start, end + 1), offset: start };
  }
  return [trimCandidate(candidate)];
}

/**
 * `text` with the ranges [from, to) replaced by spaces (newlines kept) so that positions are
 * preserved. Built from slices: no per-character array, even for a very large text.
 */
function blankRanges(text, ranges) {
  if (!ranges.length) return text;
  const parts = [];
  let at = 0;
  for (const [from, to] of ranges) {
    parts.push(text.slice(at, from), text.slice(from, to).replace(/[^\n]/g, ' '));
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/**
 * Remove // and /* *\/ comments and trailing commas before } or ], outside strings.
 * Removed characters are replaced by spaces: positions stay identical to the input.
 */
function cleanJson(text) {
  // Pass 1: comments.
  const comments = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"' || c === '\n') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const j = nl < 0 ? text.length : nl;
      comments.push([i, j]);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const j = end < 0 ? text.length : end + 2;
      comments.push([i, j]);
      i = j - 1;
    }
  }
  const noComments = blankRanges(text, comments);
  // Pass 2: trailing commas.
  const commas = [];
  inStr = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"' || c === '\n') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') commas.push([i, i + 1]);
    }
  }
  return blankRanges(noComments, commas);
}

const TYPO_QUOTES = /[\u201C\u201D\u201E]/;

/** Replace typographic quotes “ ” „ only where they act as JSON string delimiters (1:1, positions kept). */
function fixDelimiterQuotes(text) {
  return text
    .replace(/([{[,:]\s*)[\u201C\u201D\u201E]/g, '$1"')
    .replace(/[\u201C\u201D\u201E](\s*[:,}\]])/g, '"$1');
}

/** Replace every typographic double quote with a straight one (last resort). */
function fixAllQuotes(text) {
  return text.replace(/[\u201C\u201D\u201E]/g, '"');
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------------ */
/* JSON syntax checker (for French error messages with line / column)       */
/* ------------------------------------------------------------------------ */

class JsonSyntaxError extends Error {
  constructor(pos, reason) {
    super(reason);
    this.pos = pos;
    this.reason = reason;
  }
}

function describeChar(c) {
  if (c === undefined) return 'fin du texte inattendue (accolade « } » ou crochet « ] » manquant ?)';
  if (/[\u201C\u201D\u201E\u00AB\u00BB]/.test(c)) return `guillemet typographique « ${c} » : utilise des guillemets droits "`;
  if (c === "'" || c === '’') return 'guillemet simple : les textes doivent être entre guillemets droits "';
  return `caractère inattendu « ${c} »`;
}

/**
 * Strict JSON validator returning the position and a French reason of the first syntax error,
 * or null when the text is valid. Engines do not all report positions (Safari never does).
 */
function findJsonError(s) {
  let i = 0;
  const fail = (reason, pos = i) => {
    throw new JsonSyntaxError(pos, reason);
  };
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  };
  const string = () => {
    const start = i;
    i++; // opening quote
    for (;;) {
      const c = s[i];
      if (c === undefined) fail('texte sans guillemet fermant', start);
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\\') {
        const e = s[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) fail('séquence \\u invalide');
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail('barre oblique inverse « \\ » invalide (écris \\\\ pour un « \\ »)');
        continue;
      }
      if (c === '\n' || c === '\r') fail('retour à la ligne dans un texte : ferme le guillemet ou écris \\n');
      if (c < ' ') fail('caractère de contrôle dans un texte');
      i++;
    }
  };
  const number = () => {
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) fail('nombre invalide');
    i += m[0].length;
  };
  const literal = () => {
    for (const word of ['true', 'false', 'null']) {
      if (s.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    fail(describeChar(s[i]));
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') object();
    else if (c === '[') array();
    else if (c === '"') string();
    else if (c === '-' || (c >= '0' && c <= '9')) number();
    else if (c === 't' || c === 'f' || c === 'n') literal();
    else fail(describeChar(c));
  };
  const object = () => {
    i++;
    ws();
    if (s[i] === '}') {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (s[i] !== '"') {
        if (s[i] === '}') fail('virgule en trop avant « } »');
        fail(s[i] === undefined ? describeChar(undefined) : `nom de propriété attendu entre guillemets droits ("…"), trouvé ${describeChar(s[i]).replace(/^caractère inattendu /, '')}`);
      }
      string();
      ws();
      if (s[i] !== ':') fail('« : » attendu après le nom de propriété');
      i++;
      value();
      ws();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        return;
      }
      fail(s[i] === undefined ? describeChar(undefined) : 'virgule « , » ou accolade « } » attendue (virgule oubliée ?)');
    }
  };
  const array = () => {
    i++;
    ws();
    if (s[i] === ']') {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (s[i] === ']') fail('virgule en trop avant « ] »');
      value();
      ws();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === ']') {
        i++;
        return;
      }
      fail(s[i] === undefined ? describeChar(undefined) : 'virgule « , » ou crochet « ] » attendu (virgule oubliée ?)');
    }
  };
  try {
    value();
    ws();
    if (i < s.length) fail('contenu en trop après la fin du JSON');
    return null;
  } catch (err) {
    if (err instanceof JsonSyntaxError) return { pos: err.pos, reason: err.reason };
    throw err;
  }
}

/** 1-based line / column of position `pos` in `text`. */
function lineCol(text, pos) {
  let line = 1;
  let col = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}

/** Engine-reported position (V8 "position N", Firefox "line L column C"), or null. */
function enginePosition(error, text) {
  const msg = String((error && error.message) || '');
  let m = /position (\d+)/i.exec(msg);
  if (m) return Number(m[1]);
  m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) {
    const lines = text.split('\n');
    let pos = 0;
    for (let l = 0; l < Number(m[1]) - 1 && l < lines.length; l++) pos += lines[l].length + 1;
    return pos + Number(m[2]) - 1;
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/** True when a parsed value is a Recto backup rather than an import file. */
export function isBackupObject(data) {
  return isPlainObject(data) && (data.kind === 'backup' || (data.app === 'recto' && 'media' in data));
}

const TRAILING_REASON = 'contenu en trop après la fin du JSON';
/** Start of another JSON block ({"…", {}, [{…, ["…, [[…, []), as opposed to prose such as « (voir [1]) ». */
const JSON_BLOCK_START = /^(?:\{\s*["}]|\[\s*[[{"\]])/;

/**
 * Parse one candidate, with the tolerated repairs. A complete JSON value followed by text (an AI's
 * closing question, another block…) is accepted: `end` is then the position where the value ends.
 * → { ok: true, value, end } | { ok: false, error }  (error positions refer to `input`)
 */
function parseCandidate(candidate, input) {
  const { text } = candidate;
  // Valid JSON (the usual case, and big files): no repaired copies of the text are built.
  let parsed = tryParse(text);
  if (parsed.ok) return { ok: true, value: parsed.value, end: text.length };
  const attempts = [text, cleanJson(text)];
  if (TYPO_QUOTES.test(text)) attempts.push(cleanJson(fixDelimiterQuotes(text)), cleanJson(fixAllQuotes(text)));
  for (const attempt of attempts.slice(1)) {
    parsed = tryParse(attempt);
    if (parsed.ok) return { ok: true, value: parsed.value, end: text.length };
  }
  // Only a complete value followed by text that does not continue it (« Veux-tu la suite ? »):
  // an extra « } » / « ] » / « , » is a real mistake inside the JSON and is reported below.
  for (const attempt of attempts.slice(1)) {
    const found = findJsonError(attempt);
    if (!found || found.reason !== TRAILING_REASON) continue;
    if (/^\s*[,:\]}"]/.test(text.slice(found.pos))) continue;
    const head = tryParse(attempt.slice(0, found.pos));
    if (head.ok) return { ok: true, value: head.value, end: found.pos };
  }
  // Report on the most "repaired" position-preserving variant, so tolerated issues are not reported.
  const reference = attempts[attempts.length > 2 ? 2 : 1];
  const found = findJsonError(reference);
  let pos = found ? found.pos : enginePosition(parsed.error, reference);
  const reason = found ? found.reason : 'syntaxe incorrecte';
  if (pos == null) return { ok: false, error: `JSON invalide : ${reason}.` };
  pos = Math.min(pos, reference.length);
  const { line, col } = lineCol(input, candidate.offset + pos);
  return { ok: false, error: `JSON invalide (ligne ${line}, colonne ${col}) : ${reason}.` };
}

/**
 * Parse every JSON block of a pasted text. → { ok: true, values, warnings } | { ok: false, error }
 * Several fenced blocks (or JSON values written one after the other) are all kept; text after the
 * end of a JSON value is ignored with a warning.
 */
function parseBlocks(input) {
  const queue = extractCandidates(input);
  const values = [];
  const warnings = [];
  for (let k = 0; k < queue.length; k++) {
    const candidate = queue[k];
    const res = parseCandidate(candidate, input);
    if (!res.ok) {
      const several = queue.length > 1 || values.length > 0;
      return { ok: false, error: several ? `Bloc JSON n°${k + 1} : ${res.error}` : res.error };
    }
    values.push(res.value);
    const rest = trimCandidate({ text: candidate.text.slice(res.end), offset: candidate.offset + res.end });
    if (!rest.text) continue;
    if (JSON_BLOCK_START.test(rest.text)) {
      queue.splice(k + 1, 0, rest); // another JSON value right after this one
    } else {
      const maybeJson = /[{[]\s*["{[]/.test(rest.text);
      warnings.push(
        `Le texte après la fin du JSON a été ignoré (« ${excerpt(rest.text, 50)} »).${maybeJson ? ' S’il contient d’autres cartes, importe-le séparément.' : ''}`,
      );
    }
  }
  if (values.length > 1) warnings.unshift(`${values.length} blocs JSON trouvés : ils ont été importés ensemble.`);
  return { ok: true, values, warnings };
}

/**
 * Parse an import text (lenient).
 * @returns {{ok: true, tree: {folders: Array, cards: Array}, warnings: string[], stats: {folders: number, cards: number}}
 *          | {ok: false, error: string}}
 */
export function parseImport(text) {
  let values;
  let blockWarnings = [];
  if (text !== null && typeof text === 'object') {
    values = [text]; // already parsed
  } else {
    const input = String(text ?? '').replace(/^\uFEFF/, '');
    if (!input.trim()) return { ok: false, error: 'Le texte est vide : colle ton JSON ou choisis un fichier .json.' };
    const blocks = parseBlocks(input);
    if (!blocks.ok) return { ok: false, error: blocks.error };
    values = blocks.values;
    blockWarnings = blocks.warnings;
  }

  if (values.some(isBackupObject)) return { ok: false, error: BACKUP_ERROR };

  const parser = new Parser();
  parser.warnings.push(...blockWarnings);
  const tree = { folders: [], cards: [] };
  for (const value of values) {
    const part = parser.root(value);
    tree.folders.push(...part.folders);
    tree.cards.push(...part.cards);
  }
  if (parser.stats.cards === 0 && parser.stats.folders === 0) return { ok: false, error: EMPTY_ERROR };
  return { ok: true, tree, warnings: parser.warnings, stats: { ...parser.stats } };
}

function orderOf(item) {
  return Number.isFinite(item.order) ? item.order : 0;
}

function byOrder(a, b) {
  return orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0);
}

function nextOrderAfter(items) {
  let max = -1;
  for (const it of items) if (Number.isFinite(it.order) && it.order > max) max = it.order;
  return max + 1;
}

/** Texts a card was imported with ({ front, back } strings), or null (card typed in the app). */
function importedSource(card) {
  const imp = card && card.imported;
  if (!isPlainObject(imp) || typeof imp.front !== 'string' || typeof imp.back !== 'string') return null;
  return imp;
}

/** One-line excerpt of a text for messages. */
function excerpt(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Compute what an import would change, without touching the database.
 * @param {{folders: Array, cards: Array}} tree  from parseImport
 * @param {{targetFolderId?: string|null, folders: Array, cards: Array}} ctx  current DB content
 * @returns Plan (see spec §6.3), plus `keptCards` (matched cards whose verso was corrected in the
 *          app: never overwritten) and `warnings` (string[], conflicts worth showing).
 */
export function planImport(tree, { targetFolderId = null, folders = [], cards = [] } = {}) {
  const target = targetFolderId ?? null;
  const folderById = new Map(folders.map((f) => [f.id, f]));
  if (target !== null && !folderById.has(target)) {
    throw new Error('Le dossier de destination est introuvable.');
  }

  const childrenOf = new Map(); // parentId|null → Folder[]
  for (const f of folders) {
    const key = f.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(f);
  }
  const cardsOf = new Map(); // folderId → Card[]
  for (const c of cards) {
    if (!cardsOf.has(c.folderId)) cardsOf.set(c.folderId, []);
    cardsOf.get(c.folderId).push(c);
  }

  const plan = {
    target,
    newFolders: [],
    newCards: [],
    updatedCards: [],
    // Matched cards whose verso was changed in the app: never overwritten by an import.
    keptCards: [], // [{ id, front, back /* verso proposed by the file */, conflict /* the file brings a new verso */ }]
    warnings: [],
    summary: { foldersNew: 0, foldersReused: 0, cardsNew: 0, cardsUpdated: 0, cardsUnchanged: 0 },
  };
  const tempIds = new Set();
  let tempSeq = 0;
  const newTempId = () => {
    let id;
    do id = `tmp:${++tempSeq}`;
    while (folderById.has(id));
    tempIds.add(id);
    return id;
  };

  // Per parent ref: existing + planned child folders by normalised name, and the next free order.
  const folderSlots = new Map();
  const folderSlot = (parentRef) => {
    let slot = folderSlots.get(parentRef);
    if (!slot) {
      const existing = tempIds.has(parentRef) ? [] : (childrenOf.get(parentRef) || []).slice().sort(byOrder);
      const byName = new Map();
      for (const f of existing) {
        const key = normalizeText(f.name);
        if (!byName.has(key)) byName.set(key, f.id);
      }
      slot = { byName, nextOrder: nextOrderAfter(existing) };
      folderSlots.set(parentRef, slot);
    }
    return slot;
  };

  // Per folder ref: existing cards indexed by normalised recto — the current one and the one they were
  // imported with (card.imported, see db.applyImportPlan), so that a recto corrected in the app is
  // still recognised. Each existing card is matched at most once (shared entry). Next free order.
  const cardSlots = new Map();
  const cardSlot = (folderRef) => {
    let slot = cardSlots.get(folderRef);
    if (!slot) {
      const existing = tempIds.has(folderRef) ? [] : (cardsOf.get(folderRef) || []).slice().sort(byOrder);
      const byFront = new Map();
      const byImported = new Map();
      const index = (map, key, entry) => {
        if (!key) return; // media-only recto: cannot be matched by text
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
      };
      for (const c of existing) {
        const imp = importedSource(c);
        const entry = {
          card: c,
          back: normalizeText(c.back?.text),
          impBack: imp ? normalizeText(imp.back) : null,
          // Verso changed in the app since it was imported (exact text). Cards without an import
          // source were typed in the app (or predate it): their verso always belongs to the user.
          edited: !imp || String(c.back?.text ?? '').trim() !== imp.back.trim(),
          used: false,
        };
        index(byFront, normalizeText(c.front?.text), entry);
        if (imp) index(byImported, normalizeText(imp.front), entry);
      }
      slot = { byFront, byImported, nextOrder: nextOrderAfter(existing) };
      cardSlots.set(folderRef, slot);
    }
    return slot;
  };

  const reused = new Set();
  const { summary } = plan;

  const placeCards = (list, folderRef, path) => {
    if (!list || !list.length) return;
    const slot = cardSlot(folderRef);
    const keys = list.map((c) => ({ front: normalizeText(c.front), back: normalizeText(c.back) }));
    const matches = new Array(list.length).fill(null);
    const pass = (map, accept) => {
      keys.forEach((k, i) => {
        if (matches[i]) return;
        const candidate = (map.get(k.front) || []).find((e) => !e.used && accept(e, k));
        if (candidate) {
          candidate.used = true;
          matches[i] = candidate;
        }
      });
    };
    // 1. identical recto + verso (so that reordered duplicates stay stable);
    // 2. the very recto + verso it was imported with (its texts were corrected in the app);
    // 3. same recto; 4. same imported recto (recto corrected in the app: no duplicate).
    pass(slot.byFront, (e, k) => e.back === k.back);
    pass(slot.byImported, (e, k) => e.impBack === k.back);
    pass(slot.byFront, () => true);
    pass(slot.byImported, () => true);
    // Emit in JSON order.
    list.forEach((c, i) => {
      const match = matches[i];
      if (!match) {
        plan.newCards.push({ folderRef, front: c.front, back: c.back, order: slot.nextOrder++ });
        summary.cardsNew++;
      } else if (match.back === keys[i].back) {
        summary.cardsUnchanged++;
      } else if (!match.edited) {
        plan.updatedCards.push({ id: match.card.id, back: c.back });
        summary.cardsUpdated++;
      } else {
        // The user corrected this verso in the app: keep it. Only worth a warning when the file
        // brings a verso different from the one originally imported.
        const conflict = match.impBack !== keys[i].back;
        const front = String(match.card.front?.text ?? '').trim() || c.front;
        plan.keptCards.push({ id: match.card.id, front, back: c.back, conflict });
        if (conflict) {
          plan.warnings.push(`${formatPath(path, `« ${front} »`)} : verso modifié dans l’app, conservé (le fichier propose « ${excerpt(c.back)} »)`);
        }
      }
    });
  };

  const placeFolder = (folder, parentRef, path) => {
    const slot = folderSlot(parentRef);
    const name = String(folder.name ?? '').trim() || DEFAULT_FOLDER_NAME;
    const key = normalizeText(name);
    let ref = slot.byName.get(key);
    if (ref === undefined) {
      ref = newTempId();
      plan.newFolders.push({ tempId: ref, name, parentRef, order: slot.nextOrder++ });
      slot.byName.set(key, ref);
      summary.foldersNew++;
    } else if (!tempIds.has(ref) && !reused.has(ref)) {
      reused.add(ref);
      summary.foldersReused++;
    }
    placeCards(folder.cards, ref, [...path, name]);
    for (const sub of folder.folders || []) placeFolder(sub, ref, [...path, name]);
  };

  for (const folder of tree?.folders || []) placeFolder(folder, target, []);

  const rootCards = tree?.cards || [];
  if (rootCards.length) {
    if (target === null) placeFolder({ name: ROOT_IMPORT_FOLDER, folders: [], cards: rootCards }, null, []);
    else placeCards(rootCards, target, [folderById.get(target).name]);
  }

  return plan;
}
