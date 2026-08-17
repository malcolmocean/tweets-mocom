# tweets.malcolmocean.com

A static archive of [@Malcolm_Ocean](https://x.com/Malcolm_Ocean)'s tweets, sourced from
[community-archive.org](https://www.community-archive.org/) and deployed to Cloudflare Workers.

Live: **https://tweets.malcolmocean.com**

## Pages

| URL | What it is |
|---|---|
| `/` | Overview + stats |
| `/by-month/` | Calendar: years as rows, months as columns. Each cell is `rgb(retweets, likes, tweet-count)`, each channel log-scaled against the busiest month in that dimension. |
| `/by-month/YYYY-MM/` | Every tweet that month, chronological, with self-reply chains grouped. Replies to other people are toggleable (they stay in the HTML either way, so crawlers see everything). |
| `/threads/` | All share-worthy threads, sortable by topic, date, length, likes, RTs |
| `/threads/<topic>/` | One thread per page |
| `/top/` | 500 most-liked tweets, sortable by likes, RTs, date, or RT/like ratio |
| `/replies/` | 250 most-liked replies to other people, each under the tweet it answers |
| `/retweets/` | Every retweet, searchable, plus who gets retweeted most |

Plus `/sitemap.xml` and `/robots.txt` — the archive is meant to be crawled.

**"Worth sharing"** = a self-reply chain of **4+ tweets** that is either **6+ tweets long** OR has
**30+ total likes**. Currently 648 of 5,217 chains. Tune in `src/config.js`.

The 4-tweet floor is the load-bearing one: a tweet with an afterthought or two isn't a thread
however well it did, and the well-liked short ones are already on `/top/`.

## Retweets are shown but never counted

The archive stores a retweet as a tweet of Malcolm's whose text is `RT @them: …`, and — the
trap — its `favorite_count` and `retweet_count` are the **original tweet's**, not his. Counted
naively, 6.2k retweets add ~17k borrowed RTs to an account that earned ~13k, so totals, month
colours and `/top` end up measuring other people's reach.

So `loadArchive()` splits the archive in two: `archive.own` is what he wrote and every count on
the site is over it; `archive.tweets` stays the full record for the pages that display retweets
in place. Retweets are excluded from threads, `/top`, and all totals; they appear on month pages
(toggleable, like replies) and on `/retweets/`, where the "Reach" column is explicitly labelled
as the original author's.

Detection is `^RT @user[: ]` — anchored, so an old-style manual retweet with a comment in front
("Well said. RT @them …") is still counted as Malcolm's own tweet. Self-retweets (`RT
@Malcolm_Ocean`, ~350 of them) are retweets too: the tweet they point at is already in the
archive with its own numbers, so counting the retweet would double it.

## Quoted and replied-to tweets

The community archive holds Malcolm's tweets and nobody else's, so a quote-tweet arrives as a
bare id and a reply as a bare `reply_to_tweet_id` — which is exactly the half of the exchange
that makes his half readable. `fetch-embeds` pulls those ~26k tweets from Twitter's
**syndication API** (`cdn.syndication.twimg.com/tweet-result`, the unauthenticated JSON backend
behind embedded tweets — same method `~/dev/xyxz` uses) into `data/embeds.json`, and they render
as a card: above a reply, below a quote-tweet.

It's an unofficial endpoint, so everything degrades: no cache, no card, and the tweet renders
with a link the way it used to. About 14% of them are gone (deleted, locked, suspended) and get
cached as `null` so later runs don't ask again — `--retry-gone` asks anyway. A network or
rate-limit error caches nothing, so the next run retries it; 40 failures in a row stops the run
and keeps what it got. Quote-tweets of his own tweets need no fetch at all: the tweet is already
in the archive, and its card links to this site rather than to X.

## Refreshing

```sh
npm run update      # the same five steps, unattended and guarded — use this one
npm run refresh     # fetch → fetch-embeds → name-threads → build → deploy
```

Or each step alone:

```sh
npm run fetch         # community-archive → data/tweets.json  (~60 requests, ~2 min)
npm run fetch-embeds  # quoted + replied-to tweets → data/embeds.json  (incremental; first run ~1h)
npm run name-threads  # names NEW threads only → data/thread-names.json  (needs ANTHROPIC_API_KEY)
npm run build         # data/ → public/  (~2s, wipes and regenerates public/)
npm run deploy        # wrangler deploy
```

Three things make repeat runs cheap and stable:

- **`fetch` is a full refetch, deliberately.** Likes and RTs on old tweets keep changing, so an
  incremental "new tweets only" pull would freeze engagement at first-seen values and rot the
  `/top` rankings and month colours. 53k tweets is only ~60 paged requests.
- **`name-threads` is incremental.** Existing names in `data/thread-names.json` are kept, so a
  refresh only pays the LLM for threads that appeared since last time. `--all` re-names
  everything; `--limit N` caps a run.
- **`fetch-embeds` is incremental too**, and for a harder reason: it's ~26k requests to an
  endpoint that owes us nothing. Only tweets missing from `data/embeds.json` are fetched, so a
  routine refresh costs a few hundred requests. Worth keeping (and backing up) even though it's
  gitignored: tweets that get deleted between refreshes can't be fetched again. `update.js`
  keeps a `data/embeds.json.bak` for that reason.

Thread slugs are the URL, so they're stable as long as `thread-names.json` is kept — don't
delete it. Collisions get a numeric suffix (`-2`), newest thread keeps the bare slug.

## Auto-updating

`npm run update` (`src/update.js`) is the scheduled version of `refresh`: the same five steps,
written for a run nobody is watching. A daily one takes about two minutes.

```sh
npm run update                    # fetch, rebuild, deploy if anything changed
npm run update -- --no-deploy     # everything but the deploy
npm run update -- --force         # deploy even if nothing changed
npm run update -- --no-embeds --no-names --embed-limit 500
```

What it adds over running the steps by hand:

- **One at a time.** A lock file in `data/` keeps a slow run and the next cron tick from
  interleaving two fetches over the same `data/`. A lock whose process is gone is taken over.
- **The archive is restored if the refetch looks wrong.** `fetch` overwrites all 53k tweets in
  one go, so a half-answered API is the one failure that could quietly empty the site. The
  previous copy is kept as `data/tweets.json.bak`, and put back if what arrives isn't the right
  account, isn't parseable, or is more than 2% smaller than what it replaced.
- **It only deploys what's new.** The build's inputs — which tweets exist, their like/RT counts,
  and `thread-names.json` — are hashed and compared against the hash of the last successful
  deploy (`data/update-state.json`), so a run that dies before deploying still deploys next time,
  and one where nothing actually moved skips the build entirely. A deploy that went out with a
  step still owing work (names not written, embeds rate-limited) is recorded as `pending`, which
  stops the next run from skipping and stranding it.
- **Only a build failure is fatal.** Embeds and thread names are enrichments — a rate-limited
  syndication API or a missing `ANTHROPIC_API_KEY` costs a card or a thread page, not the run.
  A failed build stops before the deploy, so a half-written `public/` never reaches the live site.
- **It checks which Cloudflare account it's logged into** (`DEPLOY_ACCOUNT_EMAIL` in `config.js`)
  and refuses to deploy from the work one.
- **Everything is timestamped into `data/update.log`**, which is the only evidence a 3am run
  leaves. Exit code is 0 on success or nothing-to-do, 1 on a failed run.

Cron has no login shell, so put `ANTHROPIC_API_KEY=…` in a `.env` at the repo root — `update.js`
reads it, and anything already in the environment wins. A daily run at 4:07am:

```cron
7 4 * * * cd /Users/malcolm/dev/personal/tweets-mocom && /opt/homebrew/bin/node src/update.js >/dev/null 2>&1
```

(Absolute node path on purpose — cron's `PATH` won't find nvm's. On macOS, cron needs Full Disk
Access for the repo; `launchd` with a `StartCalendarInterval` avoids that if it bites.)

## Layout

```
src/
  config.js       account, site constants, thread thresholds
  archive.js      community-archive REST client (paging, retries)
  fetch.js        → data/tweets.json
  model.js        archive → own tweets / retweets / self-reply chains / month buckets / replies
  embeds.js       syndication-API client + cache; embed cards for quoted/replied-to tweets
  fetch-embeds.js → data/embeds.json (incremental, resumable)
  name-threads.js → data/thread-names.json (Claude API, batched + concurrent)
  render.js       page shell, tweet markup, client-side sort/filter scripts
  build.js        → public/
  update.js       one guarded, unattended run of all of the above (cron entry point)
  assets/style.css
data/             fetched + generated (not hand-edited)
public/           generated — wiped on every build, don't edit
```

Sorting and filtering are client-side over rows already present in the HTML, so every page is a
single self-contained file that works without JS.

## Notes

- Deploys to Malcolm's **personal** Cloudflare account (malcolm.m.ocean@gmail.com). This machine
  may also hold company Cloudflare credentials — check `wrangler whoami` before deploying.
- `ANTHROPIC_API_KEY` is only needed for `name-threads`.
- Media is hot-linked from `pbs.twimg.com`; images Twitter has dropped remove themselves
  client-side. Embed cards do the same with the quoted tweet's first image.
- Covers 2009-06-20 → present: 47k own tweets plus 6.2k retweets, which are shown but not counted.
- `/retweets/` is one big page (~2.6 MB, ~530 KB gzipped) so that search and sort span all of it.
