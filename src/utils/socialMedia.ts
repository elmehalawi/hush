import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';
import {Attachment} from '../store/signalStore';

const {PresageModule} = NativeModules;

// Links yt-dlp resolves to a post's media: Instagram posts and reels (Instagram's
// /share/ links need a redirect yt-dlp doesn't follow), TikTok videos, including
// the short links the TikTok app shares, and Pinterest pins on any of its
// country domains or the app's pin.it short links.
const SOCIAL_MEDIA_PATTERN =
  /\bhttps?:\/\/(?:(?:www\.)?instagram\.com\/(?!share\/)(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+|(?:www\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|t\/\w+)|(?:vm|vt)\.tiktok\.com\/\w+|(?:[\w-]+\.)?pinterest\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})\/pin\/(?:[\w-]+--)?\d+|pin\.it\/\w+)(?:[/?#][^\s<>"]*)?/i;

/**
 * The first Instagram/TikTok/Pinterest post link in `text`, without any
 * sentence punctuation that follows it.
 */
export function findSocialMediaUrl(text?: string): string | null {
  const match = text?.match(SOCIAL_MEDIA_PATTERN);
  return match ? match[0].replace(/[.,!?;:)\]'"]+$/, '') : null;
}

/** The service a social media link points at, for labelling its media. */
export function socialMediaSource(url: string): string {
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/pinterest\.|pin\.it/i.test(url)) return 'Pinterest';
  return 'TikTok';
}

export type SocialMediaState =
  | {status: 'loading'}
  | {status: 'ready'; attachments: Attachment[]}
  | {status: 'failed'};

// Settled results live for the session, so scrolling a message out and back in
// (or reopening the chat) doesn't show the placeholder again. The media itself
// is cached on disk natively, so a relaunch only pays the bridge round trip.
const settled = new Map<string, SocialMediaState>();
const inFlight = new Map<string, Promise<SocialMediaState>>();

function load(url: string): Promise<SocialMediaState> {
  let promise = inFlight.get(url);
  if (!promise) {
    promise = (PresageModule?.downloadSocialMedia(url) as Promise<Attachment[]>)
      .then(
        (attachments): SocialMediaState => ({status: 'ready', attachments}),
        (): SocialMediaState => ({status: 'failed'}),
      )
      .then(state => {
        settled.set(url, state);
        inFlight.delete(url);
        return state;
      });
    inFlight.set(url, promise);
  }
  return promise;
}

/**
 * Downloads the media in the post behind an Instagram/TikTok/Pinterest link as
 * local attachments: one video or image, or several for a multi-item post.
 * Null when there's no link.
 */
export function useSocialMedia(url: string | null): SocialMediaState | null {
  const [state, setState] = useState<SocialMediaState | null>(() =>
    url ? settled.get(url) ?? {status: 'loading'} : null,
  );

  useEffect(() => {
    if (!url || !PresageModule) {
      setState(null);
      return;
    }
    const known = settled.get(url);
    if (known) {
      setState(known);
      return;
    }
    let cancelled = false;
    setState({status: 'loading'});
    load(url).then(result => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
