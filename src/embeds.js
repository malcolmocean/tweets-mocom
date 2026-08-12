// Tweets by other people that this archive points at: the ones Malcolm quoted, and
// the ones he replied to. The community archive holds only his own tweets, so a QT
// or a reply arrives here as a bare id — "quoting a tweet", "replying to @someone" —
// which is exactly the half of the conversation that makes the other half readable.
//
// They're fetched from Twitter's syndication API: the unauthenticated JSON backend
// behind embedded tweets, and the same method ~/dev/xyxz uses. It's unofficial, so
// every failure degrades to "no embed" and the page falls back to a plain link.
//
// Results are cached in data/embeds.json and the fetch is incremental, because
// there are ~26k of these and an unknown share of them are gone for good. A tweet
// the API says is unavailable is cached as null so later runs don't ask again;
// a network/rate-limit error is cached as nothing at all, so they do.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { DATA_DIR, EMBEDS_JSON } from './config.js';
import { decodeEntities } from './model.js';

// --- cache -----------------------------------------------------------------

export async function loadEmbeds() {
  const raw = await readFile(EMBEDS_JSON, 'utf8').then(JSON.parse).catch(() => null);
  return new Map(Object.entries(raw?.tweets || {}));
}

// Written via a temp file and renamed into place: a long fetch flushes every few
// hundred tweets, and a build reading the cache mid-flush should see the previous
// complete file rather than half of this one.
export async function saveEmbeds(embeds) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${EMBEDS_JSON}.tmp`;
  await writeFile(tmp, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    tweets: Object.fromEntries(embeds),
  }));
  await rename(tmp, EMBEDS_JSON);
}

// --- what needs fetching ---------------------------------------------------

// Every foreign tweet the site would like to show, most useful first: a quoted
// tweet is load-bearing for its tweet (without it the QT is a non-sequitur), and
// beyond that the ones attached to well-liked tweets are the ones most people will
// see. Order matters because a run can be cut short by --limit or a rate limit.
export function embedNeeds(archive) {
  const need = new Map();
  const want = (id, weight) => {
    if (!id || archive.byId.has(id)) return;   // in the archive; no fetch needed
    need.set(id, Math.max(need.get(id) ?? -1, weight));
  };
  for (const t of archive.own) {
    want(t.quotes, 1e6 + t.likes);
    if (t.isReplyToOther) want(t.replyTo, t.likes);
  }
  return [...need.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

// --- the archive's own tweets, as embeds -----------------------------------

// Roughly half of the quote-tweets here quote Malcolm himself, and those don't need
// fetching — the tweet is already in the archive. Reshaped into a card so a self-quote
// looks like any other, except that its link stays on this site.
function ownAsEmbed(t, account) {
  const photos = t.media.filter(m => m.type === 'photo');
  return {
    id: t.id,
    // A retweet of someone else is their tweet; attribute the card to them.
    user: t.isRetweet ? t.rtUser : account.username,
    name: t.isRetweet ? null : account.displayName,
    at: t.at,
    text: t.isRetweet ? t.rtBody : t.text,
    urls: t.urls,
    photo: photos[0]?.url ?? null,
    photos: photos.length,
    video: t.media.some(m => m.type !== 'photo'),
    href: `/by-month/${t.month}/#t${t.id}`,
  };
}

// What the renderer calls to put a referenced tweet on the page: the archive first,
// then the fetch cache, then nothing (and the tweet renders with a link instead).
export function embedContext(archive, embeds) {
  const cache = new Map();
  return {
    embed(id) {
      if (!id) return null;
      if (cache.has(id)) return cache.get(id);
      const own = archive.byId.get(id);
      const e = own ? ownAsEmbed(own, archive.account)
        : embeds.get(id) ? { ...embeds.get(id), href: `https://x.com/${embeds.get(id).user}/status/${id}` }
          : null;
      cache.set(id, e);
      return e;
    },
  };
}

// --- syndication API -------------------------------------------------------

const ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';

// The endpoint requires this token derived from the id. Number() loses precision on
// large ids, but the endpoint expects exactly this computation.
const token = id => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

const shape = (id, t) => {
  const text = decodeEntities(t.text ?? '');
  return {
    id,
    user: t.user.screen_name,
    name: t.user.name,
    at: t.created_at ?? null,
    text,
    // Same {t,x,d} shape the archive uses for its own tweets, so linkify() can
    // expand t.co links in an embed exactly as it does in one of Malcolm's.
    urls: (t.entities?.urls || [])
      .filter(u => u.expanded_url)
      .map(u => ({ t: u.url, x: u.expanded_url, d: u.display_url })),
    // The card shows the first image, the way the tweet itself would; the rest are
    // counted. Hot-linked from pbs.twimg.com like the archive's own media, and the
    // renderer drops the figure client-side if Twitter has since dropped the file.
    photo: t.photos?.[0]?.url ?? null,
    photos: t.photos?.length ?? 0,
    video: Boolean(t.video),
    // Long tweets ("notes") come back cut at ~280 chars with a trailing ellipsis.
    // Heuristic — the API has no explicit truncation flag.
    truncated: text.endsWith('…') || text.endsWith('...') || undefined,
    // One level deep only: a quote of a quote shows the middle tweet's text, and
    // the reader can click through for the rest.
    quoted: t.quoted_tweet?.user
      ? { user: t.quoted_tweet.user.screen_name, text: decodeEntities(t.quoted_tweet.text ?? '') }
      : undefined,
  };
};

// → { embed } when it's there, { gone: true } when the API says it isn't (deleted,
// protected, suspended — cached as a permanent no), { retry: true } when the ask
// itself failed and the answer is still unknown.
export async function fetchEmbed(id, { timeout = 8000 } = {}) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}?id=${id}&token=${token(id)}&lang=en`,
      { signal: AbortSignal.timeout(timeout) });
  } catch {
    return { retry: true };
  }
  if (res.status === 404) return { gone: true };
  if (!res.ok) return { retry: true, status: res.status };
  const t = await res.json().catch(() => null);
  // A deleted or protected tweet comes back 200 as a TweetTombstone.
  if (!t) return { retry: true };
  if (t.__typename !== 'Tweet' || !t.user) return { gone: true };
  return { embed: shape(id, t) };
}
