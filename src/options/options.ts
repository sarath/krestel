import {
  DEFAULT_SETTINGS,
  DEFAULT_TAGS,
  RECOMMENDED_SYSTEM1_MODELS,
} from '../defaults';
import { OllamaModelInfo, pullOllamaModel } from '../ollamaClient';
import { ensureAgentTagDisplayName, sanitizeTagKey } from '../tagManager';
import {
  LearnedTagProfile,
  MemoCacheStats,
  PluginSettings,
  PromptMode,
  TagDefinition,
} from '../types';

declare const messenger: any;
declare const browser: any;

function getApi(): any {
  if (typeof messenger !== 'undefined') return messenger;
  if (typeof browser !== 'undefined') return browser;
  if (typeof window !== 'undefined' && (window.parent as any)?.messenger) {
    return (window.parent as any).messenger;
  }
  return null;
}

const SANDBOX_PRESETS: Record<
  string,
  { author: string; subject: string; snippet: string }
> = {
  invoice: {
    author: 'Stripe <billing@stripe.com>',
    subject: 'Your invoice #4821 has been paid',
    snippet:
      'Thank you for your payment of $29.00 for your monthly subscription. View your receipt online.',
  },
  urgent: {
    author: 'Sarah Chen <sarah@company.io>',
    subject: 'Urgent: Need your approval on Q4 budget deck before 3pm',
    snippet:
      'Hi! Can you please review slide 6 and reply with your sign-off before the board call at 3pm today?',
  },
  otp: {
    author: 'GitHub <noreply@github.com>',
    subject: '[GitHub] Please verify your device',
    snippet:
      'A sign in attempt requires further verification. Verification code: 849201. This code expires in 15 minutes.',
  },
  shipping: {
    author: 'Amazon.com <shipment-tracking@amazon.com>',
    subject: 'Your package has shipped!',
    snippet:
      'Your order #114-3920192 is out for delivery with UPS. Track your package status.',
  },
  newsletter: {
    author: 'ByteByteGo <newsletter@bytebytego.com>',
    subject: 'Weekly Digest: How Discord Stores Trillions of Messages',
    snippet:
      'In this week issue we dive into distributed database partitioning and read-heavy caching strategies. View in browser.',
  },
};

let settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
let learnedProfiles: LearnedTagProfile[] = [];
let installedModelNames = new Set<string>();

function sendRpc(payload: Record<string, unknown>): Promise<any> {
  const api = getApi();
  if (!api?.runtime?.sendMessage) {
    return Promise.resolve({ ok: false, error: 'Runtime API unavailable' });
  }
  return api.runtime.sendMessage(payload);
}

