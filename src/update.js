// One unattended run of the whole pipeline: community-archive → data/ → public/ → Cloudflare.
// This is `npm run refresh` hardened for a cron job that nobody is watching.
//
//   node src/update.js                # fetch, rebuild, deploy if anything changed
//   node src/update.js --force        # deploy even if the archive is byte-identical
//   node src/update.js --no-deploy    # everything but the deploy
//   node src/update.js --no-embeds --no-names   # skip the slow/paid steps
//   node src/update.js --embed-limit 500        # cap the syndication-API run
//
// What it adds over running the five steps by hand:
//
// - One at a time. A lock file means a slow run and the next cron tick can't
//   interleave two fetches over the same data/ directory.
// - The archive is backed up before the refetch and restored if the new one
//   doesn't look like an archive. `fetch` is a full overwrite of 53k tweets, so a
//   half-answered API is the one failure that could quietly empty the site.
// - Nothing is deployed unless it differs from what was last deployed, which is
//   tracked in data/update-state.json rather than guessed from file times — so a
//   run that dies before the deploy still deploys next time.
// - Only build failures are fatal. Embeds and thread names are enrichments: the
//   pages render without them (a link instead of a card, no page for a thread
//   until it's named), so a syndication rate-limit or a missing API key degrades
//   the run instead of ending it.
// - Everything is timestamped into data/update.log, because the output of a 3am
//   run is the only evidence of what it did.
import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, copyFile, rename, stat, unlink } from 'node:fs/promises';
import { openSync, closeSync, writeSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, DATA_DIR, TWEETS_JSON, EMBEDS_JSON, THREAD_NAMES_JSON, USERNAME, DEPLOY_ACCOUNT_EMAIL } from './config.js';

const LOG = join(DATA_DIR, 'update.log');
const LOCK = join(DATA_DIR, '.update.lock');
const STATE = join(DATA_DIR, 'update-state.json');
const TWEETS_BAK = `${TWEETS_JSON}.bak`;
const EMBEDS_BAK = `${EMBEDS_JSON}.bak`;
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

// A refetch that comes back with fewer tweets than this share of the last one is
// treated as a broken answer, not as deleted tweets. Malcolm deletes a handful at
// a time; the archive doesn't lose 2% of itself in a day.
const MIN_KEEP_RATIO = 0.98;

// --- logging ---------------------------------------------------------------

const started = Date.now();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const lines = [];

function log(msg = '') {
  const line = msg ? `[${stamp()}] ${msg}` : '';
  console.log(line);
  lines.push(line);
}

// Buffered to one append at the end so a killed run can't leave a half-written
// line, and so the log reads as one run rather than interleaved with another's.
async function flushLog() {
  if (lines.length) await appendFile(LOG, `${lines.join('\n')}\n`).catch(() => {});
  lines.length = 0;
  // A daily run writes ~2 KB, so this keeps a couple of years and then keeps one
  // generation of older runs rather than growing forever.
  const size = await stat(LOG).then(s => s.size).catch(() => 0);
  if (size > 1_000_000) await rename(LOG, `${LOG}.1`).catch(() => {});
}

// --- lock ------------------------------------------------------------------

// Signal 0 asks "is this pid there?" without sending anything. EPERM is a yes —
// it's someone else's process, which still means the pid is taken, not stale.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = await readFile(LOCK, 'utf8').then(JSON.parse).catch(() => null);
      if (held?.pid && alive(held.pid)) {
        log(`another update (pid ${held.pid}, started ${held.startedAt}) is still running — nothing to do`);
        return false;
      }
      // Whoever held this died without cleaning up; take it over.
      log(`clearing a stale lock from pid ${held?.pid ?? '?'}`);
      await unlink(LOCK).catch(() => {});
    }
  }
  return false;
}

// --- steps -----------------------------------------------------------------

// Runs a step, echoing its output into our log as it goes (indented, so a step's
// own progress lines stay distinguishable from this script's). Resolves to
// { ok, out } rather than throwing: each caller decides whether its step is fatal.
function run(label, cmd, args, { cwd = ROOT } = {}) {
  log(`→ ${label}`);
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const consume = stream => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        out += chunk;
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const p of parts) log(`  | ${p}`);
      });
      stream.on('end', () => { if (buf.trim()) log(`  | ${buf}`); });
    };
    consume(child.stdout);
    consume(child.stderr);
    child.on('error', e => { log(`  ! ${label} could not start: ${e.message}`); resolve({ ok: false, out }); });
    child.on('close', code => {
      if (code !== 0) log(`  ! ${label} exited ${code}`);
      resolve({ ok: code === 0, out });
    });
  });
}

