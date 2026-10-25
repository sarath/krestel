import { INITIAL_JOB_STATUS } from './defaults';
import { MemoizationCache } from './memoCache';
import { classifyBatchWithOllama } from './ollamaClient';
import {
  buildClassificationInput,
  computeThreadKey,
  extractEmailAddress,
  isAutomatedSenderAddress,
  matchFastPathRules,
} from './snippetExtractor';
import {
  loadLearnedTagProfiles,
  loadLifetimeStats,
  loadSettings,
  saveLearnedTagProfiles,
  saveLifetimeStats,
  saveSerializedMemoCache,
} from './storage';
import { ContinualTagLearner } from './tagLearner';
import {
  applyTagsToMessage,
  computeUpdatedMessageTags,
  extractNonAgentUserTags,
  hasExistingAiTag,
  isMessageRecentlyModifiedByPlugin,
  listThunderbirdTags,
  syncTagsWithThunderbird,
} from './tagManager';
import {
  ActivityEntry,
  ClassificationSource,
  EmailClassificationInput,
  JobStatus,
  LearnedTagProfile,
  LifetimeStats,
  MailFolder,
  MessageHeader,
  MessageListPage,
  MessagePart,
  PluginSettings,
  ScopeFilter,
  ThunderbirdTag,
} from './types';

declare const messenger: any;
declare const browser: any;

function getApi(): any {
  if (typeof messenger !== 'undefined') return messenger;
  if (typeof browser !== 'undefined') return browser;
  return null;
}

export class ClassificationJobManager {
  private status: JobStatus = structuredClone(INITIAL_JOB_STATUS);
  private memoCache = new MemoizationCache();
  private tagLearner = new ContinualTagLearner();
  private lifetimeStats: LifetimeStats | null = null;
  private abortController: AbortController | null = null;
  private activePageId: string | null = null;
  private pausePromiseResolve: (() => void) | null = null;
  private pausedAccumulatedMs = 0;
  private pauseStartedAt = 0;
  private lastBroadcastAt = 0;
  private totalClmInferenceMsInJob = 0;
  private totalClmEmailsInJob = 0;
  private statusListeners = new Set<(status: JobStatus) => void>();

  public async init(initialCacheData?: any): Promise<void> {
    if (initialCacheData) {
      this.memoCache.hydrate(initialCacheData);
    }
    const [stats, learnedProfiles] = await Promise.all([
      loadLifetimeStats(),
      loadLearnedTagProfiles(),
    ]);
    this.lifetimeStats = stats;
    this.tagLearner.hydrate(learnedProfiles);
  }

  public getStatus(): JobStatus {
    this.recomputeTimingMetrics();
    return structuredClone(this.status);
  }

  public getMemoStats() {
    return this.memoCache.getStats();
  }

  public getLearnedProfiles(): LearnedTagProfile[] {
    return this.tagLearner.getProfiles();
  }

  public getActiveLearnedTagDefinitions(minSamples = 3) {
    return this.tagLearner.getActiveLearnedTagDefinitions(minSamples);
  }

  public scoreEmailWithLocalClm(
    input: EmailClassificationInput,
    settings: PluginSettings
  ): Record<string, number> {
    const enabledAgentTags = settings.tags.filter((t) => t.enabled);
    const minSamples = settings.minLearnedSamplesToApply ?? 3;
    return this.tagLearner.scoreAllTagsWithLocalClm(
      input,
      enabledAgentTags,
      minSamples
    );
  }

  public async updateLearnedProfile(
    tagKey: string,
    updates: { enabled?: boolean; customCriteriaOverride?: string }
  ): Promise<LearnedTagProfile[]> {
    this.tagLearner.updateProfileMetadata(tagKey, updates);
    await saveLearnedTagProfiles(this.tagLearner.serialize());
    return this.tagLearner.getProfiles();
  }

  public async deleteLearnedProfile(tagKey: string): Promise<LearnedTagProfile[]> {
    this.tagLearner.deleteProfile(tagKey);
    await saveLearnedTagProfiles(this.tagLearner.serialize());
    return this.tagLearner.getProfiles();
  }

  public async clearLearnedProfiles(): Promise<LearnedTagProfile[]> {
    this.tagLearner.clearAll();
    await saveLearnedTagProfiles([]);
    return [];
  }

  public async clearMemoCache(): Promise<void> {
    this.memoCache.clear();
    await saveSerializedMemoCache(this.memoCache.serialize());
  }

