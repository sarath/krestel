import {
  DEFAULT_SETTINGS,
  DEFAULT_TAGS,
  INITIAL_LIFETIME_STATS,
} from './defaults';
import { LearnedTagProfile, LifetimeStats, PluginSettings } from './types';

declare const messenger: any;
declare const browser: any;

const SETTINGS_KEY = 'kestrel_settings_v1';
const STATS_KEY = 'kestrel_lifetime_stats_v1';
const MEMO_KEY = 'kestrel_memo_cache_v1';
const LEARNED_TAGS_KEY = 'kestrel_learned_tags_v1';

function getStorageApi(): any {
  if (typeof messenger !== 'undefined' && messenger.storage?.local) {
    return messenger.storage.local;
  }
  if (typeof browser !== 'undefined' && browser.storage?.local) {
    return browser.storage.local;
  }
  return null;
}

export async function loadSettings(): Promise<PluginSettings> {
  const storage = getStorageApi();
  if (!storage) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  try {
    const res = await storage.get(SETTINGS_KEY);
    const saved = res?.[SETTINGS_KEY];
    if (!saved || typeof saved !== 'object') {
      return structuredClone(DEFAULT_SETTINGS);
    }

    const rawTags =
      Array.isArray(saved.tags) && saved.tags.length > 0
        ? saved.tags.map((t: any) => {
            const key = String(t.key || '').replace(/^(agent:|ai_)/i, 'k1:');
            const rawName = String(t.name || '').replace(/^agent\s*:\s*/i, '');
            const name = /^k1\s*:/i.test(rawName)
              ? rawName.replace(/^k1\s*:\s*/i, 'k1: ')
              : `k1: ${rawName}`;
            return { ...t, key, name };
          })
        : structuredClone(DEFAULT_TAGS);

    const merged: PluginSettings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      defaultScope: {
        ...DEFAULT_SETTINGS.defaultScope,
        ...(saved.defaultScope || {}),
      },
      tags: rawTags,
    };

    return merged;
  } catch (err) {
    console.warn('[AITagger] Failed to load settings, using defaults:', err);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: PluginSettings): Promise<void> {
  const storage = getStorageApi();
  if (!storage) return;
  await storage.set({ [SETTINGS_KEY]: settings });
}

export async function loadLifetimeStats(): Promise<LifetimeStats> {
  const storage = getStorageApi();
  if (!storage) {
    return { ...INITIAL_LIFETIME_STATS };
  }

  try {
    const res = await storage.get(STATS_KEY);
    return {
      ...INITIAL_LIFETIME_STATS,
      ...(res?.[STATS_KEY] || {}),
    };
  } catch {
    return { ...INITIAL_LIFETIME_STATS };
  }
}

export async function saveLifetimeStats(stats: LifetimeStats): Promise<void> {
  const storage = getStorageApi();
  if (!storage) return;
  await storage.set({ [STATS_KEY]: stats });
}

export async function loadSerializedMemoCache(): Promise<any> {
  const storage = getStorageApi();
  if (!storage) return null;
  try {
    const res = await storage.get(MEMO_KEY);
    return res?.[MEMO_KEY] ?? null;
  } catch {
    return null;
  }
}

export async function saveSerializedMemoCache(data: any): Promise<void> {
  const storage = getStorageApi();
  if (!storage) return;
  try {
    await storage.set({ [MEMO_KEY]: data });
  } catch (err) {
    console.warn('[AITagger] Failed to persist memo cache:', err);
  }
}

export async function loadLearnedTagProfiles(): Promise<LearnedTagProfile[]> {
  const storage = getStorageApi();
  if (!storage) return [];
  try {
    const res = await storage.get(LEARNED_TAGS_KEY);
    return Array.isArray(res?.[LEARNED_TAGS_KEY]) ? res[LEARNED_TAGS_KEY] : [];
  } catch {
    return [];
  }
}

export async function saveLearnedTagProfiles(
  profiles: LearnedTagProfile[]
): Promise<void> {
  const storage = getStorageApi();
  if (!storage) return;
  try {
    await storage.set({ [LEARNED_TAGS_KEY]: profiles });
  } catch (err) {
    console.warn('[AITagger] Failed to persist learned tag profiles:', err);
  }
}