function showSaveToast(message?: string): void {
  const toast = document.getElementById('save-toast');
  if (!toast) return;
  toast.textContent = message || '✓ Settings saved & synced with Thunderbird';
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

function renderLearnedTagsEditor(): void {
  const listEl = document.getElementById('learned-tags-list');
  if (!listEl) return;

  if (!learnedProfiles || learnedProfiles.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">No user tags learned yet. Simply apply any Thunderbird tag (not starting with <code>k1:</code>) to an email, or click "🎓 Learn Tags" in the toolbar popup!</div>';
    return;
  }

  listEl.innerHTML = '';

  for (const prof of learnedProfiles) {
    const card = document.createElement('div');
    card.className = 'tag-card';

    const top = document.createElement('div');
    top.className = 'tag-card-top';

    const enableCheck = document.createElement('input');
    enableCheck.type = 'checkbox';
    enableCheck.checked = prof.enabled;
    enableCheck.title = 'Enable or disable applying this learned user tag to future emails';
    enableCheck.addEventListener('change', async () => {
      const res = await sendRpc({
        type: 'UPDATE_LEARNED_PROFILE',
        tagKey: prof.key,
        updates: { enabled: enableCheck.checked },
      });
      if (res?.ok && res.learnedProfiles) {
        learnedProfiles = res.learnedProfiles;
      }
    });

    const dot = document.createElement('div');
    dot.style.width = '24px';
    dot.style.height = '24px';
    dot.style.borderRadius = '6px';
    dot.style.backgroundColor = prof.color || '#00897b';

    const titleSpan = document.createElement('strong');
    titleSpan.textContent = `🎓 ${prof.name}`;

    const minSamples = settings.minLearnedSamplesToApply ?? 3;
    const isReady = prof.sampleCount >= minSamples;
    const negSuffix =
      prof.negativeCount && prof.negativeCount > 0
        ? ` • ${prof.negativeCount} negative correction(s)`
        : '';

    const sampleBadge = document.createElement('span');
    sampleBadge.className = 'tag-key-badge';
    sampleBadge.textContent = isReady
      ? `✓ Active (${prof.sampleCount}/${minSamples}+ examples)${negSuffix} • key: ${prof.key}`
      : `⏳ Warming up (${prof.sampleCount}/${minSamples} examples needed)${negSuffix} • key: ${prof.key}`;

    const forgetBtn = document.createElement('button');
    forgetBtn.className = 'btn btn-danger btn-sm';
    forgetBtn.textContent = 'Forget';
    forgetBtn.addEventListener('click', async () => {
      const res = await sendRpc({
        type: 'DELETE_LEARNED_PROFILE',
        tagKey: prof.key,
      });
      if (res?.ok) {
        learnedProfiles = res.learnedProfiles || [];
        renderLearnedTagsEditor();
      }
    });

    top.appendChild(enableCheck);
    top.appendChild(dot);
    top.appendChild(titleSpan);
    top.appendChild(sampleBadge);
    top.appendChild(forgetBtn);

    const criteriaWrap = document.createElement('div');
    const criteriaLabel = document.createElement('label');
    criteriaLabel.className = 'field-label';
    criteriaLabel.textContent =
      'Synthesized System-1 CLM Criteria (auto-learned from senders, domains & keywords — editable)';
    const criteriaInput = document.createElement('input');
    criteriaInput.type = 'text';
    criteriaInput.className = 'text-input';
    criteriaInput.value =
      prof.customCriteriaOverride || prof.synthesizedCriteria;
    criteriaInput.addEventListener('change', async () => {
      const res = await sendRpc({
        type: 'UPDATE_LEARNED_PROFILE',
        tagKey: prof.key,
        updates: { customCriteriaOverride: criteriaInput.value },
      });
      if (res?.ok && res.learnedProfiles) {
        learnedProfiles = res.learnedProfiles;
        showSaveToast(`✓ Updated learned criteria for "${prof.name}"`);
      }
    });

    criteriaWrap.appendChild(criteriaLabel);
    criteriaWrap.appendChild(criteriaInput);

    card.appendChild(top);
    card.appendChild(criteriaWrap);
    listEl.appendChild(card);
  }
}

function renderTagsEditor(): void {
  const listEl = document.getElementById('tags-editor-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  settings.tags.forEach((tag, index) => {
    const card = document.createElement('div');
    card.className = 'tag-card';

    const top = document.createElement('div');
    top.className = 'tag-card-top';

    const enableCheck = document.createElement('input');
    enableCheck.type = 'checkbox';
    enableCheck.checked = tag.enabled;
    enableCheck.title = 'Enable or disable this k1: tag';
    enableCheck.addEventListener('change', () => {
      settings.tags[index].enabled = enableCheck.checked;
    });

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-input';
    colorInput.value = tag.color;
    colorInput.addEventListener('input', () => {
      settings.tags[index].color = colorInput.value;
    });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text-input';
    nameInput.value = tag.name;
    nameInput.placeholder = 'Tag Display Name';
    nameInput.addEventListener('input', () => {
      settings.tags[index].name = nameInput.value.trim() || tag.key;
    });

    const keyBadge = document.createElement('span');
    keyBadge.className = 'tag-key-badge';
    keyBadge.textContent = tag.key;
    keyBadge.title = 'Internal Thunderbird tag key';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      settings.tags.splice(index, 1);
      renderTagsEditor();
    });

    top.appendChild(enableCheck);
    top.appendChild(colorInput);
    top.appendChild(nameInput);
    top.appendChild(keyBadge);
    top.appendChild(delBtn);

    const bottom = document.createElement('div');
    bottom.className = 'tag-card-bottom';

    const descWrap = document.createElement('div');
    const descLabel = document.createElement('label');
    descLabel.className = 'field-label';
    descLabel.textContent = 'System-1 CLM Criteria Description';
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'text-input';
    descInput.value = tag.description;
    descInput.addEventListener('input', () => {
      settings.tags[index].description = descInput.value;
    });
    descWrap.appendChild(descLabel);
    descWrap.appendChild(descInput);

    const kwWrap = document.createElement('div');
    const kwLabel = document.createElement('label');
    kwLabel.className = 'field-label';
    kwLabel.textContent = 'Fast-Path Keywords (comma-separated)';
    const kwInput = document.createElement('input');
    kwInput.type = 'text';
    kwInput.className = 'text-input';
    kwInput.value = (tag.fastPathKeywords || []).join(', ');
    kwInput.placeholder = 'Optional instant-match keywords';
    kwInput.addEventListener('input', () => {
      settings.tags[index].fastPathKeywords = kwInput.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    });
    kwWrap.appendChild(kwLabel);
    kwWrap.appendChild(kwInput);

    bottom.appendChild(descWrap);
    bottom.appendChild(kwWrap);

    card.appendChild(top);
    card.appendChild(bottom);
    listEl.appendChild(card);
  });
}

