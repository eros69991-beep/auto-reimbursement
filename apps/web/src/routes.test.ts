import { describe, expect, it } from 'vitest';

import { NAV_PAGES, parseRoute, routeHash, switchLedgerHash, type PageKey } from './routes';

describe('store routes keep the addresses they always had', () => {
  it.each<[string, PageKey]>([
    ['#upload', 'upload'],
    ['#pool', 'pool'],
    ['#pending', 'pending'],
    ['#preview', 'preview'],
    ['#history', 'history'],
    ['#settings', 'settings'],
    ['#home', 'home'],
  ])('%s is the %s page of the store ledger', (hash, page) => {
    expect(parseRoute(hash)).toEqual({ ledger: 'store', page, batchId: null });
  });

  it('opens a batch preview by its id', () => {
    expect(parseRoute('#batches/batch-1/preview')).toEqual({ ledger: 'store', page: 'preview', batchId: 'batch-1' });
  });

  it.each(['', '#', '#unknown', '#pool/', '#pool?x=1', '#/pool', '#batches//preview', '#batches/a/b/preview', '#batches/a/preview/x', '#constructor', '#__proto__'])(
    'treats %j as the home page, like before',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ ledger: 'store', page: 'home', batchId: null });
    },
  );
});

describe('company routes', () => {
  it.each<[string, PageKey]>([
    ['#company/upload', 'upload'],
    ['#company/pool', 'pool'],
    ['#company/pending', 'pending'],
    ['#company/preview', 'preview'],
    ['#company/history', 'history'],
    ['#company/settings', 'settings'],
  ])('%s is the %s page of the company ledger', (hash, page) => {
    expect(parseRoute(hash)).toEqual({ ledger: 'company', page, batchId: null });
  });

  it('opens a company batch preview by its id', () => {
    expect(parseRoute('#company/batches/batch-9/preview')).toEqual({ ledger: 'company', page: 'preview', batchId: 'batch-9' });
  });

  it.each(['#company', '#company/', '#company/home', '#company/unknown', '#company/pool/', '#company/constructor', '#company/batches//preview'])(
    'lands on the upload page for %j (the company ledger has no separate home page)',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ ledger: 'company', page: 'upload', batchId: null });
    },
  );

  it('does not mistake an address that merely starts with the word for a company address', () => {
    expect(parseRoute('#companyx/pool')).toEqual({ ledger: 'store', page: 'home', batchId: null });
    expect(parseRoute('#companies')).toEqual({ ledger: 'store', page: 'home', batchId: null });
  });

  it('keeps a store batch address in the store ledger, never the company one', () => {
    expect(parseRoute('#batches/b/preview').ledger).toBe('store');
    expect(parseRoute('#company/batches/b/preview').ledger).toBe('company');
  });
});

describe('building addresses', () => {
  it.each<[PageKey, string]>([
    ['home', '#home'],
    ['upload', '#upload'],
    ['pool', '#pool'],
    ['pending', '#pending'],
    ['preview', '#preview'],
    ['history', '#history'],
    ['settings', '#settings'],
  ])('store %s → %s', (page, hash) => {
    expect(routeHash('store', page)).toBe(hash);
  });

  it.each<[PageKey, string]>([
    ['home', '#company'],
    ['upload', '#company/upload'],
    ['pool', '#company/pool'],
    ['pending', '#company/pending'],
    ['preview', '#company/preview'],
    ['history', '#company/history'],
    ['settings', '#company/settings'],
  ])('company %s → %s', (page, hash) => {
    expect(routeHash('company', page)).toBe(hash);
  });

  it('writes a batch preview address for each ledger', () => {
    expect(routeHash('store', 'preview', 'b1')).toBe('#batches/b1/preview');
    expect(routeHash('company', 'preview', 'b1')).toBe('#company/batches/b1/preview');
  });

  it('only a preview has a batch id; other pages ignore one', () => {
    expect(routeHash('store', 'pool', 'b1')).toBe('#pool');
    expect(routeHash('company', 'history', 'b1')).toBe('#company/history');
  });

  it('every address built for a page parses back to that page and ledger', () => {
    for (const ledger of ['store', 'company'] as const) {
      for (const page of NAV_PAGES[ledger]) {
        const route = parseRoute(routeHash(ledger, page));
        expect(route.ledger).toBe(ledger);
        expect(route.page).toBe(page === 'home' && ledger === 'company' ? 'upload' : page);
      }
      expect(parseRoute(routeHash(ledger, 'preview', 'xyz'))).toEqual({ ledger, page: 'preview', batchId: 'xyz' });
    }
  });
});

describe('navigation entries', () => {
  it('the store keeps its home page; the company ledger starts at uploading', () => {
    expect(NAV_PAGES.store).toEqual(['home', 'upload', 'pool', 'pending', 'preview', 'history', 'settings']);
    expect(NAV_PAGES.company).toEqual(['upload', 'pool', 'pending', 'preview', 'history', 'settings']);
  });
});

describe('switching between the two ledgers', () => {
  it('stays on the same page', () => {
    expect(switchLedgerHash(parseRoute('#pool'), 'company')).toBe('#company/pool');
    expect(switchLedgerHash(parseRoute('#company/pending'), 'store')).toBe('#pending');
    expect(switchLedgerHash(parseRoute('#history'), 'company')).toBe('#company/history');
    expect(switchLedgerHash(parseRoute('#company/settings'), 'store')).toBe('#settings');
  });

  it('the store home page corresponds to uploading in the company ledger', () => {
    expect(switchLedgerHash(parseRoute('#home'), 'company')).toBe('#company/upload');
    expect(switchLedgerHash(parseRoute('#company'), 'store')).toBe('#upload');
  });

  it('never carries a batch of one ledger over to the other: it goes to the other ledger’s own preview', () => {
    expect(switchLedgerHash(parseRoute('#batches/b1/preview'), 'company')).toBe('#company/preview');
    expect(switchLedgerHash(parseRoute('#company/batches/b2/preview'), 'store')).toBe('#preview');
  });
});
