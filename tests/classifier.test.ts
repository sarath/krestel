import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, DEFAULT_TAGS } from '../src/defaults.ts';
import { MemoizationCache } from '../src/memoCache.ts';
import {
  buildSystemOneRequest,
  classifyBatchWithOllama,
  selectTagsFromSystemOneProbabilities,
} from '../src/ollamaClient.ts';
import {
  computeThreadKey,
  extractEmailAddress,
  extractSnippetFromMimeTree,
  isAutomatedSenderAddress,
  stripHtmlToCleanText,
} from '../src/snippetExtractor.ts';
import {
  ContinualTagLearner,
  isAgentPrefixedTag,
} from '../src/tagLearner.ts';
import {
  computeUpdatedMessageTags,
  extractNonAgentUserTags,
  hasExistingAiTag,
  sanitizeTagKey,
} from '../src/tagManager.ts';
import type { EmailClassificationInput, MessagePart } from '../src/types.ts';

describe('Snippet Extractor & Header Intelligence', () => {
  it('extracts lowercase email address from formatted Author header', () => {
    assert.equal(
      extractEmailAddress('"Stripe Billing" <Billing@Stripe.com>'),
      'billing@stripe.com'
    );
    assert.equal(extractEmailAddress('alice@example.org'), 'alice@example.org');
  });

  it('detects automated vs human sender addresses accurately', () => {
    assert.equal(isAutomatedSenderAddress('noreply@github.com'), true);
    assert.equal(isAutomatedSenderAddress('billing@stripe.com'), true);
    assert.equal(isAutomatedSenderAddress('alerts@mail.bank.com'), true);
    assert.equal(
      isAutomatedSenderAddress('founder@startup.com', {
        'list-unsubscribe': ['<https://startup.com/unsub>'],
      }),
      true
    );
    assert.equal(isAutomatedSenderAddress('colleague@company.com'), false);
  });

  it('normalizes Re:/Fwd:/[EXTERNAL] prefixes in thread keys', () => {
    const k1 = computeThreadKey(
      'Re: Fwd: [EXTERNAL] Q4 Architecture Review',
      'alice@acme.com'
    );
    const k2 = computeThreadKey(
      'AW: Re[2]: Q4 Architecture Review',
      'bob@acme.com'
    );
    assert.equal(k1, k2);
    assert.equal(k1, 'acme.com::q4 architecture review');
  });

  it('strips HTML styles, scripts, tags, and quoted replies cleanly', () => {
    const html = `
      <html>
        <head><style>.btn { color: red; }</style></head>
        <body>
          <p>Hello team,</p>
          <div>Please approve the attached invoice #901 before Friday.</div>
          <p>On Mon, Oct 18, 2026 at 10:00 AM Bob wrote:</p>
          <blockquote>&gt; Old quoted thread text here</blockquote>
        </body>
      </html>
    `;
    const cleaned = stripHtmlToCleanText(html);
    assert.equal(
      cleaned,
      'Hello team, Please approve the attached invoice #901 before Friday.'
    );
  });

  it('walks MIME tree preferring text/plain and ignoring attachments', () => {
    const mimeTree: MessagePart = {
      contentType: 'multipart/mixed',
      parts: [
        {
          contentType: 'text/plain',
          headers: { 'content-disposition': ['attachment; filename="notes.txt"'] },
          body: 'SECRET ATTACHMENT CONTENT SHOULD BE IGNORED',
        },
        {
          contentType: 'multipart/alternative',
          parts: [
            {
              contentType: 'text/plain',
              body: 'Your verification code is 394810.\n> Quoted line',
            },
            {
              contentType: 'text/html',
              body: '<p>HTML fallback</p>',
            },
          ],
        },
      ],
    };

    const { snippet } = extractSnippetFromMimeTree(mimeTree, 200);
    assert.equal(snippet, 'Your verification code is 394810.');
  });
});

