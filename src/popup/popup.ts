import {
  JobStatus,
  LearnedTagProfile,
  LifetimeStats,
  PluginSettings,
  ScopeFilter,
  ScopeMode,
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

interface FolderEntry {
  id?: string;
  accountId: string;
  accountName: string;
  name: string;
  path: string;
  type?: string;
  depth: number;
}

let currentSettings: PluginSettings | null = null;
let learnedProfiles: LearnedTagProfile[] = [];
let folderList: FolderEntry[] = [];
let tagLookup = new Map<string, { name: string; color: string }>();

function sendRpc(payload: Record<string, unknown>): Promise<any> {
  const api = getApi();
  if (!api?.runtime?.sendMessage) {
    return Promise.resolve({ ok: false, error: 'Runtime API unavailable' });
  }
  return api.runtime.sendMessage(payload);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return 'calculating...';
  }
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function showError(msg: string | null): void {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  if (!msg) {
    banner.classList.add('hidden');
    banner.textContent = '';
  } else {
    banner.textContent = msg;
    banner.classList.remove('hidden');
  }
}

function rebuildTagMap(
  tags: TagDefinition[],
  learned: LearnedTagProfile[]
): void {
  tagLookup.clear();
  for (const t of tags) {
    tagLookup.set(t.key.toLowerCase(), { name: t.name, color: t.color });
  }
  for (const p of learned) {
    tagLookup.set(p.key.toLowerCase(), {
      name: `🎓 ${p.name}`,
      color: p.color || '#00897b',
    });
  }
}

function renderActiveTags(
  tags: TagDefinition[],
  learned: LearnedTagProfile[]
): void {
  const container = document.getElementById('active-tags-list');
  if (!container) return;
  container.innerHTML = '';

  const enabledAgent = tags.filter((t) => t.enabled);
  for (const tag of enabledAgent) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.title = tag.description;

    const dot = document.createElement('span');
    dot.className = 'tag-dot';
    dot.style.backgroundColor = tag.color;

    const label = document.createElement('span');
    label.textContent = tag.name;

    chip.appendChild(dot);
    chip.appendChild(label);
    container.appendChild(chip);
  }

  for (const prof of learned.filter((p) => p.enabled && p.sampleCount > 0)) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.title = `Learned from ${prof.sampleCount} user-tagged email(s). ${prof.synthesizedCriteria}`;

    const dot = document.createElement('span');
    dot.className = 'tag-dot';
    dot.style.backgroundColor = prof.color || '#00897b';

    const minSamples = currentSettings?.minLearnedSamplesToApply ?? 3;
    const isReady = prof.sampleCount >= minSamples;
    const label = document.createElement('span');
    label.textContent = isReady
      ? `🎓 ${prof.name} (✓ ${prof.sampleCount})`
      : `🎓 ${prof.name} (${prof.sampleCount}/${minSamples} warmup)`;
    chip.title = isReady
      ? `${prof.synthesizedCriteria} — Active (${prof.sampleCount} examples)`
      : `Warming up: tag ${minSamples - prof.sampleCount} more email(s) with "${prof.name}" to auto-apply to future emails`;

    chip.appendChild(dot);
    chip.appendChild(label);
    container.appendChild(chip);
  }
}

function renderFolderDropdown(
  folders: FolderEntry[],
  activeFolder: { id?: string; accountId?: string; path?: string } | null
): void {
  const select = document.getElementById('folder-select') as HTMLSelectElement | null;
  if (!select) return;

  select.innerHTML = '';
  if (folders.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No mail folders found';
    select.appendChild(opt);
    return;
  }

  let selectedIndex = 0;
  folders.forEach((f, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    const indent = '  '.repeat(Math.max(0, f.depth));
    opt.textContent = `${f.accountName} › ${indent}${f.name}`;

    if (
      activeFolder &&
      ((activeFolder.id && f.id === activeFolder.id) ||
        (activeFolder.accountId === f.accountId && activeFolder.path === f.path))
    ) {
      selectedIndex = idx;
    } else if (
      selectedIndex === 0 &&
      f.type === 'inbox' &&
      !activeFolder
    ) {
      selectedIndex = idx;
    }
    select.appendChild(opt);
  });

  select.value = String(selectedIndex);
}

