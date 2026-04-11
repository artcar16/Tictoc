import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

// How aggressively we stay ahead of the user's scroll.
const BUFFER_TARGET = 40;   // keep the queue at least this full
const BUFFER_MIN = 15;      // trigger a refill when the queue drops below this
const BATCH_SIZE = 12;      // how many cards to ask Claude for per call

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// System prompt is long and stable → ideal candidate for prompt caching.
const SYSTEM_PROMPT = `You are the content engine for FactFlow, a TikTok-style scroll feed that replaces mindless videos with fascinating, *true* facts that stop the thumb.

Your single job: produce captivating knowledge cards across every domain of human curiosity — science, history, nature, space, tech, psychology, math, geography, culture, records, mysteries, unusual events, and everyday phenomena that feel obvious once revealed.

## Output contract (STRICT)

Respond with a JSON array only. No prose, no markdown fences, no commentary before or after. Each element must be an object with exactly these fields:

{
  "category": one of ["Science","History","Nature","Space","Tech","Culture","Psychology","Math","Geography","Records","Mystery","DidYouKnow"],
  "emoji": a single representative emoji,
  "title": a punchy hook, 3-8 words, no period at the end,
  "body": 2 to 4 short sentences, vivid and concrete, prefer specific numbers/names/dates when they exist,
  "source_hint": a brief parenthetical like "(NASA, 2019)" or "(British Museum)" — use "" if unknown,
  "gradient": a CSS linear-gradient string suggesting the mood, e.g. "linear-gradient(160deg,#0f172a,#7c3aed)"
}

## Quality bar

- Every fact must be true and well-established. If unsure, skip it.
- Prefer facts that surprise, reframe, or provoke a double-take.
- Vary topics aggressively — never two consecutive cards from the same category.
- Use concrete numbers, names, dates. Avoid vague phrases like "many people".
- Keep language fast, vivid, ~25-55 words per body. No clichéd "Did you know" openings outside the DidYouKnow category.
- Never repeat a fact within a single response.
- Match the gradient to the vibe: cosmic → deep blue/violet, nature → green/teal, history → amber/maroon, tech → cyan/magenta, records → gold/black, mystery → indigo/black, psychology → rose/plum, etc.`;

// Rotating pool of angles Claude can riff on to avoid sameness across batches.
const THEME_POOL = [
  'ocean depths', 'deep time', 'microscopic life', 'ancient engineering',
  'modern physics', 'forgotten empires', 'language quirks', 'cognitive biases',
  'extreme weather', 'biological records', 'space oddities', 'math surprises',
  'cold-war secrets', 'botanical weirdness', 'urban planning', 'lost technologies',
  'human body trivia', 'animal intelligence', 'early computing', 'natural disasters',
  'economic oddities', 'artistic heists', 'evolutionary leftovers', 'desert phenomena',
  'polar exploration', 'musical mysteries', 'chemical reactions', 'number theory',
  'festival origins', 'extinction events', 'linguistic fossils', 'underground worlds'
];

// ---- State ----

let cardIdCounter = 0;
const buffer = [];              // FIFO queue of ready-to-serve cards
let generationPromise = null;   // in-flight generation (acts as a mutex)
let generationError = null;     // last error message, if any
let topUpInFlight = null;       // the background top-up loop, if running

// ---- Helpers ----

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function pickThemes(n = 4) {
  const copy = [...THEME_POOL];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

// ---- Generation ----

async function generateBatch() {
  // Only one batch in flight at a time.
  if (generationPromise) return generationPromise;

  generationPromise = (async () => {
    try {
      const themes = pickThemes(4).join(', ');
      const userMsg =
        `Generate ${BATCH_SIZE} new FactFlow cards. For variety, lean into these angles where natural (but don't force them): ${themes}. Return only the JSON array.`;

      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: userMsg }]
      });

      const text = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      // Defensively locate the JSON array even if the model wraps it.
      const jsonStart = text.indexOf('[');
      const jsonEnd = text.lastIndexOf(']');
      if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('No JSON array found in model response');
      }
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (!Array.isArray(parsed)) {
        throw new Error('Parsed JSON is not an array');
      }

      for (const c of parsed) {
        buffer.push({
          id: cardIdCounter++,
          category: String(c.category || 'DidYouKnow'),
          emoji: String(c.emoji || '✨'),
          title: String(c.title || 'Untitled'),
          body: String(c.body || ''),
          source_hint: String(c.source_hint || ''),
          gradient: String(c.gradient || 'linear-gradient(160deg,#0f172a,#7c3aed)')
        });
      }

      log(`Generated ${parsed.length} cards. Buffer=${buffer.length}.`, {
        input: resp.usage?.input_tokens,
        cache_create: resp.usage?.cache_creation_input_tokens,
        cache_read: resp.usage?.cache_read_input_tokens,
        output: resp.usage?.output_tokens
      });
      generationError = null;
    } catch (err) {
      generationError = err?.message || String(err);
      log('Generation failed:', generationError);
    } finally {
      generationPromise = null;
    }
  })();

  return generationPromise;
}

// Background loop that keeps the buffer topped up to BUFFER_TARGET.
function scheduleTopUp() {
  if (topUpInFlight) return;
  topUpInFlight = (async () => {
    let consecutiveErrors = 0;
    while (buffer.length < BUFFER_TARGET) {
      await generateBatch();
      if (generationError) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          log('3 consecutive errors — pausing top-up loop.');
          break;
        }
        await new Promise((r) => setTimeout(r, 8000));
      } else {
        consecutiveErrors = 0;
      }
    }
  })()
    .catch((err) => log('topUp error:', err))
    .finally(() => {
      topUpInFlight = null;
    });
}

// ---- HTTP ----

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/feed', async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || 5, 1), 20);

  // If the buffer is dry, block until at least one batch lands.
  if (buffer.length === 0) {
    await generateBatch();
  }

  if (buffer.length === 0) {
    return res.status(503).json({
      cards: [],
      bufferSize: 0,
      generating: !!generationPromise,
      error: generationError || 'generation unavailable'
    });
  }

  const cards = buffer.splice(0, count);

  // Kick off background refill when the queue is running low.
  if (buffer.length < BUFFER_MIN) {
    scheduleTopUp();
  }

  res.json({
    cards,
    bufferSize: buffer.length,
    generating: !!generationPromise,
    error: generationError
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    bufferSize: buffer.length,
    bufferTarget: BUFFER_TARGET,
    bufferMin: BUFFER_MIN,
    generating: !!generationPromise,
    error: generationError,
    model: MODEL
  });
});

app.listen(PORT, () => {
  log(`FactFlow running on http://localhost:${PORT}`);
  log(`Model: ${MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    log('WARNING: ANTHROPIC_API_KEY is not set — generation will fail.');
  } else {
    scheduleTopUp(); // prime the buffer immediately
  }
});
