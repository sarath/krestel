import {
  MailAccount,
  MailFolder,
  MessageHeader,
  MessageListPage,
  MessagePart,
  ThunderbirdTag,
} from '../types';

interface SimMessage extends MessageHeader {
  bodySnippet: string;
}

interface UserTagPreset {
  key: string;
  name: string;
  color: string;
}

const STORAGE_PREFIX = 'kestrel_dev_sim_v1:';

const USER_TAG_PALETTE: UserTagPreset[] = [
  { key: 'tax_2026', name: 'tax_2026', color: '#0d9488' },
  { key: 'client_acme', name: 'client_acme', color: '#8b5cf6' },
  { key: 'vip_board', name: 'vip_board', color: '#ec4899' },
];

const SEED_TEMPLATES: Array<{
  author: string;
  subject: string;
  snippet: string;
  unread?: boolean;
}> = [
  // Tax / CPA emails (great for testing 3-example learning with `tax_2026`)
  {
    author: 'CPA Tax Partners <filing@cpataxpartners.com>',
    subject: '2026 Quarterly Estimated Tax Return & Form 1099-NEC Schedule',
    snippet:
      'Attached is your federal 1040-ES quarterly tax voucher and CPA deduction worksheet for fiscal year 2026.',
    unread: true,
  },
  {
    author: 'CPA Tax Partners <filing@cpataxpartners.com>',
    subject: 'IRS W-2 & K-1 Tax Document Checklist for 2026 Filing',
    snippet:
      'Please upload your 1099-INT, K-1 partnership schedule, and charitable deduction receipts to the CPA portal.',
    unread: true,
  },
  {
    author: 'TurboTax Tax Desk <alerts@intuit-tax.com>',
    subject: 'Your 2026 State & Federal Tax Return Deduction Summary',
    snippet:
      'Review your itemized tax deductions, Form 1098 mortgage interest statement, and CPA filing timeline.',
    unread: true,
  },
  {
    author: 'CPA Tax Partners <filing@cpataxpartners.com>',
    subject: 'Final Review: 2026 Tax Return Form 1040 Ready for E-File',
    snippet:
      'Your CPA has completed the 2026 federal tax return and Schedule C calculation. Confirm to e-file with the IRS.',
    unread: true,
  },
  // Acme Corp Client project emails (great for testing 3-example learning with `client_acme`)
  {
    author: 'Marcus Vance <mvance@acmecorp.io>',
    subject: 'Acme Corp Q4 Enterprise SOW & API Integration Milestone',
    snippet:
      'Team, here is the updated Acme Corp deployment architecture and SLA deliverables for the enterprise rollout.',
    unread: true,
  },
  {
    author: 'Elena Rostova <erostova@acmecorp.io>',
    subject: 'Acme Corp Production Webhook Credentials & Staging Sign-off',
    snippet:
      'We validated the Acme Corp SSO SAML configuration in staging. Ready for production cutover on Thursday.',
    unread: true,
  },
  {
    author: 'Marcus Vance <mvance@acmecorp.io>',
    subject: 'Re: Acme Corp Q4 Enterprise SOW & API Integration Milestone',
    snippet:
      'Following up on the Acme Corp rate-limiting throughput benchmarks before our steering committee meeting.',
    unread: false,
  },
  {
    author: 'Elena Rostova <erostova@acmecorp.io>',
    subject: 'Acme Corp Phase 2 Expansion Proposal & Seat Licensing',
    snippet:
      'Acme Corp engineering wants to add 250 additional seats to the enterprise cluster next month.',
    unread: true,
  },
  // Standard categories for default agent: tags
  {
    author: 'Stripe Billing <billing@stripe.com>',
    subject: 'Invoice #INV-90241 payment receipt ($49.00)',
    snippet:
      'Thank you for your business. Your monthly subscription invoice #INV-90241 for $49.00 has been paid in full.',
    unread: true,
  },
  {
    author: 'Sarah Jenkins <sarah.jenkins@company.io>',
    subject: 'URGENT: Need your sign-off on Q4 engineering headcount before 4pm',
    snippet:
      'Hi! Can you please review slide 4 of the board deck and reply with your approval before 4pm today?',
    unread: true,
  },
  {
    author: 'GitHub Security <noreply@github.com>',
    subject: '[GitHub] Your two-factor authentication verification code',
    snippet:
      'A sign-in attempt requires verification. Your 2FA verification code is 739104. This code expires in 15 minutes.',
    unread: true,
  },
  {
    author: 'Amazon Logistics <shipment-tracking@amazon.com>',
    subject: 'Your package #114-8841209 is out for delivery today',
    snippet:
      'UPS tracking 1Z999AA10123456784 shows your package is out for delivery and will arrive by 6:00 PM.',
    unread: true,
  },
  {
    author: 'Google Calendar <calendar-notification@google.com>',
    subject: 'Invitation: Architecture Sync @ Thu Oct 22, 2026 11:00am - 11:45am',
    snippet:
      'You have been invited to Architecture Sync. Join Zoom Meeting https://zoom.us/j/98234123. RSVP Yes / Maybe / No.',
    unread: false,
  },
  {
    author: 'ByteByteGo <newsletter@bytebytego.com>',
    subject: 'System Design Digest #148: How Cloudflare Processes 55M Requests/sec',
    snippet:
      'In this week edition of the newsletter we explore Anycast routing, eBPF packet filtering, and edge caching. Unsubscribe anytime.',
    unread: false,
  },
  {
    author: 'B&H Photo Deals <deals@promo.bhphotovideo.com>',
    subject: 'Flash Sale: 40% Off NVMe SSDs & Studio Monitors — Ends Tonight!',
    snippet:
      'Exclusive limited-time promo code SAVE40 at checkout. Shop our holiday clearance deals before midnight.',
    unread: false,
  },
  {
    author: 'PagerDuty Alerts <alerts@pagerduty.com>',
    subject: '[FIRING:1] prod-db-replica-02 high replication lag (>15s)',
    snippet:
      'Incident #40921 triggered on service production-postgres. CPU utilization at 94%. Please acknowledge immediately.',
    unread: true,
  },
  {
    author: 'AWS Billing <no-reply-aws@amazon.com>',
    subject: 'Your AWS Cloud billing statement for October is available',
    snippet:
      'Your total charges for billing period October 2026 are $184.22. View your detailed cost allocation receipt in the console.',
    unread: false,
  },
  {
    author: 'FedEx Delivery Manager <trackingupdates@fedex.com>',
    subject: 'FedEx Shipment 774829104921 Delivered — Left at Front Porch',
    snippet:
      'Your FedEx Express package from Apple Inc. was delivered at 2:14 PM. Tracking number: 774829104921.',
    unread: false,
  },
  {
    author: 'Okta Verify <security@okta.com>',
    subject: 'Security Alert: New login to your corporate Okta account from Windows',
    snippet:
      'We noticed a new sign-in to your account from Chrome on Windows 11 (IP 198.51.100.42). If this was not you, reset your password.',
    unread: true,
  },
  {
    author: 'David Kim <dkim@engineering.org>',
    subject: 'Code review request: PR #842 Streaming cursor pagination for 100k inboxes',
    snippet:
      'Added constant-memory generator paging and sender memoization cache. Benchmarks show 45x speedup on 100k messages.',
    unread: false,
  },
];

