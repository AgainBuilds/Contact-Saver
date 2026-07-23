/**
 * Improved Unsaved Contacts Detection
 */

const RAW_NUMBER_PATTERN = /^\+?[\d\s]{7,}$/;

function findUnsavedNumbers(contacts) {
  const seen = new Set();
  const unsaved = [];

  for (const jid of Object.keys(contacts || {})) {
    if (!jid.endsWith('@s.whatsapp.net')) continue;

    const contact = contacts[jid];
    const number = jid.split('@')[0];

    if (seen.has(number)) continue;
    seen.add(number);

    // More lenient detection of unsaved contacts
    const isSaved = contact?.name || 
                   (contact?.verifiedName && contact.verifiedName !== number) ||
                   contact?.pushname;

    if (isSaved) continue;

    // Only add real phone numbers
    if (RAW_NUMBER_PATTERN.test(number)) {
      unsaved.push(number);
    }
  }

  return unsaved;
}

function buildVcf(numbers) {
  let content = '';
  numbers.forEach((number, i) => {
    const label = `MATCH ${i + 1}`;
    content += `BEGIN:VCARD\nVERSION:3.0\nFN:\( {label}\nTEL;TYPE=CELL:+ \){number}\nEND:VCARD\n`;
  });
  return content;
}

module.exports = { findUnsavedNumbers, buildVcf, RAW_NUMBER_PATTERN };