describe('Tag Manager & Safe Force Re-apply with Learned User Tags', () => {
  const managedSet = new Set(DEFAULT_TAGS.map((t) => t.key));

  it('sanitizes custom tag names into valid Thunderbird tag keys with k1: prefix', () => {
    assert.equal(sanitizeTagKey('VIP Client!'), 'k1:vip_client');
    assert.equal(sanitizeTagKey('k1: already_prefixed'), 'k1:already_prefixed');
  });

  it('distinguishes k1: tags from user-created non-k1: tags', () => {
    assert.equal(isAgentPrefixedTag('k1:finance', 'k1: Finance'), true);
    assert.equal(isAgentPrefixedTag('tax_2026', 'Tax 2026'), false);

    const nonAgent = extractNonAgentUserTags(
      ['k1:finance', 'tax_2026', 'client_acme'],
      managedSet
    );
    assert.deepEqual(nonAgent, ['tax_2026', 'client_acme']);
  });

  it('detects whether a message already has a k1: tag', () => {
    assert.equal(hasExistingAiTag(['$label1', 'personal'], managedSet), false);
    assert.equal(hasExistingAiTag(['$label1', 'k1:finance'], managedSet), true);
  });

  it('preserves manual non-k1: tags while replacing only k1: tags on Force Re-apply', () => {
    const existingTags = [
      '$label1',
      'manual_tax_2026',
      'k1:promo',
      'k1:newsletter',
    ];
    const newAiTags = ['k1:finance', 'k1:action', 'k1:work'];

    const { finalTags, changed } = computeUpdatedMessageTags({
      existingTags,
      newAiTags,
      managedAiTagKeys: managedSet,
      forceReapply: true,
      maxTagsPerEmail: 2,
    });

    assert.equal(changed, true);
    assert.deepEqual(finalTags, [
      '$label1',
      'manual_tax_2026',
      'k1:finance',
      'k1:action',
    ]);
  });
});

describe('Continual Online Learning (3-Example Threshold & Negative Feedback)', () => {
  it('waits for 3 user-tagged examples before activating a learned tag and penalizes removed tags', () => {
    const learner = new ContinualTagLearner();

    const taxEmail1: EmailClassificationInput = {
      id: 501,
      author: 'Smith CPA <cpa@smithadvisors.com>',
      subject: '2026 K-1 Tax Schedule and Federal Return Deduction Summary',
      recipients: '',
      snippet: 'Attached is your federal tax return schedule K-1 and quarterly estimate.',
      threadKey: 'smithadvisors.com::2026 k-1 tax schedule',
      senderEmail: 'cpa@smithadvisors.com',
      isAutomatedSender: false,
      existingTags: ['tax_2026'],
    };

    const taxEmail2: EmailClassificationInput = {
      id: 502,
      author: 'IRS Notice <notices@irs.gov>',
      subject: 'Federal Tax Return Confirmation and W-2 Transcript',
      recipients: '',
      snippet: 'Your federal tax return transcript and deduction filing status.',
      threadKey: 'irs.gov::federal tax return confirmation',
      senderEmail: 'notices@irs.gov',
      isAutomatedSender: true,
      existingTags: ['tax_2026'],
    };

    const taxEmail3: EmailClassificationInput = {
      id: 503,
      author: 'Smith CPA <cpa@smithadvisors.com>',
      subject: 'Form 1099-NEC & Quarterly Tax Voucher',
      recipients: '',
      snippet: 'Please review your 2026 CPA tax voucher and federal deduction schedule.',
      threadKey: 'smithadvisors.com::form 1099-nec & quarterly tax voucher',
      senderEmail: 'cpa@smithadvisors.com',
      isAutomatedSender: false,
      existingTags: ['tax_2026'],
    };

    learner.learnFromTaggedEmail(taxEmail1, ['tax_2026']);
    learner.learnFromTaggedEmail(taxEmail2, ['tax_2026']);

    // With only 2 examples, threshold=3 keeps the tag in warm-up mode
    assert.equal(learner.getActiveLearnedTagDefinitions(3).length, 0);

    // 3rd example activates the learned tag!
    learner.learnFromTaggedEmail(taxEmail3, ['tax_2026']);
    const activeDefs = learner.getActiveLearnedTagDefinitions(3);
    assert.equal(activeDefs.length, 1);
    assert.equal(activeDefs[0].key, 'tax_2026');
    assert.equal(activeDefs[0].learnedSampleCount, 3);

    const profiles = learner.getProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].sampleCount, 3);
    assert.ok(profiles[0].synthesizedCriteria.includes('cpa@smithadvisors.com'));
    assert.ok(profiles[0].synthesizedCriteria.includes('tax'));

    // Score a new incoming tax email from the same CPA domain/topic
    const futureTaxEmail: EmailClassificationInput = {
      id: 504,
      author: 'Smith CPA <cpa@smithadvisors.com>',
      subject: 'Amended Tax Return Schedule K-1',
      recipients: '',
      snippet: 'Please sign the federal tax return deduction form.',
      threadKey: '',
      senderEmail: 'cpa@smithadvisors.com',
      isAutomatedSender: false,
      existingTags: [],
    };

    const unrelatedEmail: EmailClassificationInput = {
      id: 505,
      author: 'Store <deals@fashion.com>',
      subject: '50% Off Summer Shoes Flash Sale',
      recipients: '',
      snippet: 'Shop new arrivals with promo code SHOES50.',
      threadKey: '',
      senderEmail: 'deals@fashion.com',
      isAutomatedSender: true,
      existingTags: [],
    };

    const matchScoresBefore = learner.scoreEmailAgainstLearnedProfiles(futureTaxEmail, 3);
    const unrelatedScores = learner.scoreEmailAgainstLearnedProfiles(unrelatedEmail, 3);

    assert.ok((matchScoresBefore['tax_2026'] || 0) >= 0.7);
    assert.equal(unrelatedScores['tax_2026'] || 0, 0);

    // Test Hybrid Local Statistical CLM scoring across both k1: and learned tags
    const hybridScores = learner.scoreAllTagsWithLocalClm(futureTaxEmail, DEFAULT_TAGS, 3);
    assert.ok((hybridScores['k1:finance'] || 0) > 0.25);
    assert.ok((hybridScores['tax_2026'] || 0) > 0.7);

    // Test negative feedback when user manually removes `tax_2026` from an email
    learner.unlearnFromRemovedTags(futureTaxEmail, ['tax_2026']);
    const matchScoresAfterNegative = learner.scoreEmailAgainstLearnedProfiles(futureTaxEmail, 3);
    assert.ok((matchScoresAfterNegative['tax_2026'] || 0) < (matchScoresBefore['tax_2026'] || 0));
  });
});