// State of our simulated Thunderbird instance
let activeFolderId = 'fld_inbox';
const selectedMessageIds = new Set<number>([1, 5, 9]);
let inboxMessages: SimMessage[] = [];
let archive1kMessages: SimMessage[] = [];
// For the 100k folder, we store tag overrides in a sparse Map so 100,000 emails use almost zero RAM!
const archive100kTags = new Map<number, string[]>();
let nextIncomingId = 900_000;

const tbTagsMap = new Map<string, ThunderbirdTag>();
for (const preset of USER_TAG_PALETTE) {
  tbTagsMap.set(preset.key, {
    key: preset.key,
    tag: preset.name,
    color: preset.color,
  });
}

function generateSimMessages(count: number, startId: number): SimMessage[] {
  const list: SimMessage[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const tpl = SEED_TEMPLATES[i % SEED_TEMPLATES.length];
    const cycle = Math.floor(i / SEED_TEMPLATES.length);
    const id = startId + i;
    const isReply = cycle > 0 && i % 3 === 0;
    const subject =
      cycle === 0
        ? tpl.subject
        : isReply
          ? `Re: ${tpl.subject}`
          : `${tpl.subject} [#${cycle + 1}]`;
    list.push({
      id,
      author: tpl.author,
      subject,
      recipients: ['you@thunderbird.local'],
      date: new Date(now - i * 3_600_000 * 4).toISOString(),
      read: cycle > 0 ? i % 4 !== 0 : !tpl.unread,
      flagged: false,
      junk: false,
      tags: [],
      bodySnippet: tpl.snippet,
    });
  }
  return list;
}

