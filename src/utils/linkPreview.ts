import {NativeModules} from 'react-native';

const {PresageModule} = NativeModules;

export interface LinkPreviewResult {
  url: string;
  title?: string;
  description?: string;
  imagePath?: string;
  date?: number;
}

const EXCLUDED_DOMAINS = [
  'signal.org',
  'signal.group',
  'signal.me',
  'signal.link',
];

const URL_PATTERN =
  /\bhttps:\/\/[^\s<>"{}|\\^`\[\]]+/i;

/**
 * Extract the first HTTPS URL from text.
 */
export function findFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

/**
 * Check if a URL should be previewed.
 * Only HTTPS URLs from non-excluded domains are previewable.
 */
export function isPreviewableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return !EXCLUDED_DOMAINS.some(
      d => hostname === d || hostname.endsWith('.' + d),
    );
  } catch {
    return false;
  }
}

/**
 * Extract the domain from a URL for display (e.g. "github.com").
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Fetch link preview metadata via native module.
 * Returns null if the URL is not previewable or if the fetch fails.
 */
export async function fetchLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewResult | null> {
  if (!isPreviewableUrl(url)) return null;
  if (!PresageModule) return null;

  try {
    const result = await PresageModule.fetchLinkPreviewMetadata(url);
    if (signal?.aborted) return null;
    return {
      url: result.url || url,
      title: result.title || undefined,
      description: result.description || undefined,
      imagePath: result.imagePath || undefined,
      date: result.date || undefined,
    };
  } catch {
    return null;
  }
}
