/**
 * contacts.js - Unsaved contact detection for MATCH Contact Bot
 *
 * WhatsApp's privacy mode ("linked ID") can represent the same person
 * as two different chat JIDs: their real number (@s.whatsapp.net) and
 * an opaque @lid identifier. The digits inside a @lid JID are NOT a
 * phone number — they're an internal identifier — so you cannot dedupe
 * or look up a saved name for a @lid chat just by normalizing it the
 * same way you would a real number.
 *
 * If a contact is saved under their real number but you only ever see
 * them show up as a @lid chat, the old logic had no way to connect the
 * two and would flag them as "unsaved" even though they're saved.
 *
 * `lidMap` (built in index.js from contacts.upsert/set/update and from
 * message key remoteJid/remoteJidAlt pairs) bridges the two: it maps
 * lidJid -> pnJid and pnJid -> lidJid whenever Baileys hands us both
 * for the same person.
 */

function normalizeJid(jid) {
  return jid ? jid.split('@')[0].replace(/[^0-9]/g, '') : '';
}

function isPhoneNumberJid(jid) {
  return jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

// Given a chat JID, resolve it to its "identity key" — the @s.whatsapp.net
// JID if we know one (via lidMap), otherwise the JID itself. This is what
// we dedupe and look up contact info against, so a person seen under both
// their lid and their real number collapses into ONE entry instead of two.
function resolveIdentityJid(jid, lidMap) {
  if (jid.endsWith('@lid') && lidMap && lidMap[jid] && lidMap[jid].endsWith('@s.whatsapp.net')) {
    return lidMap[jid];
  }
  return jid;
}

// Looks up a contact record for a JID, trying the JID itself, its lid/pn
// counterpart (if mapped), and the plain number under both suffixes.
function lookupContact(jid, number, contactStore, lidMap) {
  const candidates = [jid];
  if (lidMap && lidMap[jid]) candidates.push(lidMap[jid]);
  candidates.push(`${number}@s.whatsapp.net`, `${number}@lid`);

  for (const candidate of candidates) {
    if (contactStore[candidate]) return contactStore[candidate];
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
function findUnsavedNumbers(chatStore, contactStore, lidMap = {}) {
  const unsaved = [];
  const seenIdentities = new Set();

  console.log(
    `[DEBUG] Total chats in store: ${chatStore.size} | Contacts in store: ${Object.keys(contactStore).length} | lid<->pn links: ${Object.keys(lidMap).length / 2}`
  );

  for (const jid of chatStore) {
    if (!isPhoneNumberJid(jid)) {
      console.log(`[DEBUG] SKIPPED (not a phone/lid jid): ${jid}`);
      continue;
    }

    // Collapse @lid chats to their real-number identity when we know the
    // mapping, so the same person isn't evaluated twice under two JIDs.
    const identityJid = resolveIdentityJid(jid, lidMap);
    if (seenIdentities.has(identityJid)) {
      console.log(`[DEBUG] jid=${jid} -> already evaluated as ${identityJid}, skipping duplicate`);
      continue;
    }
    seenIdentities.add(identityJid);

    const number = normalizeJid(identityJid);
    if (!number) continue;

    const contact = lookupContact(identityJid, number, contactStore, lidMap);

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

  console.log(`[DEBUG] Found ${unsaved.length} unsaved contacts.`);
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

module.exports = { findUnsavedNumbers, buildVcf };