function getLazy100kMessage(index: number): SimMessage {
  const id = 10_000 + index;
  const tpl = SEED_TEMPLATES[index % SEED_TEMPLATES.length];
  const isReply = index >= SEED_TEMPLATES.length;
  const subject = isReply ? `Re: ${tpl.subject}` : tpl.subject;
  return {
    id,
    author: tpl.author,
    subject,
    recipients: ['you@thunderbird.local'],
    date: new Date(Date.now() - (index % 500) * 3_600_000).toISOString(),
    read: index % 5 !== 0,
    flagged: false,
    junk: false,
    tags: archive100kTags.get(id) || [],
    bodySnippet: tpl.snippet,
  };
}

function resetSimulatedMessages(): void {
  inboxMessages = generateSimMessages(30, 1);
  archive1kMessages = generateSimMessages(1000, 1001);
  archive100kTags.clear();
  selectedMessageIds.clear();
  selectedMessageIds.add(1);
  selectedMessageIds.add(5);
  selectedMessageIds.add(9);
}

resetSimulatedMessages();

const FOLDERS: Record<string, MailFolder & { totalCount: number }> = {
  fld_inbox: {
    id: 'fld_inbox',
    accountId: 'acc_main',
    name: 'Inbox',
    path: '/Inbox',
    type: 'inbox',
    totalCount: 30,
  },
  fld_archive_1k: {
    id: 'fld_archive_1k',
    accountId: 'acc_main',
    name: 'Work Archive (1k)',
    path: '/Work Archive',
    type: 'archives',
    totalCount: 1000,
  },
  fld_archive_100k: {
    id: 'fld_archive_100k',
    accountId: 'acc_main',
    name: 'Mega Archive (100k)',
    path: '/Mega Archive',
    type: 'archives',
    totalCount: 100_000,
  },
};

function findMessageById(messageId: number): SimMessage | null {
  const inInbox = inboxMessages.find((m) => m.id === messageId);
  if (inInbox) return inInbox;
  const in1k = archive1kMessages.find((m) => m.id === messageId);
  if (in1k) return in1k;
  if (messageId >= 10_000 && messageId < 110_000) {
    return getLazy100kMessage(messageId - 10_000);
  }
  return null;
}

// Event listener registries for our mock `window.messenger`
const onNewMailListeners: Array<
  (folder: MailFolder, page: MessageListPage) => void
> = [];
const onUpdatedListeners: Array<
  (
    msg: MessageHeader,
    changed: { tags?: string[] },
    oldProps?: { tags?: string[] }
  ) => void
> = [];
const onMenuClickedListeners: Array<(info: any) => void> = [];
const onRuntimeMessageListeners: Array<
  (msg: any, sender: any, sendResponse: (res: any) => void) => boolean | void
> = [];

// Pagination cursors for `messages.list` / `messages.continueList`
interface CursorState {
  folderId: string;
  offset: number;
  pageSize: number;
  total: number;
  aborted: boolean;
}
const activeCursors = new Map<string, CursorState>();
let cursorCounter = 1;

function getPageSlice(cursor: CursorState): MessageHeader[] {
  const { folderId, offset, pageSize } = cursor;
  if (folderId === 'fld_inbox') {
    return inboxMessages
      .slice(offset, offset + pageSize)
      .map((m) => ({ ...m, tags: [...(m.tags || [])] }));
  }
  if (folderId === 'fld_archive_1k') {
    return archive1kMessages
      .slice(offset, offset + pageSize)
      .map((m) => ({ ...m, tags: [...(m.tags || [])] }));
  }
  if (folderId === 'fld_archive_100k') {
    const end = Math.min(100_000, offset + pageSize);
    const slice: MessageHeader[] = [];
    for (let i = offset; i < end; i++) {
      slice.push(getLazy100kMessage(i));
    }
    return slice;
  }
  return [];
}

let renderScheduled = false;
function scheduleTableRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderMessageTable();
    renderUserTagPalette();
  });
}

