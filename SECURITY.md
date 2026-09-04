# Security

## Reporting a vulnerability

Report it privately through GitHub, not in a public issue:

1. Go to the **Security** tab of
   <https://github.com/0xmythril/steno-personal>.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker gets.

That opens a private advisory only the maintainers can see, and it lets you be
credited on the published advisory if you want to be. There is deliberately no
security email address: a private advisory is easier for you, harder to lose,
and keeps the whole exchange in one place.

Expect an acknowledgement within a week. This is a small project run by people
with other jobs — there is no bounty and no response-time commitment beyond
best effort. If you have had no reply in two weeks, open a public issue saying
only that you are waiting on a private report; that is a nudge, not a
disclosure.

Please do not test against anyone else's instance. Run your own — it takes one
`docker compose up`.

### In scope

Anything that lets someone read an archive without a valid access key; anything
that leaks a secret (an access key, the encryption key, a session string, the
OpenRouter key) into a log line, an API response, or a page; anything that makes
the software send a message, mark a chat read, or otherwise become visible in
the user's chats; anything that serves a deleted message; anything that lets one
crafted chat message change what the server does rather than what it stores.

### Out of scope

The accepted risks in [docs/threat-model.md](docs/threat-model.md) — chiefly
that a leaked access key exposes the archive until it is revoked, that a leaked
disk exposes the messages, and that WhatsApp may restrict a number using an
unofficial client. Those are documented decisions, not bugs. Also out of scope:
missing rate limiting on the login endpoint (key entropy is the control), and
anything requiring an attacker to already have shell access to the machine.

## Supported versions

The latest release. This project has one maintained line; fixes go on top of
`main` and ship as a new tag. Upgrading is `git pull` and a restart — see
[docs/self-hosting.md](docs/self-hosting.md).

## How the guarantees are kept

Security here is mostly a matter of removing capabilities rather than guarding
them, and the removals are checked automatically on every change.

**Two credentials, neither a password.** There is no password and no account.
Access keys are 32 random bytes, labelled, minted and revoked individually, and
shown once; they are the login for the web portal and the bearer token for the
agent endpoint. Passkeys (WebAuthn) log into the portal only and are never
accepted as a bearer token, so an agent's credential can never be a passkey and
a passkey can never be pasted anywhere. Revoking either immediately ends every
browser session that was created with it. Each credential's last-used time is
on the Settings page, so an unexpected one is visible.

**Secrets stay inside the process.** The Telegram session, the OpenRouter key,
and the re-readable copy of each access key are encrypted at rest with a key
derived from `SECRET_KEY`. None of them appears in a log line, an API response,
or a status payload. The one documented exception is a key you ask for by
setting `STENO_MINT_KEY`, printed once in the boot log because with every key
lost and no phone to pair there would be no other way in — remove the variable
and revoke that key as soon as you have minted your own.

**Only two files can talk to a chat network.** The Telegram library is imported
by exactly one file, the WhatsApp library by exactly one other. Nothing else in
the codebase can open a connection to a chat service, and a repo-wide test fails
the build if that changes. It keeps the read-only and stay-invisible guarantees
auditable by reading two files instead of the whole tree.

**Nothing can silently revoke.** A single function marks a connection revoked.
No error handler, retry loop, or background job can do it behind your back.

**The tools cannot write.** The interface every channel implements has no send
method, and the agent-facing tools are all reads. There is nothing to escalate
to.

**Requests are authenticated at the edge of every route.** Web pages and API
routes accept a session cookie or a bearer access key; server actions re-check
the session themselves rather than trusting the page that rendered them, and a
test enforces that.

## Hardening your own instance

- Prefer a machine at home to a public host. If you do use a public host, the
  URL is guessable and access keys are the only barrier.
- Put it behind a reverse proxy with TLS, and make sure the proxy sets
  `X-Forwarded-Proto: https` so the session cookie is issued as `Secure`. See
  [docs/self-hosting.md](docs/self-hosting.md).
- Claim a public deploy as soon as it is green: until the first access key
  has been minted, `/setup` is open to whoever reaches the URL first. The
  claim is bound to the browser that started it: from the moment you have
  begun pairing, on either channel, every other visitor is refused — they
  cannot finish your pairing, start their own, or take the first key — but
  anyone who arrives before you can claim the instance instead.
- Mint one key per device or agent, and revoke any key that was ever printed
  to a log once you have replaced it.
- Register a passkey on the browsers you use, and keep keys for agents. A
  passkey cannot be phished onto another site or copied out of a config file.
- Do not expose the port to the internet if you only use it at home; the
  supplied compose file binds to `127.0.0.1` on purpose.
- Encrypt the disk. Encryption at rest here covers the secrets that have to be
  re-readable; the messages themselves are as safe as the volume they sit on.
- Back up `DATA_DIR` somewhere you would also be comfortable storing the chats
  themselves, because that is what a backup is.
