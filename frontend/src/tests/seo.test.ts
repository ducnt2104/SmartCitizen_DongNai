import { describe, expect, it } from 'vitest';
import { resolveRouteSeo } from '../utils/usePageSeo';

describe('Technical SEO route metadata', () => {
  it('marks public routes indexable with unique Vietnamese titles and descriptions', () => {
    const publicPaths = ['/', '/report', '/map', '/mine'];
    const titles = new Set<string>();
    const descriptions = new Set<string>();

    for (const p of publicPaths) {
      const seo = resolveRouteSeo(p, 'vi');
      expect(seo.robots).toContain('index, follow');
      expect(seo.canonicalPath).toBe(p);
      expect(seo.title.length).toBeGreaterThan(20);
      expect(seo.description.length).toBeGreaterThan(50);
      titles.add(seo.title);
      descriptions.add(seo.description);
    }

    expect(titles.size).toBe(publicPaths.length);
    expect(descriptions.size).toBe(publicPaths.length);
  });

  it('supports English SEO titles and descriptions when lang is en', () => {
    const homeEn = resolveRouteSeo('/', 'en');
    expect(homeEn.robots).toContain('index, follow');
    expect(homeEn.title).toContain('SmartCitizen Dong Nai');
  });

  it('marks internal, auth, and private routes as noindex, nofollow', () => {
    for (const p of ['/admin', '/ioc', '/officer', '/login', '/dashboard', '/rescue', '/rescue/login', '/auth', '/profile', '/volunteer']) {
      const seo = resolveRouteSeo(p, 'vi');
      expect(seo.robots).toBe('noindex, nofollow');
    }
  });

  it('marks unknown routes as 404 noindex without canonical link to avoid soft 404s', () => {
    const unknown = resolveRouteSeo('/non-existent-xyz', 'vi');
    expect(unknown.robots).toBe('noindex, nofollow');
    expect(unknown.canonicalPath).toBeUndefined();
    expect(unknown.title).toContain('404');
  });
});