// Install `window.messenger` before `background.js` runs!
const messengerMock = {
  storage: {
    local: {
      async get(keys?: string | string[] | Record<string, any> | null) {
        const result: Record<string, any> = {};
        if (!keys) {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(STORAGE_PREFIX)) {
              const shortKey = k.slice(STORAGE_PREFIX.length);
              try {
                result[shortKey] = JSON.parse(localStorage.getItem(k) || 'null');
              } catch {
                result[shortKey] = localStorage.getItem(k);
              }
            }
          }
          return result;
        }
        const keyList =
          typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys);
        for (const k of keyList) {
          const raw = localStorage.getItem(STORAGE_PREFIX + k);
          if (raw !== null) {
            try {
              result[k] = JSON.parse(raw);
            } catch {
              result[k] = raw;
            }
          } else if (typeof keys === 'object' && !Array.isArray(keys) && k in keys) {
            result[k] = keys[k];
          }
        }
        return result;
      },
      async set(items: Record<string, any>) {
        for (const [k, v] of Object.entries(items)) {
          localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v));
        }
      },
    },
  },

  accounts: {
    async list(_includeSubFolders?: boolean): Promise<MailAccount[]> {
      return [
        {
          id: 'acc_main',
          name: 'local@thunderbird.dev',
          type: 'imap',
          folders: [
            FOLDERS.fld_inbox,
            FOLDERS.fld_archive_1k,
            FOLDERS.fld_archive_100k,
          ],
        },
      ];
    },
  },

  folders: {
    async getFolderInfo(folder: MailFolder | string) {
      const id = typeof folder === 'string' ? folder : folder.id || 'fld_inbox';
      if (id === 'fld_inbox') {
        return {
          totalMessageCount: inboxMessages.length,
          unreadMessageCount: inboxMessages.filter((m) => !m.read).length,
        };
      }
      if (id === 'fld_archive_1k') {
        return {
          totalMessageCount: archive1kMessages.length,
          unreadMessageCount: archive1kMessages.filter((m) => !m.read).length,
        };
      }
      return {
        totalMessageCount: 100_000,
        unreadMessageCount: 80_000,
      };
    },
  },

  mailTabs: {
    async query() {
      return [
        {
          id: 1,
          active: true,
          displayedFolder: FOLDERS[activeFolderId] || FOLDERS.fld_inbox,
        },
      ];
    },
    async getSelectedMessages(): Promise<MessageListPage> {
      const msgs: MessageHeader[] = [];
      for (const id of selectedMessageIds) {
        const m = findMessageById(id);
        if (m) msgs.push({ ...m, tags: [...(m.tags || [])] });
      }
      return { id: null, messages: msgs };
    },
  },

  messages: {
    tags: {
      async list(): Promise<ThunderbirdTag[]> {
        return Array.from(tbTagsMap.values());
      },
      async create(key: string, tag: string, color: string) {
        tbTagsMap.set(key.toLowerCase(), { key, tag, color });
        scheduleTableRender();
      },
      async update(key: string, props: { tag?: string; color?: string }) {
        const existing = tbTagsMap.get(key.toLowerCase()) || {
          key,
          tag: props.tag || key,
          color: props.color || '#2563eb',
        };
        if (props.tag) existing.tag = props.tag;
        if (props.color) existing.color = props.color;
        tbTagsMap.set(key.toLowerCase(), existing);
        scheduleTableRender();
      },
    },
    async listTags(): Promise<ThunderbirdTag[]> {
      return Array.from(tbTagsMap.values());
    },
    async createTag(key: string, tag: string, color: string) {
      tbTagsMap.set(key.toLowerCase(), { key, tag, color });
      scheduleTableRender();
    },
    async updateTag(key: string, props: { tag?: string; color?: string }) {
      return this.tags.update(key, props);
    },

    async list(folder: MailFolder | string): Promise<MessageListPage> {
      const folderId =
        typeof folder === 'string'
          ? folder
          : folder.id ||
            (folder.path === '/Work Archive'
              ? 'fld_archive_1k'
              : folder.path === '/Mega Archive'
                ? 'fld_archive_100k'
                : 'fld_inbox');

      const total =
        folderId === 'fld_inbox'
          ? inboxMessages.length
          : folderId === 'fld_archive_1k'
            ? archive1kMessages.length
            : 100_000;
      const pageSize = 100;
      const cursor: CursorState = {
        folderId,
        offset: 0,
        pageSize,
        total,
        aborted: false,
      };
      const slice = getPageSlice(cursor);
      cursor.offset += slice.length;

      if (cursor.offset >= cursor.total) {
        return { id: null, messages: slice };
      }
      const pageId = `cursor_${cursorCounter++}`;
      activeCursors.set(pageId, cursor);
      return { id: pageId, messages: slice };
    },

    async continueList(pageId: string): Promise<MessageListPage> {
      const cursor = activeCursors.get(pageId);
      if (!cursor || cursor.aborted) {
        activeCursors.delete(pageId);
        return { id: null, messages: [] };
      }
      // Small yield so UI progress bar & Pause/Cancel buttons stay 60fps responsive during 100k runs
      await new Promise((r) => setTimeout(r, 4));
      const slice = getPageSlice(cursor);
      cursor.offset += slice.length;
      if (cursor.offset >= cursor.total) {
        activeCursors.delete(pageId);
        return { id: null, messages: slice };
      }
      return { id: pageId, messages: slice };
    },

    async abortList(pageId: string): Promise<void> {
      const cursor = activeCursors.get(pageId);
      if (cursor) {
        cursor.aborted = true;
        activeCursors.delete(pageId);
      }
    },

    async getFull(messageId: number): Promise<MessagePart> {
      const msg = findMessageById(messageId);
      return {
        contentType: 'text/plain',
        body: msg?.bodySnippet || '',
      };
    },

    async update(
      messageId: number,
      newProps: { tags?: string[]; read?: boolean }
    ): Promise<void> {
      const inInbox = inboxMessages.find((m) => m.id === messageId);
      if (inInbox) {
        const oldTags = [...(inInbox.tags || [])];
        if (Array.isArray(newProps.tags)) {
          inInbox.tags = [...newProps.tags];
          for (const fn of onUpdatedListeners) {
            fn({ ...inInbox }, { tags: [...inInbox.tags] }, { tags: oldTags });
          }
        }
        scheduleTableRender();
        return;
      }

      const in1k = archive1kMessages.find((m) => m.id === messageId);
      if (in1k) {
        const oldTags = [...(in1k.tags || [])];
        if (Array.isArray(newProps.tags)) {
          in1k.tags = [...newProps.tags];
          for (const fn of onUpdatedListeners) {
            fn({ ...in1k }, { tags: [...in1k.tags] }, { tags: oldTags });
          }
        }
        if (activeFolderId === 'fld_archive_1k') {
          scheduleTableRender();
        }
        return;
      }

      if (messageId >= 10_000 && messageId < 110_000) {
        if (Array.isArray(newProps.tags)) {
          archive100kTags.set(messageId, [...newProps.tags]);
        }
        if (activeFolderId === 'fld_archive_100k' && messageId < 10_150) {
          scheduleTableRender();
        }
      }
    },

    onNewMailReceived: {
      addListener(fn: (folder: MailFolder, page: MessageListPage) => void) {
        onNewMailListeners.push(fn);
      },
    },

    onUpdated: {
      addListener(
        fn: (
          msg: MessageHeader,
          changed: { tags?: string[] },
          oldProps?: { tags?: string[] }
        ) => void
      ) {
        onUpdatedListeners.push(fn);
      },
    },
  },

  menus: {
    async removeAll() {},
    async create(_opts: any) {},
    onClicked: {
      addListener(fn: (info: any) => void) {
        onMenuClickedListeners.push(fn);
      },
    },
  },

  browserAction: {
    async setBadgeText(details: { text: string }) {
      const pill = document.getElementById('dev-badge-mirror');
      if (pill) {
        pill.textContent = details.text
          ? `Toolbar Badge: ${details.text}`
          : 'Toolbar Badge: idle';
      }
    },
    async setBadgeBackgroundColor(details: { color: string }) {
      const pill = document.getElementById('dev-badge-mirror');
      if (pill && details.color) {
        pill.style.borderColor = details.color;
      }
    },
  },

  runtime: {
    onMessage: {
      addListener(
        fn: (
          msg: any,
          sender: any,
          sendResponse: (res: any) => void
        ) => boolean | void
      ) {
        onRuntimeMessageListeners.push(fn);
      },
    },
    async sendMessage(payload: any): Promise<any> {
      // Broadcast to any listeners registered by background.ts, popup.ts, or harness
      return new Promise((resolve) => {
        let handledAsync = false;
        for (const fn of onRuntimeMessageListeners) {
          const ret = fn(payload, {}, (response: any) => {
            resolve(response);
          });
          if (ret === true) {
            handledAsync = true;
          }
        }
        if (!handledAsync) {
          resolve({ ok: true });
        }
      });
    },
    async openOptionsPage() {
      switchInspectorPane('options');
    },
  },
};

