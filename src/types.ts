export interface TagDefinition {
  /** Internal Thunderbird tag key (e.g. 'agent:action' or user tag key like 'tax_2026') */
  key: string;
  /** Display label shown in Thunderbird UI (e.g. 'agent: Action Required' or 'Tax 2026') */
  name: string;
  /** Hex color in #RRGGBB format */
  color: string;
  /** Concise System-1 CLM criteria description used by /v1/systemone */
  description: string;
  /** Whether this tag is active for classification */
  enabled: boolean;
  /** Optional deterministic fast-path keywords matched against subject/sender */
  fastPathKeywords?: string[];
  /** True if this tag was learned from user-applied non-agent: tags */
  isLearned?: boolean;
  /** Number of user-tagged training emails observed for this tag */
  learnedSampleCount?: number;
}

export interface LearnedTagProfile {
  /** Thunderbird tag key (not prefixed by agent:) */
  key: string;
  /** Human-readable tag name from Thunderbird */
  name: string;
  /** Tag hex color */
  color: string;
  /** Whether this learned tag should be applied to future matching emails */
  enabled: boolean;
  /** Total positive training emails observed with this tag */
  sampleCount: number;
  /** Total negative feedback events (when user removed this tag from an email) */
  negativeCount: number;
  /** Positive frequency map of sender email addresses (lowercase) */
  senderCounts: Record<string, number>;
  /** Negative frequency map of sender email addresses where user removed this tag */
  negativeSenderCounts: Record<string, number>;
  /** Positive frequency map of sender domains (lowercase) */
  domainCounts: Record<string, number>;
  /** Positive frequency map of discriminative subject/snippet tokens */
  tokenCounts: Record<string, number>;
  /** Negative frequency map of tokens from emails where user removed this tag */
  negativeTokenCounts: Record<string, number>;
  /** Representative compact exemplars ("From: x | Subj: y") */
  exemplars: string[];
  /** Auto-synthesized criteria string passed into Ollama /v1/systemone */
  synthesizedCriteria: string;
  /** Optional user override for criteria description */
  customCriteriaOverride?: string;
  /** Timestamp of last training update */
  updatedAt: number;
}

export type ScopeMode = 'all' | 'unread' | 'recent_days';

export interface ScopeFilter {
  mode: ScopeMode;
  recentDays: number;
  skipJunk: boolean;
  forceReapply: boolean;
}

export type PromptMode = 'compact_snippet' | 'headers_only' | 'extended_snippet';

export interface PluginSettings {
  ollamaEndpoint: string;
  /** System-1 CLM model name on Ollama (e.g. 'tev1:0.8b', 'tev1:4b', 'nimble', 'jev') */
  model: string;
  /** Minimum probability threshold [0.05..0.95] for primary tag in /v1/systemone */
  clmConfidenceThreshold: number;
  /** Minimum probability threshold [0.05..0.95] for assigning a 2nd tag */
  clmSecondaryThreshold: number;
  /** Pass think: false when falling back to /api/chat on older Ollama (< v0.35) */
  systemOneThinkFalse: boolean;
  /** Max tags applied per email (default: 2) */
  maxTagsPerEmail: number;
  /** Automatically classify new incoming emails on arrival */
  classifyOnArrival: boolean;
  /** Automatically learn from any non-agent: tag the user applies to emails */
  enableAutoLearnUserTags: boolean;
  /** Minimum positive user-tagged examples required before auto-applying a learned tag (default: 3) */
  minLearnedSamplesToApply: number;
  /** Treat manual tag removal as negative feedback to un-learn mistakes */
  enableNegativeFeedbackOnRemove: boolean;
  /** How much of the email content to include in the CLM state */
  promptMode: PromptMode;
  /** Character limit for body snippet in compact_snippet mode */
  maxSnippetChars: number;
  /** Number of emails processed per worker batch */
  batchSize: number;
  /** Number of concurrent requests sent to Ollama /v1/systemone */
  concurrency: number;
  /** Reuse classification for messages in the same conversation thread */
  enableThreadMemoization: boolean;
  /** Reuse classification for automated/newsletter senders with consistent tags */
  enableSenderMemoization: boolean;
  /** Number of consistent classifications required before memoizing a sender */
  senderMemoMinHits: number;
  /** Enable instant zero-model matching when unambiguous fast-path keywords match */
  enableFastPathRules: boolean;
  /** How long Ollama keeps the model loaded in VRAM/RAM (e.g. '30m') */
  keepAlive: string;
  /** Default scope filter settings in popup */
  defaultScope: ScopeFilter;
  /** Configured agent: tags */
  tags: TagDefinition[];
}

