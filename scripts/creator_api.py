#!/usr/bin/env python3
"""Shared request headers for this box's calls to the Turbo IT creator API.

Cloudflare's Browser Integrity Check on api-telebotcreator.turboit.uk challenges
the default urllib agent (HTTP 403, error code 1010). The zone carries a scoped
skip rule that matches the X-TurboIT-Internal header, so a script that calls the
API needs two things on every request:

  * that header, with the value read from the secret store or the environment;
  * a real User-Agent.

The secret is never stored in this file. It is read from TURBOIT_INTERNAL_SECRET,
or from the env file named by CREATOR_API_ENV_FILE (default
~/.config/turbo-it/demo-bot.env, mode 600).

Use headers() ONLY for requests to api-telebotcreator.turboit.uk. Never merge it
into a call to Telegram, Supabase, Stripe or any other host: the secret would
leak to a third party.

Run this file directly for a read-only check that the header still passes:

    python3 scripts/creator_api.py
"""
import os
import pathlib
import sys
import urllib.error
import urllib.request

API_BASE = "https://api-telebotcreator.turboit.uk"
HEADER_NAME = "X-TurboIT-Internal"
ENV_VAR = "TURBOIT_INTERNAL_SECRET"
DEFAULT_UA = "TurboIT-creator-scripts/1.0"
DEFAULT_ENV_FILE = pathlib.Path.home() / ".config" / "turbo-it" / "demo-bot.env"

_secret = None


def env_file():
    override = os.environ.get("CREATOR_API_ENV_FILE", "")
    return pathlib.Path(override) if override else DEFAULT_ENV_FILE


def secret():
    """The shared internal secret, from the environment or the env file. Never printed."""
    global _secret
    if _secret is None:
        value = os.environ.get(ENV_VAR, "")
        if not value:
            path = env_file()
            if path.exists():
                for line in path.read_text().splitlines():
                    s = line.strip()
                    if s.startswith(ENV_VAR + "="):
                        value = s.split("=", 1)[1].strip().strip('"').strip("'")
        _secret = value
    return _secret


def headers(base=None, **extra):
    """Merge the internal header and a real User-Agent into a header dict for the creator API."""
    out = dict(base or {})
    out.update(extra)
    value = secret()
    if value:
        out.setdefault(HEADER_NAME, value)
    else:
        print(f"warning: {ENV_VAR} is not set, so the call may be refused by Browser Integrity Check",
              file=sys.stderr)
    out.setdefault("User-Agent", DEFAULT_UA)
    return out


def check():
    """Read-only check: a harmless public GET that proves the header passes the edge.

    /push/key needs no credential and returns only the VAPID public key (public by
    design), so the check proves the edge accepts us without touching any data.
    """
    url = API_BASE + "/push/key"
    req = urllib.request.Request(url, headers=headers({"Accept": "application/json"}))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            print(f"GET /push/key -> HTTP {resp.status}, {len(body)} bytes")
            return 0 if resp.status == 200 else 1
    except urllib.error.HTTPError as e:
        print(f"GET /push/key -> HTTP {e.code} (expected 200)")
        return 1


if __name__ == "__main__":
    sys.exit(check())
