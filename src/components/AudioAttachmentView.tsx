import React, {useState, useEffect, useRef, useCallback} from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  NativeModules,
  NativeEventEmitter,
  useColorScheme,
} from 'react-native';

const {PresageModule} = NativeModules;
const emitter = new NativeEventEmitter(PresageModule);

const MACOS_BLUE = '#007AFF';

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface AudioAttachmentViewProps {
  filePath: string;
  isOutgoing: boolean;
}

export function AudioAttachmentView({filePath, isOutgoing}: AudioAttachmentViewProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const barRef = useRef<View>(null);
  const barWidthRef = useRef(0);

  useEffect(() => {
    PresageModule.getAudioDuration(filePath)
      .then((dur: number) => setDuration(dur))
      .catch(() => {});
  }, [filePath]);

  useEffect(() => {
    const progressSub = emitter.addListener('onAudioProgress', (event: any) => {
      if (event.filePath !== filePath) return;
      setCurrentTime(event.currentTime);
      setDuration(event.duration);
      setPlaying(true);
    });

    const completeSub = emitter.addListener('onAudioComplete', (event: any) => {
      if (event.filePath !== filePath) return;
      setPlaying(false);
      setCurrentTime(0);
    });

    return () => {
      progressSub.remove();
      completeSub.remove();
    };
  }, [filePath]);

  const handlePlayPause = useCallback(() => {
    if (playing) {
      PresageModule.pauseAudio();
      setPlaying(false);
    } else {
      PresageModule.playAudio(filePath)
        .then((result: any) => {
          if (result) {
            setDuration(result.duration);
            setCurrentTime(result.currentTime);
          }
          setPlaying(true);
        })
        .catch(() => {});
    }
  }, [playing, filePath]);

  const handleSeek = useCallback(
    (event: any) => {
      const locationX = event.nativeEvent.locationX;
      if (barWidthRef.current > 0 && duration > 0) {
        const position = Math.max(0, Math.min(1, locationX / barWidthRef.current));
        PresageModule.seekAudio(position).catch(() => {});
        setCurrentTime(position * duration);
      }
    },
    [duration],
  );

  const progress = duration > 0 ? currentTime / duration : 0;
  const displayTime = playing ? formatTime(currentTime) : formatTime(duration);

  const glassBg = isOutgoing
    ? 'rgba(255, 255, 255, 0.12)'
    : isDark
      ? 'rgba(255, 255, 255, 0.08)'
      : 'rgba(0, 0, 0, 0.04)';
  const glassBorder = isOutgoing
    ? 'rgba(255, 255, 255, 0.2)'
    : isDark
      ? 'rgba(255, 255, 255, 0.1)'
      : 'rgba(0, 0, 0, 0.06)';
  const trackBg = isOutgoing
    ? 'rgba(255, 255, 255, 0.15)'
    : isDark
      ? 'rgba(255, 255, 255, 0.1)'
      : 'rgba(0, 0, 0, 0.06)';
  const trackFillColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.7)'
    : 'rgba(255, 255, 255, 0.85)';
  const trackBorderColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.25)'
    : isDark
      ? 'rgba(255, 255, 255, 0.12)'
      : 'rgba(0, 0, 0, 0.08)';
  const textColor = isOutgoing ? 'rgba(255, 255, 255, 0.8)' : MACOS_BLUE;
  const buttonColor = isOutgoing ? 'white' : MACOS_BLUE;

  return (
    <View style={[styles.container, {backgroundColor: glassBg, borderColor: glassBorder}]}>
      <Pressable onPress={handlePlayPause} style={styles.playButton}>
        <Text style={[styles.playIcon, {color: buttonColor}]}>
          {playing ? '\u23F8' : '\u25B6'}
        </Text>
      </Pressable>
      <View style={styles.trackArea}>
        <Pressable onPress={handleSeek} style={styles.trackPressable}>
          <View
            ref={barRef}
            onLayout={(e) => {
              barWidthRef.current = e.nativeEvent.layout.width;
            }}
            style={[styles.track, {backgroundColor: trackBg, borderColor: trackBorderColor}]}
          >
            <View
              style={[
                styles.trackFill,
                {width: `${progress * 100}%`, backgroundColor: trackFillColor},
              ]}
            />
          </View>
        </Pressable>
        <Text style={[styles.timeLabel, {color: textColor}]}>{displayTime}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 200,
    maxWidth: 260,
  },
  playButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  playIcon: {
    fontSize: 14,
  },
  trackArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  trackPressable: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  track: {
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  trackFill: {
    height: '100%',
    borderRadius: 1.5,
  },
  timeLabel: {
    fontSize: 10,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    minWidth: 28,
    textAlign: 'right',
  },
});
