import {
  ClassificationSource,
  EmailClassificationInput,
  PluginSettings,
  SystemOneRequest,
  SystemOneResponse,
  TagDefinition,
} from './types';

export interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize?: string;
  quantizationLevel?: string;
  family?: string;
}

export interface OllamaHealthCheckResult {
  ok: boolean;
  version?: string;
  systemOneSupported: boolean;
  models: OllamaModelInfo[];
  configuredModelInstalled: boolean;
  activeModel: string;
  latencyMs: number;
  error?: string;
  corsBlocked?: boolean;
}

export interface PullProgressUpdate {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export interface ClmClassificationOutput {
  tagsPerItem: string[][];
  probabilitiesPerItem: Array<Record<string, number>>;
  source: ClassificationSource;
  durationMs: number;
}

const unsupportedThinkModels = new Set<string>();

function normalizeEndpoint(endpoint: string): string {
  return (endpoint || 'http://localhost:11434').trim().replace(/\/+$/, '');
}

/**
 * Builds the `state` text and `questions` criteria map for an Ollama `/v1/systemone` Jev CLM request.
 */
export function buildSystemOneRequest(
  input: EmailClassificationInput,
  activeTags: TagDefinition[],
  model: string
): SystemOneRequest {
  const stateLines = [
    `From: ${input.author}`,
    `Subject: ${input.subject}`,
  ];
  if (input.recipients) {
    stateLines.push(`To: ${input.recipients}`);
  }
  if (input.snippet) {
    stateLines.push(`Body: ${input.snippet}`);
  }

  const criteria: Record<string, string | null> = {};
  for (const tag of activeTags) {
    const cleanLabel = tag.name.replace(/^(k1|agent)\s*:\s*/i, '').trim() || tag.name;
    criteria[tag.key] = `${cleanLabel}: ${tag.description}`;
  }
  criteria['none'] = 'None of the above categories apply to this email.';

  return {
    model,
    state: stateLines.join('\n'),
    questions: {
      category: {
        type: 'choice',
        instructions:
          'Classify the email into the most accurate category based on sender, subject, and body.',
        criteria,
      },
    },
  };
}

/**
 * Selects up to `maxTagsPerEmail` tags from the `/v1/systemone` calibrated probability distribution,
 * blended with optional local ContinualTagLearner prototype scores.
 */
export function selectTagsFromSystemOneProbabilities(params: {
  clmProbabilities: Record<string, number>;
  winningChoice?: string;
  learnedScores?: Record<string, number>;
  validTagKeys: Set<string>;
  maxTagsPerEmail: number;
  primaryThreshold: number;
  secondaryThreshold: number;
}): { selectedTags: string[]; mergedProbabilities: Record<string, number> } {
  const {
    clmProbabilities,
    winningChoice,
    learnedScores,
    validTagKeys,
    maxTagsPerEmail,
    primaryThreshold,
    secondaryThreshold,
  } = params;

  const merged: Record<string, number> = {};

  for (const [rawKey, prob] of Object.entries(clmProbabilities || {})) {
    const key = rawKey.toLowerCase();
    if (key === 'none' || !validTagKeys.has(key)) continue;
    if (typeof prob === 'number' && Number.isFinite(prob)) {
      merged[key] = Number(prob.toFixed(4));
    }
  }

  // If the CLM returned a winning choice without a full probabilities map, assign its confidence
  if (
    winningChoice &&
    winningChoice.toLowerCase() !== 'none' &&
    validTagKeys.has(winningChoice.toLowerCase()) &&
    merged[winningChoice.toLowerCase()] === undefined
  ) {
    merged[winningChoice.toLowerCase()] = 0.85;
  }

  // Blend in local ContinualTagLearner prototype scores for user-learned non-agent: tags
  if (learnedScores) {
    for (const [rawKey, learnedScore] of Object.entries(learnedScores)) {
      const key = rawKey.toLowerCase();
      if (!validTagKeys.has(key)) continue;
      const existingProb = merged[key] ?? 0;
      // Combine CLM probability and online learned prototype similarity
      const blended = Math.max(
        existingProb,
        existingProb > 0
          ? existingProb * 0.55 + learnedScore * 0.45
          : learnedScore * 0.85
      );
      merged[key] = Number(Math.min(0.99, blended).toFixed(4));
    }
  }

  const ranked = Object.entries(merged).sort((a, b) => b[1] - a[1]);
  const selectedTags: string[] = [];

  for (let i = 0; i < ranked.length; i++) {
    const [tagKey, prob] = ranked[i];
    const threshold = i === 0 ? primaryThreshold : secondaryThreshold;
    if (prob >= threshold) {
      selectedTags.push(tagKey);
      if (selectedTags.length >= maxTagsPerEmail) break;
    }
  }

  return { selectedTags, mergedProbabilities: merged };
}

/**
 * Builds a deterministic static System-1 prompt (used when falling back on Ollama < v0.35).
 */
export function buildStaticSystemPrompt(
  enabledTags: TagDefinition[],
  maxTagsPerEmail: number,
  isBatch: boolean
): string {
  const catalogLines = enabledTags
    .map((t, idx) => {
      const cleanName = t.name.replace(/^(k1|agent)\s*:\s*/i, '').trim() || t.name;
      return `${idx}=${cleanName}: ${t.description}`;
    })
    .join('\n');

  if (!isBatch) {
    return (
      `You are a fast System-1 email classifier. Assign 1 to ${maxTagsPerEmail} tag IDs (integers 0..${enabledTags.length - 1}) that best match the email, or [] if none fit.\n` +
      `Categories:\n${catalogLines}\n` +
      `Respond ONLY with JSON: {"t":[id]}`
    );
  }

  return (
    `You are a fast System-1 email classifier. For each numbered email (0..N-1), assign 1 to ${maxTagsPerEmail} tag IDs (integers 0..${enabledTags.length - 1}) that best match, or [] if none fit.\n` +
    `Categories:\n${catalogLines}\n` +
    `Respond ONLY with JSON {"t":[[id],...]} where t[i] corresponds to email i in exact input order.`
  );
}

/**
 * Formats a single email or micro-batch of emails into an ultra-compact pipe-delimited prompt.
 */
export function buildCompactUserPrompt(
  inputs: EmailClassificationInput[],
  isBatch: boolean
): string {
  if (!isBatch && inputs.length === 1) {
    const item = inputs[0];
    const parts = [`From: ${item.author}`, `Subj: ${item.subject}`];
    if (item.snippet) {
      parts.push(`Body: ${item.snippet}`);
    }
    return parts.join('\n');
  }

  return inputs
    .map((item, idx) => {
      const cleanFrom = item.author.replace(/\|/g, ' ').trim();
      const cleanSubj = item.subject.replace(/\|/g, ' ').trim();
      const cleanBody = item.snippet ? item.snippet.replace(/\|/g, ' ').trim() : '';
      return cleanBody
        ? `${idx}|${cleanFrom}|${cleanSubj}|${cleanBody}`
        : `${idx}|${cleanFrom}|${cleanSubj}`;
    })
    .join('\n');
}

/**
 * Parses compact index-array JSON responses (fallback mode).
 */
export function parseOllamaClassificationResponse(
  rawContent: string,
  enabledTags: TagDefinition[],
  batchLength: number,
  maxTagsPerEmail: number
): string[][] {
  const emptyResult = () => Array.from({ length: batchLength }, () => [] as string[]);
  if (!rawContent || enabledTags.length === 0) {
    return emptyResult();
  }

  const resolveSingleEntry = (entry: unknown): string[] => {
    const rawItems = Array.isArray(entry)
      ? entry
      : entry && typeof entry === 'object' && 't' in (entry as Record<string, unknown>)
        ? (entry as Record<string, unknown>).t
        : entry && typeof entry === 'object' && 'tags' in (entry as Record<string, unknown>)
          ? (entry as Record<string, unknown>).tags
          : [entry];

    if (!Array.isArray(rawItems)) return [];

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const val of rawItems) {
      let tagKey: string | undefined;

      if (typeof val === 'number' && Number.isInteger(val)) {
        tagKey = enabledTags[val]?.key;
      } else if (typeof val === 'string') {
        const trimmed = val.trim();
        const asInt = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(asInt) && String(asInt) === trimmed && enabledTags[asInt]) {
          tagKey = enabledTags[asInt].key;
        } else {
          const lower = trimmed.toLowerCase();
          const found = enabledTags.find(
            (t) =>
              t.key.toLowerCase() === lower ||
              t.name.toLowerCase() === lower ||
              t.name.replace(/^(k1|agent)\s*:\s*/i, '').toLowerCase() === lower
          );
          tagKey = found?.key;
        }
      }

      if (tagKey && !seen.has(tagKey)) {
        seen.add(tagKey);
        resolved.push(tagKey);
        if (resolved.length >= maxTagsPerEmail) break;
      }
    }