const node = (script, args = []) => run(script, process.execPath, [join(ROOT, 'src', script), ...args]);

// --- archive snapshots -----------------------------------------------------

// Identity of the archive *as the site renders it*: which tweets, and the two
// numbers every ranking and month colour is computed from. Text edits aren't a
// thing on Twitter, so this is the whole of what a rebuild could change about them.
function snapshot(raw) {
  const h = createHash('sha1');
  const ids = new Set();
  for (const t of raw.tweets) {
    ids.add(t.id);
    h.update(`${t.id}:${t.likes}:${t.rts}\n`);
  }
  return { count: raw.tweets.length, ids, digest: h.digest('hex'), newest: raw.tweets.at(-1) ?? null };
}

// …and thread names are the other half of what the build reads: a newly named (or
// renamed) thread changes the site without changing a single tweet. Leaving them
// out would let a thread named on a quiet day sit unpublished until the next
// tweet happened along.
async function buildKey(tweetsDigest) {
  const names = await readFile(THREAD_NAMES_JSON).catch(() => Buffer.alloc(0));
  return createHash('sha1').update(tweetsDigest).update(names).digest('hex');
}

const readArchive = path => readFile(path, 'utf8').then(JSON.parse);

// --- deploy guard ----------------------------------------------------------

// This machine also holds work Cloudflare credentials. Deploying tweets.malcolmocean.com
// from the wrong account is the kind of mistake a 3am cron job should refuse to make.
async function deployAccountOk(force) {
  const { ok, out } = await run('wrangler whoami', WRANGLER, ['whoami']);
  if (!ok) return force;
  const email = /associated with the email ([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(out)?.[1];
  if (!email) {
    log(`  ! couldn't read the logged-in account from wrangler whoami`);
    return force;
  }
  if (email.toLowerCase() !== DEPLOY_ACCOUNT_EMAIL.toLowerCase()) {
    log(`  ! logged in as ${email}, expected ${DEPLOY_ACCOUNT_EMAIL} — not deploying`);
    return force;
  }
  log(`  account ${email} ✓`);
  return true;
}

// --- driver ----------------------------------------------------------------

async function update(opts) {
  // Load .env if there's one, so a cron run gets ANTHROPIC_API_KEY without a
  // login shell. Anything already in the environment wins.
  const env = await readFile(join(ROOT, '.env'), 'utf8').catch(() => '');
  for (const line of env.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  const state = await readFile(STATE, 'utf8').then(JSON.parse).catch(() => ({}));
  const before = existsSync(TWEETS_JSON) ? snapshot(await readArchive(TWEETS_JSON)) : null;
  log(before ? `archive: ${before.count} tweets, newest ${before.newest?.at ?? '?'}` : 'no archive yet — first run');

  // 1. fetch — the one step that overwrites something irreplaceable-ish in place.
  if (before) await copyFile(TWEETS_JSON, TWEETS_BAK);
  const restore = async why => {
    log(`  ! ${why} — restoring the previous archive`);
    if (before) await copyFile(TWEETS_BAK, TWEETS_JSON);
  };
  if (!(await node('fetch.js')).ok) {
    await restore('fetch failed');
    return { ok: false, summary: 'fetch failed, nothing changed' };
  }

  let raw;
  try {
    raw = await readArchive(TWEETS_JSON);
    if (!Array.isArray(raw.tweets) || !raw.tweets.length) throw new Error('no tweets in the fetched archive');
    if (raw.account?.username?.toLowerCase() !== USERNAME.toLowerCase()) {
      throw new Error(`fetched @${raw.account?.username}, expected @${USERNAME}`);
    }
    if (before && raw.tweets.length < before.count * MIN_KEEP_RATIO) {
      throw new Error(`fetched ${raw.tweets.length} tweets, was ${before.count} — too big a drop to trust`);
    }
  } catch (e) {
    await restore(e.message);
    return { ok: false, summary: `bad fetch (${e.message}), nothing changed` };
  }

  const after = snapshot(raw);
  const fresh = before ? raw.tweets.filter(t => !before.ids.has(t.id)) : raw.tweets;
  const dropped = before ? before.count + fresh.length - after.count : 0;
  log(`fetched ${after.count} tweets — ${fresh.length} new${dropped ? `, ${dropped} gone` : ''}`);
  for (const t of fresh.slice(-5)) log(`  + ${t.at.slice(0, 16).replace('T', ' ')}  ${t.text.replace(/\s+/g, ' ').slice(0, 70)}`);

  // `pending` means the last deploy went out with a step still owing work — names
  // that never got written, embeds that got rate-limited. Skipping on an unchanged
  // digest would strand that work until the next tweet arrived, so it doesn't.
  if (await buildKey(after.digest) === state.deployedDigest && !state.pending && !opts.force) {
    return { ok: true, summary: 'nothing changed since the last deploy', unchanged: true };
  }
  let pending = false;

  // 2. embeds — quoted and replied-to tweets. Optional; the pages fall back to links.
  if (opts.embeds) {
    if (existsSync(EMBEDS_JSON)) await copyFile(EMBEDS_JSON, EMBEDS_BAK);
    const args = Number.isFinite(opts.embedLimit) ? ['--limit', String(opts.embedLimit)] : [];
    if (!(await node('fetch-embeds.js', args)).ok) {
      log('  ! carrying on without the new embeds');
      pending = true;
    }
    // Deleted tweets can never be refetched, so a cache that no longer parses is a
    // permanent loss — take the backup back rather than let the next run rewrite it.
    if (existsSync(EMBEDS_JSON) && !(await readFile(EMBEDS_JSON, 'utf8').then(JSON.parse).then(() => true).catch(() => false))) {
      log('  ! embeds cache is unreadable — restoring the backup');
      await copyFile(EMBEDS_BAK, EMBEDS_JSON).catch(() => {});
    }
  }

  // 3. thread names — needed before a new thread can have a page, but only for
  //    threads that appeared since last time.
  if (opts.names) {
    if (process.env.ANTHROPIC_API_KEY) {
      if (!(await node('name-threads.js')).ok) {
        log('  ! unnamed threads will wait for the next run');
        pending = true;
      }
    } else {
      log('→ name-threads.js — skipped: no ANTHROPIC_API_KEY (new threads stay unlisted until it runs)');
      pending = true;
    }
  }

  // 4. build — fatal. public/ is wiped at the start of a build, so a failure here
  //    leaves a half-written site that must not be deployed over a good one.
  if (!(await node('build.js')).ok) {
    return { ok: false, summary: 'build failed — the live site is untouched' };
  }

  if (!opts.deploy) {
    return { ok: true, summary: `built ${fresh.length} new tweets into public/ (deploy skipped)` };
  }
  if (!(await deployAccountOk(opts.force))) {
    return { ok: false, summary: 'built, but not deployed — wrong Cloudflare account' };
  }
  if (!(await run('wrangler deploy', WRANGLER, ['deploy'])).ok) {
    return { ok: false, summary: 'deploy failed — data/ and public/ are up to date, the live site is not' };
  }

  await writeFile(STATE, JSON.stringify({
    // Recomputed rather than reused: name-threads may have written new names since
    // the skip check, and those are part of what just got deployed.
    deployedDigest: await buildKey(after.digest),
    deployedAt: new Date().toISOString(),
    tweets: after.count,
    newest: after.newest?.at ?? null,
    pending,
  }, null, 1));
  return {
    ok: true,
    summary: `deployed — ${after.count} tweets, ${fresh.length} new` +
      (pending ? ' (a step still owes work; next run won\'t skip)' : ''),
  };
}

// A lock that outlives the process is worse than no lock, so it comes off on any
// exit path — but only if this run is the one holding it. Releasing someone
// else's lock (the "another update is running" path) would defeat the point.
let holdsLock = false;
const releaseLock = () => { if (holdsLock) { try { unlinkSync(LOCK); } catch {} holdsLock = false; } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = name => args.includes(`--${name}`);
  const limitAt = args.indexOf('--embed-limit');
  const opts = {
    force: flag('force'),
    deploy: !flag('no-deploy'),
    embeds: !flag('no-embeds'),
    names: !flag('no-names'),
    embedLimit: limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity,
  };

  if (!(await acquireLock())) { await flushLog(); return 0; }
  holdsLock = true;

  let result;
  try {
    log(`update started (${args.join(' ') || 'no flags'})`);
    result = await update(opts);
  } catch (e) {
    log(`! ${e.stack || e.message}`);
    result = { ok: false, summary: `crashed: ${e.message}` };
  } finally {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    log(`${result?.ok ? 'done' : 'FAILED'} in ${mins}m — ${result?.summary ?? 'no result'}`);
    log();
    await flushLog();
    releaseLock();
  }
  return result.ok ? 0 : 1;
}

process.exit(await main());