/** Ollama v0.35+ /v1/systemone Jev-style CLM API Types */
export interface SystemOneChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface SystemOneNoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface SystemOneScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type SystemOneQuestion =
  | SystemOneChoiceQuestion
  | SystemOneNoulQuestion
  | SystemOneScoreQuestion;

export interface SystemOneRequest {
  model: string;
  state: string;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneAnswer {
  type: 'choice' | 'noul' | 'score';
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  noul?: number;
  score?: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
}

export type ClassificationSource =
  | 'clm-systemone'
  | 'clm-local-nb'
  | 'clm-fallback'
  | 'cache-thread'
  | 'cache-sender'
  | 'fast-path';

export interface ActivityEntry {
  messageId: number;
  subject: string;
  sender: string;
  tags: string[];
  probabilities?: Record<string, number>;
  source: ClassificationSource;
  durationMs: number;
  timestamp: number;
}

export type JobRunState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'error';

export interface JobStatus {
  state: JobRunState;
  jobId: string;
  folderName: string;
  folderPath: string;
  forceReapply: boolean;
  scope: ScopeFilter;
  totalEstimated: number;
  scanned: number;
  classified: number;
  learnedExamplesHarvested: number;
  skippedAlreadyTagged: number;
  skippedByScope: number;
  cacheHits: number;
  fastPathHits: number;
  errors: number;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  emailsPerSec: number;
  classifiedPerSec: number;
  avgInferenceMs: number;
  etaSeconds: number | null;
  lastError?: string;
  tagDistribution: Record<string, number>;
  recentActivity: ActivityEntry[];
}

export interface EmailClassificationInput {
  id: number;
  subject: string;
  author: string;
  recipients: string;
  snippet: string;
  threadKey: string;
  senderEmail: string;
  isAutomatedSender: boolean;
  existingTags: string[];
}

export interface ClassificationResult {
  messageId: number;
  tags: string[];
  probabilities?: Record<string, number>;
  source: ClassificationSource;
  durationMs: number;
}

export interface MemoCacheStats {
  threadEntries: number;
  senderEntries: number;
  totalHits: number;
}

export interface LifetimeStats {
  totalScanned: number;
  totalClassified: number;
  totalCacheHits: number;
  totalFastPathHits: number;
  totalIncomingTagged: number;
  totalLearnedSamples: number;
  totalNegativeFeedback: number;
  totalClmCalls: number;
  totalClmDurationMs: number;
}

/** Thunderbird MailExtension API Subset Declarations */
export interface MailFolder {
  id?: string;
  accountId: string;
  name: string;
  path: string;
  type?: string;
  subFolders?: MailFolder[];
}

export interface MailAccount {
  id: string;
  name: string;
  type: string;
  folders: MailFolder[];
}

export interface MessageHeader {
  id: number;
  date?: Date | string;
  author: string;
  recipients?: string[];
  ccList?: string[];
  subject: string;
  read: boolean;
  flagged: boolean;
  junk: boolean;
  tags: string[];
  folder?: MailFolder;
  headerMessageId?: string;
}

export interface MessageListPage {
  id: string | null;
  messages: MessageHeader[];
}

export interface MessagePart {
  partName?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string[]>;
  parts?: MessagePart[];
  size?: number;
  name?: string;
}

export interface ThunderbirdTag {
  key: string;
  tag: string;
  color: string;
  ordinal?: string;
}