(window as any).messenger = messengerMock;
(window as any).browser = messengerMock;

// Harness UI helpers
function setToast(html: string): void {
  const el = document.getElementById('last-event-toast');
  if (el) el.innerHTML = html;
}

function switchInspectorPane(pane: 'popup' | 'options'): void {
  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.classList.toggle(
      'active',
      (btn as HTMLElement).dataset.pane === pane
    );
  });
  document
    .getElementById('pane-popup')
    ?.classList.toggle('active', pane === 'popup');
  document
    .getElementById('pane-options')
    ?.classList.toggle('active', pane === 'options');

  // Refresh the iframe state when switching to Options Studio
  if (pane === 'options') {
    const iframe = document.getElementById(
      'iframe-options'
    ) as HTMLIFrameElement | null;
    iframe?.contentWindow?.location.reload();
  }
}

function getVisibleFolderMessages(): SimMessage[] {
  if (activeFolderId === 'fld_inbox') {
    return inboxMessages;
  }
  if (activeFolderId === 'fld_archive_1k') {
    return archive1kMessages.slice(0, 100);
  }
  const preview100k: SimMessage[] = [];
  for (let i = 0; i < 100; i++) {
    preview100k.push(getLazy100kMessage(i));
  }
  return preview100k;
}

function renderUserTagPalette(): void {
  const container = document.getElementById('user-tag-palette');
  if (!container) return;
  container.innerHTML = '';

  for (const tag of USER_TAG_PALETTE) {
    const chip = document.createElement('span');
    chip.className = 'palette-chip';
    chip.style.backgroundColor = tag.color;
    chip.textContent = `🎓 ${tag.name}`;
    container.appendChild(chip);
  }
}

