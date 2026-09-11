import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

type Fixture = { id: string; file: string };

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'manifest.json');
const images = join(here, 'images');
async function main(): Promise<void> {
const fixtures = JSON.parse(await readFile(manifestPath, 'utf8')) as Fixture[];

await mkdir(images, { recursive: true });
for (const [index, fixture] of fixtures.entries()) {
  if (fixture.id === 'duplicate-renamed') continue;
  const seed = index + 1;
  const visualSeed = fixture.id === 'similar-crop' ? 1 : seed;
  const label = fixture.id.replace(/-/g, ' ').toUpperCase();
  const crop = fixture.id === 'similar-crop';
  const payload = visualSeed & 0b11_1111;
  const parity = payload.toString(2).split('').filter((bit) => bit === '1').length % 2;
  const code = (payload << 2) | (parity << 1) | parity;
  const markers = Array.from({ length: 8 }, (_, row) => {
    const levels = [0];
    for (let column = 0; column < 8; column += 1) {
      levels.push(levels[column]! + (((code >> (7 - column)) & 1) === 1 ? -1 : 1));
    }
    const minimum = Math.min(...levels);
    return Array.from({ length: 9 }, (_, column) => {
      const brightness = 16 + (levels[column]! - minimum) * 28;
      const cell = `<rect x="${column * 100}" y="${row * 162.5}" width="100" height="162.5" fill="rgb(${brightness},${brightness},${brightness})"/>`;
      return cell;
    }).join('');
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300" viewBox="${crop ? '36 26 792 1160' : '0 0 900 1300'}">
    ${markers}
    <rect x="${40 + (visualSeed * 53) % 340}" y="${50 + (visualSeed * 79) % 850}" width="${120 + (visualSeed % 3) * 35}" height="${90 + (visualSeed % 4) * 25}" fill="#${(0x204060 + visualSeed * 1973).toString(16).slice(-6)}" opacity=".78"/>
    <circle cx="${100 + (visualSeed * 97) % 700}" cy="${120 + (visualSeed * 41) % 1000}" r="${28 + (visualSeed % 5) * 9}" fill="#${(0x801820 + visualSeed * 733).toString(16).slice(-6)}" opacity=".75"/>
    <path d="M 60 ${220 + (visualSeed * 17) % 760} L 840 ${310 + (visualSeed * 31) % 760}" stroke="#${(0x163860 + visualSeed * 97).toString(16).slice(-6)}" stroke-width="${8 + visualSeed % 10}"/>
    <rect x="55" y="70" width="790" height="1080" rx="18" fill="#fff" fill-opacity=".15" stroke="#23384d" stroke-width="6"/>
    <text x="100" y="185" font-family="Arial, sans-serif" font-size="46" font-weight="700" fill="#14283d">SYNTHETIC RECEIPT</text>
    <text x="100" y="285" font-family="Arial, sans-serif" font-size="34" fill="#14283d">${label}</text>
    <text x="100" y="420" font-family="Arial, sans-serif" font-size="28" fill="#14283d">seed ${seed} • no private data</text>
    <text x="100" y="575" font-family="Arial, sans-serif" font-size="64" font-weight="700" fill="#14283d">¥ ${(seed * 11 + 9).toFixed(2)}</text>
    <text x="100" y="780" font-family="Arial, sans-serif" font-size="26" fill="#14283d">fixture-only visual marker ${seed}</text>
    <rect x="100" y="850" width="620" height="10" fill="#${(0x435366 + seed * 311).toString(16).slice(-6)}"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(join(images, fixture.file));
}

console.log(`Generated ${fixtures.filter((fixture) => fixture.id !== 'duplicate-renamed').length} synthetic fixture records.`);

const hashes = new Map<string, string>();
for (const fixture of fixtures) {
  if (!hashes.has(fixture.file)) hashes.set(fixture.file, await dHash(await readFile(join(images, fixture.file))));
}
const normal = fixtures.filter((fixture) => fixture.id.startsWith('normal-'));
for (let left = 0; left < normal.length; left += 1) {
  for (let right = left + 1; right < normal.length; right += 1) {
    if (distance(hashes.get(normal[left]!.file)!, hashes.get(normal[right]!.file)!) <= 5) {
      throw new Error(`Normal fixture dHash collision: ${normal[left]!.id}/${normal[right]!.id}`);
    }
  }
}
if (distance(hashes.get('normal-01.png')!, hashes.get('similar-crop.png')!) > 5) {
  throw new Error('The intended crop is not below the dHash suspicion threshold.');
}
}

void main();

async function dHash(bytes: Buffer): Promise<string> {
  const pixels = await sharp(bytes).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let value = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      value <<= 1n;
      if (pixels[row * 9 + column]! > pixels[row * 9 + column + 1]!) value |= 1n;
    }
  }
  return value.toString(16).padStart(16, '0');
}

function distance(left: string, right: string): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}
