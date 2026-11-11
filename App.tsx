// Per-weight imports, so only these five files are bundled.
import { FragmentMono_400Regular } from '@expo-google-fonts/fragment-mono/400Regular';
import { Gloock_400Regular } from '@expo-google-fonts/gloock/400Regular';
import { SchibstedGrotesk_400Regular } from '@expo-google-fonts/schibsted-grotesk/400Regular';
import { SchibstedGrotesk_500Medium } from '@expo-google-fonts/schibsted-grotesk/500Medium';
import { SchibstedGrotesk_700Bold } from '@expo-google-fonts/schibsted-grotesk/700Bold';
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useCaptureSync } from './src/captures';
import { Header } from './src/components/Header';
import type { RootStackParamList } from './src/navigation';
import CaptureDetailScreen from './src/screens/CaptureDetailScreen';
import CaptureScreen from './src/screens/CaptureScreen';
import CapturesScreen from './src/screens/CapturesScreen';
import KeyScreen from './src/screens/KeyScreen';
import VerifyScreen from './src/screens/VerifyScreen';
import { fonts, useTheme } from './src/theme';

void SplashScreen.preventAutoHideAsync();

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [loaded, error] = useFonts({
    Gloock_400Regular,
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_700Bold,
    FragmentMono_400Regular,
  });
  const { scheme, c } = useTheme();
  useCaptureSync();

  // Hold the splash until the fonts load; on a load error, carry on with system fonts.
  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);
  if (!loaded && !error) return null;

  const base = scheme === 'print' ? DefaultTheme : DarkTheme;
  const navTheme: Theme = {
    ...base,
    dark: scheme === 'darkroom',
    colors: { ...base.colors, primary: c.text, background: c.bg, card: c.bg, text: c.text, border: c.line, notification: c.safelight },
    fonts: {
      regular: { fontFamily: fonts.text, fontWeight: '400' },
      medium: { fontFamily: fonts.textMedium, fontWeight: '500' },
      bold: { fontFamily: fonts.textBold, fontWeight: '700' },
      heavy: { fontFamily: fonts.textBold, fontWeight: '700' },
    },
  };

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{ header: (props) => <Header {...props} />, contentStyle: { backgroundColor: c.bg }, animation: 'fade' }}
        >
          <Stack.Screen name="Captures" component={CapturesScreen} options={{ title: 'Contact sheet' }} />
          <Stack.Screen name="Capture" component={CaptureScreen} options={{ headerShown: false, animation: 'fade_from_bottom' }} />
          <Stack.Screen name="Detail" component={CaptureDetailScreen} options={{ title: 'Frame' }} />
          <Stack.Screen name="Verify" component={VerifyScreen} options={{ title: 'Check a photo' }} />
          <Stack.Screen name="Key" component={KeyScreen} options={{ title: 'Key and service' }} />
        </Stack.Navigator>
        <StatusBar style={scheme === 'print' ? 'dark' : 'light'} />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
