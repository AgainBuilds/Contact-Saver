/**
 * Pure logic for finding "unsaved" contacts and building a .vcf file.
 * Kept separate from the Baileys connection code so it can be unit
 * tested with fake data (no live WhatsApp connection needed).
 */

const RAW_NUMBER_PATTERN = /^\+?[\d\s]{7,}$/;

/**
 * @param {Object} contacts - Baileys' contact store, keyed by jid.
 *   Each entry looks like: { name?, notify?, verifiedName? }
 *   `name` is only set if YOU saved them in your phone contacts.
 *   `notify` is the display name THEY set for themselves (pushName) —
 *   not proof you saved them.
 */
function findUnsavedNumbers(contacts) {
  const seen = new Set();
  const unsaved = [];

  for (const jid of Object.keys(contacts || {})) {
    if (!jid.endsWith('@s.whatsapp.net')) continue; // skip groups/broadcast/status
    const contact = contacts[jid];
    const number = jid.split('@')[0];

    if (seen.has(number)) continue;

    // Saved = has a real `name` (only ever set from the phone's own contacts).
    if (contact?.name) continue;

    unsaved.push(number);
    seen.add(number);
  }

  return unsaved;
}

function buildVcf(numbers) {
  let content = '';
  numbers.forEach((number, i) => {
    const label = `MATCH ${i + 1}`;
    content += `BEGIN:VCARD\nVERSION:3.0\nFN:${label}\nTEL;TYPE=CELL:+${number}\nEND:VCARD\n`;
  });
  return content;
}

module.exports = { findUnsavedNumbers, buildVcf, RAW_NUMBER_PATTERN };
