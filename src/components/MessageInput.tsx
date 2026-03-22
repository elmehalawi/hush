import React, {
  useState,
  useRef,
  useImperativeHandle,
  forwardRef,
  useEffect,
  useCallback,
} from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  useColorScheme,
  Image,
  Text,
  ScrollView,
  TouchableOpacity,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import {GlassView} from './GlassView';
import {GlassButton} from './GlassButton';

const {PresageModule, CommandPaletteModule} = NativeModules;
const commandEmitter = CommandPaletteModule
  ? new NativeEventEmitter(CommandPaletteModule)
  : null;

interface PendingAttachment {
  path: string;
  name: string;
  type: 'image' | 'video' | 'file';
  thumbnailPath?: string;
}

interface MessageInputProps {
  onSend: (text: string, attachmentPaths?: string[]) => void;
  disabled?: boolean;
}

export interface MessageInputHandle {
  focus: () => void;
  insertText: (letter: string) => void;
  addFiles: (paths: string[]) => void;
}

function getFileType(path: string): 'image' | 'video' | 'file' {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v'].includes(ext)) {
    return 'video';
  }
  return 'file';
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(
  function MessageInput({onSend, disabled}, ref) {
    const [text, setText] = useState('');
    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
    const isDark = useColorScheme() === 'dark';
    const inputRef = useRef<TextInput>(null);
    const sendingRef = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
      },
      insertText: (letter: string) => {
        setText(prev => prev + letter);
        sendingRef.current = false;
        inputRef.current?.focus();
      },
      addFiles: (paths: string[]) => {
        if (paths && paths.length > 0) {
          addFilePaths(paths);
        }
      },
    }));

    const addFilePaths = useCallback(async (paths: string[]) => {
      // Immediately add attachments without thumbnails for instant UI feedback
      const newAttachments: PendingAttachment[] = paths.map(path => ({
        path,
        name: getFileName(path),
        type: getFileType(path),
      }));
      setAttachments(prev => [...prev, ...newAttachments]);

      // Generate thumbnails in background and update as they complete
      for (const att of newAttachments) {
        let thumbnailPath: string | undefined;
        try {
          if (att.type === 'image' && PresageModule) {
            thumbnailPath = await PresageModule.generateImageThumbnail(att.path);
          } else if (att.type === 'video' && PresageModule) {
            thumbnailPath = await PresageModule.generateVideoThumbnailAtPath(att.path);
          } else if (att.type === 'file' && PresageModule) {
            thumbnailPath = await PresageModule.getFileIcon(att.path);
          }
        } catch {
          // ignore thumbnail errors
        }
        if (thumbnailPath) {
          setAttachments(prev =>
            prev.map(a => a.path === att.path ? {...a, thumbnailPath} : a),
          );
        }
      }
    }, []);

    const removeAttachment = useCallback((index: number) => {
      setAttachments(prev => prev.filter((_, i) => i !== index));
    }, []);

    const handleSend = () => {
      if (sendingRef.current) return;
      const trimmed = text.trim();
      const hasAttachments = attachments.length > 0;

      if (trimmed.length > 0 || hasAttachments) {
        sendingRef.current = true;
        const paths = hasAttachments
          ? attachments.map(a => a.path)
          : undefined;
        onSend(trimmed, paths);
      }
      setText('');
      setAttachments([]);
      setTimeout(() => { sendingRef.current = false; }, 100);
    };

    const handleTextChange = (newText: string) => {
      sendingRef.current = false;
      setText(newText);
    };

    const handlePickFiles = useCallback(async () => {
      if (!PresageModule) {
        return;
      }
      try {
        const paths: string[] = await PresageModule.pickFiles();
        if (paths && paths.length > 0) {
          addFilePaths(paths);
        }
      } catch {
        // ignore picker errors
      }
    }, [addFilePaths]);

    // Listen for paste events from native key monitor
    useEffect(() => {
      if (!commandEmitter || !PresageModule) return;

      const pasteSub = commandEmitter.addListener(
        'onPasteFiles',
        async (event: {hasFiles: boolean; hasImage: boolean}) => {
          try {
            if (event.hasFiles) {
              const paths: string[] = await PresageModule.getClipboardFiles();
              if (paths && paths.length > 0) {
                addFilePaths(paths);
              }
            } else if (event.hasImage) {
              const path: string | null =
                await PresageModule.getClipboardImage();
              if (path) {
                addFilePaths([path]);
              }
            }
          } catch {
            // ignore clipboard errors
          }
        },
      );

      return () => {
        pasteSub.remove();
      };
    }, [addFilePaths]);

    const hasContent = text.trim().length > 0 || attachments.length > 0;
    const hasAttachments = attachments.length > 0;

    return (
      <View style={styles.container}>
          <GlassView
            style={[
              styles.inputWrapper,
              hasAttachments && styles.inputWrapperExpanded,
            ]}
            cornerRadius={24}>
            {hasAttachments && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.previewRow}
                contentContainerStyle={styles.previewRowContent}>
                {attachments.map((attachment, index) => (
                  <View key={`${attachment.path}-${index}`} style={styles.previewItem}>
                    <View style={styles.previewThumb}>
                      {attachment.type === 'image' ? (
                        attachment.thumbnailPath ? (
                          <Image
                            source={{uri: `file://${attachment.thumbnailPath}`}}
                            style={styles.previewImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={[styles.previewImage, styles.filePlaceholder]}>
                            <Text style={styles.fileEmoji}>🖼</Text>
                          </View>
                        )
                      ) : attachment.type === 'video' ? (
                        <View style={styles.previewImage}>
                          {attachment.thumbnailPath ? (
                            <Image
                              source={{
                                uri: `file://${attachment.thumbnailPath}`,
                              }}
                              style={styles.previewImage}
                              resizeMode="cover"
                            />
                          ) : (
                            <View
                              style={[
                                styles.previewImage,
                                styles.filePlaceholder,
                              ]}>
                              <Text style={styles.fileEmoji}>🎥</Text>
                            </View>
                          )}
                          <View style={styles.playOverlay}>
                            <Text style={styles.playIcon}>▶</Text>
                          </View>
                        </View>
                      ) : (
                        <View style={styles.filePreview}>
                          {attachment.thumbnailPath ? (
                            <Image
                              source={{
                                uri: `file://${attachment.thumbnailPath}`,
                              }}
                              style={styles.fileIcon}
                              resizeMode="contain"
                            />
                          ) : (
                            <Text style={styles.fileEmoji}>📄</Text>
                          )}
                        </View>
                      )}
                    </View>
                    {attachment.type === 'file' && (
                      <Text
                        style={[
                          styles.fileName,
                          isDark && {color: '#CCCCCC'},
                        ]}
                        numberOfLines={1}>
                        {attachment.name}
                      </Text>
                    )}
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => removeAttachment(index)}>
                      <Text style={styles.removeIcon}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
            <TextInput
              ref={inputRef}
              style={[styles.input, isDark && {color: '#FFFFFF'}]}
              value={text}
              onChangeText={handleTextChange}
              placeholder="Signal Message"
              placeholderTextColor="#9e9e9e"
              multiline
              submitBehavior="submit"
              blurOnSubmit={false}
              onSubmitEditing={handleSend}
              editable={!disabled}
            />
          </GlassView>
          <GlassButton
            style={styles.sendButton}
            symbolName="plus"
            onPress={handlePickFiles}
            disabled={disabled}
          />
          <GlassButton
            style={styles.sendButton}
            symbolName="arrow.up"
            bezelColor="#007AFF"
            onPress={handleSend}
            disabled={disabled || !hasContent}
          />
        </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
  },
  inputWrapper: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    marginRight: 8,
  },
  inputWrapperExpanded: {
    maxHeight: 240,
    minHeight: 140,
  },
  input: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: 'transparent',
  },
  sendButton: {
    width: 40,
    height: 40,
    marginLeft: 4,
  },
  previewRow: {
    maxHeight: 100,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128, 128, 128, 0.3)',
  },
  previewRowContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  previewItem: {
    alignItems: 'center',
    width: 80,
  },
  previewThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(128, 128, 128, 0.1)',
  },
  previewImage: {
    width: 72,
    height: 72,
  },
  filePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(128, 128, 128, 0.15)',
  },
  filePreview: {
    width: 72,
    height: 72,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(128, 128, 128, 0.1)',
  },
  fileIcon: {
    width: 48,
    height: 48,
  },
  fileEmoji: {
    fontSize: 28,
  },
  fileName: {
    fontSize: 10,
    color: '#666666',
    marginTop: 2,
    textAlign: 'center',
    width: 72,
  },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  playIcon: {
    color: '#FFFFFF',
    fontSize: 24,
  },
  removeButton: {
    position: 'absolute',
    top: -4,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(128, 128, 128, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeIcon: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
});