  /**
   * Real-time online training hook triggered by `messenger.messages.onUpdated`
   * whenever a user manually tags an email with a tag NOT prefixed by `agent:`.
   */
  public async handleUserTagModification(
    message: MessageHeader,
    newTags: string[],
    oldTags?: string[]
  ): Promise<void> {
    if (!message || isMessageRecentlyModifiedByPlugin(message.id)) {
      return;
    }

    const settings = await loadSettings();
    if (!settings.enableAutoLearnUserTags) return;

    const managedAgentKeys = new Set(
      settings.tags.map((t) => t.key.toLowerCase())
    );
    const oldSet = new Set((oldTags || []).map((t) => t.toLowerCase()));
    const newSet = new Set((newTags || []).map((t) => t.toLowerCase()));

    // Find newly added non-agent tags
    const candidateNonAgentTags = extractNonAgentUserTags(
      newTags,
      managedAgentKeys
    ).filter((t) => oldSet.size === 0 || !oldSet.has(t.toLowerCase()));

    // Detect removed tags when oldTags is provided (for negative feedback & cache invalidation)
    const removedTags =
      oldTags && oldTags.length > 0
        ? oldTags.filter((t) => !newSet.has(t.toLowerCase()))
        : [];

    if (candidateNonAgentTags.length === 0 && removedTags.length === 0) return;

    const tbTags = await listThunderbirdTags();
    const tbMap = new Map<string, ThunderbirdTag>(
      tbTags.map((t) => [t.key.toLowerCase(), t])
    );

    const fullPart =
      settings.promptMode === 'headers_only'
        ? null
        : await this.safeGetFullMessage(message.id);

    const input = buildClassificationInput(
      message,
      fullPart,
      settings.promptMode,
      settings.maxSnippetChars
    );

    let modified = false;

    if (
      removedTags.length > 0 &&
      (settings.enableNegativeFeedbackOnRemove ?? true)
    ) {
      const penalized = this.tagLearner.unlearnFromRemovedTags(
        input,
        removedTags
      );
      this.memoCache.invalidate(input.threadKey, input.senderEmail);
      if (penalized.length > 0) {
        modified = true;
      }
    }

    if (candidateNonAgentTags.length > 0) {
      const learnedKeys = this.tagLearner.learnFromTaggedEmail(
        input,
        candidateNonAgentTags,
        tbMap
      );

      if (learnedKeys.length > 0) {
        modified = true;
        // Also record in Thread & Sender memoization so future messages in the same thread/sender get tagged immediately
        this.memoCache.record(input, learnedKeys);
        if (this.lifetimeStats) {
          this.lifetimeStats.totalLearnedSamples =
            (this.lifetimeStats.totalLearnedSamples || 0) + learnedKeys.length;
        }
      }
    }

    if (modified) {
      await Promise.all([
        saveLearnedTagProfiles(this.tagLearner.serialize()),
        this.flushStatsAndCache(),
      ]);
    }
  }

