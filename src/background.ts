import { ClassificationJobManager } from './jobQueue';
import {
  checkOllamaHealth,
  classifyBatchWithOllama,
} from './ollamaClient';
import {
  computeThreadKey,
  extractEmailAddress,
  isAutomatedSenderAddress,
} from './snippetExtractor';
import {
  loadLifetimeStats,
  loadSerializedMemoCache,
  loadSettings,
  saveSettings,
} from './storage';
import { syncTagsWithThunderbird } from './tagManager';
import {
  EmailClassificationInput,
  MailAccount,
  MailFolder,
  MessageHeader,
  MessageListPage,
  PluginSettings,
  ScopeFilter,
} from './types';

declare const messenger: any;
declare const browser: any;

function getApi(): any {
  if (typeof messenger !== 'undefined') return messenger;
  if (typeof browser !== 'undefined') return browser;
  return null;
}

const jobManager = new ClassificationJobManager();

async function listAllFolders(): Promise<
  Array<{
    id?: string;
    accountId: string;
    accountName: string;
    name: string;
    path: string;
    type?: string;
    depth: number;
  }>
> {
  const api = getApi();
  if (!api?.accounts?.list) return [];

  const result: Array<{
    id?: string;
    accountId: string;
    accountName: string;
    name: string;
    path: string;
    type?: string;
    depth: number;
  }> = [];

  try {
    const accounts: MailAccount[] = await api.accounts.list(true);
    const walkFolders = (
      folders: MailFolder[] | undefined,
      accountName: string,
      depth: number
    ) => {
      if (!Array.isArray(folders)) return;
      for (const f of folders) {
        result.push({
          id: f.id,
          accountId: f.accountId,
          accountName,
          name: f.name,
          path: f.path,
          type: f.type,
          depth,
        });
        if (Array.isArray(f.subFolders) && f.subFolders.length > 0) {
          walkFolders(f.subFolders, accountName, depth + 1);
        }
      }
    };

    for (const acc of accounts) {
      walkFolders(acc.folders, acc.name || acc.id, 0);
    }
  } catch (err) {
    console.warn('[AITagger] Failed to list mail accounts/folders:', err);
  }

  return result;
}

async function resolveFolderReference(ref: {
  id?: string;
  accountId?: string;
  path?: string;
  name?: string;
}): Promise<MailFolder | null> {
  const api = getApi();
  if (!api?.accounts?.list) return null;

  try {
    const accounts: MailAccount[] = await api.accounts.list(true);
    const findInList = (folders: MailFolder[] | undefined): MailFolder | null => {
      if (!Array.isArray(folders)) return null;
      for (const f of folders) {
        if (ref.id && f.id === ref.id) return f;
        if (
          ref.accountId &&
          ref.path &&
          f.accountId === ref.accountId &&
          f.path === ref.path
        ) {
          return f;
        }
        const nested = findInList(f.subFolders);
        if (nested) return nested;
      }
      return null;
    };

    for (const acc of accounts) {
      const found = findInList(acc.folders);
      if (found) return found;
    }
  } catch (err) {
    console.warn('[AITagger] Could not resolve folder reference:', err);
  }

  if (ref.id || (ref.accountId && ref.path)) {
    return {
      id: ref.id,
      accountId: ref.accountId || '',
      name: ref.name || ref.path || 'Folder',
      path: ref.path || '',
    };
  }
  return null;
}

function setupOllamaOriginHeaderRewrite(): void {
  const api = getApi();
  if (!api?.webRequest?.onBeforeSendHeaders) return;

  try {
    api.webRequest.onBeforeSendHeaders.addListener(
      (details: any) => {
        const requestHeaders: Array<{ name: string; value?: string }> =
          details.requestHeaders || [];
        const filtered = requestHeaders.filter(
          (h) => h.name.toLowerCase() !== 'origin'
        );
        return { requestHeaders: filtered };
      },
      {
        urls: [
          'http://localhost/*',
          'http://127.0.0.1/*',
          'http://[::1]/*',
        ],
      },
      ['blocking', 'requestHeaders']
    );
  } catch (err) {
    console.warn('[AITagger] webRequest header rewrite unavailable:', err);
  }
}

