// Turns the raw archive into the objects the site is made of: tweets, threads, months.
// Pure data — no HTML. Both build.js and name-threads.js consume this.
import { readFile } from 'node:fs/promises';
import { TWEETS_JSON, THREAD_MIN_TWEETS, THREAD_MIN_LIKES, CHAIN_MIN_TWEETS } from './config.js';

// Twitter HTML-escapes &, < and > inside full_text, and the archive stores it that
// way. Decode once on load so the text is plain and every renderer can escape it
// itself — otherwise "&" reaches the page as "&amp;".
const decodeEntities = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

// The archive stores a retweet as a tweet of your own whose text is "RT @them: …".
// It is NOT your writing, and — this is the trap — its favorite_count and
// retweet_count belong to the tweet being retweeted, not to you. Left in, 6k
// retweets add ~17k borrowed RTs to an account that earned ~13k: totals, month
// colours and /top all end up measuring other people's reach. So retweets are
// carried through the site (they're part of the record) but counted nowhere.
//
// Anchored at the start on purpose: an old-style manual RT with a comment in
// front of it ("Well said. RT @them …") is Malcolm's own tweet and stays one.
const RETWEET_RE = /^RT @(\w{1,15})[: ]/;

export async function loadArchive() {
  const raw = JSON.parse(await readFile(TWEETS_JSON, 'utf8'));
  const byId = new Map(raw.tweets.map(t => [t.id, t]));
  for (const t of raw.tweets) {
    t.text = decodeEntities(t.text);
    t.month = t.at.slice(0, 7);       // YYYY-MM (UTC)
    t.date = t.at.slice(0, 10);
    const rt = RETWEET_RE.exec(t.text);
    t.isRetweet = Boolean(rt);
    t.rtUser = rt ? rt[1] : null;
    // The "RT @them: " prefix is metadata, not part of what was said; the renderer
    // shows the attribution as its own line and the body without it.
    // (the separator is part of the match for "RT @them: x" but not "RT @them x")
    t.rtBody = rt ? t.text.slice(rt[0].length).replace(/^\s+/, '') : null;
    // A reply to someone else, or to a tweet that isn't in the archive, starts a
    // new conversation from this site's point of view. A retweet is neither — the
    // handful that carry a reply_to are retweets *of* a reply, not replies.
    t.isSelfReply = !t.isRetweet && Boolean(t.replyTo && byId.has(t.replyTo) &&
      (!t.replyToUser || t.replyToUser === raw.account.id));
    t.isReplyToOther = !t.isRetweet && Boolean(t.replyTo && !t.isSelfReply);
  }
  // `own` is what this account actually wrote — every count on the site is over it.
  // `tweets` stays the full record, for the pages that show retweets in place.
  return {
    ...raw, byId,
    own: raw.tweets.filter(t => !t.isRetweet),
    retweets: raw.tweets.filter(t => t.isRetweet),
  };
}

// Self-reply chains. The root may itself be a reply to someone else — a thread hung
// off a reply still reads as a thread — what makes it a root is that its parent isn't
// an own tweet in the archive. Where a tweet has several self-replies (branching),
// the earliest child continues the main chain; other branches start their own.
export function assembleChains(archive) {
  const tweets = archive.own;
  // Chains are made of own tweets only. A reply hanging off one of your own
  // retweets is a comment on someone else's tweet, so it starts a chain of its
  // own rather than continuing one.
  const ownIds = new Set(tweets.map(t => t.id));
  const children = new Map();
  for (const t of tweets) {
    if (!t.isSelfReply || !ownIds.has(t.replyTo)) continue;
    if (!children.has(t.replyTo)) children.set(t.replyTo, []);
    children.get(t.replyTo).push(t);
  }
  for (const kids of children.values()) {
    kids.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  const claimed = new Set();
  const chains = [];
  // Walk roots in chronological order so the main chain claims its tweets before
  // any later branch tries to.
  for (const t of tweets) {
    if (t.isSelfReply && ownIds.has(t.replyTo)) continue; // not a root
    if (!children.has(t.id)) continue;                  // no chain hanging off it
    const chain = [t];
    let cur = t;
    while (children.has(cur.id)) {
      const next = children.get(cur.id).find(k => !claimed.has(k.id));
      if (!next) break;
      claimed.add(next.id);
      chain.push(next);
      cur = next;
    }
    if (chain.length >= CHAIN_MIN_TWEETS) chains.push(chain);
  }
  return chains;
}

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

export function chainToThread(chain) {
  const root = chain[0];
  return {
    id: root.id,
    tweets: chain,
    len: chain.length,
    likes: sum(chain, t => t.likes),
    rts: sum(chain, t => t.rts),
    at: root.at,
    date: root.date,
    month: root.month,
    // Engagement the thread actually earned, best-guess: the root's numbers dominate
    // reach, but a thread people read to the end racks up likes down-chain too.
    topLikes: Math.max(...chain.map(t => t.likes)),
  };
}

export function worthSharing(thread) {
  return thread.len >= THREAD_MIN_TWEETS || thread.likes >= THREAD_MIN_LIKES;
}

export function threads(archive) {
  return assembleChains(archive).map(chainToThread);
}

// Month buckets, every month between the first and last tweet (gaps included as zeroes
// so the calendar grid stays a grid). `tweets` is everything that month in order,
// retweets included, because the month page shows them; `count`/`likes`/`rts` count
// own tweets only, because the calendar colours and the totals measure this account.
export function months(archive) {
  const by = new Map();
  for (const t of archive.tweets) {
    if (!by.has(t.month)) by.set(t.month, []);
    by.get(t.month).push(t);
  }
  const keys = [...by.keys()].sort();
  const out = [];
  if (!keys.length) return out;
  const [y0, m0] = keys[0].split('-').map(Number);
  const [y1, m1] = keys.at(-1).split('-').map(Number);
  for (let y = y0; y <= y1; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === y0 && m < m0) continue;
      if (y === y1 && m > m1) continue;
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const ts = by.get(key) || [];
      const own = ts.filter(t => !t.isRetweet);
      out.push({
        key, year: y, month: m,
        tweets: ts,
        count: own.length,
        likes: sum(own, t => t.likes),
        rts: sum(own, t => t.rts),
        retweets: ts.length - own.length,
      });
    }
  }
  return out;
}

// Who gets retweeted, most first. Ties break alphabetically so the table is stable
// across refreshes instead of reshuffling equal-count accounts every build.
export function retweetedAccounts(archive) {
  const by = new Map();
  for (const t of archive.retweets) {
    const a = by.get(t.rtUser) || { user: t.rtUser, count: 0, first: t.date, last: t.date };
    a.count++;
    if (t.date < a.first) a.first = t.date;
    if (t.date > a.last) a.last = t.date;
    by.set(t.rtUser, a);
  }
  return [...by.values()].sort((a, b) =>
    b.count - a.count || a.user.toLowerCase().localeCompare(b.user.toLowerCase()));
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
