/**
 * The schema.org JSON-LD the marketing pages embed for search engines.
 *
 * The risk is a claim that does not match the page: a price search shows that
 * the pricing page does not, a free tier advertised after it was removed, or
 * an FAQ answer that drifted from the one rendered. Prices and FAQs are built
 * from `marketingData.ts`, so these specs derive their expectations from the
 * same data and pin the shape and the arithmetic, not today's numbers. The
 * graph ids are pinned literally because every embed must resolve to the
 * same node.
 */
import { SITE_URL } from '@/lib/seo/site';
import { FAQS, PLANS } from '@/components/marketingComp/marketingData';
import {
  ORGANIZATION_ID,
  SOFTWARE_ID,
  WEBSITE_ID,
  breadcrumbSchema,
  faqPageSchema,
  organizationSchema,
  softwareApplicationSchema,
  websiteSchema,
} from '@/lib/seo/structuredData';

describe('graph identity', () => {
  it('anchors every node id on the site origin', () => {
    expect(ORGANIZATION_ID).toBe(`${SITE_URL}/#organization`);
    expect(WEBSITE_ID).toBe(`${SITE_URL}/#website`);
    expect(SOFTWARE_ID).toBe(`${SITE_URL}/#software`);
  });

  it('builds the organization node with its id, url and absolute logo', () => {
    const org = organizationSchema();
    expect(org).toMatchObject({
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: 'Paralegix',
      legalName: 'Paralegix, Inc.',
      url: SITE_URL,
      logo: `${SITE_URL}/img/paralegix-mark-512.png`,
    });
  });

  it('points the website and the software at the organization by id, not by copy', () => {
    expect(websiteSchema()).toEqual({
      '@type': 'WebSite',
      '@id': WEBSITE_ID,
      name: 'Paralegix',
      url: SITE_URL,
      publisher: { '@id': ORGANIZATION_ID },
    });
    expect(softwareApplicationSchema().provider).toEqual({ '@id': ORGANIZATION_ID });
  });
});

describe('softwareApplicationSchema offers', () => {
  const schema = softwareApplicationSchema();
  const offers = schema.offers;

  it('summarises one offer per marketed plan, priced in USD strings', () => {
    expect(offers['@type']).toBe('AggregateOffer');
    expect(offers.priceCurrency).toBe('USD');
    expect(offers.offerCount).toBe(PLANS.length);
    expect(offers.offers.map((o) => o.name)).toEqual(PLANS.map((p) => `${p.name} plan`));
    expect(offers.offers.map((o) => o.price)).toEqual(PLANS.map((p) => String(p.monthly)));
  });

  it('reports the highest monthly price as highPrice', () => {
    expect(offers.highPrice).toBe(String(Math.max(...PLANS.map((p) => p.monthly))));
  });

  it('advertises a lowPrice of 0 only while a free plan is actually marketed', () => {
    // lowPrice is a literal "0" in the builder. If the free tier is ever
    // dropped from PLANS, search results would still claim a $0 price; this
    // goes red at that moment.
    expect(offers.lowPrice).toBe(String(Math.min(...PLANS.map((p) => p.monthly))));
  });

  it('labels a free plan Free and gives it no price specification', () => {
    const free = PLANS.filter((p) => p.monthly === 0);
    expect(free.length).toBeGreaterThan(0);
    for (const plan of free) {
      const offer = offers.offers.find((o) => o.name === `${plan.name} plan`)!;
      expect(offer.category).toBe('Free');
      expect(offer).not.toHaveProperty('priceSpecification');
    }
  });

  it('gives each paid plan a monthly and an annual price matching the pricing page', () => {
    const paid = PLANS.filter((p) => p.monthly > 0);
    expect(paid.length).toBeGreaterThan(0);
    for (const plan of paid) {
      const offer = offers.offers.find((o) => o.name === `${plan.name} plan`)!;
      expect(offer.category).toBe('SaaS subscription');
      expect(offer.url).toBe(`${SITE_URL}/pricing`);
      expect(offer.description).toBe(plan.description);
      expect(offer.priceSpecification).toEqual([
        {
          '@type': 'UnitPriceSpecification',
          price: String(plan.monthly),
          priceCurrency: 'USD',
          unitText: 'MONTH',
          description: 'Billed monthly',
        },
        {
          '@type': 'UnitPriceSpecification',
          price: String(plan.annualPerMonth),
          priceCurrency: 'USD',
          unitText: 'MONTH',
          description: `Billed annually at $${plan.annualTotal}/year`,
        },
      ]);
    }
  });

  it('carries no aggregateRating, since there is no review corpus to source one from', () => {
    expect(schema).not.toHaveProperty('aggregateRating');
  });
});

describe('faqPageSchema', () => {
  it('emits every FAQ, in order, with the exact question and answer text', () => {
    expect(faqPageSchema()).toEqual({
      '@type': 'FAQPage',
      mainEntity: FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
    expect(faqPageSchema().mainEntity.length).toBe(FAQS.length);
  });
});

describe('breadcrumbSchema', () => {
  it('numbers items from 1 and makes each path absolute, with the home crumb as the bare origin', () => {
    expect(
      breadcrumbSchema([
        { name: 'Home', path: '/' },
        { name: 'Features', path: '/features' },
        { name: 'Billing', path: '/features/billing' },
      ]),
    ).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Features', item: `${SITE_URL}/features` },
        { '@type': 'ListItem', position: 3, name: 'Billing', item: `${SITE_URL}/features/billing` },
      ],
    });
  });

  it('is an empty list for no items', () => {
    expect(breadcrumbSchema([]).itemListElement).toEqual([]);
  });
});