function populateSettingsFields(): void {
  const endpointEl = document.getElementById('opt-endpoint') as HTMLInputElement | null;
  const modelEl = document.getElementById('opt-model') as HTMLInputElement | null;
  const autoLearnEl = document.getElementById('opt-auto-learn') as HTMLInputElement | null;
  const minLearnedEl = document.getElementById('opt-min-learned-samples') as HTMLInputElement | null;
  const negFeedbackEl = document.getElementById('opt-negative-feedback') as HTMLInputElement | null;
  const arrivalEl = document.getElementById('opt-classify-arrival') as HTMLInputElement | null;
  const clmThreshEl = document.getElementById('opt-clm-threshold') as HTMLInputElement | null;
  const clmSecThreshEl = document.getElementById('opt-clm-sec-threshold') as HTMLInputElement | null;
  const maxTagsEl = document.getElementById('opt-max-tags') as HTMLSelectElement | null;
  const keepAliveEl = document.getElementById('opt-keep-alive') as HTMLSelectElement | null;
  const promptModeEl = document.getElementById('opt-prompt-mode') as HTMLSelectElement | null;
  const snippetCharsEl = document.getElementById('opt-snippet-chars') as HTMLInputElement | null;
  const batchSizeEl = document.getElementById('opt-batch-size') as HTMLInputElement | null;
  const concurrencyEl = document.getElementById('opt-concurrency') as HTMLInputElement | null;
  const threadMemoEl = document.getElementById('opt-thread-memo') as HTMLInputElement | null;
  const senderMemoEl = document.getElementById('opt-sender-memo') as HTMLInputElement | null;
  const fastPathEl = document.getElementById('opt-fast-path') as HTMLInputElement | null;

  if (endpointEl) endpointEl.value = settings.ollamaEndpoint;
  if (modelEl) modelEl.value = settings.model;
  if (autoLearnEl) autoLearnEl.checked = settings.enableAutoLearnUserTags ?? true;
  if (minLearnedEl) minLearnedEl.value = String(settings.minLearnedSamplesToApply ?? 3);
  if (negFeedbackEl) negFeedbackEl.checked = settings.enableNegativeFeedbackOnRemove ?? true;
  if (arrivalEl) arrivalEl.checked = settings.classifyOnArrival;
  if (clmThreshEl) clmThreshEl.value = String(settings.clmConfidenceThreshold ?? 0.25);
  if (clmSecThreshEl) clmSecThreshEl.value = String(settings.clmSecondaryThreshold ?? 0.18);
  if (maxTagsEl) maxTagsEl.value = String(settings.maxTagsPerEmail);
  if (keepAliveEl) keepAliveEl.value = settings.keepAlive || '30m';
  if (promptModeEl) promptModeEl.value = settings.promptMode;
  if (snippetCharsEl) snippetCharsEl.value = String(settings.maxSnippetChars);
  if (batchSizeEl) batchSizeEl.value = String(settings.batchSize);
  if (concurrencyEl) concurrencyEl.value = String(settings.concurrency);
  if (threadMemoEl) threadMemoEl.checked = settings.enableThreadMemoization;
  if (senderMemoEl) senderMemoEl.checked = settings.enableSenderMemoization;
  if (fastPathEl) fastPathEl.checked = settings.enableFastPathRules;
}

