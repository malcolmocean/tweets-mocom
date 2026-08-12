// Names every share-worthy thread with a topic slug + title, via the Claude API.
// Incremental by design: names already in data/thread-names.json are kept, so a
// scheduled refresh only pays for threads that appeared since the last run.
//
//   node src/name-threads.js            # name what's missing
//   node src/name-threads.js --all      # re-name everything
//   node src/name-threads.js --limit 50 # cap this run (useful for a dry run)
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { loadArchive, threads, worthSharing } from './model.js';
import { THREAD_NAMES_JSON } from './config.js';

const MODEL = 'claude-opus-5';
const BATCH = 8;        // threads per request
const CONCURRENCY = 6;  // in-flight requests

const SYSTEM = `You name Twitter threads for a public archive of Malcolm Ocean's tweets.
Malcolm writes about: relating & communication, self-authorship, meta-cognition, goal-craft
and effectiveness, non-coercive collaboration, group dynamics, romance & attachment,
software & AI, and language/philosophy of mind.

For each thread you are given, produce:
- "slug": 2-5 words, lowercase kebab-case, ASCII letters/digits/hyphens only. It becomes a URL
  (tweets.malcolmocean.com/threads/<slug>), so it must read as a topic, not a summary sentence.
  Specific over generic: "non-coercive-collaboration" not "thoughts-on-working-together".
- "title": a short human-readable title, under 70 characters, sentence case, no trailing period.
  Name what the thread is ABOUT. Don't editorialize and don't start with "Malcolm" or "A thread".

Base both only on what the thread actually says.`;

const SCHEMA = {
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['id', 'slug', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['threads'],
  additionalProperties: false,
};

// t.co links carry no meaning for a naming decision and eat tokens.
const clean = s => s.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim();

function render(thread) {
  const body = thread.tweets
    .map((t, i) => `${i + 1}. ${clean(t.text).slice(0, 400)}`)
    .join('\n')
    .slice(0, 2500);
  return `<thread id="${thread.id}" date="${thread.date}" tweets="${thread.len}" likes="${thread.likes}">
${body}
</thread>`;
}

export function slugify(s) {
  return s.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'thread';
}

async function nameBatch(client, batch, attempt = 0) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: `Name each of these ${batch.length} threads.\n\n${batch.map(render).join('\n\n')}`,
      }],
    });
    if (res.stop_reason === 'refusal') throw new Error('refusal');
    const text = res.content.find(b => b.type === 'text')?.text ?? '';
    return JSON.parse(text).threads;
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
      return nameBatch(client, batch, attempt + 1);
    }
    console.error(`  batch failed (${batch.map(t => t.id).join(',')}): ${e.message}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

  const existing = all ? {} : await readFile(THREAD_NAMES_JSON, 'utf8')
    .then(JSON.parse).catch(() => ({}));

  const archive = await loadArchive();
  const shareable = threads(archive).filter(worthSharing);
  const todo = shareable.filter(t => !existing[t.id]).slice(0, limit);
  console.log(`${shareable.length} share-worthy threads, ${todo.length} to name`);
  if (!todo.length) return;

  const client = new Anthropic();
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  const named = { ...existing };
  let done = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const out = await nameBatch(client, batch);
      for (const r of out || []) {
        // The model echoes ids back; only trust ones we actually asked about.
        if (batch.some(t => t.id === r.id)) {
          named[r.id] = { slug: slugify(r.slug), title: String(r.title).trim() };
        }
      }
      done += batch.length;
      if (done % 80 < BATCH) console.log(`  named ~${done}/${todo.length}`);
    }
  }));

  // Any thread the model dropped or that failed retries still needs a page.
  let fallbacks = 0;
  for (const t of todo) {
    if (!named[t.id]) {
      const words = clean(t.tweets[0].text).split(' ').slice(0, 6).join(' ');
      named[t.id] = { slug: slugify(words) || `thread-${t.id}`, title: words || `Thread ${t.date}` };
      fallbacks++;
    }
  }
  if (fallbacks) console.log(`  ${fallbacks} threads fell back to first-tweet naming`);

  await writeFile(THREAD_NAMES_JSON, JSON.stringify(named, null, 1));
  console.log(`wrote ${THREAD_NAMES_JSON} (${Object.keys(named).length} names)`);
}

main().catch(e => { console.error(e); process.exit(1); });
