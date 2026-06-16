import React, {useState, useCallback, useMemo, useRef} from 'react';
import {View, Text, Image, StyleSheet, Pressable, Animated} from 'react-native';
import {Attachment} from '../store/signalStore';
import {NativeSwipeGestureView} from './NativeSwipeGestureView';

const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;
const SWIPE_THRESHOLD = 40;
const SWIPE_OFF_DISTANCE = 350;

function getImageDimensions(attachment: Attachment) {
  const w = attachment.width || MAX_IMAGE_WIDTH;
  const h = attachment.height || MAX_IMAGE_WIDTH;
  const aspectRatio = w / h;

  let displayWidth = Math.min(w, MAX_IMAGE_WIDTH);
  let displayHeight = displayWidth / aspectRatio;

  if (displayHeight > MAX_IMAGE_HEIGHT) {
    displayHeight = MAX_IMAGE_HEIGHT;
    displayWidth = displayHeight * aspectRatio;
  }

  return {width: displayWidth, height: displayHeight};
}

function isVideoType(contentType: string) {
  return contentType.startsWith('video/');
}

// Stable pseudo-random rotations for the stack effect — larger range for visible messiness
const STACK_ROTATIONS = [-8, 5.5, -6, 9, -7, 4.5, -9.5, 6.5];

interface AlbumViewProps {
  attachments: Attachment[];
  isOutgoing: boolean;
  onPreview?: (filePath: string) => void;
}

