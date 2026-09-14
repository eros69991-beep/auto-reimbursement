const raw = process.env.VITE_API_BASE_URL?.trim();
let valid = false;

try {
  const url = new URL(raw ?? '');
  valid =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === raw &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
} catch {
  valid = false;
}

if (!valid) {
  console.error(
    'VITE_API_BASE_URL is required for Netlify production builds and must be an HTTP(S) origin',
  );
  process.exitCode = 1;
}
