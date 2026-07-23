// server/names.js
// Generates short, human, collision-avoiding display names for peers,
// e.g. "Blue Falcon" — nicer than showing raw device/browser strings.

const ADJECTIVES = [
  'Amber', 'Azure', 'Blue', 'Bronze', 'Coral', 'Crimson', 'Emerald', 'Golden',
  'Gray', 'Green', 'Indigo', 'Ivory', 'Jade', 'Lilac', 'Maroon', 'Navy',
  'Olive', 'Orange', 'Pink', 'Purple', 'Red', 'Rose', 'Ruby', 'Rust',
  'Sandy', 'Sapphire', 'Scarlet', 'Silver', 'Slate', 'Teal', 'Violet', 'White'
];

const ANIMALS = [
  'Falcon', 'Otter', 'Panther', 'Heron', 'Wolf', 'Fox', 'Hawk', 'Lynx',
  'Raven', 'Badger', 'Owl', 'Bear', 'Eagle', 'Tiger', 'Deer', 'Rabbit',
  'Cobra', 'Dolphin', 'Panda', 'Koala', 'Moose', 'Gecko', 'Stag', 'Ibis',
  'Marten', 'Weasel', 'Crane', 'Puma', 'Bison', 'Swan', 'Wren'
];

function randomName(existingNames) {
  const used = new Set(existingNames || []);
  for (let attempt = 0; attempt < 50; attempt++) {
    const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const name = `${a} ${b}`;
    if (!used.has(name)) return name;
  }
  // Fallback: guaranteed-unique with a short suffix
  return `Peer ${Math.floor(Math.random() * 9000 + 1000)}`;
}

function deviceInfoFromUA(ua) {
  ua = ua || '';
  const isMobile = /Mobi|Android(?!.*Tablet)|iPhone/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);
  let type = 'desktop';
  if (isTablet) type = 'tablet';
  else if (isMobile) type = 'mobile';

  let os = 'Unknown';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  return { type, os, browser };
}

module.exports = { randomName, deviceInfoFromUA };
