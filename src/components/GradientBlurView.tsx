import React from 'react';
import {requireNativeComponent, ViewStyle} from 'react-native';

interface GradientBlurViewProps {
  style?: ViewStyle;
  blurRadius?: number;
}

const NativeGradientBlurView =
  requireNativeComponent<any>('GradientBlurView');

export function GradientBlurView({style, blurRadius}: GradientBlurViewProps) {
  return <NativeGradientBlurView style={style} blurRadius={blurRadius} />;
}
