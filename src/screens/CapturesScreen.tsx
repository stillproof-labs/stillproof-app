import { useEffect, useLayoutEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { photoFile, pollPending, useCaptures, type Capture } from '../captures';
import { ContactSheet } from '../components/ContactSheet';
import { Body, Button, EdgeLabel, Rule } from '../components/ui';
import { NETWORK, POLL_MS } from '../config';
import { edge, edgeTime, frameNumber } from '../design/format';
import type { ScreenProps } from '../navigation';
import { space, useTheme } from '../theme';

const STATUS: Record<Capture['status'], string> = {
  queued: 'queued, waiting for connection',
  pending: 'pending, waiting for the anchor',
  anchored: 'anchored',
  failed: 'failed',
};

export default function CapturesScreen({ navigation }: ScreenProps<'Captures'>) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const captures = useCaptures();
  const anyPending = captures.some((x) => x.status === 'pending');
  const counts = { queued: 0, pending: 0, anchored: 0, failed: 0 };
  captures.forEach((x) => counts[x.status]++);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Device key and anchoring service"
          onPress={() => navigation.navigate('Key')}
          hitSlop={12}
        >
          <EdgeLabel style={{ color: c.text }}>Key · Service</EdgeLabel>
        </Pressable>
      ),
    });
  }, [navigation, c.text]);

  useEffect(() => {
    if (!anyPending) return;
    void pollPending();
    const timer = setInterval(() => void pollPending(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyPending]);

  const frames = captures.map((x, i) => {
    const frame = frameNumber(captures.length - i);
    const time = edgeTime(Number(x.captured)) ?? 'unknown time';
    return {
      key: x.id,
      uri: photoFile(x).uri,
      frame,
      status: x.status,
      label: `Frame ${frame}, ${STATUS[x.status]}, device clock ${time}`,
      onPress: () => navigation.navigate('Detail', { id: x.id }),
    };
  });

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <EdgeLabel>
          {edge(
            `${captures.length} ${captures.length === 1 ? 'frame' : 'frames'}`,
            counts.anchored > 0 && `${counts.anchored} anchored`,
            counts.pending > 0 && `${counts.pending} pending`,
            counts.queued > 0 && `${counts.queued} queued`,
            counts.failed > 0 && `${counts.failed} failed`,
            NETWORK,
          )}
        </EdgeLabel>
        {captures.length === 0 ? (
          <View style={styles.empty}>
            <Body>No frames yet.</Body>
            <Body muted>
              Each photo you take here is signed on this phone and its hash is anchored on Stellar. The photo stays on
              the phone.
            </Body>
          </View>
        ) : (
          <ContactSheet frames={frames} />
        )}
      </ScrollView>
      <Rule />
      <View style={[styles.bar, { paddingBottom: insets.bottom + space[3] }]}>
        <View style={styles.flex}>
          <Button title="Check a photo" onPress={() => navigation.navigate('Verify')} />
        </View>
        <View style={styles.flex}>
          <Button primary title="Capture" label="Capture a photo" onPress={() => navigation.navigate('Capture')} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space[4], gap: space[4] },
  empty: { gap: space[3], paddingVertical: space[6] },
  bar: { flexDirection: 'row', gap: space[2], paddingHorizontal: space[4], paddingTop: space[3] },
  flex: { flex: 1 },
});
