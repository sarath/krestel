import {
  ClassificationSource,
  EmailClassificationInput,
  MemoCacheStats,
} from './types';

interface SenderRecord {
  signature: string;
  tags: string[];
  consistentCount: number;
  mixed: boolean;
  isAutomated: boolean;
  updatedAt: number;
}

interface SerializedMemoCache {
  threads: Array<[string, string[]]>;
  senders: Array<[string, SenderRecord]>;
  totalHits: number;
}

const MAX_THREAD_ENTRIES = 6000;
const MAX_SENDER_ENTRIES = 4000;

export class MemoizationCache {
  private threadMap = new Map<string, string[]>();
  private senderMap = new Map<string, SenderRecord>();
  private totalHits = 0;

  /**
   * Looks up a cached tag assignment by thread or consistent sender.
   */
  public lookup(
    input: EmailClassificationInput,
    options: {
      enableThread: boolean;
      enableSender: boolean;
      senderMemoMinHits: number;
      validTagKeys: Set<string>;
      maxTags: number;
    }
  ): { tags: string[]; source: ClassificationSource } | null {
    // 1. Thread Memoization Lookup
    if (options.enableThread && input.threadKey) {
      const threadTags = this.threadMap.get(input.threadKey);
      if (threadTags && threadTags.length > 0) {
        const filtered = threadTags
          .filter((k) => options.validTagKeys.has(k))
          .slice(0, options.maxTags);
        if (filtered.length > 0) {
          // Refresh LRU order
          this.threadMap.delete(input.threadKey);
          this.threadMap.set(input.threadKey, filtered);
          this.totalHits++;
          return { tags: filtered, source: 'cache-thread' };
        }
      }
    }

    // 2. Consistent / Automated Sender Lookup
    if (options.enableSender && input.senderEmail) {
      const record = this.senderMap.get(input.senderEmail);
      if (record && !record.mixed) {
        const requiredHits = record.isAutomated
          ? Math.max(1, options.senderMemoMinHits)
          : Math.max(3, options.senderMemoMinHits + 2);

        if (record.consistentCount >= requiredHits) {
          const filtered = record.tags
            .filter((k) => options.validTagKeys.has(k))
            .slice(0, options.maxTags);
          if (filtered.length > 0) {
            this.totalHits++;
            return { tags: filtered, source: 'cache-sender' };
          }
        }
      }
    }

    return null;
  }

  /**
   * Records a newly classified email into the thread and sender caches.
   */
  public record(input: EmailClassificationInput, tags: string[]): void {
    if (!tags || tags.length === 0) return;

    // 1. Record Thread
    if (input.threadKey) {
      if (this.threadMap.has(input.threadKey)) {
        this.threadMap.delete(input.threadKey);
      } else if (this.threadMap.size >= MAX_THREAD_ENTRIES) {
        const oldestKey = this.threadMap.keys().next().value;
        if (oldestKey !== undefined) {
          this.threadMap.delete(oldestKey);
        }
      }
      this.threadMap.set(input.threadKey, [...tags]);
    }

    // 2. Record Sender Consistency
    if (input.senderEmail) {
      const signature = [...tags].sort().join('|');
      const existing = this.senderMap.get(input.senderEmail);

      if (!existing) {
        if (this.senderMap.size >= MAX_SENDER_ENTRIES) {
          const oldestSender = this.senderMap.keys().next().value;
          if (oldestSender !== undefined) {
            this.senderMap.delete(oldestSender);
          }
        }
        this.senderMap.set(input.senderEmail, {
          signature,
          tags: [...tags],
          consistentCount: 1,
          mixed: false,
          isAutomated: input.isAutomatedSender,
          updatedAt: Date.now(),
        });
      } else if (!existing.mixed) {
        if (existing.signature === signature) {
          existing.consistentCount += 1;
          existing.isAutomated = existing.isAutomated || input.isAutomatedSender;
          existing.updatedAt = Date.now();
        } else {
          // This sender sends multiple categories of emails (e.g., amazon shipping + security),
          // so mark as mixed to always classify per-message via LLM/thread.
          existing.mixed = true;
          existing.updatedAt = Date.now();
        }
      }
    }
  }

  public clear(): void {
    this.threadMap.clear();
    this.senderMap.clear();
    this.totalHits = 0;
  }

  /**
   * Invalidates cached thread and sender entries when a user manually removes a tag (negative feedback).
   */
  public invalidate(threadKey?: string, senderEmail?: string): void {
    if (threadKey) {
      this.threadMap.delete(threadKey);
    }
    if (senderEmail) {
      const existing = this.senderMap.get(senderEmail.toLowerCase());
      if (existing) {
        existing.mixed = true;
        existing.updatedAt = Date.now();
      }
    }
  }

  public getStats(): MemoCacheStats {
    return {
      threadEntries: this.threadMap.size,
      senderEntries: this.senderMap.size,
      totalHits: this.totalHits,
    };
  }

  public serialize(): SerializedMemoCache {
    return {
      threads: Array.from(this.threadMap.entries()).slice(-2500),
      senders: Array.from(this.senderMap.entries()).slice(-2000),
      totalHits: this.totalHits,
    };
  }

  public hydrate(data: Partial<SerializedMemoCache> | null | undefined): void {
    if (!data) return;
    if (Array.isArray(data.threads)) {
      this.threadMap = new Map(data.threads.slice(-MAX_THREAD_ENTRIES));
    }
    if (Array.isArray(data.senders)) {
      this.senderMap = new Map(data.senders.slice(-MAX_SENDER_ENTRIES));
    }
    if (typeof data.totalHits === 'number') {
      this.totalHits = data.totalHits;
    }
  }
}