  public onStatusChange(listener: (status: JobStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public pauseJob(): JobStatus {
    if (this.status.state === 'running') {
      this.status.state = 'paused';
      this.pauseStartedAt = Date.now();
      this.updateBadge('⏸', '#f57c00');
      this.broadcastStatus(true);
    }
    return this.getStatus();
  }

  public resumeJob(): JobStatus {
    if (this.status.state === 'paused') {
      if (this.pauseStartedAt > 0) {
        this.pausedAccumulatedMs += Date.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
      }
      this.status.state = 'running';
      if (this.pausePromiseResolve) {
        const resolve = this.pausePromiseResolve;
        this.pausePromiseResolve = null;
        resolve();
      }
      this.broadcastStatus(true);
    }
    return this.getStatus();
  }

  public async cancelJob(): Promise<JobStatus> {
    if (this.status.state === 'running' || this.status.state === 'paused') {
      this.status.state = 'cancelling';
      if (this.pausePromiseResolve) {
        const resolve = this.pausePromiseResolve;
        this.pausePromiseResolve = null;
        resolve();
      }
      if (this.abortController) {
        this.abortController.abort();
      }
      await this.abortActiveMessageList();
      this.status.state = 'idle';
      this.updateBadge('', '#1565c0');
      this.broadcastStatus(true);
    }
    return this.getStatus();
  }

  private async waitIfPaused(): Promise<void> {
    while (this.status.state === 'paused') {
      await new Promise<void>((resolve) => {
        this.pausePromiseResolve = resolve;
      });
    }
  }

  private isCancelledOrIdle(): boolean {
    const st = this.status.state;
    return (
      st === 'cancelling' ||
      st === 'idle' ||
      Boolean(this.abortController?.signal.aborted)
    );
  }

  private async abortActiveMessageList(): Promise<void> {
    const api = getApi();
    if (this.activePageId && api?.messages?.abortList) {
      try {
        await api.messages.abortList(this.activePageId);
      } catch {
        // Ignore if list already finished
      }
    }
    this.activePageId = null;
  }

  /**
   * Rapidly scans a folder to harvest existing non-`agent:` user tags and train the ContinualTagLearner.
   * Zero model calls required — runs at thousands of headers per second!
   */
  public async harvestLearnedTagsFromFolder(
    folder: MailFolder
  ): Promise<{ scanned: number; learnedSamples: number; profiles: LearnedTagProfile[] }> {
    const settings = await loadSettings();
    const managedAgentKeys = new Set(
      settings.tags.map((t) => t.key.toLowerCase())
    );
    const tbTags = await listThunderbirdTags();
    const tbMap = new Map<string, ThunderbirdTag>(
      tbTags.map((t) => [t.key.toLowerCase(), t])
    );

    let scanned = 0;
    let learnedSamples = 0;

    for await (const pageHeaders of this.streamFolderPages(folder)) {
      for (const header of pageHeaders) {
        scanned++;
        if (header.junk) continue;

        const userTags = extractNonAgentUserTags(header.tags, managedAgentKeys);
        if (userTags.length === 0) continue;

        const headerInput = this.buildHeaderOnlyInput(header);
        const updated = this.tagLearner.learnFromTaggedEmail(
          headerInput,
          userTags,
          tbMap
        );
        if (updated.length > 0) {
          learnedSamples += updated.length;
          this.memoCache.record(headerInput, updated);
        }
      }
    }

    if (learnedSamples > 0) {
      if (this.lifetimeStats) {
        this.lifetimeStats.totalLearnedSamples =
          (this.lifetimeStats.totalLearnedSamples || 0) + learnedSamples;
      }
      await Promise.all([
        saveLearnedTagProfiles(this.tagLearner.serialize()),
        this.flushStatsAndCache(),
      ]);
    }

    return {
      scanned,
      learnedSamples,
      profiles: this.tagLearner.getProfiles(),
    };
  }

  /**
   * Classifies a batch of newly arrived or manually selected messages using the `/v1/systemone` CLM + Learned Tags.
   */
  public async classifyMessagesList(
    headers: MessageHeader[],
    options: { forceReapply: boolean; isIncomingArrival?: boolean }
  ): Promise<{ classified: number; skipped: number }> {
    if (!headers || headers.length === 0) {
      return { classified: 0, skipped: 0 };
    }

    const settings = await loadSettings();
    const minLearnedSamples = settings.minLearnedSamplesToApply ?? 3;
    const enabledAgentTags = settings.tags.filter((t) => t.enabled);
    const learnedTagDefs = settings.enableAutoLearnUserTags
      ? this.tagLearner.getActiveLearnedTagDefinitions(minLearnedSamples)
      : [];

    if (enabledAgentTags.length === 0 && learnedTagDefs.length === 0) {
      return { classified: 0, skipped: headers.length };
    }

    const tbMap = await syncTagsWithThunderbird(enabledAgentTags);
    const managedAgentTagKeys = new Set(
      settings.tags.map((t) => t.key.toLowerCase())
    );
    const validAssignableKeys = new Set([
      ...enabledAgentTags.map((t) => t.key.toLowerCase()),
      ...learnedTagDefs.map((t) => t.key.toLowerCase()),
    ]);

    const clmQueue: Array<{ header: MessageHeader; input: EmailClassificationInput }> = [];
    let classifiedCount = 0;
    let skippedCount = 0;

    for (const header of headers) {
      if (settings.defaultScope.skipJunk && header.junk) {
        skippedCount++;
        continue;
      }

      // Opportunistically learn from any non-agent: tags already on the message
      if (settings.enableAutoLearnUserTags) {
        const userTags = extractNonAgentUserTags(
          header.tags,
          managedAgentTagKeys
        );
        if (userTags.length > 0) {
          const hInput = this.buildHeaderOnlyInput(header);
          this.tagLearner.learnFromTaggedEmail(hInput, userTags, tbMap);
        }
      }

      if (
        !options.forceReapply &&
        hasExistingAiTag(header.tags, managedAgentTagKeys)
      ) {
        skippedCount++;
        continue;
      }

      const headerInput = this.buildHeaderOnlyInput(header);

      if (!options.forceReapply) {
        const cached = this.memoCache.lookup(headerInput, {
          enableThread: settings.enableThreadMemoization,
          enableSender: settings.enableSenderMemoization,
          senderMemoMinHits: settings.senderMemoMinHits,
          validTagKeys: validAssignableKeys,
          maxTags: settings.maxTagsPerEmail,
        });

        if (cached && cached.tags.length > 0) {
          await this.applyAndRecordResult(
            header,
            headerInput,
            cached.tags,
            undefined,
            cached.source,
            0,
            managedAgentTagKeys,
            validAssignableKeys,
            options.forceReapply,
            settings.maxTagsPerEmail,
            options.isIncomingArrival
          );
          classifiedCount++;
          continue;
        }
      }

      const fullPart =
        settings.promptMode === 'headers_only'
          ? null
          : await this.safeGetFullMessage(header.id);

      const fullInput = buildClassificationInput(
        header,
        fullPart,
        settings.promptMode,
        settings.maxSnippetChars
      );

      if (settings.enableFastPathRules) {
        const fastTags = matchFastPathRules(
          fullInput,
          enabledAgentTags,
          settings.maxTagsPerEmail
        );
        if (fastTags.length > 0) {
          await this.applyAndRecordResult(
            header,
            fullInput,
            fastTags,
            undefined,
            'fast-path',
            1,
            managedAgentTagKeys,
            validAssignableKeys,
            options.forceReapply,
            settings.maxTagsPerEmail,
            options.isIncomingArrival
          );
          classifiedCount++;
          continue;
        }
      }

      clmQueue.push({ header, input: fullInput });
    }

    const chunkSize = Math.max(1, settings.batchSize || 5);
    for (let i = 0; i < clmQueue.length; i += chunkSize) {
      const slice = clmQueue.slice(i, i + chunkSize);
      try {
        const learnedScoresPerItem = slice.map((s) =>
          this.tagLearner.scoreAllTagsWithLocalClm(
            s.input,
            enabledAgentTags,
            minLearnedSamples
          )
        );
        const {
          tagsPerItem,
          probabilitiesPerItem,
          source,
          durationMs,
        } = await classifyBatchWithOllama(
          slice.map((s) => s.input),
          settings,
          undefined,
          learnedTagDefs,
          learnedScoresPerItem
        );
        const perEmailMs = Math.round(durationMs / slice.length);

        for (let j = 0; j < slice.length; j++) {
          const item = slice[j];
          const chosenTags = tagsPerItem[j] || [];
          await this.applyAndRecordResult(
            item.header,
            item.input,
            chosenTags,
            probabilitiesPerItem[j],
            source,
            perEmailMs,
            managedAgentTagKeys,
            validAssignableKeys,
            options.forceReapply,
            settings.maxTagsPerEmail,
            options.isIncomingArrival
          );
          classifiedCount++;
        }
      } catch (err) {
        console.error('[AITagger] CLM classification error:', err);
      }
    }

    await Promise.all([
      saveLearnedTagProfiles(this.tagLearner.serialize()),
      this.flushStatsAndCache(),
    ]);
    return { classified: classifiedCount, skipped: skippedCount };
  }

  /**
   * Starts a high-throughput streaming job on a Thunderbird folder (scales from 1,000 to 100,000+ emails).
   */
  public async startFolderJob(
    folder: MailFolder,
    scope: ScopeFilter
  ): Promise<JobStatus> {
    if (this.status.state === 'running' || this.status.state === 'paused') {
      throw new Error('A classification job is already running. Pause or cancel it first.');
    }

    const settings = await loadSettings();
    const minLearnedSamples = settings.minLearnedSamplesToApply ?? 3;
    const enabledAgentTags = settings.tags.filter((t) => t.enabled);
    const learnedTagDefs = settings.enableAutoLearnUserTags
      ? this.tagLearner.getActiveLearnedTagDefinitions(minLearnedSamples)
      : [];

    if (enabledAgentTags.length === 0 && learnedTagDefs.length === 0) {
      throw new Error('No tags are enabled. Enable at least one tag in Options.');
    }

    const tbMap = await syncTagsWithThunderbird(enabledAgentTags);

    if (scope.forceReapply) {
      this.memoCache.clear();
    }

    const initialTotal = await this.estimateFolderCount(folder, scope);
    this.abortController = new AbortController();
    this.pausedAccumulatedMs = 0;
    this.pauseStartedAt = 0;
    this.totalClmInferenceMsInJob = 0;
    this.totalClmEmailsInJob = 0;

    this.status = {
      state: 'running',
      jobId: `job_${Date.now()}`,
      folderName: folder.name || folder.path || 'Folder',
      folderPath: folder.path || folder.name || '',
      forceReapply: scope.forceReapply,
      scope: structuredClone(scope),
      totalEstimated: initialTotal,
      scanned: 0,
      classified: 0,
      learnedExamplesHarvested: 0,
      skippedAlreadyTagged: 0,
      skippedByScope: 0,
      cacheHits: 0,
      fastPathHits: 0,
      errors: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      elapsedMs: 0,
      emailsPerSec: 0,
      classifiedPerSec: 0,
      avgInferenceMs: 0,
      etaSeconds: null,
      tagDistribution: {},
      recentActivity: [],
    };

    this.updateBadge('0%', '#1565c0');
    this.broadcastStatus(true);

    void this.executeStreamingFolderLoop(folder, scope, settings, tbMap);

    return this.getStatus();
  }

  private async executeStreamingFolderLoop(
    folder: MailFolder,
    scope: ScopeFilter,
    settings: PluginSettings,
    tbMap: Map<string, ThunderbirdTag>
  ): Promise<void> {
    const enabledAgentTags = settings.tags.filter((t) => t.enabled);
    const managedAgentTagKeys = new Set(
      settings.tags.map((t) => t.key.toLowerCase())
    );

    const minLearnedSamples = settings.minLearnedSamplesToApply ?? 3;
    const getDynamicAssignableSet = () => {
      const learnedDefs = settings.enableAutoLearnUserTags
        ? this.tagLearner.getActiveLearnedTagDefinitions(minLearnedSamples)
        : [];
      return {
        learnedDefs,
        validAssignableKeys: new Set([
          ...enabledAgentTags.map((t) => t.key.toLowerCase()),
          ...learnedDefs.map((t) => t.key.toLowerCase()),
        ]),
      };
    };

    const cutoffTimestamp =
      scope.mode === 'recent_days' && scope.recentDays > 0
        ? Date.now() - scope.recentDays * 86_400_000
        : 0;

    const batchSize = Math.max(1, Math.min(15, settings.batchSize || 5));
    const concurrency = Math.max(1, Math.min(8, settings.concurrency || 3));

    let pendingBatch: Array<{
      header: MessageHeader;
      input: EmailClassificationInput;
    }> = [];
    const activeWorkerPromises = new Set<Promise<void>>();

    const dispatchBatchToWorker = async (
      batchItems: Array<{ header: MessageHeader; input: EmailClassificationInput }>
    ) => {
      if (batchItems.length === 0) return;

      const workerTask = (async () => {
        try {
          await this.waitIfPaused();
          if (this.isCancelledOrIdle()) return;

          const { learnedDefs, validAssignableKeys } = getDynamicAssignableSet();
          const stillNeedingClm: Array<{
            header: MessageHeader;
            input: EmailClassificationInput;
          }> = [];

          for (const item of batchItems) {
            const lateCacheHit = this.memoCache.lookup(item.input, {
              enableThread: settings.enableThreadMemoization,
              enableSender: settings.enableSenderMemoization,
              senderMemoMinHits: settings.senderMemoMinHits,
              validTagKeys: validAssignableKeys,
              maxTags: settings.maxTagsPerEmail,
            });

            if (lateCacheHit && lateCacheHit.tags.length > 0) {
              this.status.cacheHits++;
              await this.applyAndRecordResult(
                item.header,
                item.input,
                lateCacheHit.tags,
                undefined,
                lateCacheHit.source,
                0,
                managedAgentTagKeys,
                validAssignableKeys,
                scope.forceReapply,
                settings.maxTagsPerEmail,
                false
              );
            } else {
              stillNeedingClm.push(item);
            }
          }

          if (stillNeedingClm.length === 0) {
            this.broadcastStatus(false);
            return;
          }

          const learnedScoresPerItem = stillNeedingClm.map((x) =>
            this.tagLearner.scoreAllTagsWithLocalClm(
              x.input,
              enabledAgentTags,
              minLearnedSamples
            )
          );

          const {
            tagsPerItem,
            probabilitiesPerItem,
            source,
            durationMs,
          } = await classifyBatchWithOllama(
            stillNeedingClm.map((x) => x.input),
            settings,
            this.abortController?.signal,
            learnedDefs,
            learnedScoresPerItem
          );

          this.totalClmInferenceMsInJob += durationMs;
          this.totalClmEmailsInJob += stillNeedingClm.length;
          if (this.lifetimeStats) {
            this.lifetimeStats.totalClmCalls += 1;
            this.lifetimeStats.totalClmDurationMs += durationMs;
          }

          const perItemMs = Math.max(
            1,
            Math.round(durationMs / stillNeedingClm.length)
          );

          for (let idx = 0; idx < stillNeedingClm.length; idx++) {
            const { header, input } = stillNeedingClm[idx];
            const chosenTags = tagsPerItem[idx] || [];
            await this.applyAndRecordResult(
              header,
              input,
              chosenTags,
              probabilitiesPerItem[idx],
              source,
              perItemMs,
              managedAgentTagKeys,
              validAssignableKeys,
              scope.forceReapply,
              settings.maxTagsPerEmail,
              false
            );
          }
        } catch (err: any) {
          if (err?.name === 'AbortError' || this.isCancelledOrIdle()) {
            return;
          }
          this.status.errors += batchItems.length;
          this.status.lastError = err?.message || String(err);
          console.error('[AITagger] Worker batch error:', err);
        } finally {
          this.broadcastStatus(false);
        }
      })();

      activeWorkerPromises.add(workerTask);
      void workerTask.finally(() => activeWorkerPromises.delete(workerTask));

      if (activeWorkerPromises.size >= concurrency) {
        await Promise.race(activeWorkerPromises);
      }
    };

    try {
      for await (const pageHeaders of this.streamFolderPages(folder)) {
        if (this.isCancelledOrIdle()) break;
        await this.waitIfPaused();

        if (this.status.scanned + pageHeaders.length > this.status.totalEstimated) {
          this.status.totalEstimated = this.status.scanned + pageHeaders.length;
        }

        for (const header of pageHeaders) {
          await this.waitIfPaused();
          if (this.isCancelledOrIdle()) break;

          this.status.scanned++;
          if (this.lifetimeStats) {
            this.lifetimeStats.totalScanned++;
          }

          if (scope.skipJunk && header.junk) {
            this.status.skippedByScope++;
            this.broadcastStatus(false);
            continue;
          }

          const headerInput = this.buildHeaderOnlyInput(header);

          // 0. Online Continual Learning: If email has any non-agent: user tags, harvest them as training examples!
          if (settings.enableAutoLearnUserTags) {
            const nonAgentTags = extractNonAgentUserTags(
              header.tags,
              managedAgentTagKeys
            );
            if (nonAgentTags.length > 0) {
              const updatedLearned = this.tagLearner.learnFromTaggedEmail(
                headerInput,
                nonAgentTags,
                tbMap
              );
              if (updatedLearned.length > 0) {
                this.status.learnedExamplesHarvested += updatedLearned.length;
                if (this.lifetimeStats) {
                  this.lifetimeStats.totalLearnedSamples =
                    (this.lifetimeStats.totalLearnedSamples || 0) +
                    updatedLearned.length;
                }
                this.memoCache.record(headerInput, updatedLearned);
              }
            }
          }

          // 1. Fast Header-Level Scope Checks (0ms, zero MIME parsing)
          if (scope.mode === 'unread' && header.read) {
            this.status.skippedByScope++;
            this.broadcastStatus(false);
            continue;
          }

          if (cutoffTimestamp > 0 && header.date) {
            const msgTime = new Date(header.date).getTime();
            if (!Number.isNaN(msgTime) && msgTime < cutoffTimestamp) {
              this.status.skippedByScope++;
              this.broadcastStatus(false);
              continue;
            }
          }

          // 2. Skip Already-Tagged Check (unless Force Re-apply is enabled)
          if (
            !scope.forceReapply &&
            hasExistingAiTag(header.tags, managedAgentTagKeys)
          ) {
            this.status.skippedAlreadyTagged++;
            this.broadcastStatus(false);
            continue;
          }

          const { validAssignableKeys } = getDynamicAssignableSet();

          // 3. Zero-I/O Header-Level Thread & Sender Memoization Lookup
          const memoHit = this.memoCache.lookup(headerInput, {
            enableThread: settings.enableThreadMemoization,
            enableSender: settings.enableSenderMemoization,
            senderMemoMinHits: settings.senderMemoMinHits,
            validTagKeys: validAssignableKeys,
            maxTags: settings.maxTagsPerEmail,
          });

          if (memoHit && memoHit.tags.length > 0) {
            this.status.cacheHits++;
            if (this.lifetimeStats) {
              this.lifetimeStats.totalCacheHits++;
            }
            await this.applyAndRecordResult(
              header,
              headerInput,
              memoHit.tags,
              undefined,
              memoHit.source,
              0,
              managedAgentTagKeys,
              validAssignableKeys,
              scope.forceReapply,
              settings.maxTagsPerEmail,
              false
            );
            this.broadcastStatus(false);
            continue;
          }

          // 4. Extract Compact Snippet from MIME tree (only for cache misses!)
          const fullPart =
            settings.promptMode === 'headers_only'
              ? null
              : await this.safeGetFullMessage(header.id);

          const fullInput = buildClassificationInput(
            header,
            fullPart,
            settings.promptMode,
            settings.maxSnippetChars
          );

          // 5. Optional Deterministic Fast-Path Keyword Rules
          if (settings.enableFastPathRules) {
            const fastTags = matchFastPathRules(
              fullInput,
              enabledAgentTags,
              settings.maxTagsPerEmail
            );
            if (fastTags.length > 0) {
              this.status.fastPathHits++;
              if (this.lifetimeStats) {
                this.lifetimeStats.totalFastPathHits++;
              }
              await this.applyAndRecordResult(
                header,
                fullInput,
                fastTags,
                undefined,
                'fast-path',
                1,
                managedAgentTagKeys,
                validAssignableKeys,
                scope.forceReapply,
                settings.maxTagsPerEmail,
                false
              );
              this.broadcastStatus(false);
              continue;
            }
          }

          // 6. Enqueue for `/v1/systemone` Jev CLM Classification
          pendingBatch.push({ header, input: fullInput });
          if (pendingBatch.length >= batchSize) {
            const toRun = pendingBatch;
            pendingBatch = [];
            await dispatchBatchToWorker(toRun);
          }
        }
      }

      if (pendingBatch.length > 0 && !this.isCancelledOrIdle()) {
        await dispatchBatchToWorker(pendingBatch);
        pendingBatch = [];
      }

      if (activeWorkerPromises.size > 0) {
        await Promise.allSettled(Array.from(activeWorkerPromises));
      }

      if (this.status.state === 'running') {
        this.status.totalEstimated = this.status.scanned;
        this.status.state = 'completed';
        this.updateBadge('✓', '#2e7d32');
      }
    } catch (err: any) {
      if (!this.isCancelledOrIdle()) {
        this.status.state = 'error';
        this.status.lastError = err?.message || String(err);
        this.updateBadge('!', '#e53935');
      }
    } finally {
      await this.abortActiveMessageList();
      await Promise.all([
        saveLearnedTagProfiles(this.tagLearner.serialize()),
        this.flushStatsAndCache(),
      ]);
      this.broadcastStatus(true);
    }
  }

  private buildHeaderOnlyInput(header: MessageHeader): EmailClassificationInput {
    const senderEmail = extractEmailAddress(header.author || '');
    return {
      id: header.id,
      subject: (header.subject || '(No Subject)').slice(0, 180),
      author: (header.author || '').slice(0, 120),
      recipients: (header.recipients || []).slice(0, 2).join(', ').slice(0, 100),
      snippet: '',
      threadKey: computeThreadKey(header.subject || '', senderEmail),
      senderEmail,
      isAutomatedSender: isAutomatedSenderAddress(senderEmail),
      existingTags: Array.isArray(header.tags) ? [...header.tags] : [],
    };
  }

  private async applyAndRecordResult(
    header: MessageHeader,
    input: EmailClassificationInput,
    chosenTags: string[],
    probabilities: Record<string, number> | undefined,
    source: ClassificationSource,
    durationMs: number,
    managedAgentTagKeys: Set<string>,
    validAssignableKeys: Set<string>,
    forceReapply: boolean,
    maxTagsPerEmail: number,
    isIncomingArrival?: boolean
  ): Promise<void> {
    const { finalTags, changed } = computeUpdatedMessageTags({
      existingTags: header.tags || [],
      newAiTags: chosenTags,
      managedAiTagKeys: managedAgentTagKeys,
      validAssignableTagKeys: validAssignableKeys,
      forceReapply,
      maxTagsPerEmail,
    });

    if (changed) {
      await applyTagsToMessage(header.id, finalTags);
    }

    if (chosenTags.length > 0) {
      this.memoCache.record(input, chosenTags);
      for (const tagKey of chosenTags) {
        this.status.tagDistribution[tagKey] =
          (this.status.tagDistribution[tagKey] || 0) + 1;
      }
    }

    this.status.classified++;
    if (this.lifetimeStats) {
      this.lifetimeStats.totalClassified++;
      if (isIncomingArrival) {
        this.lifetimeStats.totalIncomingTagged++;
      }
    }

    const entry: ActivityEntry = {
      messageId: header.id,
      subject: input.subject,
      sender: input.senderEmail || input.author,
      tags: chosenTags,
      probabilities,
      source,
      durationMs,
      timestamp: Date.now(),
    };

    this.status.recentActivity.unshift(entry);
    if (this.status.recentActivity.length > 18) {
      this.status.recentActivity.length = 18;
    }
  }

  private async *streamFolderPages(
    folder: MailFolder
  ): AsyncGenerator<MessageHeader[], void, unknown> {
    const api = getApi();
    if (!api?.messages?.list) return;

    let page: MessageListPage;
    try {
      page = await api.messages.list(folder.id ?? folder);
    } catch {
      page = await api.messages.list(folder);
    }

    this.activePageId = page.id || null;
    if (Array.isArray(page.messages) && page.messages.length > 0) {
      yield page.messages;
    }

    while (page.id) {
      if (this.isCancelledOrIdle()) break;
      page = await api.messages.continueList(page.id);
      this.activePageId = page.id || null;
      if (Array.isArray(page.messages) && page.messages.length > 0) {
        yield page.messages;
      }
    }

    this.activePageId = null;
  }

  private async estimateFolderCount(
    folder: MailFolder,
    scope: ScopeFilter
  ): Promise<number> {
    const api = getApi();
    if (!api?.folders?.getFolderInfo) return 0;

    try {
      const info = await api.folders.getFolderInfo(folder.id ?? folder);
      if (scope.mode === 'unread' && typeof info?.unreadMessageCount === 'number') {
        return info.unreadMessageCount;
      }
      if (typeof info?.totalMessageCount === 'number') {
        return info.totalMessageCount;
      }
    } catch {
      try {
        const info = await api.folders.getFolderInfo(folder);
        if (typeof info?.totalMessageCount === 'number') {
          return info.totalMessageCount;
        }
      } catch {
        // Ignore if not supported
      }
    }
    return 0;
  }

  private async safeGetFullMessage(messageId: number): Promise<MessagePart | null> {
    const api = getApi();
    if (!api?.messages?.getFull) return null;
    try {
      return await api.messages.getFull(messageId);
    } catch {
      return null;
    }
  }

  private recomputeTimingMetrics(): void {
    if (this.status.startedAt <= 0) return;

    const now =
      this.status.state === 'completed' ||
      this.status.state === 'error' ||
      this.status.state === 'idle'
        ? this.status.updatedAt
        : Date.now();

    const currentPauseDelta =
      this.status.state === 'paused' && this.pauseStartedAt > 0
        ? Date.now() - this.pauseStartedAt
        : 0;

    const activeElapsedMs = Math.max(
      1,
      now - this.status.startedAt - this.pausedAccumulatedMs - currentPauseDelta
    );

    this.status.elapsedMs = activeElapsedMs;

    const elapsedSec = activeElapsedMs / 1000;
    this.status.emailsPerSec =
      elapsedSec > 0.2 ? Number((this.status.scanned / elapsedSec).toFixed(1)) : 0;
    this.status.classifiedPerSec =
      elapsedSec > 0.2 ? Number((this.status.classified / elapsedSec).toFixed(1)) : 0;

    this.status.avgInferenceMs =
      this.totalClmEmailsInJob > 0
        ? Math.round(this.totalClmInferenceMsInJob / this.totalClmEmailsInJob)
        : 0;

    if (
      this.status.state === 'running' &&
      this.status.totalEstimated > this.status.scanned &&
      this.status.emailsPerSec > 0
    ) {
      const remaining = this.status.totalEstimated - this.status.scanned;
      this.status.etaSeconds = Math.ceil(remaining / this.status.emailsPerSec);
    } else {
      this.status.etaSeconds = null;
    }
  }

  private broadcastStatus(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcastAt < 220) {
      return;
    }
    this.lastBroadcastAt = now;
    this.status.updatedAt = now;
    this.recomputeTimingMetrics();

    if (this.status.state === 'running' && this.status.totalEstimated > 0) {
      const pct = Math.min(
        99,
        Math.round((this.status.scanned / this.status.totalEstimated) * 100)
      );
      this.updateBadge(`${pct}%`, '#1565c0');
    }

    const snapshot = structuredClone(this.status);
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore closed listener
      }
    }

    const api = getApi();
    if (api?.runtime?.sendMessage) {
      api.runtime
        .sendMessage({ type: 'AITAGGER_JOB_STATUS', status: snapshot })
        .catch(() => {
          // Normal when popup/options pages are not currently open
        });
    }
  }

  private updateBadge(text: string, color: string): void {
    const api = getApi();
    const actionApi = api?.browserAction || api?.action;
    if (!actionApi) return;

    try {
      actionApi.setBadgeText?.({ text });
      actionApi.setBadgeBackgroundColor?.({ color });
    } catch {
      // Ignore badge errors
    }
  }

  private async flushStatsAndCache(): Promise<void> {
    if (this.lifetimeStats) {
      await saveLifetimeStats(this.lifetimeStats);
    }
    await saveSerializedMemoCache(this.memoCache.serialize());
  }
}