async function registerContextMenus(): Promise<void> {
  const api = getApi();
  if (!api?.menus?.create) return;

  try {
    await api.menus.removeAll();

    // Folder pane context menus
    await api.menus.create({
      id: 'kestrel-folder-classify',
      title: 'Kestrel: Classify Untagged Emails in Folder',
      contexts: ['folder_pane'],
    });

    await api.menus.create({
      id: 'kestrel-folder-unread',
      title: 'Kestrel: Classify Unread Emails in Folder',
      contexts: ['folder_pane'],
    });

    await api.menus.create({
      id: 'kestrel-folder-force-reapply',
      title: 'Kestrel: Force Re-apply k1: Tags on Folder',
      contexts: ['folder_pane'],
    });

    await api.menus.create({
      id: 'kestrel-folder-learn',
      title: 'Kestrel: Learn User Tags from Folder (Train Model)',
      contexts: ['folder_pane'],
    });

    // Message list context menus
    await api.menus.create({
      id: 'kestrel-msg-classify',
      title: 'Kestrel: Classify Selected Email(s)',
      contexts: ['message_list'],
    });

    await api.menus.create({
      id: 'kestrel-msg-force-reapply',
      title: 'Kestrel: Force Re-apply k1: Tags on Selected',
      contexts: ['message_list'],
    });
  } catch (err) {
    console.warn('[AITagger] Failed to create context menus:', err);
  }
}

async function collectAllMessagesFromPage(
  initialPage: MessageListPage
): Promise<MessageHeader[]> {
  const api = getApi();
  const collected: MessageHeader[] = [];
  let page = initialPage;

  if (Array.isArray(page?.messages)) {
    collected.push(...page.messages);
  }

  while (page?.id && api?.messages?.continueList) {
    page = await api.messages.continueList(page.id);
    if (Array.isArray(page?.messages)) {
      collected.push(...page.messages);
    }
  }

  return collected;
}

