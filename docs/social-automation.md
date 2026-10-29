# Social automation (Reddit + Twitter)

The SOCIAL group in the console. It runs her marketing on Reddit and Twitter on
a schedule, so new men find her Telegram bot without anyone posting by hand.

The funnel it serves is the same one FabSwingers served before the ban:

    teaser on Reddit / Twitter
        -> a man notices her, likes the look
        -> finds her Telegram handle (bio or post text)
        -> messages the bot
        -> the bot chats, sends free pictures, sells from the menu

Nothing is ever sold on Reddit or Twitter itself. They are shop windows; the
selling happens in Telegram like it always has.

## The two sections

**Reddit** and **Twitter** are the same page with the same parts, one per
platform:

- **Accounts.** One login per platform, with its API keys. Each account is
  verified against the live site when you add it, so a typo cannot save a
  dead login and queue posts that never go anywhere. Credentials are stored
  encrypted (the same seal the FabSwingers passwords use), never plaintext.
- **Post queue.** Every teaser you write sits here with a state:
  draft, scheduled, posted, failed. The Worker's cron (already running every
  minute for FabSwingers) publishes anything whose time has come, a handful per
  tick. You never have to be awake for it.

## Adding a Reddit account (one-off)

You need two things from Reddit:

1. Her Reddit login (username + password), on a throwaway that reads like a
   real woman's account.
2. A Reddit "app". Go to reddit.com/prefs/apps while signed in as her,
   Create App, choose **script**, name it anything, redirect uri
   `http://localhost:8080`. That gives you a client ID and a secret.

Console: SOCIAL > Reddit > Add account. Fill in her username, password,
client ID and secret. It logs in and checks /me before saving; if the keys
are wrong you get told there and then. Link it to her bot account if you want
the roster to show the pairing (optional, it does not affect posting).

## Adding a Twitter account (one-off)

From developer.twitter.twitter.com (the X developer portal), create a Project,
then an App inside it, and set its permissions to **Read and write** BEFORE
generating the keys (regenerate them if you change permissions after). You
need all four:

- API key + API secret (the consumer pair)
- Access token + access secret (the user pair)

Console: SOCIAL > Twitter > Add account, fill in the handle and the four keys.
Same live check against /users/me before it saves.

Free tier is enough: a few tweets a day, which is all a personal account
should do anyway.

## Writing the posts

New post on either section:

- **Reddit:** subreddit (no r/ needed), a title, optional body text. Keep it
  a teaser, not a reveal: a clothed or partial pic and a line like
  "fancy a chat? more of me on tg". The subreddit's own rules matter more than
  ours: read them before posting anywhere new, some ban link posts or require
  verification. Start with the subs that already allow seller posts.
- **Twitter:** just the text (280 chars) and a schedule time. Same rule:
  tease, never full nudity, or the account dies.
- **Schedule for:** a date and time. Leave it empty to keep the post as a
  draft you can schedule later from the queue.

**Schedule** on a queued draft or failed post sets it going out one minute
from now. **Publish due** runs the queue immediately instead of waiting for
the cron, useful after adding several posts at once.

## Day to day

- Turn an account off (Turn off on the row) to pause its queue without
  deleting anything. Posts stay queued and go out when you turn it back on.
- A failed post shows the site's own error under the state pill. Fix the
  text (usually a subreddit rule or a duplicate) and hit Schedule to retry.
- Pace it like a person: one or two posts a day per platform, evening times
  for the UK. Volume gets accounts banned faster than content does.

## What it does NOT do

- It does not reply to Reddit comments or DMs. The point of every post is to
  move the man to Telegram; the bot does all the talking there.
- It does not auto-generate content. The pictures and lines are yours, so
  nothing reads machine-made where these audiences hate that.
- It does not post nudes for you. That judgement stays with you; both
  platforms will suspend an account that goes too far.

## Where things live

- Console code: `console/index.html`, the `/* Social */` block and the two
  body-level dialogs (`social-dialog`, `social-post-dialog`).
- API: `api/src/social.js`, routes under `/social/*` in `api/src/index.js`.
  The cron entry in `scheduled()` drains the queue alongside the FabSwingers
  poller.
- Database: `social_accounts` and `social_posts` (migration
  `db/migrations/20261029_social_automation.sql`), RLS on both.
- Tests: `api/test/social.test.mjs`.