function readSettingsFromDom(): PluginSettings {
  const endpointEl = document.getElementById('opt-endpoint') as HTMLInputElement | null;
  const modelEl = document.getElementById('opt-model') as HTMLInputElement | null;
  const autoLearnEl = document.getElementById('opt-auto-learn') as HTMLInputElement | null;
  const minLearnedEl = document.getElementById('opt-min-learned-samples') as HTMLInputElement | null;
  const negFeedbackEl = document.getElementById('opt-negative-feedback') as HTMLInputElement | null;
  const arrivalEl = document.getElementById('opt-classify-arrival') as HTMLInputElement | null;
  const clmThreshEl = document.getElementById('opt-clm-threshold') as HTMLInputElement | null;
  const clmSecThreshEl = document.getElementById('opt-clm-sec-threshold') as HTMLInputElement | null;
  const maxTagsEl = document.getElementById('opt-max-tags') as HTMLSelectElement | null;
  const keepAliveEl = document.getElementById('opt-keep-alive') as HTMLSelectElement | null;
  const promptModeEl = document.getElementById('opt-prompt-mode') as HTMLSelectElement | null;
  const snippetCharsEl = document.getElementById('opt-snippet-chars') as HTMLInputElement | null;
  const batchSizeEl = document.getElementById('opt-batch-size') as HTMLInputElement | null;
  const concurrencyEl = document.getElementById('opt-concurrency') as HTMLInputElement | null;
  const threadMemoEl = document.getElementById('opt-thread-memo') as HTMLInputElement | null;
  const senderMemoEl = document.getElementById('opt-sender-memo') as HTMLInputElement | null;
  const fastPathEl = document.getElementById('opt-fast-path') as HTMLInputElement | null;

  settings.ollamaEndpoint =
    (endpointEl?.value || 'http://localhost:11434').trim();
  settings.model = (modelEl?.value || 'tev1:0.8b').trim();
  settings.enableAutoLearnUserTags = Boolean(autoLearnEl?.checked);
  settings.minLearnedSamplesToApply = Math.max(
    1,
    Math.min(20, Number.parseInt(minLearnedEl?.value || '3', 10) || 3)
  );
  settings.enableNegativeFeedbackOnRemove = Boolean(negFeedbackEl?.checked);
  settings.classifyOnArrival = Boolean(arrivalEl?.checked);
  settings.clmConfidenceThreshold = Math.max(
    0.05,
    Math.min(0.95, Number.parseFloat(clmThreshEl?.value || '0.25') || 0.25)
  );
  settings.clmSecondaryThreshold = Math.max(
    0.05,
    Math.min(0.95, Number.parseFloat(clmSecThreshEl?.value || '0.18') || 0.18)
  );
  settings.maxTagsPerEmail = Math.max(
    1,
    Math.min(3, Number.parseInt(maxTagsEl?.value || '2', 10) || 2)
  );
  settings.keepAlive = keepAliveEl?.value || '30m';
  settings.promptMode = (promptModeEl?.value || 'compact_snippet') as PromptMode;
  settings.maxSnippetChars = Math.max(
    100,
    Math.min(1200, Number.parseInt(snippetCharsEl?.value || '380', 10) || 380)
  );
  settings.batchSize = Math.max(
    1,
    Math.min(12, Number.parseInt(batchSizeEl?.value || '5', 10) || 5)
  );
  settings.concurrency = Math.max(
    1,
    Math.min(8, Number.parseInt(concurrencyEl?.value || '3', 10) || 3)
  );
  settings.enableThreadMemoization = Boolean(threadMemoEl?.checked);
  settings.enableSenderMemoization = Boolean(senderMemoEl?.checked);
  settings.enableFastPathRules = Boolean(fastPathEl?.checked);

  return settings;
}

