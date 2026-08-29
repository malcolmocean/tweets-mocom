import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const PUBLIC_DIR = join(ROOT, 'public');
export const TWEETS_JSON = join(DATA_DIR, 'tweets.json');
export const THREAD_NAMES_JSON = join(DATA_DIR, 'thread-names.json');
export const EMBEDS_JSON = join(DATA_DIR, 'embeds.json');

export const USERNAME = 'Malcolm_Ocean';
export const SITE = 'https://tweets.malcolmocean.com';
export const SITE_TITLE = 'Malcolm Ocean’s tweets';

// This site lives on Malcolm's personal Cloudflare account, and this machine may
// also be logged into a work one. update.js checks `wrangler whoami` against this
// before it deploys anything.
export const DEPLOY_ACCOUNT_EMAIL = 'malcolm.m.ocean@gmail.com';

// A thread is "worth sharing" if it's long OR well-liked (Malcolm's call).
export const THREAD_MIN_TWEETS = 6;
export const THREAD_MIN_LIKES = 30;
// …but four tweets is the floor either way. A one-liner with an afterthought or two
// is a tweet that kept going, not a thread, however well it did — and the well-liked
// short ones are already on /top/.
export const THREAD_MIN_LEN = 4;
// Below this a chain isn't a chain at all. Chains under THREAD_MIN_LEN still group
// visually on the month pages; they just don't get a page of their own.
export const CHAIN_MIN_TWEETS = 2;

// How many rows the "most of X" pages carry.
export const TOP_TWEETS = 500;
// How many of those the homepage draws its random tweet from. Fetched after the
// page renders, so this is a size budget rather than a page-weight one.
export const RANDOM_TOP_SAMPLE = 150;
export const TOP_REPLIES = 250;

// Replies that earned their likes but not their place at the top of /replies/. They
// stay on the page — the archive doesn't hide things — but sort below every other
// reply instead of leading the list. Reasons are kept next to the ids, because
// "why is this one down here" is the only question the list raises.
export const DEMOTED_REPLIES = new Set([
  '1804197674809463019', // carabiners: well-liked, not worth reading first
  '1795022615687401731', // "everything is monocausal": ditto
  '1680075236509622272', // the tweet it answers is deleted, so it's half a conversation
]);