describe('Two-Tier Thread & Sender Memoization', () => {
  const validKeys = new Set(DEFAULT_TAGS.map((t) => t.key));

  it('memoizes threads and consistent automated senders while safeguarding mixed senders', () => {
    const cache = new MemoizationCache();

    const msg1: EmailClassificationInput = {
      id: 1,
      author: 'Stripe <billing@stripe.com>',
      subject: 'Invoice #101',
      recipients: '',
      snippet: 'Paid $10',
      threadKey: 'stripe.com::invoice #101',
      senderEmail: 'billing@stripe.com',
      isAutomatedSender: true,
      existingTags: [],
    };

    const msg2SameSender: EmailClassificationInput = {
      ...msg1,
      id: 2,
      subject: 'Invoice #102',
      threadKey: 'stripe.com::invoice #102',
    };

    const msg3SameSender: EmailClassificationInput = {
      ...msg1,
      id: 3,
      subject: 'Invoice #103',
      threadKey: 'stripe.com::invoice #103',
    };

    cache.record(msg1, ['k1:finance']);
    cache.record(msg2SameSender, ['k1:finance']);

    const hit = cache.lookup(msg3SameSender, {
      enableThread: true,
      enableSender: true,
      senderMemoMinHits: 2,
      validTagKeys: validKeys,
      maxTags: 2,
    });
    assert.deepEqual(hit, { tags: ['k1:finance'], source: 'cache-sender' });

    const amzShip: EmailClassificationInput = {
      id: 10,
      author: 'Amazon <no-reply@amazon.com>',
      subject: 'Order shipped',
      recipients: '',
      snippet: '',
      threadKey: 'amazon.com::order shipped',
      senderEmail: 'no-reply@amazon.com',
      isAutomatedSender: true,
      existingTags: [],
    };
    const amzOtp: EmailClassificationInput = {
      ...amzShip,
      id: 11,
      subject: 'Amazon security code',
      threadKey: 'amazon.com::amazon security code',
    };
    const amzThird: EmailClassificationInput = {
      ...amzShip,
      id: 12,
      subject: 'Another message',
      threadKey: 'amazon.com::another message',
    };

    cache.record(amzShip, ['k1:shipping']);
    cache.record(amzOtp, ['k1:security']);

    const mixedLookup = cache.lookup(amzThird, {
      enableThread: true,
      enableSender: true,
      senderMemoMinHits: 2,
      validTagKeys: validKeys,
      maxTags: 2,
    });
    assert.equal(mixedLookup, null);
  });
});

