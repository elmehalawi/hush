import React from 'react';
import {requireNativeComponent, ViewStyle} from 'react-native';

interface GradientBlurViewProps {
  style?: ViewStyle;
}

const NativeGradientBlurView =
  requireNativeComponent<any>('GradientBlurView');

export function GradientBlurView({style}: GradientBlurViewProps) {
  return <NativeGradientBlurView style={style} />;
}
