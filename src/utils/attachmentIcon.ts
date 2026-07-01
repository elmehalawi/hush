import {useEffect, useState} from 'react';
import {NativeModules} from 'react-native';

const {PresageModule} = NativeModules;

// ---- Content-type detection (MIME based) ----

export function isImageType(contentType?: string): boolean {
  return !!contentType && contentType.startsWith('image/');
}

export function isVideoType(contentType?: string): boolean {
  return !!contentType && contentType.startsWith('video/');
}

export function isAudioType(contentType?: string): boolean {
  return !!contentType && contentType.startsWith('audio/');
}

export type AttachmentKind = 'image' | 'video' | 'file';

// Resolve the visual kind of an attachment. An explicit override wins (used by
// the compose bar, which derives the kind from a file extension and has no MIME
// type); otherwise fall back to the content type.
export function attachmentKind(
  contentType?: string,
  override?: AttachmentKind,
): AttachmentKind {
  if (override) {
    return override;
  }
  if (isImageType(contentType)) {
    return 'image';
  }
  if (isVideoType(contentType)) {
    return 'video';
  }
  return 'file';
}

// ---- Native OS file icons ----

// getFileIcon renders a native macOS icon (e.g. the Word icon for .docx, the
// PDF icon for .pdf) to a PNG and returns its path. Icons are stable per file
// path, so cache them process-wide to avoid re-rendering on every mount.
const fileIconCache = new Map<string, string>();

// Lazily fetch the native file-type icon for a local file. Pass `undefined` to
// skip fetching (e.g. for image/video attachments that render their own
// preview, or when an icon path is already known).
export function useFileIcon(filePath?: string): string | undefined {
  const [icon, setIcon] = useState<string | undefined>(() =>
    filePath ? fileIconCache.get(filePath) : undefined,
  );

  useEffect(() => {
    if (!filePath) {
      setIcon(undefined);
      return;
    }
    const cached = fileIconCache.get(filePath);
    if (cached) {
      setIcon(cached);
      return;
    }
    if (!PresageModule?.getFileIcon) {
      return;
    }
    let cancelled = false;
    PresageModule.getFileIcon(filePath)
      .then((path: string) => {
        if (path) {
          fileIconCache.set(filePath, path);
        }
        if (!cancelled) {
          setIcon(path || undefined);
        }
      })
      .catch(() => {
        // Icon rendering can fail (e.g. file not yet on disk) — fall back to the
        // emoji placeholder in AttachmentThumbnail.
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return icon;
}