async function userToggleTagOnMessage(
  msg: SimMessage,
  tagKey: string,
  mode: 'add' | 'remove'
): Promise<void> {
  const oldTags = [...(msg.tags || [])];
  const exists = oldTags.some((t) => t.toLowerCase() === tagKey.toLowerCase());

  let newTags: string[];
  if (mode === 'add') {
    if (exists) return;
    newTags = [...oldTags, tagKey];
  } else {
    newTags = oldTags.filter((t) => t.toLowerCase() !== tagKey.toLowerCase());
  }

  // Update message in place
  const inInbox = inboxMessages.find((m) => m.id === msg.id);
  if (inInbox) inInbox.tags = newTags;
  const in1k = archive1kMessages.find((m) => m.id === msg.id);
  if (in1k) in1k.tags = newTags;
  if (msg.id >= 10_000) archive100kTags.set(msg.id, newTags);

  // Fire `messenger.messages.onUpdated` with oldTags so background.ts runs ContinualTagLearner or Negative Feedback!
  for (const fn of onUpdatedListeners) {
    await fn({ ...msg, tags: newTags }, { tags: newTags }, { tags: oldTags });
  }

  // Query updated learned profiles from background to show live 1/3 -> 2/3 -> 3/3 warmup feedback!
  const state = await messengerMock.runtime.sendMessage({ type: 'GET_STATE' });
  const minSamples = state?.settings?.minLearnedSamplesToApply ?? 3;
  const prof = (state?.learnedProfiles || []).find(
    (p: any) => p.key.toLowerCase() === tagKey.toLowerCase()
  );

  if (mode === 'add' && prof) {
    if (prof.sampleCount >= minSamples) {
      setToast(
        `🎉 <strong>"${prof.name}" is now ACTIVE (${prof.sampleCount}/${minSamples} examples)!</strong> Future matching emails will be auto-tagged with <code>${prof.key}</code>.`
      );
    } else {
      setToast(
        `⏳ Learned example <strong>${prof.sampleCount}/${minSamples}</strong> for <code>${prof.name}</code> — tag ${minSamples - prof.sampleCount} more email(s) to activate auto-tagging!`
      );
    }
  } else if (mode === 'remove') {
    setToast(
      `🚫 Removed <code>${tagKey}</code> from "${msg.subject.slice(0, 38)}..." — Negative feedback recorded &amp; memo cache invalidated.`
    );
  }

  scheduleTableRender();
  refreshPopupIframe();
}

function refreshPopupIframe(): void {
  const popupWin = (
    document.getElementById('iframe-popup') as HTMLIFrameElement | null
  )?.contentWindow as any;
  if (popupWin && popupWin.messenger) {
    // Send a status refresh broadcast
    void messengerMock.runtime
      .sendMessage({ type: 'GET_STATE' })
      .then((res) => {
        if (res?.jobStatus) {
          for (const fn of onRuntimeMessageListeners) {
            fn({ type: 'JOB_STATUS_UPDATE', status: res.jobStatus }, {}, () => {});
          }
        }
      });
  }
}

