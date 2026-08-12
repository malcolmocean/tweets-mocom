// Fills data/embeds.json with the foreign tweets this archive points at — the ones
// Malcolm quoted and the ones he replied to — so QTs and replies render with the
// thing they're responding to instead of a bare "quoting a tweet" link.
//
//   node src/fetch-embeds.js              # fetch what's missing
//   node src/fetch-embeds.js --limit 500  # cap this run
//   node src/fetch-embeds.js --retry-gone # re-ask about tweets last seen as unavailable
//
// Incremental and interruptible: the cache is flushed every SAVE_EVERY answers, so a
// run that dies (or gets rate-limited) keeps what it had and the next one picks up.
// There are ~26k of these; a fair share are deleted by now and stay cached as nulls.
import { loadArchive } from './model.js';
import { loadEmbeds, saveEmbeds, embedNeeds, fetchEmbed } from './embeds.js';
import { EMBEDS_JSON } from './config.js';

const CONCURRENCY = 8;
const SAVE_EVERY = 500;
// Consecutive failures that mean "the endpoint is done talking to us" rather than
// "this one tweet is weird" — stop and keep what we have, rather than burning the
// rest of the queue into the retry pile.
const MAX_CONSECUTIVE_ERRORS = 40;

const log = (...a) => console.log(...a);

async function main() {
  const args = process.argv.slice(2);
  const retryGone = args.includes('--retry-gone');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

  const archive = await loadArchive();
  const embeds = await loadEmbeds();
  const needs = embedNeeds(archive);
  const todo = needs
    .filter(id => !embeds.has(id) || (retryGone && embeds.get(id) === null))
    .slice(0, limit);

  const known = needs.filter(id => embeds.get(id)).length;
  log(`${needs.length} referenced tweets · ${known} already embedded · ${todo.length} to fetch`);
  if (!todo.length) return;

  let cursor = 0, done = 0, got = 0, gone = 0, failed = 0, streak = 0, stopped = false;
  const flush = async () => { await saveEmbeds(embeds); };

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < todo.length && !stopped) {
      const id = todo[cursor++];
      const r = await fetchEmbed(id);
      if (r.embed) { embeds.set(id, r.embed); got++; streak = 0; }
      else if (r.gone) { embeds.set(id, null); gone++; streak = 0; }
      else {
        // Left out of the cache entirely: unknown, not unavailable — ask again next run.
        failed++;
        if (++streak >= MAX_CONSECUTIVE_ERRORS) {
          stopped = true;
          log(`  ${streak} failures in a row (last: ${r.status ?? 'network'}) — stopping early`);
        }
        // Back off a little so a rate limit isn't hammered by all workers at once.
        await new Promise(res => setTimeout(res, 500 * Math.min(streak, 10)));
      }
      if (++done % SAVE_EVERY === 0) {
        await flush();
        log(`  ${done}/${todo.length} — ${got} embedded, ${gone} unavailable, ${failed} failed`);
      }
    }
  }));

  await flush();
  log(`wrote ${EMBEDS_JSON}: +${got} embedded, ${gone} unavailable, ${failed} to retry ` +
    `(${embeds.size} cached total)`);
}

main().catch(e => { console.error(e); process.exit(1); });
