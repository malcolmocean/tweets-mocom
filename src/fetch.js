// Pulls the full tweet archive for ACCOUNT from community-archive.org into data/tweets.json.
//
// Deliberately a full refetch (~60 paged requests): engagement counts on OLD tweets
// keep changing, so an incremental "only new tweets" pull would freeze likes/RTs at
// their first-seen values and quietly rot the /top and by-month colour data.
// This is the auto-update entry point — run it on a schedule, then `build`.
import { writeFile, mkdir } from 'node:fs/promises';
import { caPaged, findAccount } from './archive.js';
import { USERNAME, DATA_DIR, TWEETS_JSON } from './config.js';

const SELECT = [
  'tweet_id', 'created_at', 'full_text', 'favorite_count', 'retweet_count',
  'reply_to_tweet_id', 'reply_to_user_id', 'reply_to_username',
  'tweet_media(media_url,media_type)',
  'tweet_urls(url,expanded_url,display_url)',
  'quote_tweets(quoted_tweet_id)',
].join(',');

const log = (...a) => console.log(...a);

async function main() {
  const account = await findAccount(USERNAME);
  log(`account @${account.username} (${account.account_id}) — ${account.num_tweets} tweets claimed`);

  const rows = await caPaged('tweets', `account_id=eq.${account.account_id}&select=${SELECT}`, {
    // tweet_id is unique and monotonic-ish; ordering on it keeps offset paging stable
    // in a way created_at (with ties) does not.
    order: 'tweet_id.asc',
    onPage: n => log(`  fetched ${n}…`),
  });
  log(`fetched ${rows.length} tweets`);

  const tweets = rows.map(t => ({
    id: String(t.tweet_id),
    at: t.created_at,
    text: t.full_text,
    likes: t.favorite_count ?? 0,
    rts: t.retweet_count ?? 0,
    replyTo: t.reply_to_tweet_id ? String(t.reply_to_tweet_id) : null,
    replyToUser: t.reply_to_user_id ? String(t.reply_to_user_id) : null,
    replyToUsername: t.reply_to_username || null,
    media: (t.tweet_media || []).map(m => ({ url: m.media_url, type: m.media_type })),
    urls: (t.tweet_urls || [])
      .filter(u => u.expanded_url)
      .map(u => ({ t: u.url, x: u.expanded_url, d: u.display_url })),
    quotes: (t.quote_tweets || [])[0]?.quoted_tweet_id
      ? String(t.quote_tweets[0].quoted_tweet_id)
      : null,
  }));
  tweets.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TWEETS_JSON, JSON.stringify({
    account: {
      id: String(account.account_id),
      username: account.username,
      displayName: account.account_display_name,
      followers: account.num_followers ?? null,
    },
    fetchedAt: new Date().toISOString(),
    tweets,
  }));
  log(`wrote ${TWEETS_JSON}`);
}

main().catch(e => { console.error(e); process.exit(1); });