    return resolved;
  };

  try {
    const cleanedJson = rawContent
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleanedJson);

    if (batchLength === 1) {
      const tVal = parsed?.t ?? parsed?.tags ?? parsed;
      if (Array.isArray(tVal) && tVal.length === 1 && Array.isArray(tVal[0])) {
        return [resolveSingleEntry(tVal[0])];
      }
      return [resolveSingleEntry(tVal)];
    }

    const listCandidate = parsed?.t ?? parsed?.results ?? parsed?.r ?? parsed;
    if (Array.isArray(listCandidate)) {
      const output: string[][] = [];
      for (let i = 0; i < batchLength; i++) {
        output.push(resolveSingleEntry(listCandidate[i] ?? []));
      }
      return output;
    }
  } catch {
    if (batchLength === 1) {
      const match = rawContent.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/);
      if (match && match[1]) {
        const nums = match[1].split(',').map((s) => Number.parseInt(s.trim(), 10));
        return [resolveSingleEntry(nums)];
      }
    }
  }

  return emptyResult();
}

/**
 * Primary classification entry point:
 * 1. Calls Ollama's native `/v1/systemone` Jev CLM endpoint (`tev1:0.8b`, `tev1:4b`, `nimble`, `jev`)
 *    which evaluates all `agent:` tags and learned user tags in a SINGLE forward pass with ZERO output tokens,
 *    returning calibrated probabilities.
 * 2. Blends in local ContinualTagLearner prototype scores for user-learned tags.
 * 3. Automatically falls back if the user's Ollama version is older than v0.35.0.
 */
