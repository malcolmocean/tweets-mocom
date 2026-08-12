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
| `/retweets/` | Every retweet, searchable, plus who gets retweeted most |

Plus `/sitemap.xml` and `/robots.txt` — the archive is meant to be crawled.

**"Worth sharing"** = a self-reply chain that is **6+ tweets long** OR has **30+ total likes**.
Currently 965 of 5,217 chains. Tune in `src/config.js`.

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

## Refreshing

```sh
npm run refresh     # fetch → name-threads → build → deploy
```

Or each step alone:

```sh
npm run fetch         # community-archive → data/tweets.json  (~60 requests, ~2 min)
npm run name-threads  # names NEW threads only → data/thread-names.json  (needs ANTHROPIC_API_KEY)
npm run build         # data/ → public/  (~2s, wipes and regenerates public/)
npm run deploy        # wrangler deploy
```

Designed to be run on a schedule (cron, GitHub Action, or a Cloudflare cron trigger driving a
CI job). Two things make repeat runs cheap and stable:

- **`fetch` is a full refetch, deliberately.** Likes and RTs on old tweets keep changing, so an
  incremental "new tweets only" pull would freeze engagement at first-seen values and rot the
  `/top` rankings and month colours. 53k tweets is only ~60 paged requests.
- **`name-threads` is incremental.** Existing names in `data/thread-names.json` are kept, so a
  refresh only pays the LLM for threads that appeared since last time. `--all` re-names
  everything; `--limit N` caps a run.

Thread slugs are the URL, so they're stable as long as `thread-names.json` is kept — don't
delete it. Collisions get a numeric suffix (`-2`), newest thread keeps the bare slug.

## Layout

```
src/
  config.js       account, site constants, thread thresholds
  archive.js      community-archive REST client (paging, retries)
  fetch.js        → data/tweets.json
  model.js        archive → own tweets / retweets / self-reply chains / month buckets
  name-threads.js → data/thread-names.json (Claude API, batched + concurrent)
  render.js       page shell, tweet markup, client-side sort/filter scripts
  build.js        → public/
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
- Media is hot-linked from `pbs.twimg.com`; images Twitter has dropped remove themselves client-side.
- Covers 2009-06-20 → present: 47k own tweets plus 6.2k retweets, which are shown but not counted.
- `/retweets/` is one big page (~2.6 MB, ~530 KB gzipped) so that search and sort span all of it.
