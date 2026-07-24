/**
 * MATCH Contact Bot — multi-account manager
 * -------------------------------------------
 * YOUR own WhatsApp account (PHONE_NUMBER) is the admin session. Only
 * you, messaging yourself, can send:
 *
 *     connect <country_code_without_plus> <local_number>
 *
 * e.g.  connect 234 8121081916
 *
 * ...which pairs a NEW, fully separate WhatsApp account into the bot —
 * its own auth, its own chat/contact store, completely isolated from
 * yours and from every other connected account. The resulting pairing
 * code is sent back to YOU (never exposed to the new member directly),
 * so you relay it to them yourself. They then link it exactly the same
 * manual way you did: WhatsApp > Settings > Linked Devices > Link a
 * Device > "Link with phone number instead" > enter the code.
 *
 * Every connected account (yours included) can message itself "export"
 * to get its own unsaved-contacts .vcf. NO connected account other than
 * yours can use "connect" — this isn't a permission check that could be
 * bypassed, it's that the command is only ever wired up on your session
 * (see handleExtraCommand below); a member's session simply has no code
 * path that leads to it.
 *
 * Capped at MAX_CONNECTED_ACCOUNTS (default 10, INCLUDING you — change
 * the env var if you meant 10 besides yourself). Once at the cap,
 * "connect" just replies with a plain refusal. Deliberately NOT a
 * crash: a real crash kills this whole process, which would take down
 * every already-connected member's live session too, not just block
 * the 11th. A graceful cap protects everyone already connected.
 *
 * Everything else here — the healthcheck server, the single-request
 * pairing-code flow, syncFullHistory/markOnlineOnConnect, the @lid
 * resolution logic — is EXACTLY what your account was already running
 * before "connect" existed. It's just been extracted into
 * accountSession.js (one instance per connected account) instead of
 * being hardcoded to a single account.
 *
 * NOTE: no persistent volume on the free plan, so auth/store files for
 * EVERY connected account reset on every redeploy — same limitation as
 * before, just now multiplied across however many accounts are
 * connected at redeploy time. All of them would need to re-pair from
 * scratch after a restart, same manual process as the very first
 * pairing.
 */

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAccountSession } from './accountSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = __dirname;

const OWNER_PHONE_NUMBER = process.env.PHONE_NUMBER; // e.g. "2348121081916"
const MAX_CONNECTED_ACCOUNTS = parseInt(process.env.MAX_CONNECTED_ACCOUNTS || '10', 10); // includes the owner

// --- Railway needs something listening on $PORT ---
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MATCH Contact Bot is running.\n');
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on port ${PORT}`));

// accountId (== phone number, "owner" for yours) -> { session, phoneNumber }
const accounts = new Map();
let ownerSession = null;

function ownerSock() {
  return ownerSession?.getSock();
}

function totalAccounts() {
  return accounts.size;
}

async function connectMember(countryCode, localNumberRaw, ownerJid) {
  const localNumber = localNumberRaw.replace(/^0+/, ''); // same normalization used for PHONE_NUMBER itself
  const fullNumber = `${countryCode}${localNumber}`;

  if (totalAccounts() >= MAX_CONNECTED_ACCOUNTS) {
    await ownerSock()?.sendMessage(ownerJid, {
      text: `Can't connect another account — limit of ${MAX_CONNECTED_ACCOUNTS} reached (${totalAccounts()}/${MAX_CONNECTED_ACCOUNTS}).`,
    });
    return;
  }
  if (accounts.has(fullNumber)) {
    await ownerSock()?.sendMessage(ownerJid, { text: `${fullNumber} is already connected or connecting.` });
    return;
  }

  // Reserve the slot synchronously, before any await below, so two
  // rapid "connect" calls for two different numbers can't both pass
  // the cap check before either finishes registering.
  accounts.set(fullNumber, { phoneNumber: fullNumber });
  await ownerSock()?.sendMessage(ownerJid, { text: `Starting connection for ${fullNumber}…` });

  const session = createAccountSession({
    accountId: fullNumber,
    phoneNumber: fullNumber,
    baseDir: BASE_DIR,
    onPairingCode: async (code) => {
      await ownerSock()?.sendMessage(ownerJid, {
        text:
          `Pairing code for ${fullNumber}: ${code}\n\n` +
          `Send this to them now — it expires in under a minute. They enter it at: ` +
          `WhatsApp > Settings > Linked Devices > Link a Device > "Link with phone number instead".`,
      });
    },
    onPairingFailure: async () => {
      accounts.delete(fullNumber);
      await ownerSock()?.sendMessage(ownerJid, {
        text: `Connecting ${fullNumber} failed before pairing completed. Try "connect ${countryCode} ${localNumberRaw}" again.`,
      });
    },
    onOpen: async () => {
      await ownerSock()?.sendMessage(ownerJid, {
        text: `${fullNumber} is connected. They can now message themselves "export".`,
      });
    },
    // No handleExtraCommand passed — this account gets ONLY "export".
  });

  accounts.set(fullNumber, { session, phoneNumber: fullNumber });
  session.start();
}

async function startOwner() {
  if (!OWNER_PHONE_NUMBER) {
    console.error('\nSet the PHONE_NUMBER environment variable and restart.\n');
    process.exit(1);
  }

  ownerSession = createAccountSession({
    accountId: 'owner',
    phoneNumber: OWNER_PHONE_NUMBER,
    baseDir: BASE_DIR,
    onPairingCode: (code) => {
      console.log('\n================================');
      console.log(' PAIRING CODE (owner):', code);
      console.log(' Settings > Linked Devices > Link a Device');
      console.log(' > "Link with phone number instead" > enter this code');
      console.log(' This code expires in under a minute — have the phone');
      console.log(' already sitting on the entry screen before this prints.');
      console.log('================================\n');
    },
    onPairingFailure: (err) => {
      console.error('Owner pairing failed or was closed before completing:', err?.message || err);
    },
    onOpen: () => {
      console.log('Owner connected. "export" and "connect <cc> <number>" are both available.');
    },
    // Only the owner's session gets this hook — this is the ONLY place
    // "connect" is ever reachable from.
    handleExtraCommand: async (text, ownJid, sock) => {
      const parts = text.split(/\s+/);
      if (parts[0]?.toLowerCase() !== 'connect') return false; // not for us — fall through to "export"

      if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) {
        await sock.sendMessage(ownJid, {
          text: 'Usage: connect <country code, no +> <number>\ne.g. connect 234 8121081916',
        });
        return true;
      }
      await connectMember(parts[1], parts[2], ownJid);
      return true;
    },
  });

  accounts.set('owner', { session: ownerSession, phoneNumber: OWNER_PHONE_NUMBER });
  await ownerSession.start();
}

startOwner().catch((err) => console.error('Failed to start owner session:', err));

// Don't let one bad event silently crash the whole container — this
// now matters even more, since a crash here takes down EVERY connected
// account's session, not just one.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
