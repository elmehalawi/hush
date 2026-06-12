import React, {useState, useEffect, useRef, useCallback, useMemo} from 'react';
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

const BAR_COUNT = 26;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_MIN_HEIGHT = 3;
const BAR_MAX_HEIGHT = 16;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Generate consistent waveform heights from a file path
function generateWaveform(filePath: string): number[] {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) - hash + filePath.charCodeAt(i)) | 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    // Simple LCG-style PRNG seeded from the hash
    hash = (hash * 1103515245 + 12345) | 0;
    const t = ((hash >>> 16) & 0x7fff) / 0x7fff;
    // Shape it so the middle bars tend to be taller (bell-ish curve)
    const center = BAR_COUNT / 2;
    const dist = Math.abs(i - center) / center;
    const envelope = 1 - dist * 0.4;
    const height = BAR_MIN_HEIGHT + (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * t * envelope;
    bars.push(Math.round(height));
  }
  return bars;
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
  const [transcription, setTranscription] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const waveformRef = useRef<View>(null);
  const waveformWidthRef = useRef(0);

  const waveform = useMemo(() => generateWaveform(filePath), [filePath]);

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
      if (waveformWidthRef.current > 0 && duration > 0) {
        const position = Math.max(0, Math.min(1, locationX / waveformWidthRef.current));
        PresageModule.seekAudio(position).catch(() => {});
        setCurrentTime(position * duration);
      }
    },
    [duration],
  );

  const handleTranscribe = useCallback(() => {
    if (transcription || transcribing) return;
    setTranscribing(true);
    setTranscriptionError(null);
    PresageModule.transcribeAudio(filePath)
      .then((result: any) => {
        setTranscription(result.text);
        setTranscribing(false);
      })
      .catch((err: any) => {
        setTranscriptionError(err?.message || 'Transcription failed');
        setTranscribing(false);
      });
  }, [filePath, transcription, transcribing]);

  const progress = duration > 0 ? currentTime / duration : 0;
  const displayTime = playing ? formatTime(currentTime) : formatTime(duration);
  const playedBars = Math.floor(progress * BAR_COUNT);

  // Bubble colors matching the message bubbles
  const bubbleBg = isOutgoing
    ? (isDark ? '#2E6FA3' : '#3A9DF5')
    : (isDark ? '#3A3A3D' : '#E9E9EB');

  // Bar colors
  const playedBarColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.9)'
    : (isDark ? '#EBEBF0' : '#212121');
  const unplayedBarColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.35)'
    : (isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.15)');

  // Play button
  const playBtnBg = isOutgoing
    ? 'rgba(255, 255, 255, 0.2)'
    : (isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.07)');
  const playIconColor = isOutgoing
    ? '#FFFFFF'
    : (isDark ? '#EBEBF0' : '#212121');

  // Time color
  const timeColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.7)'
    : (isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)');

  // Transcribe button color
  const transcribeBtnColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.6)'
    : (isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.3)');

  // Transcription text color
  const transcriptionTextColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.9)'
    : (isDark ? '#EBEBF0' : '#1C1C1E');

  return (
    <View style={[styles.bubble, {backgroundColor: bubbleBg}, isOutgoing ? styles.bubbleOutgoing : styles.bubbleIncoming]}>
      <View style={styles.topRow}>
        <Pressable onPress={handlePlayPause} style={[styles.playButton, {backgroundColor: playBtnBg}]}>
          <Text style={[styles.playIcon, {color: playIconColor}]}>
            {playing ? '\u23F8' : '\u25B6'}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleSeek}
          style={styles.waveformPressable}
        >
          <View
            ref={waveformRef}
            onLayout={(e) => {
              waveformWidthRef.current = e.nativeEvent.layout.width;
            }}
            style={styles.waveformContainer}
          >
            {waveform.map((height, i) => (
              <View
                key={i}
                style={[
                  styles.bar,
                  {
                    height,
                    backgroundColor: i < playedBars ? playedBarColor : unplayedBarColor,
                  },
                ]}
              />
            ))}
          </View>
        </Pressable>
        <Text style={[styles.timeLabel, {color: timeColor}]}>{displayTime}</Text>
        <Pressable
          onPress={handleTranscribe}
          style={[styles.transcribeButton, transcription ? styles.transcribeButtonActive : null]}
          disabled={transcribing}
        >
          <Text style={[styles.transcribeButtonText, {color: transcribeBtnColor}, transcription ? {opacity: 1} : null]}>
            {transcribing ? '\u2026' : 'Aa'}
          </Text>
        </Pressable>
      </View>
      {transcription ? (
        <View style={[styles.transcriptionContainer, {borderTopColor: isOutgoing ? 'rgba(255,255,255,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)')}]}>
          <Text style={[styles.transcriptionText, {color: transcriptionTextColor}]}>{transcription}</Text>
        </View>
      ) : null}
      {transcriptionError ? (
        <View style={styles.transcriptionContainer}>
          <Text style={[styles.transcriptionText, {color: 'rgba(255,59,48,0.8)', fontSize: 11}]}>{transcriptionError}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    flexDirection: 'column',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 18,
    minWidth: 220,
    maxWidth: 300,
  },
  bubbleOutgoing: {
    borderBottomRightRadius: 4,
  },
  bubbleIncoming: {
    borderBottomLeftRadius: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    fontSize: 13,
    marginLeft: 1,
  },
  waveformPressable: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 4,
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
    height: BAR_MAX_HEIGHT,
    overflow: 'hidden',
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: 1.5,
  },
  timeLabel: {
    fontSize: 11,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    minWidth: 30,
    textAlign: 'right',
  },
  transcribeButton: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transcribeButtonActive: {
    opacity: 0.7,
  },
  transcribeButtonText: {
    fontSize: 11,
    fontWeight: '600',
  },
  transcriptionContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  transcriptionText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