export async function classifyBatchWithOllama(
  inputs: EmailClassificationInput[],
  settings: PluginSettings,
  signal?: AbortSignal,
  extraLearnedTags: TagDefinition[] = [],
  learnedScoresPerItem?: Array<Record<string, number>>
): Promise<ClmClassificationOutput> {
  const activeTags = [
    ...settings.tags.filter((t) => t.enabled),
    ...extraLearnedTags.filter((t) => t.enabled),
  ];

  if (inputs.length === 0 || activeTags.length === 0) {
    return {
      tagsPerItem: inputs.map(() => []),
      probabilitiesPerItem: inputs.map(() => ({})),
      source: 'clm-systemone',
      durationMs: 0,
    };
  }

  const endpoint = normalizeEndpoint(settings.ollamaEndpoint);
  const validTagKeys = new Set(activeTags.map((t) => t.key.toLowerCase()));
  const primaryThreshold = settings.clmConfidenceThreshold ?? 0.25;
  const secondaryThreshold = settings.clmSecondaryThreshold ?? 0.18;
  const startTime = performance.now();

  // Attempt native Ollama `/v1/systemone` Jev CLM endpoint first
  try {
    const systemOneResults = await Promise.all(
      inputs.map(async (input, idx) => {
        const reqBody = buildSystemOneRequest(input, activeTags, settings.model);
        const res = await fetch(`${endpoint}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal,
        });

        if (!res.ok) {
          const err = new Error(`SystemOne HTTP ${res.status}`) as Error & {
            status?: number;
          };
          err.status = res.status;
          throw err;
        }

        const data = (await res.json()) as SystemOneResponse;
        const catAnswer =
          data?.answers?.category ||
          Object.values(data?.answers || {})[0];

        const { selectedTags, mergedProbabilities } =
          selectTagsFromSystemOneProbabilities({
            clmProbabilities: catAnswer?.probabilities || {},
            winningChoice: catAnswer?.choice,
            learnedScores: learnedScoresPerItem?.[idx],
            validTagKeys,
            maxTagsPerEmail: settings.maxTagsPerEmail,
            primaryThreshold,
            secondaryThreshold,
          });

        return { selectedTags, mergedProbabilities };
      })
    );

    const durationMs = Math.round(performance.now() - startTime);
    return {
      tagsPerItem: systemOneResults.map((r) => r.selectedTags),
      probabilitiesPerItem: systemOneResults.map((r) => r.mergedProbabilities),
      source: 'clm-systemone',
      durationMs,
    };
  } catch (sysOneErr: any) {
    if (sysOneErr?.name === 'AbortError' || signal?.aborted) {
      throw sysOneErr;
    }

    // Fallback for Ollama < v0.35.0 or models that don't implement /v1/systemone yet
    return await classifyBatchWithFallback(
      inputs,
      activeTags,
      settings,
      endpoint,
      startTime,
      signal,
      learnedScoresPerItem
    );
  }
}

async function classifyBatchWithFallback(
  inputs: EmailClassificationInput[],
  activeTags: TagDefinition[],
  settings: PluginSettings,
  endpoint: string,
  startTime: number,
  signal?: AbortSignal,
  learnedScoresPerItem?: Array<Record<string, number>>
): Promise<ClmClassificationOutput> {
  const isBatch = inputs.length > 1;
  const maxTagIndex = Math.max(0, activeTags.length - 1);

  const systemPrompt = buildStaticSystemPrompt(
    activeTags,
    settings.maxTagsPerEmail,
    isBatch
  );
  const userPrompt = buildCompactUserPrompt(inputs, isBatch);

  const formatSchema = isBatch
    ? {
        type: 'object',
        properties: {
          t: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: 'integer',
                minimum: 0,
                maximum: maxTagIndex,
              },
            },
          },
        },
        required: ['t'],
      }
    : {
        type: 'object',
        properties: {
          t: {
            type: 'array',
            items: {
              type: 'integer',
              minimum: 0,
              maximum: maxTagIndex,
            },
          },
        },
        required: ['t'],
      };

  const numPredict = isBatch ? Math.min(256, inputs.length * 14 + 16) : 28;
  const numCtx = isBatch ? 2048 : 1024;

  const buildPayload = (includeThinkParam: boolean) => {
    const payload: Record<string, unknown> = {
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      format: formatSchema,
      keep_alive: settings.keepAlive || '30m',
      options: {
        temperature: 0,
        num_predict: numPredict,
        num_ctx: numCtx,
      },
    };
    if (includeThinkParam && settings.systemOneThinkFalse) {
      payload.think = false;
    }
    return payload;
  };

  const canUseThink =
    settings.systemOneThinkFalse && !unsupportedThinkModels.has(settings.model);

  try {
    let response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(canUseThink)),
      signal,
    });

    if (!response.ok && canUseThink && response.status === 400) {
      unsupportedThinkModels.add(settings.model);
      response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(false)),
        signal,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 403) {
        throw new Error(
          `Ollama returned 403 Forbidden (CORS). Make sure Ollama is running locally or set OLLAMA_ORIGINS=*`
        );
      }
      throw new Error(
        `Ollama error (${response.status}): ${errText || response.statusText}`
      );
    }

    const data = await response.json();
    const rawContent: string = data?.message?.content || '';
    const durationMs = Math.round(performance.now() - startTime);

    const parsedTagsPerItem = parseOllamaClassificationResponse(
      rawContent,
      activeTags,
      inputs.length,
      settings.maxTagsPerEmail
    );

    const probabilitiesPerItem: Array<Record<string, number>> = [];
    const finalTagsPerItem = parsedTagsPerItem.map((tags, idx) => {
      const probs: Record<string, number> = {};
      for (const k of tags) {
        probs[k] = 0.85;
      }
      const learnedScores = learnedScoresPerItem?.[idx] || {};
      for (const [learnedKey, score] of Object.entries(learnedScores)) {
        probs[learnedKey] = Math.max(probs[learnedKey] || 0, score);
        if (
          score >= (settings.clmConfidenceThreshold ?? 0.25) &&
          !tags.includes(learnedKey) &&
          tags.length < settings.maxTagsPerEmail
        ) {
          tags.push(learnedKey);
        }
      }
      probabilitiesPerItem.push(probs);
      return tags.slice(0, settings.maxTagsPerEmail);
    });

    return {
      tagsPerItem: finalTagsPerItem,
      probabilitiesPerItem,
      source: 'clm-fallback',
      durationMs,
    };
  } catch (fallbackErr: any) {
    if (fallbackErr?.name === 'AbortError' || signal?.aborted) {
      throw fallbackErr;
    }

    // If local Naive-Bayes/BM25 CLM scores were computed, use them seamlessly when Ollama is offline or model is not pulled
    if (learnedScoresPerItem && learnedScoresPerItem.length === inputs.length) {
      const validTagKeys = new Set(activeTags.map((t) => t.key.toLowerCase()));
      const primaryThreshold = settings.clmConfidenceThreshold ?? 0.25;
      const secondaryThreshold = settings.clmSecondaryThreshold ?? 0.18;

      const localResults = learnedScoresPerItem.map((localScores) =>
        selectTagsFromSystemOneProbabilities({
          clmProbabilities: localScores,
          validTagKeys,
          maxTagsPerEmail: settings.maxTagsPerEmail,
          primaryThreshold,
          secondaryThreshold,
        })
      );

      return {
        tagsPerItem: localResults.map((r) => r.selectedTags),
        probabilitiesPerItem: localResults.map((r) => r.mergedProbabilities),
        source: 'clm-local-nb',
        durationMs: Math.max(1, Math.round(performance.now() - startTime)),
      };
    }

    throw fallbackErr;
  }
}

/**
 * Checks connectivity to Ollama, version support for `/v1/systemone`, and installed models.
 */
export async function checkOllamaHealth(
  settings: PluginSettings
): Promise<OllamaHealthCheckResult> {
  const endpoint = normalizeEndpoint(settings.ollamaEndpoint);
  const start = performance.now();

  try {
    const [tagsRes, versionRes] = await Promise.all([
      fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
      fetch(`${endpoint}/api/version`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }).catch(() => null),
    ]);

    const latencyMs = Math.round(performance.now() - start);

    if (tagsRes.status === 403) {
      return {
        ok: false,
        systemOneSupported: false,
        models: [],
        configuredModelInstalled: false,
        activeModel: settings.model,
        latencyMs,
        corsBlocked: true,
        error:
          'Ollama blocked the request (HTTP 403 CORS). Set OLLAMA_ORIGINS=* or reload the extension.',
      };
    }

    if (!tagsRes.ok) {
      return {
        ok: false,
        systemOneSupported: false,
        models: [],
        configuredModelInstalled: false,
        activeModel: settings.model,
        latencyMs,
        error: `HTTP ${tagsRes.status}: ${tagsRes.statusText}`,
      };
    }

    const data = await tagsRes.json();
    const versionData = versionRes?.ok ? await versionRes.json().catch(() => null) : null;
    const versionStr: string | undefined = versionData?.version;

    // Ollama v0.35.0+ supports native /v1/systemone Jev CLM decision models
    let systemOneSupported = false;
    if (versionStr) {
      const parts = versionStr.replace(/^v/i, '').split('.').map(Number);
      if (parts[0] > 0 || (parts[0] === 0 && (parts[1] || 0) >= 35)) {
        systemOneSupported = true;
      }
    }

    const rawModels: Array<Record<string, any>> = Array.isArray(data?.models)
      ? data.models
      : [];

    const models: OllamaModelInfo[] = rawModels.map((m) => ({
      name: String(m.name || m.model || ''),
      size: Number(m.size || 0),
      parameterSize: m.details?.parameter_size,
      quantizationLevel: m.details?.quantization_level,
      family: m.details?.family,
    }));

    const configuredLower = settings.model.trim().toLowerCase();
    const configuredModelInstalled = models.some((m) => {
      const nameLower = m.name.toLowerCase();
      return (
        nameLower === configuredLower ||
        nameLower === `${configuredLower}:latest` ||
        nameLower.split(':')[0] === configuredLower
      );
    });

    return {
      ok: true,
      version: versionStr,
      systemOneSupported,
      models,
      configuredModelInstalled,
      activeModel: settings.model,
      latencyMs,
    };
  } catch (err: any) {
    return {
      ok: false,
      systemOneSupported: false,
      models: [],
      configuredModelInstalled: false,
      activeModel: settings.model,
      latencyMs: Math.round(performance.now() - start),
      error:
        err?.message ||
        `Could not connect to Ollama at ${endpoint}. Ensure 'ollama serve' is running.`,
    };
  }
}

/**
 * Pulls a CLM model (e.g. `tev1:0.8b`, `tev1:4b`, `nimble`) from Ollama with live streaming progress.
 */
export async function pullOllamaModel(
  endpointUrl: string,
  modelName: string,
  onProgress?: (update: PullProgressUpdate) => void
): Promise<void> {
  const endpoint = normalizeEndpoint(endpointUrl);
  const res = await fetch(`${endpoint}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to pull ${modelName} (${res.status}): ${text}`);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.error) {
          throw new Error(msg.error);
        }
        if (onProgress) {
          const percent =
            msg.total && msg.completed
              ? Math.round((msg.completed / msg.total) * 100)
              : undefined;
          onProgress({
            status: msg.status || 'Downloading...',
            completed: msg.completed,
            total: msg.total,
            percent,
          });
        }
      } catch (e: any) {
        if (e?.message && !e.message.includes('JSON')) {
          throw e;
        }
      }
    }
  }
}
