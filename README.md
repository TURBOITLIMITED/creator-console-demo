# turbo-creator

Recovered source for the **Turbo Creator Assistant** — the Telegram AI creator
platform that, before this repo existed, lived **only inside Cloudflare**.

> **Provenance warning.** Nothing here was recovered from a git history, because
> there wasn't one. `api/src/*` was extracted from the deployed Worker's
> sourcemap (`sourcesContent`) and `console/*` was downloaded from the live
> Pages site, both on **2026-10-16**. `api/wrangler.jsonc` was reconstructed by
> reading the live binding list over the Cloudflare API. Diff against the
> dashboard before trusting it.

## What is deployed right now

| Piece | Platform | URL | Deploy method |
|---|---|---|---|
| `console/` | Cloudflare **Pages** project `creator-console-demo` | https://telebotcreator.turboit.uk | **Direct upload — no git connection** |
| `api/` | Cloudflare **Worker** `creator-api` | https://api-telebotcreator.turboit.uk | **Hand-run `wrangler deploy` ×10** |
| database | Supabase `turbo-creator-assistant` (`xsgvdlgmhuxozjlbjzxy`) | Turbo IT Org, **eu-west-2** | n/a |
| media | R2 bucket `creator-media` | served via signed `/m/<key>` | n/a |
| inference | Workers AI binding `AI` | vision OCR only | n/a |

Both deploy paths violate the estate rule that a site ships via a git-connected
Cloudflare project. Wiring this repo to Workers Builds is a prerequisite for
treating any of it as production.

## The state of it, honestly

This is a **well-provisioned shell**, not a working product.

- **Telegram cannot work today.** `POST /bots/hook` registers a webhook at
  `/tg/<persona>`, and **no `/tg/` route exists** in `api/src/index.js`. Real
  Telegram updates hit the auth gate with no credential and get `401`. There is
  no inbound handler, no `sendMessage`, and no `business_connection` code.
- **No AI conversation engine.** Workers AI is used only to OCR screenshots of a
  creator's chats (`/style-import`) to learn their voice. No persona prompt, no
  reply generation. The console says so itself: *"The assistant runs on rules
  today, so it is zero."*
- **The database is empty.** 0 conversations, 0 items, 0 payments, 0 bots,
  0 audit rows. `creators` holds 12 test rows from one day, one of them named
  `cNone`. There is **no messages table at all.**
- **The dashboard renders from `console_snapshot.data`**, a single jsonb blob
  whose KPIs (19 replies, 4 conversations, 2.8s median) are not derivable from
  the empty base tables.

## Known defects (do not ship without fixing)

1. `/tg/<persona>` webhook target does not exist — the whole Telegram loop is open.
2. `ADMIN_TOKEN` is a global cross-tenant god-token; `?creator=<id>` impersonates
   anyone, defaulting to `"ava"`. Compared with `===`, not constant-time.
3. `MEDIA_SECRET` falls back to the literal `"dev"` when unset — fails **open**.
4. All table access uses `SUPABASE_SERVICE_KEY`, bypassing RLS. The 8 RLS
   policies only guard the browser's direct `console_snapshot` read.
5. `bots.token` and `creators.dashboard_token` are **plaintext at rest**.
6. Zero logging anywhere. No audit trail beyond `settings.value.{by,at}`.
7. `/style-probe` — a 4-model x 3-payload debug harness — is live in production
   and burns Workers AI calls on every call.
8. 500 responses omit CORS headers, so browsers see a CORS error, not the cause.
9. Console tables mislabel columns: "All creators" renders 4 of 9 columns with
   the wrong data; "Payouts owed" advertises Split/They keep/We take and never
   computes them; "Revenue by plan" groups by revenue total, not plan.
10. No rate limiting, no cron, no queue, no Durable Object.

## What is genuinely good and worth keeping

- Console auth: Supabase session -> **AAL2 TOTP MFA** -> RLS-gated row read.
  `disable_signup: true`. `is_console_admin()` is SECURITY DEFINER with a pinned
  `search_path`.
- Signed-media serving: HMAC + server-side expiry + **constant-time** compare,
  TTL clamped to [60s, 7d], per-owner key prefix check.
- `payments.processor_ref` is UNIQUE — a ready-made payment idempotency key.
- Schema has real PKs, FKs and `ON DELETE CASCADE` throughout.
- `/style-import` strips names, handles, links and prices before modelling tone.

## Layout

```
api/      Cloudflare Worker `creator-api` (recovered from sourcemap)
console/  Cloudflare Pages site (downloaded from the live origin)
docs/     sourcemap + audit artefacts
```
