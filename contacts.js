/**
 * contacts.js - Unsaved contact detection for MATCH Contact Bot
 *
 * WhatsApp's LID (Local Identifier) system is now the default identity
 * for chats (finalized in Baileys 7.x) — WhatsApp increasingly shows
 * people as an opaque @lid JID instead of their real @s.whatsapp.net
 * number, for privacy. The digits inside a @lid JID are NOT a phone
 * number — they're an internal identifier — so a @lid chat can't be
 * deduped or matched against your saved address book just by
 * normalizing it the way you would a real number.
 *
 * Resolution order for a @lid chat, fastest/cheapest first:
 *   1. Our own harvested map (built in index.js from Contact objects'
 *      `phoneNumber`/`lid` fields, and from message keys'
 *      `remoteJidAlt`/`participantAlt` — both confirmed fields as of
 *      Baileys 7.x).
 *   2. Baileys' own official LID<->PN store,
 *      `sock.signalRepository.lidMapping.getPNForLID()` — passed in
 *      here as `resolveLid`, an async function, since that store may
 *      know a mapping ours hasn't seen yet.
 * A @lid chat neither source can resolve is skipped from the export
 * entirely rather than guessed at — see findUnsavedNumbers.
 */

function normalizeJid(jid) {
  return jid ? jid.split('@')[0].replace(/[^0-9]/g, '') : '';
}

function isPhoneNumberJid(jid) {
  return jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

// Resolves a chat JID to its "identity JID" — the real @s.whatsapp.net
// JID if we can find one, otherwise the original JID unchanged (still
// @lid if unresolved). This is what we dedupe and look up saved-contact
// info against, so a person seen under both their lid and their real
// number collapses into ONE entry instead of two.
async function resolveIdentityJid(jid, resolveLid) {
  if (!jid.endsWith('@lid')) return jid;
  if (typeof resolveLid !== 'function') return jid;
  try {
    const pnJid = await resolveLid(jid);
    if (pnJid && pnJid.endsWith('@s.whatsapp.net')) return pnJid;
  } catch (err) {
    console.log(`[DEBUG] resolveLid threw for ${jid}:`, err?.message || err);
  }
  return jid; // still unresolved
}

// Looks up a contact record for an already-resolved identity JID,
// trying the JID itself and the plain number under both suffixes
// (covers cases where the contact store only ever saw one form).
function lookupContact(identityJid, originalJid, number, contactStore) {
  const candidates = [identityJid, originalJid, `${number}@s.whatsapp.net`, `${number}@lid`];
  for (const candidate of candidates) {
    if (candidate && contactStore[candidate]) return contactStore[candidate];
  }
  return {};
}

// Only a contact.name (synced from your phone's address book) proves
// YOU have actually saved this person. notify/pushname/verifiedName are
// set by the OTHER person themselves and say nothing about whether you
// saved them — a stranger who set their own display name still looks
// "named" but is not a saved contact. We keep them out of the identity
// check for that reason; they're still shown in the debug log for
// visibility.
async function findUnsavedNumbers(chatStore, contactStore, resolveLid) {
  const unsaved = [];
  const seenIdentities = new Set();
  let skippedUnresolvedLid = 0;

  console.log(
    `[DEBUG] Total chats in store: ${chatStore.size} | Contacts in store: ${Object.keys(contactStore).length}`
  );

  for (const jid of chatStore) {
    if (!isPhoneNumberJid(jid)) {
      console.log(`[DEBUG] SKIPPED (not a phone/lid jid): ${jid}`);
      continue;
    }

    const identityJid = await resolveIdentityJid(jid, resolveLid);

    // A @lid we could not resolve to a real number has no dialable
    // phone number behind it as far as we currently know. Exporting
    // its lid digits into the .vcf would produce a fake, unusable
    // contact, so we skip it and just report a count — it'll resolve
    // automatically as WhatsApp syncs more of the lid<->pn mapping.
    if (identityJid.endsWith('@lid')) {
      skippedUnresolvedLid += 1;
      console.log(`[DEBUG] jid=${jid} -> SKIPPED (no known real number behind this @lid chat yet)`);
      continue;
    }

    if (seenIdentities.has(identityJid)) {
      console.log(`[DEBUG] jid=${jid} -> already evaluated as ${identityJid}, skipping duplicate`);
      continue;
    }
    seenIdentities.add(identityJid);

    const number = normalizeJid(identityJid);
    if (!number) continue;

    const contact = lookupContact(identityJid, jid, number, contactStore);

    const savedName = (contact.name || '').trim();
    const otherNames = [contact.notify, contact.pushname, contact.verifiedName, contact.shortName]
      .filter(Boolean)
      .map((n) => n.trim());

    const numberWithPlus = `+${number}`;
    const isNumberLike = (val) => /^[\+]?[\d\s\-\(\)]{7,}$/.test(val);

    // Unsaved = no real address-book name, OR the address-book name is
    // itself just the raw number.
    const isUnsaved = !savedName || savedName === numberWithPlus || savedName === number || isNumberLike(savedName);

    console.log(
      `[DEBUG] jid=${jid} identity=${identityJid} number=${number} contact.name="${contact.name || ''}" other=${JSON.stringify(otherNames)} -> ${isUnsaved ? 'UNSAVED' : 'SAVED'}`
    );

    if (isUnsaved) {
      unsaved.push({
        jid: identityJid,
        number,
        displayName: savedName || otherNames[0] || '(no name)',
      });
    }
  }

  console.log(`[DEBUG] Found ${unsaved.length} unsaved contacts. Skipped ${skippedUnresolvedLid} unresolved @lid chat(s).`);
  unsaved.skippedUnresolvedLid = skippedUnresolvedLid;
  return unsaved;
}

function buildVcf(unsaved) {
  let vcfContent = '';
  unsaved.forEach((contact, index) => {
    const tvName = `TV ${index + 1}`;
    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:${tvName}\nTEL;type=CELL:${contact.number}\nEND:VCARD\n`;
  });
  return vcfContent;
}

export { findUnsavedNumbers, buildVcf };
                                                                                   
