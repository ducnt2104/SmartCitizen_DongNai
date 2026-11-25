import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRobotsTxt, buildSitemapXml, injectHtmlSeo } from '../src/utils/seo';

let base = '';
let close: () => Promise<void> = async () => undefined;
let dir = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-seo-test-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = '';

  const { createRepositories } = await import('../src/repositories');
  const { createServices } = await import('../src/services/container');
  const { createApp } = await import('../src/app');

  const boot = await createRepositories();
  const services = createServices(boot.repos);
  const server = createApp(services, boot).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  close = async () => {
    await new Promise((r) => server.close(r));
    await boot.repos.close();
  };
});

afterAll(async () => {
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SEO helpers (robots.txt, sitemap.xml, HTML injection)', () => {
  it('generates standard robots.txt with normalized SITE_URL', () => {
    const txt = buildRobotsTxt('https://example.gov.vn///');
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Disallow: /api/');
    expect(txt).toContain('Disallow: /admin');
    expect(txt).toContain('Disallow: /ioc');
    expect(txt).toContain('Sitemap: https://example.gov.vn/sitemap.xml');
  });

  it('generates valid sitemap.xml listing only public indexable routes', () => {
    const xml = buildSitemapXml('https://smartcitizen-dongnai.onrender.com', '2026-11-25');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<loc>https://smartcitizen-dongnai.onrender.com/</loc>');
    expect(xml).toContain('<loc>https://smartcitizen-dongnai.onrender.com/map</loc>');
    expect(xml).toContain('<loc>https://smartcitizen-dongnai.onrender.com/report</loc>');
    expect(xml).toContain('<loc>https://smartcitizen-dongnai.onrender.com/mine</loc>');
    expect(xml).not.toContain('/admin');
    expect(xml).not.toContain('/ioc');
    expect(xml).not.toContain('/auth');
  });

  it('injects google-site-verification only when non-empty and escapes attributes', () => {
    const baseHtml = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');

    const withoutToken = injectHtmlSeo(baseHtml, {
      siteUrl: 'https://smartcitizen-dongnai.onrender.com',
      googleSiteVerification: '',
    });
    expect(withoutToken).not.toContain('google-site-verification');

    const withToken = injectHtmlSeo(baseHtml, {
      siteUrl: 'https://custom.dongnai.gov.vn/',
      googleSiteVerification: 'token-"abc"&123',
      pathname: '/map',
    });
    expect(withToken).toContain('<meta name="google-site-verification" content="token-&quot;abc&quot;&amp;123" />');
    expect(withToken).toContain('<link rel="canonical" href="https://custom.dongnai.gov.vn/map" />');
    expect(withToken).toContain('<meta property="og:url" content="https://custom.dongnai.gov.vn/map" />');
  });
});

describe('Express crawl & HTTP status hygiene', () => {
  it('serves /robots.txt as text/plain and /sitemap.xml as application/xml', async () => {
    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toMatch(/^text\/plain\b/i);
    const robotsText = await robots.text();
    expect(robotsText).toContain('User-agent: *');
    expect(robotsText).toContain('Disallow: /api/');
    expect(robotsText).toContain('Sitemap: ');

    const sitemap = await fetch(`${base}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toMatch(/application\/xml/i);
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapXml).toContain('/map</loc>');
    expect(sitemapXml).toContain('/report</loc>');
  });

  it('serves index.html SEO tags, static assets, noindex on /admin, and HTTP 404 on unknown routes', async () => {
    const distHtml = path.resolve(__dirname, '../../frontend/dist/index.html');
    if (!fs.existsSync(distHtml)) {
      return;
    }

    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toMatch(/text\/html/i);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('<html lang="vi">');
    expect(homeHtml).toContain('<link rel="canonical" href="https://smartcitizen-dongnai.onrender.com/"');
    expect(homeHtml).toContain('property="og:image"');
    expect(homeHtml).toContain('/og-cover.png');
    expect(homeHtml).toContain('application/ld+json');
    expect(homeHtml).toContain('"@type": "WebSite"');
    expect(homeHtml).toContain('"@type": "WebApplication"');
    expect(homeHtml).toContain('<noscript>');

    const ogImg = await fetch(`${base}/og-cover.png`);
    expect(ogImg.status).toBe(200);
    expect(ogImg.headers.get('content-type')).toMatch(/^image\/png\b/i);

    const favicon = await fetch(`${base}/favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('content-type')).toMatch(/^image\/svg\+xml\b/i);

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);

    const admin = await fetch(`${base}/admin`);
    expect(admin.status).toBe(200);
    expect(admin.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const adminHtml = await admin.text();
    expect(adminHtml).toContain('<meta name="robots" content="noindex, nofollow" />');

    const missingPage = await fetch(`${base}/non-existent-xyz`);
    expect(missingPage.status).toBe(404);
    expect(missingPage.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const missingAsset = await fetch(`${base}/assets/non-existent-xyz.js`);
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get('content-type')).toMatch(/^text\/plain\b/i);
  });
});
