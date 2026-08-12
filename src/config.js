import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const PUBLIC_DIR = join(ROOT, 'public');
export const TWEETS_JSON = join(DATA_DIR, 'tweets.json');
export const THREAD_NAMES_JSON = join(DATA_DIR, 'thread-names.json');

export const USERNAME = 'Malcolm_Ocean';
export const SITE = 'https://tweets.malcolmocean.com';
export const SITE_TITLE = 'Malcolm Ocean’s tweets';

// A thread is "worth sharing" if it's long OR well-liked (Malcolm's call).
export const THREAD_MIN_TWEETS = 6;
export const THREAD_MIN_LIKES = 30;
// Below this a chain isn't a thread at all, just a self-reply or two.
export const CHAIN_MIN_TWEETS = 2;