function renderMessageTable(): void {
  const tbody = document.getElementById('tb-message-tbody');
  const cntInbox = document.getElementById('cnt-inbox');
  const selCountEl = document.getElementById('selected-count-text');
  if (cntInbox) cntInbox.textContent = String(inboxMessages.length);
  if (selCountEl) {
    selCountEl.textContent = `${selectedMessageIds.size} selected`;
  }
  if (!tbody) return;

  const visibleMessages = getVisibleFolderMessages();
  tbody.innerHTML = '';

  for (const msg of visibleMessages) {
    const tr = document.createElement('tr');
    if (!msg.read) tr.classList.add('unread');

    // Checkbox cell
    const tdSel = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selectedMessageIds.has(msg.id);
    chk.addEventListener('change', () => {
      if (chk.checked) selectedMessageIds.add(msg.id);
      else selectedMessageIds.delete(msg.id);
      if (selCountEl) {
        selCountEl.textContent = `${selectedMessageIds.size} selected`;
      }
    });
    tdSel.appendChild(chk);

    // Author cell
    const tdAuthor = document.createElement('td');
    const authorSpan = document.createElement('span');
    authorSpan.className = 'msg-author';
    authorSpan.textContent = msg.author;
    const dateSpan = document.createElement('span');
    dateSpan.className = 'msg-date';
    dateSpan.textContent = new Date(msg.date || Date.now()).toLocaleTimeString(
      [],
      { hour: '2-digit', minute: '2-digit' }
    );
    tdAuthor.appendChild(authorSpan);
    tdAuthor.appendChild(dateSpan);

    // Subject & Snippet cell
    const tdSub = document.createElement('td');
    const subDiv = document.createElement('div');
    subDiv.className = 'msg-subject';
    subDiv.textContent = msg.subject;
    const snipDiv = document.createElement('div');
    snipDiv.className = 'msg-snippet';
    snipDiv.textContent = msg.bodySnippet;
    tdSub.appendChild(subDiv);
    tdSub.appendChild(snipDiv);

    // Applied Tags cell (click any pill to remove & trigger negative feedback)
    const tdTags = document.createElement('td');
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'applied-tags-cell';

    if (!msg.tags || msg.tags.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted-sm';
      empty.textContent = 'Untagged';
      tagsWrap.appendChild(empty);
    } else {
      for (const tKey of msg.tags) {
        const tbMeta = tbTagsMap.get(tKey.toLowerCase());
        const pill = document.createElement('button');
        pill.className = 'applied-tag-pill';
        pill.style.backgroundColor = tbMeta?.color || '#2563eb';
        pill.title = `Click to remove "${tbMeta?.tag || tKey}" (triggers Negative Feedback)`;
        pill.textContent = `${tbMeta?.tag || tKey} ×`;
        pill.addEventListener('click', () => {
          void userToggleTagOnMessage(msg, tKey, 'remove');
        });
        tagsWrap.appendChild(pill);
      }
    }
    tdTags.appendChild(tagsWrap);

    // Quick Apply User Tag cell
    const tdLearn = document.createElement('td');
    const learnWrap = document.createElement('div');
    learnWrap.className = 'quick-learn-btns';
    for (const preset of USER_TAG_PALETTE) {
      const btn = document.createElement('button');
      btn.className = 'quick-learn-btn';
      btn.textContent = `+ ${preset.name}`;
      btn.title = `Manually tag with "${preset.name}" (non-agent: tag trains ContinualTagLearner)`;
      btn.addEventListener('click', () => {
        void userToggleTagOnMessage(msg, preset.key, 'add');
      });
      learnWrap.appendChild(btn);
    }
    tdLearn.appendChild(learnWrap);

    tr.appendChild(tdSel);
    tr.appendChild(tdAuthor);
    tr.appendChild(tdSub);
    tr.appendChild(tdTags);
    tr.appendChild(tdLearn);
    tbody.appendChild(tr);
  }
}

