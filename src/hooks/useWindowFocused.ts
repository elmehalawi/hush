import {useState, useEffect} from 'react';
import {AppState} from 'react-native';

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      setFocused(state === 'active');
    });
    return () => sub.remove();
  }, []);

  return focused;
}
