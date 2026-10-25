import {
  EmailClassificationInput,
  LearnedTagProfile,
  TagDefinition,
  ThunderbirdTag,
} from './types';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'have', 'are',
  'was', 'were', 'will', 'would', 'could', 'should', 'can', 'not', 'but', 'you',
  'all', 'any', 'has', 'had', 'our', 'out', 'new', 'more', 'about', 'into',
  'than', 'then', 'them', 'they', 'their', 'there', 'been', 'who', 'what',
  'when', 'where', 'which', 'how', 'why', 'just', 'like', 'only', 'also',
  'very', 'some', 'other', 'such', 'here', 'http', 'https', 'www', 'com',
  'org', 'net', 'mailto', 'link', 'email', 'message', 'sent', 'wrote', 'hello',
  'dear', 'hi', 'hey', 'thanks', 'thank', 'regards', 'best', 'sincerely',
  'please', 'view', 'browser', 'unsubscribe', 'click', 'subject', 'fwd',
]);

const MAX_TOKENS_PER_PROFILE = 80;
const MAX_SENDERS_PER_PROFILE = 40;
const MAX_DOMAINS_PER_PROFILE = 30;
const MAX_EXEMPLARS_PER_PROFILE = 4;

/**
 * Returns true if a tag key and display name belong to a `k1:` managed tag.
 * Non-`k1:` tags are treated as user-applied tags eligible for model training!
 */
export function isAgentPrefixedTag(key: string, displayName?: string): boolean {
  const k = (key || '').trim().toLowerCase();
  const n = (displayName || '').trim().toLowerCase();
  return (
    k.startsWith('k1:') ||
    k.startsWith('k1_') ||
    k.startsWith('agent:') ||
    k.startsWith('agent_') ||
    k.startsWith('ai_') ||
    n.startsWith('k1:') ||
    n.startsWith('agent:')
  );
}

/**
 * Extracts informative lowercase alphanumeric tokens (length 3..24) from text.
 */
