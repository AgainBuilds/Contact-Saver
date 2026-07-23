# MATCH Contact Bot

Connects to a WhatsApp account (linked by its own owner, via pairing code —
no QR scan, no screen share needed) and, on request, exports every
**unsaved contact** as a ready-to-import `.vcf` file, labeled `MATCH 1`,
`MATCH 2`, `MATCH 3`, etc.

## How the client links their account

1. You deploy this bot (see below) and set `PHONE_NUMBER` to the
   **client's own WhatsApp number** (international format, digits only,
   e.g. `2348012345678`).
2. On startup, the bot prints an 8-character pairing code in the logs.
3. Send that code to the client. They open WhatsApp on **their own phone**:
   `Settings → Linked Devices → Link a Device → "Link with phone number instead"`
   and type in the code.
4. Their account is now linked. They can unlink it themselves anytime from
   that same Linked Devices screen — they stay in control.

## How the client uses it

Once connected, the client just opens their own **"Message Yourself"**
chat in WhatsApp and types:

```
export
```

The bot scans their chats, finds every contact that's still showing as a
raw phone number (never saved), and sends back a `MATCH-contacts.vcf`
file right there in the chat. They tap it, and their phone imports all
the contacts in one go, named `MATCH 1`, `MATCH 2`, etc.

## Local setup

```bash
npm install
PHONE_NUMBER=2348012345678 npm start
```

## Deploying to Railway (recommended — runs 24/7 in the background)

1. Push this folder to a GitHub repo.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select the repo.
4. Under **Variables**, add `PHONE_NUMBER` = the client's number.
5. Deploy. Open the **Logs** tab (works fine from your phone browser) to
   see the pairing code when it's ready.
6. Once linked, the bot keeps running in the background — no laptop or
   phone needed to stay open.

**Important:** the `auth_info/` folder holds the session after linking.
On Railway, add a **Volume** mounted at `/app/auth_info` so the session
survives redeploys — otherwise it'll ask to be re-linked every time the
service restarts.

## Notes

- Only messages the account sends **to itself** trigger the export — no
  one else can request it by messaging the number.
- "Unsaved" is detected by checking if WhatsApp has no saved contact name
  on file for that chat (only a phone number or their own self-set display name).