function renderJobStatus(status: JobStatus, stats?: LifetimeStats): void {
  const jobCard = document.getElementById('job-card');
  const stateBadge = document.getElementById('job-state-badge');
  const folderTitle = document.getElementById('job-folder-name');
  const pauseBtn = document.getElementById('btn-pause-resume') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('btn-cancel-job') as HTMLButtonElement | null;
  const fill = document.getElementById('job-progress-fill');
  const countsText = document.getElementById('job-progress-counts');
  const etaText = document.getElementById('job-eta-text');
  const metricClassified = document.getElementById('metric-classified');
  const metricLearned = document.getElementById('metric-learned');
  const metricCache = document.getElementById('metric-cache');
  const metricSpeed = document.getElementById('metric-speed');
  const distRow = document.getElementById('job-tag-distribution');
  const startBtn = document.getElementById('btn-start-folder') as HTMLButtonElement | null;

  if (!jobCard) return;

  const isRunningOrPaused =
    status.state === 'running' ||
    status.state === 'paused' ||
    status.state === 'cancelling';

  if (startBtn) {
    startBtn.disabled = isRunningOrPaused;
  }

  if (status.state === 'idle' && status.scanned === 0) {
    jobCard.classList.add('hidden');
  } else {
    jobCard.classList.remove('hidden');

    if (stateBadge) {
      stateBadge.className = `state-badge ${status.state}`;
      stateBadge.textContent = status.forceReapply
        ? `${status.state.toUpperCase()} • FORCE`
        : status.state.toUpperCase();
    }
    if (folderTitle) {
      folderTitle.textContent = status.folderName || 'Folder';
    }

    if (pauseBtn && cancelBtn) {
      if (isRunningOrPaused) {
        pauseBtn.classList.remove('hidden');
        cancelBtn.classList.remove('hidden');
        pauseBtn.textContent =
          status.state === 'paused' ? '▶ Resume' : '⏸ Pause';
      } else {
        pauseBtn.classList.add('hidden');
        cancelBtn.classList.add('hidden');
      }
    }

    const total = Math.max(status.totalEstimated, status.scanned);
    const pct =
      status.state === 'completed'
        ? 100
        : total > 0
          ? Math.min(99, Math.round((status.scanned / total) * 100))
          : 0;

    if (fill) {
      fill.style.width = `${pct}%`;
    }
    if (countsText) {
      countsText.textContent =
        total > 0
          ? `${status.scanned.toLocaleString()} / ${total.toLocaleString()} scanned (${pct}%)`
          : `${status.scanned.toLocaleString()} scanned`;
    }
    if (etaText) {
      if (status.state === 'completed') {
        etaText.textContent = `Done in ${(status.elapsedMs / 1000).toFixed(1)}s`;
      } else if (status.state === 'paused') {
        etaText.textContent = 'Paused';
      } else {
        etaText.textContent = `ETA: ${formatDuration(status.etaSeconds)}`;
      }
    }

    if (metricClassified) {
      metricClassified.textContent = status.classified.toLocaleString();
    }
    if (metricLearned) {
      metricLearned.textContent = (
        status.learnedExamplesHarvested || 0
      ).toLocaleString();
    }
    if (metricCache) {
      metricCache.textContent = (
        status.cacheHits + status.fastPathHits
      ).toLocaleString();
    }
    if (metricSpeed) {
      metricSpeed.textContent = `${status.emailsPerSec}/s`;
    }

    if (distRow) {
      distRow.innerHTML = '';
      for (const [key, count] of Object.entries(status.tagDistribution)) {
        const tagMeta = tagLookup.get(key.toLowerCase());
        const badge = document.createElement('span');
        badge.className = 'mini-tag';
        badge.style.backgroundColor = tagMeta?.color || '#5c6bc0';
        badge.textContent = `${tagMeta?.name || key}: ${count.toLocaleString()}`;
        distRow.appendChild(badge);
      }
    }

    if (status.lastError) {
      showError(status.lastError);
    }
  }

  renderActivityFeed(status.recentActivity, stats);
}

