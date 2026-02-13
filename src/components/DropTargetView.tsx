import React from 'react';
import {requireNativeComponent, ViewStyle} from 'react-native';

interface NativeDropTargetViewProps {
  style?: ViewStyle;
  children?: React.ReactNode;
  onFileDrop?: (event: {nativeEvent: {paths: string[]}}) => void;
}

const NativeDropTargetView =
  requireNativeComponent<NativeDropTargetViewProps>('DropTargetView');

interface DropTargetViewProps {
  style?: ViewStyle;
  children?: React.ReactNode;
  onFileDrop?: (paths: string[]) => void;
}

export function DropTargetView({
  style,
  children,
  onFileDrop,
}: DropTargetViewProps) {
  return (
    <NativeDropTargetView
      style={style}
      onFileDrop={
        onFileDrop
          ? (event: {nativeEvent: {paths: string[]}}) =>
              onFileDrop(event.nativeEvent.paths)
          : undefined
      }>
      {children}
    </NativeDropTargetView>
  );
}