function renderRecommendedModels(): void {
  const container = document.getElementById('recommended-models-list');
  if (!container) return;
  container.innerHTML = '';

  for (const rec of RECOMMENDED_SYSTEM1_MODELS) {
    const isInstalled = Array.from(installedModelNames).some(
      (n) =>
        n.toLowerCase() === rec.id.toLowerCase() ||
        n.toLowerCase().startsWith(rec.id.toLowerCase())
    );

    const row = document.createElement('div');
    row.className = 'rec-model-item';

    const info = document.createElement('div');
    info.className = 'rec-model-info';
    const title = document.createElement('strong');
    title.textContent = `${rec.label} (${rec.size}) — ${rec.badge}`;
    const sub = document.createElement('span');
    sub.textContent = rec.description;
    info.appendChild(title);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'rec-model-actions';

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-secondary btn-sm';
    useBtn.textContent =
      settings.model === rec.id ? '✓ Active' : isInstalled ? 'Select' : 'Use Name';
    useBtn.addEventListener('click', () => {
      const modelInput = document.getElementById('opt-model') as HTMLInputElement | null;
      if (modelInput) modelInput.value = rec.id;
      settings.model = rec.id;
      renderRecommendedModels();
    });

    actions.appendChild(useBtn);

    if (!isInstalled && rec.id !== 'jev') {
      const pullBtn = document.createElement('button');
      pullBtn.className = 'btn btn-primary btn-sm';
      pullBtn.textContent = '⬇ Pull';
      pullBtn.addEventListener('click', async () => {
        const progressBox = document.getElementById('pull-progress-box');
        if (progressBox) {
          progressBox.classList.remove('hidden');
          progressBox.textContent = `Pulling ${rec.id} from Ollama...`;
        }
        pullBtn.disabled = true;
        try {
          readSettingsFromDom();
          await pullOllamaModel(settings.ollamaEndpoint, rec.id, (upd) => {
            if (progressBox) {
              const pctStr =
                typeof upd.percent === 'number' ? ` (${upd.percent}%)` : '';
              progressBox.textContent = `${rec.id}: ${upd.status}${pctStr}`;
            }
          });
          if (progressBox) {
            progressBox.textContent = `✓ Successfully pulled ${rec.id}!`;
          }
          const modelInput = document.getElementById(
            'opt-model'
          ) as HTMLInputElement | null;
          if (modelInput) modelInput.value = rec.id;
          settings.model = rec.id;
          await runOllamaCheck();
        } catch (err: any) {
          if (progressBox) {
            progressBox.textContent = `✗ Error pulling ${rec.id}: ${err?.message || err}`;
          }
        } finally {
          pullBtn.disabled = false;
        }
      });
      actions.appendChild(pullBtn);
    }

    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  }
}

async function runOllamaCheck(): Promise<void> {
  const healthBox = document.getElementById('ollama-health-box');
  const installedSelect = document.getElementById(
    'opt-installed-models'
  ) as HTMLSelectElement | null;

  if (healthBox) {
    healthBox.className = 'health-box';
    healthBox.textContent = 'Testing connection to Ollama...';
  }

  readSettingsFromDom();
  const res = await sendRpc({ type: 'CHECK_OLLAMA', settings });

  if (!res?.ok || !res.health) {
    if (healthBox) {
      healthBox.className = 'health-box err';
      healthBox.textContent = res?.error || 'Could not reach background script.';
    }
    return;
  }

  const health = res.health;
  installedModelNames = new Set(
    (health.models || []).map((m: OllamaModelInfo) => m.name)
  );

  if (installedSelect) {
    installedSelect.innerHTML = '';
    if (!health.models || health.models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = health.ok
        ? 'No local models installed — pull tev1:0.8b below'
        : 'Ollama offline';
      installedSelect.appendChild(opt);
    } else {
      for (const m of health.models as OllamaModelInfo[]) {
        const opt = document.createElement('option');
        opt.value = m.name;
        const sizeGb = (m.size / (1024 * 1024 * 1024)).toFixed(1);
        const paramMeta = m.parameterSize ? ` • ${m.parameterSize}` : '';
        opt.textContent = `${m.name} (${sizeGb} GB${paramMeta})`;
        if (m.name.toLowerCase() === settings.model.toLowerCase()) {
          opt.selected = true;
        }
        installedSelect.appendChild(opt);
      }
    }
  }

  if (healthBox) {
    if (health.ok) {
      healthBox.className = 'health-box ok';
      const vBadge = health.version ? `v${health.version}` : 'connected';
      const sysOneMsg = health.systemOneSupported
        ? 'Native /v1/systemone Jev CLM endpoint active.'
        : 'Update Ollama to v0.35+ for native /v1/systemone (compatibility fallback active).';
      healthBox.textContent = health.configuredModelInstalled
        ? `✓ Ollama ${vBadge} (${health.latencyMs}ms) — '${settings.model}' installed. ${sysOneMsg}`
        : `Connected to Ollama ${vBadge} (${health.latencyMs}ms), but '${settings.model}' is not pulled yet. Click Pull on tev1:0.8b below or select an installed model. ${sysOneMsg}`;
    } else {
      healthBox.className = 'health-box err';
      healthBox.textContent = `✗ ${health.error}`;
    }
  }

  renderRecommendedModels();
}