function renderActivityFeed(
  activities: JobStatus['recentActivity'],
  stats?: LifetimeStats
): void {
  const listEl = document.getElementById('activity-list');
  const counterEl = document.getElementById('lifetime-counter');
  if (counterEl && stats) {
    const learnedCount = stats.totalLearnedSamples || 0;
    counterEl.textContent = `${stats.totalClassified.toLocaleString()} tagged • ${learnedCount.toLocaleString()} learned`;
  }
  if (!listEl) return;

  if (!activities || activities.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">No recent classifications yet. Tag any email manually (without <code>k1:</code>) to auto-train custom tags!</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const item of activities.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'activity-item';

    const top = document.createElement('div');
    top.className = 'activity-top';

    const subj = document.createElement('span');
    subj.className = 'activity-subj';
    subj.textContent = item.subject;
    subj.title = `${item.subject} (${item.sender})`;

    const meta = document.createElement('span');
    meta.className = 'activity-meta';
    const srcLabel =
      item.source === 'cache-thread'
        ? '⚡ Thread Cache'
        : item.source === 'cache-sender'
          ? '⚡ Sender Cache'
          : item.source === 'fast-path'
            ? '⚡ Fast Rule'
            : item.source === 'clm-systemone'
              ? `CLM ${item.durationMs}ms`
              : `${item.durationMs}ms`;
    meta.textContent = srcLabel;

    top.appendChild(subj);
    top.appendChild(meta);

    const bottom = document.createElement('div');
    bottom.className = 'activity-bottom';

    const senderEl = document.createElement('span');
    senderEl.className = 'activity-meta';
    senderEl.textContent = item.sender;

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'activity-tags';

    if (item.tags.length === 0) {
      const none = document.createElement('span');
      none.className = 'activity-meta';
      none.textContent = 'No match';
      tagsWrap.appendChild(none);
    } else {
      for (const k of item.tags) {
        const def = tagLookup.get(k.toLowerCase());
        const prob = item.probabilities?.[k.toLowerCase()];
        const probStr =
          typeof prob === 'number' ? ` ${Math.round(prob * 100)}%` : '';
        const pill = document.createElement('span');
        pill.className = 'mini-tag';
        pill.style.backgroundColor = def?.color || '#5c6bc0';
        pill.textContent = `${def?.name || k}${probStr}`;
        tagsWrap.appendChild(pill);
      }
    }

    bottom.appendChild(senderEl);
    bottom.appendChild(tagsWrap);

    row.appendChild(top);
    row.appendChild(bottom);
    listEl.appendChild(row);
  }
}

function getSelectedScopeFromUi(): ScopeFilter {
  const checkedRadio = document.querySelector(
    'input[name="scope-mode"]:checked'
  ) as HTMLInputElement | null;
  const mode = (checkedRadio?.value || 'all') as ScopeMode;
  const recentSelect = document.getElementById(
    'input-recent-days'
  ) as HTMLSelectElement | null;
  const forceCheck = document.getElementById(
    'checkbox-force-reapply'
  ) as HTMLInputElement | null;

  return {
    mode,
    recentDays: Number.parseInt(recentSelect?.value || '30', 10) || 30,
    skipJunk: currentSettings?.defaultScope.skipJunk ?? true,
    forceReapply: Boolean(forceCheck?.checked),
  };
}

