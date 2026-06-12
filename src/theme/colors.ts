import {useColorScheme} from 'react-native';

const lightColors = {
  label: '#212121',
  secondaryLabel: '#757575',
  tertiaryLabel: '#9e9e9e',
  separator: 'rgba(0,0,0,0.1)',
  incomingBubble: '#E9E9EB',
  incomingBody: '#212121',
  sidebarBackground: '#F5F5F5',
  sidebarSeparator: 'rgba(0,0,0,0.12)',
  sidebarSelected: 'rgba(0,0,0,0.08)',
  searchFieldBackground: 'rgba(0,0,0,0.06)',
};

const darkColors: typeof lightColors = {
  label: '#EBEBF0',
  secondaryLabel: '#EBEBF099',
  tertiaryLabel: '#EBEBF04D',
  separator: 'rgba(255,255,255,0.1)',
  incomingBubble: '#3A3A3D',
  incomingBody: '#EBEBF0',
  sidebarBackground: '#2B2B2B',
  sidebarSeparator: 'rgba(255,255,255,0.12)',
  sidebarSelected: 'rgba(255,255,255,0.10)',
  searchFieldBackground: 'rgba(255,255,255,0.08)',
};

export function useColors() {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkColors : lightColors;
}
