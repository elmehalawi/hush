import React, {useState, useCallback, useMemo, useRef, useImperativeHandle, forwardRef} from 'react';
import {View, Text, Image, StyleSheet, Pressable, Animated} from 'react-native';
import {Attachment} from '../store/signalStore';

const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;
const SWIPE_THRESHOLD = 50;

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

// Stable pseudo-random rotations for the stack effect
const STACK_ROTATIONS = [-8, 5.5, -6, 9, -7, 4.5, -9.5, 6.5];

export interface AlbumViewHandle {
  onSwipeUpdate: (deltaX: number) => void;
  onSwipeEnd: (deltaX: number) => void;
}

interface AlbumViewProps {
  attachments: Attachment[];
  isOutgoing: boolean;
  onPreview?: (filePath: string) => void;
}

export const AlbumView = forwardRef<AlbumViewHandle, AlbumViewProps>(
  function AlbumView({attachments, isOutgoing, onPreview}, ref) {
    // order[0] = top of stack (current), order[1] = one below, etc.
    const [order, setOrder] = useState(() => attachments.map((_, i) => i));

    // Tracks the top card's horizontal position — 1:1 with finger
    const swipeX = useRef(new Animated.Value(0)).current;
    // Tracks the departing card's "return to stack" animation (0 = off-screen, 1 = settled in stack)
    const returnAnim = useRef(new Animated.Value(1)).current;
    const departingIdx = useRef<number | null>(null);
    const animating = useRef(false);
    const orderRef = useRef(order);
    orderRef.current = order;

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

    useImperativeHandle(ref, () => ({
      onSwipeUpdate(deltaX: number) {
        if (animating.current) return;
        swipeX.setValue(deltaX);
      },
      onSwipeEnd(deltaX: number) {
        if (animating.current) return;

        if (Math.abs(deltaX) > SWIPE_THRESHOLD) {
          animating.current = true;
          const direction = deltaX < 0 ? -1 : 1;
          const offScreenX = direction * (stackDims.width + 80);

          // Phase 1: slide the top card off-screen
          Animated.timing(swipeX, {
            toValue: offScreenX,
            duration: 180,
            useNativeDriver: false,
          }).start(() => {
            const currentOrder = orderRef.current;
            const departingAttIdx = currentOrder[0];
            let newOrder: number[];
            if (direction < 0) {
              // Swipe left → send top to bottom, next becomes top
              newOrder = [...currentOrder.slice(1), currentOrder[0]];
            } else {
              // Swipe right → bring bottom to top
              newOrder = [currentOrder[currentOrder.length - 1], ...currentOrder.slice(0, -1)];
            }

            // Set up rubber-band return for the departing card
            departingIdx.current = departingAttIdx;
            returnAnim.setValue(0);
            swipeX.setValue(0);
            setOrder(newOrder);

            // Phase 2: departing card shrinks and slides into its stack position
            Animated.spring(returnAnim, {
              toValue: 1,
              useNativeDriver: false,
              tension: 80,
              friction: 10,
            }).start(() => {
              departingIdx.current = null;
              animating.current = false;
            });
          });
        } else {
          // Below threshold — spring back
          Animated.spring(swipeX, {
            toValue: 0,
            useNativeDriver: false,
            tension: 200,
            friction: 15,
          }).start();
        }
      },
    }), [swipeX, returnAnim, stackDims.width]);

    const handlePress = useCallback(
      (filePath: string) => {
        onPreview?.(filePath);
      },
      [onPreview],
    );

    // Top card rotation follows the swipe — subtle tilt
    const topRotation = swipeX.interpolate({
      inputRange: [-(stackDims.width + 80), 0, stackDims.width + 80],
      outputRange: ['-8deg', '0deg', '8deg'],
    });

    // As top card moves away, the next card underneath straightens and scales up
    const absSwipe = swipeX.interpolate({
      inputRange: [-(stackDims.width + 80), 0, stackDims.width + 80],
      outputRange: [1, 0, 1],
      extrapolate: 'clamp',
    });

    const visibleCount = Math.min(order.length, 3);

    const pageLabel = (
      <Text style={styles.pageIndicator}>
        {order[0] + 1} of {attachments.length}
      </Text>
    );

    return (
      <View style={styles.container}>
        {isOutgoing && pageLabel}
        <View style={[styles.stack, {width: stackDims.width, height: stackDims.height}]}>
          {/* Render bottom-to-top so the top card paints last */}
          {order.slice(0, visibleCount).reverse().map((attIdx, renderIdx) => {
            const stackPos = visibleCount - 1 - renderIdx; // 0 = top, 1 = one below, etc.
            const att = attachments[attIdx];
            const dims = getImageDimensions(att);
            const isTop = stackPos === 0;
            const isDeparting = attIdx === departingIdx.current;

            // Stack positioning: cards below are rotated and offset
            const baseRotation = STACK_ROTATIONS[attIdx % STACK_ROTATIONS.length];
            const stackOffsetX = isTop ? 0 : baseRotation * 1.2;
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

            // Card that just got swiped away — rubber-banding back into the stack
            if (isDeparting) {
              const departScale = returnAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.88, 1],
              });
              const departRotation = returnAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', `${baseRotation}deg`],
              });
              const departOffsetX = returnAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, stackOffsetX],
              });

              return (
                <Animated.View
                  key={attIdx}
                  style={[
                    styles.item,
                    {
                      width: dims.width,
                      height: dims.height,
                      zIndex: 1,
                      opacity: 0.85,
                      left: (stackDims.width - dims.width) / 2,
                      top: (stackDims.height - dims.height) / 2,
                      transform: [
                        {translateX: departOffsetX},
                        {rotate: departRotation},
                        {scale: departScale},
                      ],
                    },
                  ]}>
                  {cardContent}
                </Animated.View>
              );
            }

            // Card directly behind the top — straightens as top card moves away
            if (stackPos === 1) {
              const nextRotation = Animated.multiply(
                absSwipe,
                -1,
              ).interpolate({
                inputRange: [-1, 0],
                outputRange: [`${baseRotation}deg`, '0deg'],
                extrapolate: 'clamp',
              });
              const nextScale = absSwipe.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 0.97],
                extrapolate: 'clamp',
              });

              return (
                <Animated.View
                  key={attIdx}
                  style={[
                    styles.item,
                    {
                      width: dims.width,
                      height: dims.height,
                      zIndex: 10 - stackPos,
                      opacity: 0.85,
                      left: (stackDims.width - dims.width) / 2 + stackOffsetX,
                      top: (stackDims.height - dims.height) / 2 + stackOffsetY,
                      transform: [
                        {rotate: nextRotation},
                        {scale: nextScale},
                      ],
                    },
                  ]}>
                  {cardContent}
                </Animated.View>
              );
            }

            // Top card — follows finger 1:1
            if (isTop) {
              return (
                <Animated.View
                  key={attIdx}
                  style={[
                    styles.item,
                    {
                      width: dims.width,
                      height: dims.height,
                      zIndex: 10,
                      left: (stackDims.width - dims.width) / 2,
                      top: (stackDims.height - dims.height) / 2,
                      transform: [
                        {translateX: swipeX},
                        {rotate: topRotation},
                      ],
                    },
                  ]}>
                  <Pressable
                    onPress={() => att.filePath && handlePress(att.filePath)}
                    style={{width: dims.width, height: dims.height}}>
                    {cardContent}
                  </Pressable>
                </Animated.View>
              );
            }

            // Other stack cards — static
            return (
              <Animated.View
                key={attIdx}
                style={[
                  styles.item,
                  {
                    width: dims.width,
                    height: dims.height,
                    zIndex: 10 - stackPos,
                    opacity: 0.85,
                    left: (stackDims.width - dims.width) / 2 + stackOffsetX,
                    top: (stackDims.height - dims.height) / 2 + stackOffsetY,
                    transform: [{rotate: `${baseRotation}deg`}],
                  },
                ]}>
                {cardContent}
              </Animated.View>
            );
          })}
        </View>
        {!isOutgoing && pageLabel}
      </View>
    );
  },
);

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