async function bootstrap(): Promise<void> {
  setupOllamaOriginHeaderRewrite();

  const cachedMemo = await loadSerializedMemoCache();
  await jobManager.init(cachedMemo);

  const settings = await loadSettings();
  await syncTagsWithThunderbird(settings.tags);
  await registerContextMenus();

  const api = getApi();
  if (!api) return;

  // 1. Incoming Mail Listener (`onNewMailReceived`)
  if (api.messages?.onNewMailReceived) {
    api.messages.onNewMailReceived.addListener(
      async (_folder: MailFolder, messagesPage: MessageListPage) => {
        try {
          const currentSettings = await loadSettings();
          if (!currentSettings.classifyOnArrival) return;

          const newHeaders = await collectAllMessagesFromPage(messagesPage);
          if (newHeaders.length === 0) return;

          await jobManager.classifyMessagesList(newHeaders, {
            forceReapply: false,
            isIncomingArrival: true,
          });
        } catch (err) {
          console.error('[AITagger] Error classifying incoming mail:', err);
        }
      }
    );
  }

  // 2. Real-Time User Tag Learning Listener (`messages.onUpdated`)
  // Whenever a user adds a tag NOT prefixed by `agent:`, train the ContinualTagLearner immediately!
  if (api.messages?.onUpdated) {
    api.messages.onUpdated.addListener(
      async (
        message: MessageHeader,
        changedProperties: { tags?: string[] },
        oldProperties?: { tags?: string[] }
      ) => {
        try {
          if (Array.isArray(changedProperties?.tags)) {
            await jobManager.handleUserTagModification(
              message,
              changedProperties.tags,
              oldProperties?.tags
            );
          }
        } catch (err) {
          console.warn('[AITagger] Error in onUpdated tag learning:', err);
        }
      }
    );
  }

  // 3. Context Menu Click Listener
  if (api.menus?.onClicked) {
    api.menus.onClicked.addListener(async (info: any) => {
      try {
        const currentSettings = await loadSettings();
        const menuId: string = info.menuItemId;

        if (menuId === 'kestrel-folder-learn') {
          const clickedFolder: MailFolder | undefined =
            info.selectedFolder || info.displayedFolder || info.folder;
          if (!clickedFolder) return;
          await jobManager.harvestLearnedTagsFromFolder(clickedFolder);
          return;
        }

        if (
          menuId === 'kestrel-folder-classify' ||
          menuId === 'kestrel-folder-unread' ||
          menuId === 'kestrel-folder-force-reapply'
        ) {
          const clickedFolder: MailFolder | undefined =
            info.selectedFolder || info.displayedFolder || info.folder;
          if (!clickedFolder) return;

          const scope: ScopeFilter = {
            ...currentSettings.defaultScope,
            mode:
              menuId === 'kestrel-folder-unread'
                ? 'unread'
                : currentSettings.defaultScope.mode,
            forceReapply: menuId === 'kestrel-folder-force-reapply',
          };

          await jobManager.startFolderJob(clickedFolder, scope);
        } else if (
          menuId === 'kestrel-msg-classify' ||
          menuId === 'kestrel-msg-force-reapply'
        ) {
          const selectedPage: MessageListPage | undefined = info.selectedMessages;
          if (!selectedPage) return;

          const headers = await collectAllMessagesFromPage(selectedPage);
          await jobManager.classifyMessagesList(headers, {
            forceReapply: menuId === 'kestrel-msg-force-reapply',
            isIncomingArrival: false,
          });
        }
      } catch (err) {
        console.error('[AITagger] Context menu action failed:', err);
      }
    });
  }

  // 4. Runtime Message RPC Handler for Popup & Options UI
  if (api.runtime?.onMessage) {
    api.runtime.onMessage.addListener(
      (message: any, _sender: any, sendResponse: (res: any) => void) => {
        (async () => {
          try {
            switch (message?.type) {
              case 'GET_STATE': {
                const [currentSettings, lifetimeStats, folders] =
                  await Promise.all([
                    loadSettings(),
                    loadLifetimeStats(),
                    listAllFolders(),
                  ]);

                let activeFolder: MailFolder | null = null;
                try {
                  if (api.mailTabs?.query) {
                    const tabs = await api.mailTabs.query({
                      active: true,
                      currentWindow: true,
                    });
                    if (tabs?.[0]?.displayedFolder) {
                      activeFolder = tabs[0].displayedFolder;
                    }
                  }
                } catch {
                  // Ignore if no active mailTab
                }

                return {
                  ok: true,
                  settings: currentSettings,
                  jobStatus: jobManager.getStatus(),
                  lifetimeStats,
                  memoStats: jobManager.getMemoStats(),
                  learnedProfiles: jobManager.getLearnedProfiles(),
                  folders,
                  activeFolder,
                };
              }

              case 'START_FOLDER_JOB': {
                const folder = await resolveFolderReference(message.folder);
                if (!folder) {
                  throw new Error('Please select a valid Thunderbird folder.');
                }
                const scope: ScopeFilter = message.scope;
                const status = await jobManager.startFolderJob(folder, scope);
                return { ok: true, status };
              }

              case 'HARVEST_FOLDER_LEARNED_TAGS': {
                const folder = await resolveFolderReference(message.folder);
                if (!folder) {
                  throw new Error('Please select a valid Thunderbird folder.');
                }
                const res = await jobManager.harvestLearnedTagsFromFolder(folder);
                return { ok: true, ...res };
              }

              case 'UPDATE_LEARNED_PROFILE': {
                const profiles = await jobManager.updateLearnedProfile(
                  String(message.tagKey || ''),
                  message.updates || {}
                );
                return { ok: true, learnedProfiles: profiles };
              }

              case 'DELETE_LEARNED_PROFILE': {
                const profiles = await jobManager.deleteLearnedProfile(
                  String(message.tagKey || '')
                );
                return { ok: true, learnedProfiles: profiles };
              }

              case 'CLEAR_LEARNED_PROFILES': {
                const profiles = await jobManager.clearLearnedProfiles();
                return { ok: true, learnedProfiles: profiles };
              }

              case 'PAUSE_JOB': {
                return { ok: true, status: jobManager.pauseJob() };
              }

              case 'RESUME_JOB': {
                return { ok: true, status: jobManager.resumeJob() };
              }

              case 'CANCEL_JOB': {
                const status = await jobManager.cancelJob();
                return { ok: true, status };
              }

              case 'CLASSIFY_SELECTED_IN_ACTIVE_TAB': {
                if (!api.mailTabs?.getSelectedMessages) {
                  throw new Error('mailTabs API not available.');
                }
                const page = await api.mailTabs.getSelectedMessages();
                const headers = await collectAllMessagesFromPage(page);
                if (headers.length === 0) {
                  throw new Error(
                    'No messages selected in the current Thunderbird message list.'
                  );
                }
                const res = await jobManager.classifyMessagesList(headers, {
                  forceReapply: Boolean(message.forceReapply),
                  isIncomingArrival: false,
                });
                return { ok: true, ...res };
              }

              case 'SAVE_SETTINGS': {
                const newSettings: PluginSettings = message.settings;
                await saveSettings(newSettings);
                await syncTagsWithThunderbird(newSettings.tags);
                return { ok: true, settings: newSettings };
              }

              case 'SYNC_TAGS': {
                const currentSettings = await loadSettings();
                await syncTagsWithThunderbird(currentSettings.tags);
                return { ok: true };
              }

              case 'CHECK_OLLAMA': {
                const targetSettings: PluginSettings =
                  message.settings || (await loadSettings());
                const health = await checkOllamaHealth(targetSettings);
                return { ok: true, health };
              }

              case 'TEST_CLASSIFY_SAMPLE': {
                const targetSettings: PluginSettings =
                  message.settings || (await loadSettings());
                const sampleAuthor = String(
                  message.sample?.author || 'billing@stripe.com'
                );
                const sampleSubject = String(
                  message.sample?.subject || 'Invoice #2049 payment receipt'
                );
                const sampleSnippet = String(
                  message.sample?.snippet ||
                    'Thank you for your payment of $49.00. Your invoice is attached.'
                );
                const senderEmail = extractEmailAddress(sampleAuthor);

                const sampleInput: EmailClassificationInput = {
                  id: 0,
                  author: sampleAuthor,
                  subject: sampleSubject,
                  recipients: '',
                  snippet: sampleSnippet,
                  senderEmail,
                  isAutomatedSender: isAutomatedSenderAddress(senderEmail),
                  threadKey: computeThreadKey(sampleSubject, senderEmail),
                  existingTags: [],
                };

                const minSamples = targetSettings.minLearnedSamplesToApply ?? 3;
                const learnedDefs = jobManager.getActiveLearnedTagDefinitions(
                  minSamples
                );
                const localScores = jobManager.scoreEmailWithLocalClm(
                  sampleInput,
                  targetSettings
                );

                const {
                  tagsPerItem,
                  probabilitiesPerItem,
                  source,
                  durationMs,
                } = await classifyBatchWithOllama(
                  [sampleInput],
                  targetSettings,
                  undefined,
                  learnedDefs,
                  [localScores]
                );
                return {
                  ok: true,
                  tags: tagsPerItem[0] || [],
                  probabilities: probabilitiesPerItem[0] || {},
                  source,
                  durationMs,
                };
              }

              case 'CLEAR_MEMO_CACHE': {
                await jobManager.clearMemoCache();
                return { ok: true, memoStats: jobManager.getMemoStats() };
              }

              default:
                return { ok: false, error: `Unknown message type: ${message?.type}` };
            }
          } catch (err: any) {
            return {
              ok: false,
              error: err?.message || String(err),
            };
          }
        })().then(sendResponse);

        return true;
      }
    );
  }
}

void bootstrap();