function syncStartButtonState(): void {
  const forceCheck = document.getElementById(
    'checkbox-force-reapply'
  ) as HTMLInputElement | null;
  const startBtn = document.getElementById(
    'btn-start-folder'
  ) as HTMLButtonElement | null;
  if (!forceCheck || !startBtn) return;

  if (forceCheck.checked) {
    startBtn.textContent = '🔄 Force Re-apply';
    startBtn.classList.add('force-mode');
  } else {
    startBtn.textContent = '⚡ Classify Folder';
    startBtn.classList.remove('force-mode');
  }
}

async function checkOllamaStatusInPopup(): Promise<void> {
  const dot = document.getElementById('ollama-dot');
  const text = document.getElementById('ollama-status-text');
  const res = await sendRpc({ type: 'CHECK_OLLAMA' });

  if (!dot || !text) return;
  if (res?.ok && res.health?.ok) {
    dot.className = 'status-dot online';
    const sysOneBadge = res.health.systemOneSupported
      ? '/v1/systemone CLM'
      : 'CLM';
    if (res.health.configuredModelInstalled) {
      text.textContent = `${sysOneBadge} ready (${res.health.latencyMs}ms)`;
    } else {
      text.textContent = `Pull '${res.health.activeModel}' in ⚙️`;
    }
  } else {
    dot.className = 'status-dot offline';
    text.textContent = res?.health?.error || 'Ollama offline — run ollama serve';
  }
}