export function tokenizeForLearning(text: string): string[] {
  if (!text) return [];
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9_+#$-]+/g, ' ')
    .split(/\s+/);

  const tokens: string[] = [];
  for (const w of raw) {
    const clean = w.replace(/^[-_+#$]+|[-_+#$]+$/g, '');
    if (clean.length < 3 || clean.length > 24) continue;
    if (/^\d+$/.test(clean)) continue;
    if (STOP_WORDS.has(clean)) continue;
    tokens.push(clean);
  }
  return tokens;
}

function pruneTopK(
  counts: Record<string, number>,
  maxEntries: number
): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= maxEntries) return counts;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

/**
 * Synthesizes a compact, high-signal `/v1/systemone` CLM criterion description
 * from the learned senders, domains, keywords, and exemplars of a user tag.
 */
export function synthesizeClmCriteria(profile: LearnedTagProfile): string {
  if (profile.customCriteriaOverride?.trim()) {
    return profile.customCriteriaOverride.trim();
  }

  const topSenders = Object.entries(profile.senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([s]) => s);

  const topDomains = Object.entries(profile.domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([d]) => `@${d}`);

  const topTokens = Object.entries(profile.tokenCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t);

  const negSenders = Object.entries(profile.negativeSenderCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s);

  const segments: string[] = [`Learned user tag "${profile.name}"`];

  const senderList = Array.from(new Set([...topSenders, ...topDomains])).slice(0, 5);
  if (senderList.length > 0) {
    segments.push(`Typical senders: ${senderList.join(', ')}`);
  }

  if (topTokens.length > 0) {
    segments.push(`Key terms: ${topTokens.join(', ')}`);
  }

  if (negSenders.length > 0) {
    segments.push(`Exclude senders: ${negSenders.join(', ')}`);
  }

  if (profile.exemplars.length > 0) {
    segments.push(`Examples: ${profile.exemplars.slice(0, 2).join(' ; ')}`);
  }

  return segments.join('. ') + '.';
}

export class ContinualTagLearner {
  private profiles = new Map<string, LearnedTagProfile>();
  /** Tracks negative feedback on `agent:` tags as well so user removals suppress false positives */
  private agentNegativeSenders = new Map<string, Record<string, number>>();
  private agentNegativeTokens = new Map<string, Record<string, number>>();
  /** Tracks `(messageId::tagKey)` pairs already used for training so we never double-count the same email */
  private trainedPairs = new Set<string>();

  public hydrate(savedProfiles: LearnedTagProfile[] | null | undefined): void {
    if (!Array.isArray(savedProfiles)) return;
    this.profiles.clear();
    for (const p of savedProfiles) {
      if (p && p.key && !isAgentPrefixedTag(p.key, p.name)) {
        this.profiles.set(p.key.toLowerCase(), {
          ...p,
          negativeCount: p.negativeCount || 0,
          senderCounts: p.senderCounts || {},
          negativeSenderCounts: p.negativeSenderCounts || {},
          domainCounts: p.domainCounts || {},
          tokenCounts: p.tokenCounts || {},
          negativeTokenCounts: p.negativeTokenCounts || {},
          exemplars: Array.isArray(p.exemplars) ? p.exemplars : [],
        });
      }
    }
  }

  public serialize(): LearnedTagProfile[] {
    return Array.from(this.profiles.values());
  }

  public getProfiles(): LearnedTagProfile[] {
    return Array.from(this.profiles.values()).sort(
      (a, b) => b.sampleCount - a.sampleCount
    );
  }

  public getProfile(tagKey: string): LearnedTagProfile | undefined {
    return this.profiles.get(tagKey.toLowerCase());
  }

  public deleteProfile(tagKey: string): void {
    this.profiles.delete(tagKey.toLowerCase());
  }

  public clearAll(): void {
    this.profiles.clear();
    this.agentNegativeSenders.clear();
    this.agentNegativeTokens.clear();
    this.trainedPairs.clear();
  }

  public updateProfileMetadata(
    tagKey: string,
    updates: { enabled?: boolean; customCriteriaOverride?: string }
  ): LearnedTagProfile | undefined {
    const profile = this.profiles.get(tagKey.toLowerCase());
    if (!profile) return undefined;

    if (typeof updates.enabled === 'boolean') {
      profile.enabled = updates.enabled;
    }
    if (typeof updates.customCriteriaOverride === 'string') {
      profile.customCriteriaOverride = updates.customCriteriaOverride;
      profile.synthesizedCriteria = synthesizeClmCriteria(profile);
    }
    profile.updatedAt = Date.now();
    return profile;
  }

  /**
   * Trains the continual learner on a message that has one or more non-`agent:` user tags.
   * Returns the list of learned tag keys that were updated.
   */
  public learnFromTaggedEmail(
    input: EmailClassificationInput,
    nonAgentTagKeys: string[],
    tbTagRegistry?: Map<string, ThunderbirdTag>
  ): string[] {
    if (!nonAgentTagKeys || nonAgentTagKeys.length === 0) return [];

    const updatedKeys: string[] = [];
    const sender = (input.senderEmail || '').toLowerCase();
    const domain =
      sender.includes('@') ? sender.slice(sender.indexOf('@') + 1) : '';

    // Weight subject tokens 2x and snippet tokens 1x
    const subjTokens = tokenizeForLearning(input.subject);
    const bodyTokens = tokenizeForLearning(input.snippet);

    const exemplarStr = `"${input.subject.slice(0, 65)}" (${sender || input.author.slice(0, 35)})`;

    for (const rawKey of nonAgentTagKeys) {
      const key = rawKey.toLowerCase();
      if (isAgentPrefixedTag(key)) continue;

      const pairKey = `${input.id}::${key}`;
      if (input.id > 0 && this.trainedPairs.has(pairKey)) {
        continue;
      }
      if (input.id > 0) {
        if (this.trainedPairs.size > 25000) {
          this.trainedPairs.clear();
        }
        this.trainedPairs.add(pairKey);
      }

      const tbMeta = tbTagRegistry?.get(key);
      const displayName = tbMeta?.tag || rawKey;
      if (isAgentPrefixedTag(key, displayName)) continue;

      let profile = this.profiles.get(key);
      if (!profile) {
        profile = {
          key,
          name: displayName,
          color: tbMeta?.color || '#00897b',
          enabled: true,
          sampleCount: 0,
          negativeCount: 0,
          senderCounts: {},
          negativeSenderCounts: {},
          domainCounts: {},
          tokenCounts: {},
          negativeTokenCounts: {},
          exemplars: [],
          synthesizedCriteria: '',
          updatedAt: Date.now(),
        };
        this.profiles.set(key, profile);
      } else if (tbMeta) {
        profile.name = tbMeta.tag || profile.name;
        profile.color = tbMeta.color || profile.color;
      }

      profile.sampleCount += 1;

      if (sender) {
        profile.senderCounts[sender] = (profile.senderCounts[sender] || 0) + 1;
        profile.senderCounts = pruneTopK(
          profile.senderCounts,
          MAX_SENDERS_PER_PROFILE
        );
      }

      if (domain) {
        profile.domainCounts[domain] = (profile.domainCounts[domain] || 0) + 1;
        profile.domainCounts = pruneTopK(
          profile.domainCounts,
          MAX_DOMAINS_PER_PROFILE
        );
      }

      for (const tok of subjTokens) {
        profile.tokenCounts[tok] = (profile.tokenCounts[tok] || 0) + 2;
      }
      for (const tok of bodyTokens) {
        profile.tokenCounts[tok] = (profile.tokenCounts[tok] || 0) + 1;
      }
      profile.tokenCounts = pruneTopK(
        profile.tokenCounts,
        MAX_TOKENS_PER_PROFILE
      );

      if (
        input.subject &&
        !profile.exemplars.includes(exemplarStr) &&
        profile.exemplars.length < MAX_EXEMPLARS_PER_PROFILE
      ) {
        profile.exemplars.push(exemplarStr);
      }

      profile.synthesizedCriteria = synthesizeClmCriteria(profile);
      profile.updatedAt = Date.now();
      updatedKeys.push(key);
    }

    return updatedKeys;
  }

  /**
   * Negative feedback handler: called when the user manually removes a tag (either a learned tag
   * or an `agent:` tag) from an email in Thunderbird.
   * Penalizes the sender and subject/body tokens for that tag so the model corrects itself immediately.
   */
  public unlearnFromRemovedTags(
    input: EmailClassificationInput,
    removedTagKeys: string[]
  ): string[] {
    if (!removedTagKeys || removedTagKeys.length === 0) return [];

    const penalizedKeys: string[] = [];
    const sender = (input.senderEmail || '').toLowerCase();
    const domain =
      sender.includes('@') ? sender.slice(sender.indexOf('@') + 1) : '';
    const subjTokens = tokenizeForLearning(input.subject);
    const bodyTokens = tokenizeForLearning(input.snippet);

    for (const rawKey of removedTagKeys) {
      const key = rawKey.toLowerCase();
      this.trainedPairs.delete(`${input.id}::${key}`);

      if (isAgentPrefixedTag(key)) {
        // Record negative feedback for built-in/custom `agent:` tag
        if (sender) {
          const map = this.agentNegativeSenders.get(key) || {};
          map[sender] = (map[sender] || 0) + 1;
          this.agentNegativeSenders.set(key, pruneTopK(map, MAX_SENDERS_PER_PROFILE));
        }
        const tokMap = this.agentNegativeTokens.get(key) || {};
        for (const tok of subjTokens) {
          tokMap[tok] = (tokMap[tok] || 0) + 2;
        }
        for (const tok of bodyTokens) {
          tokMap[tok] = (tokMap[tok] || 0) + 1;
        }
        this.agentNegativeTokens.set(key, pruneTopK(tokMap, MAX_TOKENS_PER_PROFILE));
        penalizedKeys.push(key);
        continue;
      }

      const profile = this.profiles.get(key);
      if (!profile) continue;

      profile.negativeCount = (profile.negativeCount || 0) + 1;

      if (sender) {
        profile.negativeSenderCounts[sender] =
          (profile.negativeSenderCounts[sender] || 0) + 1;
        if (profile.senderCounts[sender]) {
          profile.senderCounts[sender] = Math.max(
            0,
            profile.senderCounts[sender] - 1
          );
          if (profile.senderCounts[sender] === 0) {
            delete profile.senderCounts[sender];
          }
        }
      }

      if (domain && profile.domainCounts[domain]) {
        profile.domainCounts[domain] = Math.max(
          0,
          profile.domainCounts[domain] - 1
        );
        if (profile.domainCounts[domain] === 0) {
          delete profile.domainCounts[domain];
        }
      }

      for (const tok of subjTokens) {
        profile.negativeTokenCounts[tok] =
          (profile.negativeTokenCounts[tok] || 0) + 2;
        if (profile.tokenCounts[tok]) {
          profile.tokenCounts[tok] = Math.max(0, profile.tokenCounts[tok] - 2);
          if (profile.tokenCounts[tok] === 0) delete profile.tokenCounts[tok];
        }
      }
      for (const tok of bodyTokens) {
        profile.negativeTokenCounts[tok] =
          (profile.negativeTokenCounts[tok] || 0) + 1;
      }

      profile.negativeSenderCounts = pruneTopK(
        profile.negativeSenderCounts,
        MAX_SENDERS_PER_PROFILE
      );
      profile.negativeTokenCounts = pruneTopK(
        profile.negativeTokenCounts,
        MAX_TOKENS_PER_PROFILE
      );
      profile.synthesizedCriteria = synthesizeClmCriteria(profile);
      profile.updatedAt = Date.now();
      penalizedKeys.push(key);
    }

    return penalizedKeys;
  }

  /**
   * Converts active learned tag profiles that have reached `minSamples` (default: 3)
   * into `TagDefinition` items so they participate in `/v1/systemone` CLM choices alongside `agent:` tags.
   */
  public getActiveLearnedTagDefinitions(minSamples = 3): TagDefinition[] {
    const threshold = Math.max(1, minSamples);
    const defs: TagDefinition[] = [];
    for (const p of this.profiles.values()) {
      if (!p.enabled || p.sampleCount < threshold) continue;
      defs.push({
        key: p.key,
        name: p.name,
        color: p.color,
        description:
          p.synthesizedCriteria ||
          `Learned user category "${p.name}" (${p.sampleCount} examples).`,
        enabled: true,
        isLearned: true,
        learnedSampleCount: p.sampleCount,
      });
    }
    return defs;
  }

  /**
   * Computes a fast (<0.1ms) local prototype similarity score [0.0 .. 1.0] for each active learned tag
   * (that has at least `minSamples` positive examples, default 3), incorporating negative feedback penalties.
   */
  public scoreEmailAgainstLearnedProfiles(
    input: EmailClassificationInput,
    minSamples = 3
  ): Record<string, number> {
    const scores: Record<string, number> = {};
    if (this.profiles.size === 0) return scores;

    const requiredSamples = Math.max(1, minSamples);
    const sender = (input.senderEmail || '').toLowerCase();
    const domain =
      sender.includes('@') ? sender.slice(sender.indexOf('@') + 1) : '';
    const emailTokens = new Set([
      ...tokenizeForLearning(input.subject),
      ...tokenizeForLearning(input.snippet),
    ]);

    for (const profile of this.profiles.values()) {
      if (!profile.enabled || profile.sampleCount < requiredSamples) continue;

      let rawScore = 0;

      // 1. Exact sender match signal
      const senderHits = sender ? profile.senderCounts[sender] || 0 : 0;
      const negSenderHits = sender
        ? profile.negativeSenderCounts?.[sender] || 0
        : 0;

      if (negSenderHits > 0 && negSenderHits >= senderHits) {
        // User explicitly removed this tag from this sender — strong negative penalty
        rawScore -= 0.65;
      } else if (senderHits > 0) {
        const senderRatio = Math.min(1, senderHits / Math.max(2, profile.sampleCount));
        rawScore += 0.52 * (0.5 + 0.5 * senderRatio);
      } else if (domain && profile.domainCounts[domain]) {
        // 2. Domain match signal
        const domainHits = profile.domainCounts[domain];
        const domainRatio = Math.min(1, domainHits / Math.max(2, profile.sampleCount));
        rawScore += 0.28 * (0.4 + 0.6 * domainRatio);
      }

      // 3. Discriminative token overlap signal (positive vs negative tokens)
      if (emailTokens.size > 0) {
        const topProfileTokens = Object.entries(profile.tokenCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25);

        let matchedWeight = 0;
        let maxPossibleWeight = 0;
        for (const [tok, count] of topProfileTokens) {
          const weight = Math.log2(1 + count);
          maxPossibleWeight += weight;
          if (emailTokens.has(tok)) {
            matchedWeight += weight;
          }
        }

        if (maxPossibleWeight > 0) {
          const tokenScore = Math.min(
            1,
            matchedWeight / Math.min(maxPossibleWeight, 8.5)
          );
          rawScore += 0.58 * tokenScore;
        }

        // Apply negative token penalties if user un-tagged similar topics
        const negTokens = Object.entries(profile.negativeTokenCounts || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20);
        let negWeight = 0;
        for (const [tok, count] of negTokens) {
          if (emailTokens.has(tok)) {
            negWeight += Math.log2(1 + count);
          }
        }
        if (negWeight > 0) {
          rawScore -= Math.min(0.55, negWeight * 0.12);
        }
      }

      const clamped = Number(Math.max(0, Math.min(0.99, rawScore)).toFixed(4));
      if (clamped >= 0.05) {
        scores[profile.key] = clamped;
      }
    }

    return scores;
  }

  /**
   * Built-in Hybrid Local Naive-Bayes / BM25 Statistical CLM scorer across both `agent:` tags
   * and active learned user tags (with negative feedback suppression).
   * Used both to calibrate `/v1/systemone` probabilities and as an instant offline fallback.
   */
  public scoreAllTagsWithLocalClm(
    input: EmailClassificationInput,
    enabledAgentTags: TagDefinition[],
    minLearnedSamples = 3
  ): Record<string, number> {
    const scores: Record<string, number> = {
      ...this.scoreEmailAgainstLearnedProfiles(input, minLearnedSamples),
    };

    const sender = (input.senderEmail || '').toLowerCase();
    const haystack = `${input.subject} ${input.author} ${input.snippet}`.toLowerCase();
    const emailTokens = new Set([
      ...tokenizeForLearning(input.subject),
      ...tokenizeForLearning(input.snippet),
      ...tokenizeForLearning(input.author),
    ]);

    for (const tag of enabledAgentTags) {
      if (!tag.enabled) continue;
      const key = tag.key.toLowerCase();
      let score = 0;

      // Check negative sender feedback on this agent: tag
      const negSenderMap = this.agentNegativeSenders.get(key);
      if (sender && negSenderMap?.[sender]) {
        score -= 0.55;
      }

      // Check fast-path phrase matches
      if (Array.isArray(tag.fastPathKeywords)) {
        for (const kw of tag.fastPathKeywords) {
          const cleanKw = kw.trim().toLowerCase();
          if (cleanKw.length >= 3 && haystack.includes(cleanKw)) {
            score += 0.45;
          }
        }
      }

      // Check token overlap with tag description + name
      const descTokens = tokenizeForLearning(
        `${tag.name.replace(/^(k1|agent)\s*:\s*/i, '')} ${tag.description}`
      );
      if (descTokens.length > 0 && emailTokens.size > 0) {
        let hits = 0;
        for (const dt of descTokens) {
          if (emailTokens.has(dt)) {
            hits += 1;
          } else {
            // Prefix stem match (e.g. "invoic" matching "invoices" / "invoice")
            const stem = dt.slice(0, Math.max(4, dt.length - 2));
            if (stem.length >= 4) {
              for (const et of emailTokens) {
                if (et.startsWith(stem) || dt.startsWith(et.slice(0, Math.max(4, et.length - 2)))) {
                  hits += 0.75;
                  break;
                }
              }
            }
          }
        }
        score += Math.min(0.75, hits * 0.28);
      }

      // Apply negative token penalties if user removed this agent: tag on similar emails
      const negTokMap = this.agentNegativeTokens.get(key);
      if (negTokMap) {
        for (const [nt, count] of Object.entries(negTokMap)) {
          if (emailTokens.has(nt)) {
            score -= Math.min(0.4, count * 0.12);
          }
        }
      }

      const clamped = Number(Math.max(0, Math.min(0.96, score)).toFixed(4));
      if (clamped >= 0.05) {
        scores[key] = Math.max(scores[key] || 0, clamped);
      }
    }

    return scores;
  }
}
