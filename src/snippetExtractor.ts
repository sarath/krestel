import {
  EmailClassificationInput,
  MessageHeader,
  MessagePart,
  PromptMode,
  TagDefinition,
} from './types';

const AUTOMATED_LOCAL_PART_REGEX =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|billing|receipts?|invoices?|orders?|shipping|newsletter|updates?|digest|security|auth|verify|mailer-daemon|postmaster|bounce|automated|system|info|news|marketing|deals|promo|support)([+._-].*)?$/i;

const SUBJECT_PREFIX_REGEX =
  /^(\s*((re|fw|fwd|aw|wg|sv|vs|tr)\s*(\[\d+\])?\s*:\s*|\[(external|ext|spam|bulk)\]\s*))+/i;

const LONG_URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]{30,}/gi;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ndash;': '-',
  '&mdash;': '--',
  '&hellip;': '...',
  '&copy;': '(c)',
  '&reg;': '(R)',
};

/**
 * Extracts a lowercase email address from an RFC 5322 author header
 * e.g. "GitHub <noreply@github.com>" -> "noreply@github.com"
 */
export function extractEmailAddress(rawAuthor: string): string {
  if (!rawAuthor) return '';
  const angleMatch = rawAuthor.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angleMatch && angleMatch[1]) {
    return angleMatch[1].trim().toLowerCase();
  }
  const bareMatch = rawAuthor.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (bareMatch && bareMatch[1]) {
    return bareMatch[1].trim().toLowerCase();
  }
  return rawAuthor.trim().toLowerCase();
}

/**
 * Determines if an email sender is an automated/transactional/newsletter sender
 * based on address patterns and optional MIME headers.
 */
export function isAutomatedSenderAddress(
  senderEmail: string,
  rootHeaders?: Record<string, string[]>
): boolean {
  if (rootHeaders) {
    if (
      rootHeaders['list-unsubscribe'] ||
      rootHeaders['list-id'] ||
      rootHeaders['x-campaign'] ||
      rootHeaders['x-mailgun-variables'] ||
      rootHeaders['x-sendgrid-eid']
    ) {
      return true;
    }
    const precedence = (rootHeaders['precedence']?.[0] || '').toLowerCase();
    if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
      return true;
    }
    const autoSubmitted = (rootHeaders['auto-submitted']?.[0] || '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') {
      return true;
    }
  }

  const atIndex = senderEmail.indexOf('@');
  if (atIndex <= 0) return false;
  const localPart = senderEmail.slice(0, atIndex);
  const domainPart = senderEmail.slice(atIndex + 1);

  if (AUTOMATED_LOCAL_PART_REGEX.test(localPart)) {
    return true;
  }

  if (
    domainPart.startsWith('mail.') ||
    domainPart.startsWith('notify.') ||
    domainPart.startsWith('notifications.') ||
    domainPart.startsWith('em.') ||
    domainPart.startsWith('e.') ||
    domainPart.startsWith('news.') ||
    domainPart.startsWith('bounce.')
  ) {
    return true;
  }

  return false;
}

/**
 * Normalizes an email subject to group messages belonging to the same conversation thread.
 */
export function computeThreadKey(subject: string, senderEmail: string): string {
  const cleanedSubject = (subject || '')
    .replace(SUBJECT_PREFIX_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!cleanedSubject || cleanedSubject.length < 6) {
    return '';
  }

  const domain = senderEmail.includes('@')
    ? senderEmail.slice(senderEmail.indexOf('@') + 1)
    : senderEmail;

  return `${domain}::${cleanedSubject.slice(0, 120)}`;
}

/**
 * Converts HTML email content into compact plain text suitable for a System-1 prompt.
 */
export function stripHtmlToCleanText(html: string): string {
  if (!html) return '';
  let text = html
    // Remove style, script, head, svg, xml blocks completely
    .replace(/<(style|script|head|svg|noscript|xml)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Replace block tags with newlines so words don't mash together
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|section|article|header|footer)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text.replace(
    /&(nbsp|amp|lt|gt|quot|apos|ndash|mdash|hellip|copy|reg|#39);/gi,
    (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? ' '
  );
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
  });

  return cleanPlainTextSnippet(text);
}

/**
 * Strips quoted replies, signatures, tracking links, and redundant whitespace.
 */
