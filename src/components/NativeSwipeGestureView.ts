import {requireNativeComponent, Animated} from 'react-native';

export const NativeSwipeGestureView = requireNativeComponent<any>('SwipeGestureView');
export const AnimatedSwipeGestureView = Animated.createAnimatedComponent(NativeSwipeGestureView);