describe('Ollama /v1/systemone Jev CLM Decision Engine', () => {
  it('builds structured /v1/systemone choice request with k1: and learned tags', () => {
    const sample: EmailClassificationInput = {
      id: 1,
      author: 'CPA <cpa@firm.com>',
      subject: 'Tax Invoice #10',
      recipients: '',
      snippet: 'Enclosed is your tax filing receipt.',
      threadKey: '',
      senderEmail: 'cpa@firm.com',
      isAutomatedSender: false,
      existingTags: [],
    };

    const req = buildSystemOneRequest(sample, DEFAULT_TAGS, 'tev1:0.8b');
    assert.equal(req.model, 'tev1:0.8b');
    assert.equal(req.questions.category.type, 'choice');
    assert.ok('k1:finance' in req.questions.category.criteria);
    assert.ok('none' in req.questions.category.criteria);
  });

  it('selects top tags from calibrated /v1/systemone probabilities blended with learned tag scores', () => {
    const validKeys = new Set([
      ...DEFAULT_TAGS.map((t) => t.key),
      'tax_2026',
    ]);

    const { selectedTags, mergedProbabilities } =
      selectTagsFromSystemOneProbabilities({
        clmProbabilities: {
          'k1:finance': 0.88,
          'k1:action': 0.04,
          tax_2026: 0.35,
          none: 0.02,
        },
        winningChoice: 'k1:finance',
        learnedScores: {
          tax_2026: 0.82,
        },
        validTagKeys: validKeys,
        maxTagsPerEmail: 2,
        primaryThreshold: 0.25,
        secondaryThreshold: 0.18,
      });

    assert.deepEqual(selectedTags, ['k1:finance', 'tax_2026']);
    assert.ok(mergedProbabilities['tax_2026'] > 0.5);
  });

  it('executes /v1/systemone CLM classification and returns calibrated probabilities', async () => {
    const sampleInput: EmailClassificationInput = {
      id: 101,
      author: 'Stripe <billing@stripe.com>',
      subject: 'Receipt for your payment of $49.00',
      recipients: '',
      snippet: 'Invoice #9910 has been paid in full.',
      threadKey: '',
      senderEmail: 'billing@stripe.com',
      isAutomatedSender: true,
      existingTags: [],
    };

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/v1/systemone')) {
          return new Response(
            JSON.stringify({
              model: 'tev1:0.8b',
              answers: {
                category: {
                  type: 'choice',
                  choice: 'k1:finance',
                  probabilities: {
                    'k1:finance': 0.942,
                    'k1:work': 0.031,
                    none: 0.027,
                  },
                  confidence: 0.942,
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      }) as typeof fetch;

      const result = await classifyBatchWithOllama(
        [sampleInput],
        DEFAULT_SETTINGS
      );

      assert.equal(result.source, 'clm-systemone');
      assert.deepEqual(result.tagsPerItem, [['k1:finance']]);
      assert.equal(result.probabilitiesPerItem[0]['k1:finance'], 0.942);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Release & Pre-release Versioning for Thunderbird Marketplace', () => {
  it('generates Mozilla-valid 4-part pre-release versions on PRs and monotonically increments on merge to main', async () => {
    const { computeReleaseVersion, MOZILLA_VERSION_REGEX } = await import(
      // @ts-expect-error -- .mjs script import
      '../scripts/resolve-version.mjs'
    );

    // 1. PR before any stable tag exists
    const prInitial = computeReleaseVersion({
      baseVersion: '1.0.0',
      gitTags: [],
      eventName: 'pull_request',
      refName: '12/merge',
      prNumber: '12',
      runNumber: '5',
    });
    assert.equal(prInitial.isPrerelease, true);
    assert.equal(prInitial.manifestVersion, '0.99.12.5');
    assert.equal(MOZILLA_VERSION_REGEX.test(prInitial.manifestVersion), true);
    assert.equal(prInitial.releaseTag, 'v1.0.0-pr.12.5');
    assert.equal(prInitial.channel, 'unlisted');

    // 2. First merge to main cuts v1.0.0
    const mainFirst = computeReleaseVersion({
      baseVersion: '1.0.0',
      gitTags: ['v1.0.0-pr.12.5'],
      eventName: 'push',
      refName: 'main',
      runNumber: '6',
    });
    assert.equal(mainFirst.isPrerelease, false);
    assert.equal(mainFirst.manifestVersion, '1.0.0');
    assert.equal(mainFirst.releaseTag, 'v1.0.0');
    assert.equal(mainFirst.channel, 'listed');

    // 3. Subsequent PR after v1.0.0 is tagged -> gets 1.0.0.<runNumber>
    const prNext = computeReleaseVersion({
      baseVersion: '1.0.0',
      gitTags: ['v1.0.0', 'v1.0.0-pr.12.5'],
      eventName: 'pull_request',
      refName: '15/merge',
      prNumber: '15',
      runNumber: '7',
    });
    assert.equal(prNext.isPrerelease, true);
    assert.equal(prNext.manifestVersion, '1.0.0.7');
    assert.equal(MOZILLA_VERSION_REGEX.test(prNext.manifestVersion), true);
    assert.equal(prNext.releaseTag, 'v1.0.1-pr.15.7');
    assert.equal(prNext.channel, 'unlisted');

    // 4. Merge to main when v1.0.0 already exists auto-bumps to v1.0.1 (> 1.0.0.7)
    const mainSecond = computeReleaseVersion({
      baseVersion: '1.0.0',
      gitTags: ['v1.0.0', 'v1.0.1-pr.15.7'],
      eventName: 'push',
      refName: 'main',
      runNumber: '8',
    });
    assert.equal(mainSecond.isPrerelease, false);
    assert.equal(mainSecond.manifestVersion, '1.0.1');
    assert.equal(mainSecond.releaseTag, 'v1.0.1');
    assert.equal(mainSecond.channel, 'listed');
  });
});

