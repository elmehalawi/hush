import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';
import {Attachment} from '../store/signalStore';

const {PresageModule} = NativeModules;

// Links yt-dlp resolves to a single video: Instagram posts and reels (Instagram's
// /share/ links need a redirect yt-dlp doesn't follow), and TikTok videos,
// including the short links the TikTok app shares.
const SOCIAL_VIDEO_PATTERN =
  /\bhttps?:\/\/(?:(?:www\.)?instagram\.com\/(?!share\/)(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+|(?:www\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|t\/\w+)|(?:vm|vt)\.tiktok\.com\/\w+)(?:[/?#][^\s<>"]*)?/i;

/**
 * The first Instagram/TikTok video link in `text`, without any sentence
 * punctuation that follows it.
 */
export function findSocialVideoUrl(text?: string): string | null {
  const match = text?.match(SOCIAL_VIDEO_PATTERN);
  return match ? match[0].replace(/[.,!?;:)\]'"]+$/, '') : null;
}

/** The service a social video link points at, for labelling the video. */
export function socialVideoSource(url: string): string {
  return /instagram\.com/i.test(url) ? 'Instagram' : 'TikTok';
}

export type SocialVideoState =
  | {status: 'loading'}
  | {status: 'ready'; attachment: Attachment}
  | {status: 'failed'};

// Settled results live for the session, so scrolling a message out and back in
// (or reopening the chat) doesn't show the placeholder again. The video itself
// is cached on disk natively, so a relaunch only pays the bridge round trip.
const settled = new Map<string, SocialVideoState>();
const inFlight = new Map<string, Promise<SocialVideoState>>();

function load(url: string): Promise<SocialVideoState> {
  let promise = inFlight.get(url);
  if (!promise) {
    promise = (PresageModule?.downloadSocialVideo(url) as Promise<Attachment>)
      .then(
        (attachment): SocialVideoState => ({status: 'ready', attachment}),
        (): SocialVideoState => ({status: 'failed'}),
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
 * Downloads the video behind an Instagram/TikTok link as a local video
 * attachment. Null when there's no link.
 */
export function useSocialVideo(url: string | null): SocialVideoState | null {
  const [state, setState] = useState<SocialVideoState | null>(() =>
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
