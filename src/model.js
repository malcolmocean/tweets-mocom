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

export async function loadArchive() {
  const raw = JSON.parse(await readFile(TWEETS_JSON, 'utf8'));
  const byId = new Map(raw.tweets.map(t => [t.id, t]));
  for (const t of raw.tweets) {
    t.text = decodeEntities(t.text);
    t.month = t.at.slice(0, 7);       // YYYY-MM (UTC)
    t.date = t.at.slice(0, 10);
    // A reply to someone else, or to a tweet that isn't in the archive, starts a
    // new conversation from this site's point of view.
    t.isSelfReply = Boolean(t.replyTo && byId.has(t.replyTo) &&
      (!t.replyToUser || t.replyToUser === raw.account.id));
    t.isReplyToOther = Boolean(t.replyTo && !t.isSelfReply);
  }
  return { ...raw, byId };
}

// Self-reply chains. The root may itself be a reply to someone else — a thread hung
// off a reply still reads as a thread — what makes it a root is that its parent isn't
// an own tweet in the archive. Where a tweet has several self-replies (branching),
// the earliest child continues the main chain; other branches start their own.
export function assembleChains(archive) {
  const { tweets, byId } = archive;
  const children = new Map();
  for (const t of tweets) {
    if (!t.isSelfReply) continue;
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
    if (t.isSelfReply && byId.has(t.replyTo)) continue; // not a root
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
// so the calendar grid stays a grid).
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
      out.push({
        key, year: y, month: m,
        tweets: ts,
        count: ts.length,
        likes: sum(ts, t => t.likes),
        rts: sum(ts, t => t.rts),
      });
    }
  }
  return out;
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