export function AlbumView({attachments, isOutgoing, onPreview}: AlbumViewProps) {
  // The "order" array tracks which attachment index is at each visual position.
  // order[0] is the top of the stack (current), order[1] is one below, etc.
  const [order, setOrder] = useState(() => attachments.map((_, i) => i));

  const swipeX = useRef(new Animated.Value(0)).current;
  const swipeTriggered = useRef(false);
  const swipeEnded = useRef(false);

  // Use the current (top) item's dimensions for the stack frame
  const currentAttIdx = order[0];
  const stackDims = useMemo(() => {
    let maxW = 0;
    let maxH = 0;
    for (const att of attachments) {
      const d = getImageDimensions(att);
      if (d.width > maxW) maxW = d.width;
      if (d.height > maxH) maxH = d.height;
    }
    return {width: maxW, height: maxH};
  }, [attachments]);

  const handleSwipeUpdate = useCallback(
    (e: any) => {
      if (swipeEnded.current) return;
      const deltaX = e.nativeEvent.deltaX;
      // Allow swiping in both directions, apply slight dampening
      swipeX.setValue(deltaX * 0.8);
      if (Math.abs(deltaX) > SWIPE_THRESHOLD && !swipeTriggered.current) {
        swipeTriggered.current = true;
      }
    },
    [swipeX],
  );

  const handleSwipeEnd = useCallback(
    (e: any) => {
      swipeEnded.current = true;
      const deltaX = e?.nativeEvent?.deltaX ?? 0;

      if (swipeTriggered.current) {
        // Animate the top card off-screen in the swipe direction
        const direction = deltaX < 0 ? -1 : 1;
        Animated.timing(swipeX, {
          toValue: direction * SWIPE_OFF_DISTANCE,
          duration: 200,
          useNativeDriver: false,
        }).start(() => {
          // Move top item to bottom of stack (circular)
          if (direction < 0) {
            // Swipe left → send top to bottom, next becomes top
            setOrder(prev => [...prev.slice(1), prev[0]]);
          } else {
            // Swipe right → bring bottom to top
            setOrder(prev => [prev[prev.length - 1], ...prev.slice(0, -1)]);
          }
          swipeX.setValue(0);
          swipeTriggered.current = false;
          swipeEnded.current = false;
        });
      } else {
        // Spring back
        swipeTriggered.current = false;
        Animated.spring(swipeX, {
          toValue: 0,
          useNativeDriver: false,
          tension: 120,
          friction: 10,
        }).start(() => {
          swipeEnded.current = false;
        });
      }
    },
    [swipeX],
  );

  const handlePress = useCallback(
    (filePath: string) => {
      onPreview?.(filePath);
    },
    [onPreview],
  );

  // Derive a rotation from the swipe for a natural feel on the top card
  const topRotation = swipeX.interpolate({
    inputRange: [-SWIPE_OFF_DISTANCE, 0, SWIPE_OFF_DISTANCE],
    outputRange: ['-12deg', '0deg', '12deg'],
  });

  // Render items in reverse order so the first in the array (top of stack) paints last (on top)
  const visibleCount = Math.min(order.length, 3);

  const pageLabel = (
    <Text style={styles.pageIndicator}>
      {order[0] + 1} of {attachments.length}
    </Text>
  );

  return (
    <View style={styles.container}>
      {isOutgoing && pageLabel}
      <NativeSwipeGestureView
        onSwipeUpdate={handleSwipeUpdate}
        onSwipeEnd={handleSwipeEnd}
        style={[styles.stack, {width: stackDims.width, height: stackDims.height}]}>
        {/* Render bottom-to-top so the top card paints last */}
        {order.slice(0, visibleCount).reverse().map((attIdx, renderIdx) => {
          const stackPos = visibleCount - 1 - renderIdx; // 0 = top, 1 = one below, etc.
          const att = attachments[attIdx];
          const dims = getImageDimensions(att);
          const isTop = stackPos === 0;

          // Stack positioning: cards below are slightly rotated and offset
          const stackRotation = isTop ? 0 : STACK_ROTATIONS[attIdx % STACK_ROTATIONS.length];
          const stackOffsetX = isTop ? 0 : stackRotation * 1.2;
          const stackOffsetY = isTop ? 0 : -stackPos * 2;

          const thumbUri = isVideoType(att.contentType)
            ? att.thumbnailPath
              ? `file://${att.thumbnailPath}`
              : undefined
            : att.filePath
            ? `file://${att.filePath}`
            : undefined;

          const cardContent = (
            <>
              {thumbUri ? (
                <Image
                  source={{uri: thumbUri}}
                  style={[styles.image, {width: dims.width, height: dims.height}]}
                  resizeMode="cover"
                />
              ) : (
                <View style={[styles.placeholder, {width: dims.width, height: dims.height}]} />
              )}
              {isVideoType(att.contentType) && isTop && (
                <View style={styles.playOverlay}>
                  <View style={styles.playButton}>
                    <Text style={styles.playIcon}>{'\u25B6'}</Text>
                  </View>
                </View>
              )}
            </>
          );

          return (
            <Animated.View
              key={attIdx}
              style={[
                styles.item,
                {
                  width: dims.width,
                  height: dims.height,
                  zIndex: isTop ? 10 : 10 - stackPos,
                  opacity: isTop ? 1 : 0.85,
                  left: (stackDims.width - dims.width) / 2 + stackOffsetX,
                  top: (stackDims.height - dims.height) / 2 + stackOffsetY,
                  transform: isTop
                    ? [{translateX: swipeX}, {rotate: topRotation}]
                    : [{rotate: `${stackRotation}deg`}],
                },
              ]}>
              {isTop ? (
                <Pressable
                  onPress={() => att.filePath && handlePress(att.filePath)}
                  style={{width: dims.width, height: dims.height}}>
                  {cardContent}
                </Pressable>
              ) : (
                cardContent
              )}
            </Animated.View>
          );
        })}
      </NativeSwipeGestureView>
      {!isOutgoing && pageLabel}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stack: {
    position: 'relative',
  },
  item: {
    position: 'absolute',
    borderRadius: 17,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0, 0, 0, 0.15)',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  image: {
    borderRadius: 17,
  },
  placeholder: {
    borderRadius: 17,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    color: 'white',
    fontSize: 18,
    marginLeft: 3,
  },
  pageIndicator: {
    fontSize: 11,
    color: '#8E8E93',
    marginHorizontal: 14,
  },
});