function renderMemoStats(memoStats?: MemoCacheStats): void {
  const el = document.getElementById('memo-stats-text');
  if (!el || !memoStats) return;
  el.textContent = `${memoStats.threadEntries.toLocaleString()} threads • ${memoStats.senderEntries.toLocaleString()} senders cached (${memoStats.totalHits.toLocaleString()} hits)`;
}

async function initOptions(): Promise<void> {
  const stateRes = await sendRpc({ type: 'GET_STATE' });
  if (stateRes?.ok && stateRes.settings) {
    settings = stateRes.settings;
    learnedProfiles = stateRes.learnedProfiles || [];
  }

  populateSettingsFields();
  renderLearnedTagsEditor();
  renderTagsEditor();
  renderMemoStats(stateRes?.memoStats);
  await runOllamaCheck();

  const installedSelect = document.getElementById(
    'opt-installed-models'
  ) as HTMLSelectElement | null;
  installedSelect?.addEventListener('change', () => {
    if (!installedSelect.value) return;
    const modelInput = document.getElementById('opt-model') as HTMLInputElement | null;
    if (modelInput) modelInput.value = installedSelect.value;
    settings.model = installedSelect.value;
    renderRecommendedModels();
  });

  // Clear all learned user tags
  document
    .getElementById('btn-clear-learned')
    ?.addEventListener('click', async () => {
      if (
        confirm(
          'Clear all learned user tag profiles? Future manual tags will start fresh.'
        )
      ) {
        const res = await sendRpc({ type: 'CLEAR_LEARNED_PROFILES' });
        if (res?.ok) {
          learnedProfiles = [];
          renderLearnedTagsEditor();
          showSaveToast('✓ Cleared learned user tag profiles');
        }
      }
    });

  // Add new custom agent: tag
  document.getElementById('btn-add-tag')?.addEventListener('click', () => {
    const nameInput = document.getElementById('new-tag-name') as HTMLInputElement | null;
    const colorInput = document.getElementById('new-tag-color') as HTMLInputElement | null;
    const descInput = document.getElementById('new-tag-desc') as HTMLInputElement | null;
    const kwInput = document.getElementById('new-tag-keywords') as HTMLInputElement | null;

    const rawName = (nameInput?.value || '').trim();
    if (!rawName) {
      alert('Please enter a Tag Name.');
      return;
    }

    const name = ensureAgentTagDisplayName(rawName);
    const key = sanitizeTagKey(rawName);
    if (settings.tags.some((t) => t.key === key)) {
      alert(`A tag with key "${key}" already exists.`);
      return;
    }

    const newTag: TagDefinition = {
      key,
      name,
      color: colorInput?.value || '#00897b',
      description:
        (descInput?.value || '').trim() ||
        `Emails related to ${rawName.replace(/^(k1|agent)\s*:\s*/i, '')}.`,
      enabled: true,
      fastPathKeywords: (kwInput?.value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };

    settings.tags.unshift(newTag);
    renderTagsEditor();

    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (kwInput) kwInput.value = '';
  });

  // Reset default tags
  document.getElementById('btn-reset-tags')?.addEventListener('click', () => {
    if (
      confirm(
        'Reset k1: tags to the default 8 categories? Any custom k1: tags you added will be replaced.'
      )
    ) {
      settings.tags = structuredClone(DEFAULT_TAGS);
      renderTagsEditor();
    }
  });

  // Sync tags with Thunderbird now
  document
    .getElementById('btn-sync-tb-tags')
    ?.addEventListener('click', async () => {
      readSettingsFromDom();
      await sendRpc({ type: 'SAVE_SETTINGS', settings });
      showSaveToast('✓ All k1: tags synced to Thunderbird!');
    });

  // Save all button
  document
    .getElementById('btn-save-all')
    ?.addEventListener('click', async () => {
      readSettingsFromDom();
      const res = await sendRpc({ type: 'SAVE_SETTINGS', settings });
      if (res?.ok) {
        showSaveToast('✓ Settings saved & synced with Thunderbird');
      } else {
        alert(`Failed to save settings: ${res?.error}`);
      }
    });

  // Test Ollama button
  document
    .getElementById('btn-test-ollama')
    ?.addEventListener('click', () => {
      void runOllamaCheck();
    });

  // Clear Memoization Cache
  document
    .getElementById('btn-clear-cache')
    ?.addEventListener('click', async () => {
      const res = await sendRpc({ type: 'CLEAR_MEMO_CACHE' });
      if (res?.ok) {
        renderMemoStats(res.memoStats);
        showSaveToast('✓ Memoization cache cleared');
      }
    });

  // Sandbox preset selector
  const presetSelect = document.getElementById(
    'sandbox-preset'
  ) as HTMLSelectElement | null;
  presetSelect?.addEventListener('change', () => {
    const preset = SANDBOX_PRESETS[presetSelect.value];
    if (!preset) return;
    const authorEl = document.getElementById(
      'sandbox-author'
    ) as HTMLInputElement | null;
    const subjectEl = document.getElementById(
      'sandbox-subject'
    ) as HTMLInputElement | null;
    const snippetEl = document.getElementById(
      'sandbox-snippet'
    ) as HTMLTextAreaElement | null;

    if (authorEl) authorEl.value = preset.author;
    if (subjectEl) subjectEl.value = preset.subject;
    if (snippetEl) snippetEl.value = preset.snippet;
  });

  // Run Sandbox Test
  const runSandboxBtn = document.getElementById(
    'btn-run-sandbox'
  ) as HTMLButtonElement | null;
  runSandboxBtn?.addEventListener('click', async () => {
    const resultEl = document.getElementById('sandbox-result');
    const authorEl = document.getElementById(
      'sandbox-author'
    ) as HTMLInputElement | null;
    const subjectEl = document.getElementById(
      'sandbox-subject'
    ) as HTMLInputElement | null;
    const snippetEl = document.getElementById(
      'sandbox-snippet'
    ) as HTMLTextAreaElement | null;

    if (!resultEl) return;
    resultEl.innerHTML =
      '<span>⏳ Evaluating with Ollama System-1 CLM...</span>';
    if (runSandboxBtn) runSandboxBtn.disabled = true;

    try {
      readSettingsFromDom();
      const res = await sendRpc({
        type: 'TEST_CLASSIFY_SAMPLE',
        settings,
        sample: {
          author: authorEl?.value || '',
          subject: subjectEl?.value || '',
          snippet: snippetEl?.value || '',
        },
      });

      if (!res?.ok) {
        resultEl.innerHTML = `<span style="color:#ef4444">✗ Error: ${res?.error}</span>`;
        return;
      }

      const assignedKeys: string[] = res.tags || [];
      const probs: Record<string, number> = res.probabilities || {};
      resultEl.innerHTML = '';

      const speedSpan = document.createElement('strong');
      const modeLabel =
        res.source === 'clm-systemone' ? '/v1/systemone CLM' : 'CLM';
      speedSpan.textContent = `⚡ ${modeLabel} (${res.durationMs}ms):`;
      resultEl.appendChild(speedSpan);

      if (assignedKeys.length === 0) {
        const none = document.createElement('span');
        none.textContent = 'No tags exceeded confidence threshold.';
        resultEl.appendChild(none);
      } else {
        for (const k of assignedKeys) {
          const agentDef = settings.tags.find(
            (t) => t.key.toLowerCase() === k.toLowerCase()
          );
          const learnedDef = learnedProfiles.find(
            (p) => p.key.toLowerCase() === k.toLowerCase()
          );
          const probVal = probs[k.toLowerCase()];
          const probText =
            typeof probVal === 'number'
              ? ` • ${Math.round(probVal * 100)}%`
              : '';

          const badge = document.createElement('span');
          badge.className = 'tag-badge';
          badge.style.backgroundColor =
            agentDef?.color || learnedDef?.color || '#1565c0';
          const labelName =
            agentDef?.name ||
            (learnedDef ? `🎓 ${learnedDef.name}` : k);
          badge.textContent = `${labelName}${probText}`;
          resultEl.appendChild(badge);
        }
      }
    } finally {
      if (runSandboxBtn) runSandboxBtn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initOptions();
});