function initHarnessUi(): void {
  renderUserTagPalette();
  renderMessageTable();

  // Folder switching
  document.querySelectorAll('.folder-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const folderId = (btn as HTMLElement).dataset.folderId || 'fld_inbox';
      activeFolderId = folderId;
      document.querySelectorAll('.folder-tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      scheduleTableRender();
    });
  });

  // Inspector tab switching (Popup vs Options Studio)
  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pane = ((btn as HTMLElement).dataset.pane || 'popup') as
        | 'popup'
        | 'options';
      switchInspectorPane(pane);
    });
  });

  // Add custom user tag to palette
  document.getElementById('btn-add-user-tag')?.addEventListener('click', () => {
    const input = document.getElementById(
      'input-custom-user-tag'
    ) as HTMLInputElement | null;
    const raw = (input?.value || '').trim().replace(/^(k1|agent)\s*:\s*/i, '');
    if (!raw) return;
    const key = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
    if (!USER_TAG_PALETTE.some((p) => p.key === key)) {
      const colors = ['#0d9488', '#8b5cf6', '#ec4899', '#d97706', '#0284c7'];
      const color = colors[USER_TAG_PALETTE.length % colors.length];
      USER_TAG_PALETTE.push({ key, name: raw, color });
      tbTagsMap.set(key, { key, tag: raw, color });
      renderUserTagPalette();
      renderMessageTable();
    }
    if (input) input.value = '';
  });

  // Select all visible checkbox
  const selectAllChk = document.getElementById(
    'chk-select-all'
  ) as HTMLInputElement | null;
  selectAllChk?.addEventListener('change', () => {
    const visible = getVisibleFolderMessages();
    if (selectAllChk.checked) {
      for (const m of visible) selectedMessageIds.add(m.id);
    } else {
      selectedMessageIds.clear();
    }
    scheduleTableRender();
  });

  // Context menu action buttons
  document
    .getElementById('btn-ctx-classify-selected')
    ?.addEventListener('click', async () => {
      setToast('⚡ Classifying selected messages via System-1 CLM...');
      const res = await messengerMock.runtime.sendMessage({
        type: 'CLASSIFY_SELECTED_IN_ACTIVE_TAB',
        forceReapply: false,
      });
      if (res?.ok) {
        setToast(
          `✓ Classified ${res.classified} selected message(s) (${res.skipped} skipped)`
        );
      } else {
        setToast(`✗ ${res?.error || 'Select at least 1 message first'}`);
      }
      scheduleTableRender();
    });

  document
    .getElementById('btn-ctx-force-selected')
    ?.addEventListener('click', async () => {
      setToast(
        '🔄 Force Re-applying k1: tags on selected (preserving manual user tags)...'
      );
      const res = await messengerMock.runtime.sendMessage({
        type: 'CLASSIFY_SELECTED_IN_ACTIVE_TAB',
        forceReapply: true,
      });
      if (res?.ok) {
        setToast(
          `✓ Force re-applied k1: tags on ${res.classified} message(s) — manual tags preserved!`
        );
      }
      scheduleTableRender();
    });

  document
    .getElementById('btn-ctx-learn-folder')
    ?.addEventListener('click', async () => {
      const folder = FOLDERS[activeFolderId] || FOLDERS.fld_inbox;
      const res = await messengerMock.runtime.sendMessage({
        type: 'HARVEST_FOLDER_LEARNED_TAGS',
        folder,
      });
      if (res?.ok) {
        setToast(
          `🎓 Scanned ${res.scanned.toLocaleString()} headers in ${folder.name} — harvested ${res.learnedSamples} user tag example(s)!`
        );
      }
    });

  // Simulate Incoming Email (`onNewMailReceived`)
  let incomingCycle = 0;
  document
    .getElementById('btn-sim-incoming')
    ?.addEventListener('click', async () => {
      const incomingTemplates = [
        {
          author: 'CPA Tax Partners <filing@cpataxpartners.com>',
          subject: 'Urgent 2026 IRS Tax Extension Form 4868 Confirmation',
          snippet:
            'Your CPA has filed your 2026 federal tax extension and calculated your estimated tax balance.',
        },
        {
          author: 'Marcus Vance <mvance@acmecorp.io>',
          subject: 'Acme Corp Production Launch Sign-off & API Keys',
          snippet:
            'Acme Corp engineering signed off on the enterprise SOW milestone. Ready to enable production traffic.',
        },
        {
          author: 'Stripe <billing@stripe.com>',
          subject: 'Invoice #99412 payment receipt for $129.00',
          snippet:
            'Thank you for your payment of $129.00. Your invoice receipt is attached.',
        },
      ];
      const tpl = incomingTemplates[incomingCycle % incomingTemplates.length];
      incomingCycle++;

      const newMsg: SimMessage = {
        id: nextIncomingId++,
        author: tpl.author,
        subject: tpl.subject,
        recipients: ['you@thunderbird.local'],
        date: new Date().toISOString(),
        read: false,
        flagged: false,
        junk: false,
        tags: [],
        bodySnippet: tpl.snippet,
      };

      inboxMessages.unshift(newMsg);
      activeFolderId = 'fld_inbox';
      scheduleTableRender();

      setToast(
        `📨 New email arrived: "${newMsg.subject}" — running onNewMailReceived...`
      );
      for (const fn of onNewMailListeners) {
        await fn(FOLDERS.fld_inbox, { id: null, messages: [newMsg] });
      }
      scheduleTableRender();
      setToast(
        `✓ Incoming email classified on arrival: "${newMsg.subject}" → [${(newMsg.tags || []).join(', ') || 'no tag'}]`
      );
    });

  // Reset simulated inbox
  document.getElementById('btn-reset-sim')?.addEventListener('click', () => {
    resetSimulatedMessages();
    scheduleTableRender();
    setToast('↺ Reset simulated Inbox (30), Work Archive (1k), and Mega Archive (100k).');
  });

  // Listen for JOB_STATUS_UPDATE broadcasts from background.ts so the table updates live
  messengerMock.runtime.onMessage.addListener((msg: any) => {
    if (msg?.type === 'JOB_STATUS_UPDATE') {
      scheduleTableRender();
      // Also forward to the popup iframe if open
      const popupWin = (
        document.getElementById('iframe-popup') as HTMLIFrameElement | null
      )?.contentWindow as any;
      if (popupWin?.dispatchEvent) {
        scheduleTableRender();
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initHarnessUi();
});
