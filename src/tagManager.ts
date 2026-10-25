import { isAgentPrefixedTag } from './tagLearner';
import { TagDefinition, ThunderbirdTag } from './types';

declare const messenger: any;
declare const browser: any;

function getApi(): any {
  if (typeof messenger !== 'undefined') return messenger;
  if (typeof browser !== 'undefined') return browser;
  return null;
}

/**
 * Tracks message IDs currently being updated by the plugin itself so `messages.onUpdated`
 * only triggers online user-tag training when the USER manually adds a tag.
 */
const pluginModifiedMessageIds = new Map<number, number>();

export function isMessageRecentlyModifiedByPlugin(messageId: number): boolean {
  const ts = pluginModifiedMessageIds.get(messageId);
  if (!ts) return false;
  if (Date.now() - ts > 4000) {
    pluginModifiedMessageIds.delete(messageId);
    return false;
  }
  return true;
}

/**
 * Generates a safe Thunderbird tag key with the `k1:` prefix from a user-provided label.
 * Thunderbird tag keys must be lowercase and free of spaces or disallowed IMAP characters.
 */
export function sanitizeTagKey(nameOrKey: string): string {
  const withoutPrefix = (nameOrKey || '')
    .trim()
    .toLowerCase()
    .replace(/^(k1\s*:\s*|agent\s*:\s*|ai_)/i, '');

  const slug = withoutPrefix
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);

  if (!slug) {
    return `k1:tag_${Date.now().toString(36)}`;
  }
  return `k1:${slug}`;
}

/**
 * Ensures a human-readable tag display name has the `k1: ` prefix.
 */
export function ensureAgentTagDisplayName(rawName: string): string {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return 'k1: Tag';
  if (/^(k1|agent)\s*:/i.test(trimmed)) {
    return trimmed.replace(/^(k1|agent)\s*:\s*/i, 'k1: ');
  }
  return `k1: ${trimmed}`;
}

/**
 * Returns true if the message already has at least one `agent:` managed tag applied.
 */
export function hasExistingAiTag(
  existingTags: string[] | undefined,
  managedAiTagKeys: Set<string>
): boolean {
  if (!Array.isArray(existingTags) || existingTags.length === 0) {
    return false;
  }
  return existingTags.some(
    (t) => managedAiTagKeys.has(t.toLowerCase()) || isAgentPrefixedTag(t)
  );
}

/**
 * Extracts any non-`agent:` user tags present on a message header.
 * These are used to train the continual learning model.
 */
export function extractNonAgentUserTags(
  tags: string[] | undefined,
  managedAgentTagKeys: Set<string>
): string[] {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  return tags.filter((t) => {
    const lower = t.toLowerCase();
    return !managedAgentTagKeys.has(lower) && !isAgentPrefixedTag(lower);
  });
}

/**
 * Computes the final array of tag keys for a message, safely preserving manual user tags
 * (non-`agent:` tags) while applying up to `maxTagsPerEmail` newly classified tags
 * (which can include both `agent:*` tags and learned user tags).
 */
export function computeUpdatedMessageTags(params: {
  existingTags: string[];
  newAiTags: string[];
  managedAiTagKeys: Set<string>;
  validAssignableTagKeys?: Set<string>;
  forceReapply: boolean;
  maxTagsPerEmail: number;
}): { finalTags: string[]; changed: boolean } {
  const {
    existingTags,
    newAiTags,
    managedAiTagKeys,
    validAssignableTagKeys,
    forceReapply,
    maxTagsPerEmail,
  } = params;

  const allowedSet = validAssignableTagKeys || managedAiTagKeys;
  const current = Array.isArray(existingTags) ? existingTags : [];

  // Manual user tags (not prefixed by agent:) are ALWAYS preserved, even on Force Re-apply!
  const preservedManualTags = current.filter(
    (t) => !managedAiTagKeys.has(t.toLowerCase()) && !isAgentPrefixedTag(t)
  );
  const existingAgentTags = current.filter(
    (t) => managedAiTagKeys.has(t.toLowerCase()) || isAgentPrefixedTag(t)
  );

  const validNewAssigned = newAiTags
    .filter((t) => allowedSet.has(t.toLowerCase()))
    .slice(0, Math.max(1, maxTagsPerEmail));

  let resultingClassifierTags: string[];
  if (forceReapply) {
    resultingClassifierTags = validNewAssigned;
  } else {
    const merged = [...existingAgentTags];
    for (const tag of validNewAssigned) {
      if (!merged.includes(tag) && merged.length < maxTagsPerEmail) {
        merged.push(tag);
      }
    }
    resultingClassifierTags = merged;
  }

  const finalTags = Array.from(
    new Set([...preservedManualTags, ...resultingClassifierTags])
  );
  const changed =
    finalTags.length !== current.length ||
    finalTags.some((t, idx) => current[idx] !== t);

  return { finalTags, changed };
}

/**
 * Lists all existing tags registered in Thunderbird across TB 115, 121, and 128+ APIs.
 */
export async function listThunderbirdTags(): Promise<ThunderbirdTag[]> {
  const api = getApi();
  if (!api) return [];

  try {
    if (api.tags?.list) {
      return await api.tags.list();
    }
    if (api.messages?.tags?.list) {
      return await api.messages.tags.list();
    }
    if (api.messages?.listTags) {
      return await api.messages.listTags();
    }
  } catch (err) {
    console.warn('[AITagger] Failed to list Thunderbird tags:', err);
  }
  return [];
}

/**
 * Ensures all enabled `agent:` tags exist in Thunderbird's native tag registry with the right label and color.
 */
export async function syncTagsWithThunderbird(
  configuredTags: TagDefinition[]
): Promise<Map<string, ThunderbirdTag>> {
  const api = getApi();
  const existing = await listThunderbirdTags();
  const existingByKey = new Map<string, ThunderbirdTag>(
    existing.map((t) => [t.key.toLowerCase(), t])
  );

  if (!api) return existingByKey;

  for (const tagDef of configuredTags) {
    const key = tagDef.key.toLowerCase();
    const currentTbTag = existingByKey.get(key);

    try {
      if (!currentTbTag) {
        if (api.tags?.create) {
          await api.tags.create(key, tagDef.name, tagDef.color);
        } else if (api.messages?.tags?.create) {
          await api.messages.tags.create(key, tagDef.name, tagDef.color);
        } else if (api.messages?.createTag) {
          await api.messages.createTag(key, tagDef.name, tagDef.color);
        }
      } else if (
        currentTbTag.tag !== tagDef.name ||
        currentTbTag.color.toLowerCase() !== tagDef.color.toLowerCase()
      ) {
        if (api.tags?.update) {
          await api.tags.update(key, {
            tag: tagDef.name,
            color: tagDef.color,
          });
        } else if (api.messages?.tags?.update) {
          await api.messages.tags.update(key, {
            tag: tagDef.name,
            color: tagDef.color,
          });
        }
      }
    } catch (err) {
      console.warn(`[AITagger] Could not sync tag "${key}":`, err);
    }
  }

  return existingByKey;
}

/**
 * Applies the computed tag list to a Thunderbird message by ID and marks it as plugin-initiated.
 */
export async function applyTagsToMessage(
  messageId: number,
  finalTags: string[]
): Promise<void> {
  const api = getApi();
  if (!api?.messages?.update) return;

  if (pluginModifiedMessageIds.size > 5000) {
    pluginModifiedMessageIds.clear();
  }
  pluginModifiedMessageIds.set(messageId, Date.now());
  await api.messages.update(messageId, { tags: finalTags });
}
