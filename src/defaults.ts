import { JobStatus, LifetimeStats, PluginSettings, TagDefinition } from './types';

export const DEFAULT_TAGS: TagDefinition[] = [
  {
    key: 'k1:action',
    name: 'k1: Action',
    color: '#e53935',
    description:
      'Direct questions, urgent requests, tasks needing a reply, approvals, or deadlines.',
    enabled: true,
    fastPathKeywords: ['action required', 'urgent response needed', 'please approve'],
  },
  {
    key: 'k1:finance',
    name: 'k1: Finance',
    color: '#2e7d32',
    description:
      'Invoices, payment receipts, billing statements, bank alerts, tax documents, or refunds.',
    enabled: true,
    fastPathKeywords: [
      'm1.com',
      'robinhood',
      'bank of america',
      'chase.com',
      'discover.com',
      'capitalone.com',
      'fidelity.com',
      'webull.com',
      'your receipt from',
      'invoice #',
      'payment confirmation',
      'billing statement',
    ],
  },
  {
    key: 'k1:work',
    name: 'k1: Work',
    color: '#1565c0',
    description:
      'Colleague discussions, project updates, code reviews, engineering tickets, or client correspondence.',
    enabled: true,
    fastPathKeywords: ['pull request', 'jira', 'linear', 'build failed'],
  },
  {
    key: 'k1:calendar',
    name: 'k1: Events',
    color: '#8e24aa',
    description:
      'Meeting invitations, calendar RSVPs, schedule changes, flight/hotel reservations, or event reminders.',
    enabled: true,
    fastPathKeywords: [
      'invitation:',
      'updated invitation:',
      'canceled event:',
      'calendar event',
    ],
  },
  {
    key: 'k1:shipping',
    name: 'k1: Orders',
    color: '#ef6c00',
    description:
      'Order confirmations, package tracking, dispatch notices, or delivery status updates.',
    enabled: true,
    fastPathKeywords: [
      'your order has shipped',
      'out for delivery',
      'tracking number',
      'package delivered',
    ],
  },
  {
    key: 'k1:security',
    name: 'k1: Security',
    color: '#00838f',
    description:
      '2FA verification codes, one-time passwords (OTP), password resets, sign-in alerts, or security notices.',
    enabled: true,
    fastPathKeywords: [
      'verification code',
      'security alert',
      'reset your password',
      'one-time passcode',
      'new sign-in',
    ],
  },
  {
    key: 'k1:newsletter',
    name: 'k1: Newsletter',
    color: '#5c6bc0',
    description:
      'Subscribed newsletters, weekly digests, Substack posts, industry roundups, or blog updates.',
    enabled: true,
    fastPathKeywords: ['weekly digest', 'daily digest', 'view in browser'],
  },
  {
    key: 'k1:promo',
    name: 'k1: Promos',
    color: '#757575',
    description:
      'Marketing campaigns, sales, discount codes, product launches, or promotional offers.',
    enabled: true,
    fastPathKeywords: ['% off', 'flash sale', 'limited time offer', 'promo code'],
  },
];

export interface RecommendedModel {
  id: string;
  label: string;
  size: string;
  badge: string;
  description: string;
}

export const RECOMMENDED_SYSTEM1_MODELS: RecommendedModel[] = [
  {
    id: 'tev1:0.8b',
    label: 'Tev1 0.8B (System-1 Jev CLM)',
    size: '812 MB',
    badge: 'Recommended CLM (/v1/systemone)',
    description:
      'Featherweight Together AI System-1 decision model. Evaluates all tag choices in a single forward pass with zero output tokens and calibrated probabilities.',
  },
  {
    id: 'tev1:4b',
    label: 'Tev1 4B (System-1 Jev CLM)',
    size: '4.5 GB',
    badge: 'High-Precision CLM (/v1/systemone)',
    description:
      '4B parameter System-1 decision model for nuanced multi-label email routing via /v1/systemone.',
  },
  {
    id: 'nimble',
    label: 'Nimble 9B (Bespoke Labs System-1 CLM)',
    size: '9.5 GB',
    badge: 'Flagship Decision CLM (/v1/systemone)',
    description:
      'High-accuracy Jev-compatible decision model returning calibrated choice probabilities in one pass.',
  },
  {
    id: 'jev',
    label: 'Jev (Custom Local System-1 CLM Alias)',
    size: 'Varies',
    badge: 'Native Jev Spec (/v1/systemone)',
    description:
      'TypeSafe AI Jev-style System-1 decision model alias running on Ollama /v1/systemone.',
  },
];

export const DEFAULT_SETTINGS: PluginSettings = {
  ollamaEndpoint: 'http://localhost:11434',
  model: 'tev1:0.8b',
  clmConfidenceThreshold: 0.25,
  clmSecondaryThreshold: 0.18,
  systemOneThinkFalse: true,
  maxTagsPerEmail: 2,
  classifyOnArrival: true,
  enableAutoLearnUserTags: true,
  minLearnedSamplesToApply: 3,
  enableNegativeFeedbackOnRemove: true,
  promptMode: 'compact_snippet',
  maxSnippetChars: 380,
  batchSize: 5,
  concurrency: 3,
  enableThreadMemoization: true,
  enableSenderMemoization: true,
  senderMemoMinHits: 2,
  enableFastPathRules: false,
  keepAlive: '30m',
  defaultScope: {
    mode: 'all',
    recentDays: 30,
    skipJunk: true,
    forceReapply: false,
  },
  tags: DEFAULT_TAGS,
};

export const INITIAL_JOB_STATUS: JobStatus = {
  state: 'idle',
  jobId: '',
  folderName: '',
  folderPath: '',
  forceReapply: false,
  scope: {
    mode: 'all',
    recentDays: 30,
    skipJunk: true,
    forceReapply: false,
  },
  totalEstimated: 0,
  scanned: 0,
  classified: 0,
  learnedExamplesHarvested: 0,
  skippedAlreadyTagged: 0,
  skippedByScope: 0,
  cacheHits: 0,
  fastPathHits: 0,
  errors: 0,
  startedAt: 0,
  updatedAt: 0,
  elapsedMs: 0,
  emailsPerSec: 0,
  classifiedPerSec: 0,
  avgInferenceMs: 0,
  etaSeconds: null,
  tagDistribution: {},
  recentActivity: [],
};

export const INITIAL_LIFETIME_STATS: LifetimeStats = {
  totalScanned: 0,
  totalClassified: 0,
  totalCacheHits: 0,
  totalFastPathHits: 0,
  totalIncomingTagged: 0,
  totalLearnedSamples: 0,
  totalNegativeFeedback: 0,
  totalClmCalls: 0,
  totalClmDurationMs: 0,
};