async function initPopup(): Promise<void> {
  const stateRes = await sendRpc({ type: 'GET_STATE' });
  if (!stateRes?.ok) {
    showError(stateRes?.error || 'Failed to load extension state.');
    return;
  }

  currentSettings = stateRes.settings as PluginSettings;
  learnedProfiles = stateRes.learnedProfiles || [];
  folderList = stateRes.folders || [];
  rebuildTagMap(currentSettings.tags, learnedProfiles);

  const modelBadge = document.getElementById('model-badge');
  if (modelBadge) {
    modelBadge.textContent = currentSettings.model;
  }

  const arrivalToggle = document.getElementById(
    'toggle-arrival'
  ) as HTMLInputElement | null;
  if (arrivalToggle) {
    arrivalToggle.checked = currentSettings.classifyOnArrival;
    arrivalToggle.addEventListener('change', async () => {
      if (!currentSettings) return;
      currentSettings.classifyOnArrival = arrivalToggle.checked;
      await sendRpc({ type: 'SAVE_SETTINGS', settings: currentSettings });
    });
  }

  renderActiveTags(currentSettings.tags, learnedProfiles);
  renderFolderDropdown(folderList, stateRes.activeFolder);
  renderJobStatus(stateRes.jobStatus, stateRes.lifetimeStats);

  const radios = document.querySelectorAll('input[name="scope-mode"]');
  const recentRow = document.getElementById('recent-days-row');
  radios.forEach((r) => {
    r.addEventListener('change', () => {
      const scope = getSelectedScopeFromUi();
      if (recentRow) {
        recentRow.classList.toggle('hidden', scope.mode !== 'recent_days');
      }
    });
  });

  const forceCheck = document.getElementById(
    'checkbox-force-reapply'
  ) as HTMLInputElement | null;
  if (forceCheck) {
    forceCheck.addEventListener('change', syncStartButtonState);
  }

  // Start Folder button
  const startBtn = document.getElementById('btn-start-folder');
  startBtn?.addEventListener('click', async () => {
    showError(null);
    const select = document.getElementById('folder-select') as HTMLSelectElement | null;
    const idx = Number.parseInt(select?.value || '0', 10);
    const chosenFolder = folderList[idx];
    if (!chosenFolder) {
      showError('Please select a target folder first.');
      return;
    }

    const scope = getSelectedScopeFromUi();
    const res = await sendRpc({
      type: 'START_FOLDER_JOB',
      folder: chosenFolder,
      scope,
    });

    if (!res?.ok) {
      showError(res?.error || 'Could not start folder classification.');
    } else if (res.status) {
      renderJobStatus(res.status);
    }
  });

  // Learn Tags from Folder button
  const learnBtn = document.getElementById(
    'btn-learn-folder'
  ) as HTMLButtonElement | null;
  learnBtn?.addEventListener('click', async () => {
    showError(null);
    const select = document.getElementById('folder-select') as HTMLSelectElement | null;
    const idx = Number.parseInt(select?.value || '0', 10);
    const chosenFolder = folderList[idx];
    if (!chosenFolder) {
      showError('Please select a target folder first.');
      return;
    }

    if (learnBtn) {
      learnBtn.disabled = true;
      learnBtn.textContent = '⏳ Learning...';
    }
    try {
      const res = await sendRpc({
        type: 'HARVEST_FOLDER_LEARNED_TAGS',
        folder: chosenFolder,
      });
      if (!res?.ok) {
        showError(res?.error || 'Could not scan folder for learned tags.');
      } else {
        learnedProfiles = res.profiles || [];
        if (currentSettings) {
          rebuildTagMap(currentSettings.tags, learnedProfiles);
          renderActiveTags(currentSettings.tags, learnedProfiles);
        }
      }
    } finally {
      if (learnBtn) {
        learnBtn.disabled = false;
        learnBtn.textContent = '🎓 Learn Tags';
      }
    }
  });

  // Classify Selected Messages button
  const selectedBtn = document.getElementById(
    'btn-classify-selected'
  ) as HTMLButtonElement | null;
  selectedBtn?.addEventListener('click', async () => {
    showError(null);
    if (selectedBtn) selectedBtn.disabled = true;
    try {
      const scope = getSelectedScopeFromUi();
      const res = await sendRpc({
        type: 'CLASSIFY_SELECTED_IN_ACTIVE_TAB',
        forceReapply: scope.forceReapply,
      });
      if (!res?.ok) {
        showError(res?.error || 'Could not classify selected messages.');
      } else {
        const refreshed = await sendRpc({ type: 'GET_STATE' });
        if (refreshed?.ok) {
          learnedProfiles = refreshed.learnedProfiles || [];
          if (currentSettings) {
            rebuildTagMap(currentSettings.tags, learnedProfiles);
            renderActiveTags(currentSettings.tags, learnedProfiles);
          }
          renderJobStatus(refreshed.jobStatus, refreshed.lifetimeStats);
        }
      }
    } finally {
      if (selectedBtn) selectedBtn.disabled = false;
    }
  });

  // Pause / Resume button
  const pauseBtn = document.getElementById('btn-pause-resume');
  pauseBtn?.addEventListener('click', async () => {
    const isPaused = pauseBtn.textContent?.includes('Resume');
    const res = await sendRpc({
      type: isPaused ? 'RESUME_JOB' : 'PAUSE_JOB',
    });
    if (res?.ok && res.status) {
      renderJobStatus(res.status);
    }
  });

  // Cancel button
  const cancelBtn = document.getElementById('btn-cancel-job');
  cancelBtn?.addEventListener('click', async () => {
    const res = await sendRpc({ type: 'CANCEL_JOB' });
    if (res?.ok && res.status) {
      renderJobStatus(res.status);
    }
  });

  const openOpts = () => {
    const api = getApi();
    if (api?.runtime?.openOptionsPage) {
      api.runtime.openOptionsPage();
    }
  };
  document
    .getElementById('btn-open-options')
    ?.addEventListener('click', openOpts);
  document
    .getElementById('btn-manage-tags')
    ?.addEventListener('click', openOpts);

  const api = getApi();
  if (api?.runtime?.onMessage) {
    api.runtime.onMessage.addListener((msg: any) => {
      if (msg?.type === 'AITAGGER_JOB_STATUS' && msg.status) {
        renderJobStatus(msg.status);
      }
    });
  }

  void checkOllamaStatusInPopup();
}

document.addEventListener('DOMContentLoaded', () => {
  void initPopup();
});
