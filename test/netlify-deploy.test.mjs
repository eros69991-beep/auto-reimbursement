import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('Netlify rejects a production build without a public API origin', () => {
  const env = { ...process.env };
  delete env.VITE_API_BASE_URL;
  const validation = spawnSync('node test/validate-netlify-env.mjs', {
    cwd: root,
    encoding: 'utf8',
    env,
    shell: true,
  });

  assert.notEqual(validation.status, 0);
  assert.match(
    validation.stderr,
    /VITE_API_BASE_URL is required for Netlify production builds/,
  );
});

test('Netlify builds the SPA with the configured Railway origin and no server secrets', () => {
  const gitignore = readFileSync(new URL('.gitignore', root), 'utf8');
  assert.match(gitignore, /^\.netlify\/$/m, 'local Netlify state must be ignored');
  assert.match(gitignore, /^work\/$/m, 'local smoke data must be ignored');

  const configUrl = new URL('netlify.toml', root);
  assert.equal(existsSync(configUrl), true, 'netlify.toml must exist');
  const config = readFileSync(configUrl, 'utf8');
  assert.match(config, /node test\/validate-netlify-env\.mjs/);
  assert.doesNotMatch(
    config,
    /AI_BASE_URL|AI_MODEL|AI_API_KEY|DEEPSEEK|sk-[A-Za-z0-9_-]+/i,
  );
  assert.equal(
    existsSync(new URL('apps/web/public/api-unavailable.json', root)),
    false,
    'the absolute API client must not retain the obsolete relative API fallback',
  );

  const command = config.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const publish = config.match(/^\s*publish\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert.ok(command, 'Netlify build command must be configured');
  assert.equal(publish, 'apps/web/dist');

  const build = spawnSync(command, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    env: {
      ...process.env,
      VITE_API_BASE_URL: 'https://api.example.railway.app',
    },
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const publishUrl = new URL(`${publish}/`, root);
  const indexHtml = readFileSync(new URL('index.html', publishUrl), 'utf8');
  const bundleName = indexHtml.match(/assets\/([^"']+\.js)/)?.[1];
  assert.ok(bundleName, 'built index must reference a JavaScript bundle');
  const bundle = readFileSync(new URL(`assets/${bundleName}`, publishUrl), 'utf8');
  assert.match(bundle, /https:\/\/api\.example\.railway\.app/);
  assert.doesNotMatch(bundle, /AI_API_KEY|sk-[A-Za-z0-9_-]{12,}/);

  const redirects = [...config.matchAll(/\[\[redirects\]\]/g)];
  assert.equal(redirects.length, 1, 'only the SPA fallback is needed');
  assert.match(
    config,
    /from\s*=\s*"\/\*"[\s\S]*?to\s*=\s*"\/index\.html"[\s\S]*?status\s*=\s*200/,
  );
  assert.match(config, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(config, /X-Frame-Options\s*=\s*"DENY"/);
});