export function cleanPlainTextSnippet(rawText: string): string {
  if (!rawText) return '';

  const lines = rawText.split(/\r?\n/);
  const keptLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip quoted lines
    if (line.startsWith('>')) continue;

    // Stop at standard reply or forward separators
    if (
      /^On .+ wrote:$/i.test(line) ||
      /^-{3,}\s*(Original Message|Forwarded message)\s*-{3,}$/i.test(line) ||
      /^From:\s+.+@.+/i.test(line)
    ) {
      break;
    }

    // Stop at standard signature delimiter
    if (line === '--' || line === '---' || /^Sent from my (iPhone|iPad|Galaxy|Android)/i.test(line)) {
      break;
    }

    // Skip common invisible preheader filler characters (zero-width spaces)
    const strippedZeroWidth = line.replace(/[\u200B-\u200D\uFEFF\u00AD\u034F]/g, '').trim();
    if (!strippedZeroWidth) continue;

    keptLines.push(strippedZeroWidth);
    if (keptLines.length >= 24) break;
  }

  return keptLines
    .join(' ')
    .replace(LONG_URL_REGEX, '[link]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Walks a Thunderbird MessagePart MIME tree to extract the best body text without attachments.
 */
export function extractSnippetFromMimeTree(
  rootPart: MessagePart | null | undefined,
  maxChars: number
): { snippet: string; rootHeaders?: Record<string, string[]> } {
  if (!rootPart || maxChars <= 0) {
    return { snippet: '' };
  }

  let plainCandidate = '';
  let htmlCandidate = '';

  const visit = (part: MessagePart) => {
    if (plainCandidate.length >= maxChars * 2) return;

    const contentType = (part.contentType || '').toLowerCase();
    const disposition = (part.headers?.['content-disposition']?.[0] || '').toLowerCase();

    // Skip explicit attachments
    if (disposition.startsWith('attachment')) {
      return;
    }

    if (part.body && typeof part.body === 'string') {
      if (contentType.includes('text/plain')) {
        plainCandidate += '\n' + part.body;
      } else if (contentType.includes('text/html') && !plainCandidate) {
        htmlCandidate += '\n' + part.body;
      }
    }

    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        visit(child);
        if (plainCandidate.length >= maxChars * 2) break;
      }
    }
  };

  visit(rootPart);

  const cleaned = plainCandidate
    ? cleanPlainTextSnippet(plainCandidate)
    : htmlCandidate
      ? stripHtmlToCleanText(htmlCandidate)
      : '';

  return {
    snippet: cleaned.slice(0, maxChars),
    rootHeaders: rootPart.headers,
  };
}

/**
 * Builds the normalized EmailClassificationInput from a Thunderbird MessageHeader and optional MIME tree.
 */
export function buildClassificationInput(
  header: MessageHeader,
  fullPart: MessagePart | null | undefined,
  promptMode: PromptMode,
  maxSnippetChars: number
): EmailClassificationInput {
  const senderEmail = extractEmailAddress(header.author || '');
  const charBudget =
    promptMode === 'headers_only'
      ? 0
      : promptMode === 'extended_snippet'
        ? Math.max(maxSnippetChars, 750)
        : maxSnippetChars;

  const { snippet, rootHeaders } =
    charBudget > 0
      ? extractSnippetFromMimeTree(fullPart, charBudget)
      : { snippet: '', rootHeaders: fullPart?.headers };

  const isAutomated = isAutomatedSenderAddress(senderEmail, rootHeaders);
  const threadKey = computeThreadKey(header.subject || '', senderEmail);

  return {
    id: header.id,
    subject: (header.subject || '(No Subject)').slice(0, 180),
    author: (header.author || '').slice(0, 120),
    recipients: (header.recipients || []).slice(0, 2).join(', ').slice(0, 100),
    snippet,
    threadKey,
    senderEmail,
    isAutomatedSender: isAutomated,
    existingTags: Array.isArray(header.tags) ? [...header.tags] : [],
  };
}

/**
 * Optional deterministic fast-path keyword matcher.
 * Returns matched tag keys (up to maxTags) if unambiguous keywords match subject or snippet.
 */
export function matchFastPathRules(
  input: EmailClassificationInput,
  enabledTags: TagDefinition[],
  maxTags: number
): string[] {
  const haystack = `${input.subject} ${input.author} ${input.snippet}`.toLowerCase();
  const matched: string[] = [];

  for (const tag of enabledTags) {
    if (!tag.fastPathKeywords || tag.fastPathKeywords.length === 0) continue;
    for (const kw of tag.fastPathKeywords) {
      const normalizedKw = kw.trim().toLowerCase();
      if (normalizedKw.length >= 3 && haystack.includes(normalizedKw)) {
        matched.push(tag.key);
        break;
      }
    }
    if (matched.length >= maxTags) break;
  }

  return matched;
}
