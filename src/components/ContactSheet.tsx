import { Image, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { hairline, space, useTheme } from '../theme';
import { EdgeLabel } from './ui';

export type SheetStatus = 'queued' | 'pending' | 'anchored' | 'failed';

export type SheetFrame = {
  key: string;
  uri: string;
  /** "014" */
  frame: string;
  status: SheetStatus;
  /** Accessibility label for the frame. */
  label: string;
  onPress: () => void;
};

const COLUMNS = 3;
const GAP = space[2];

/** The capture list: three columns of square thumbnails, each with a frame number and status dot. */
export function ContactSheet({ frames }: { frames: SheetFrame[] }) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const side = Math.floor((width - 2 * space[4] - (COLUMNS - 1) * GAP) / COLUMNS);
  const dot: Record<SheetStatus, string> = { queued: c.muted, pending: c.safelight, anchored: c.ok, failed: c.fail };
  return (
    <View style={styles.sheet}>
      {frames.map((f) => (
        <Pressable
          key={f.key}
          accessibilityRole="button"
          accessibilityLabel={f.label}
          onPress={f.onPress}
          style={({ pressed }) => [{ width: side }, pressed && styles.pressed]}
        >
          <Image
            source={{ uri: f.uri }}
            style={[styles.thumb, { width: side, height: side, borderColor: c.line, backgroundColor: c.surface }]}
          />
          <View style={styles.edge}>
            <EdgeLabel>{f.frame}</EdgeLabel>
            <View style={[styles.dot, { backgroundColor: dot[f.status] }]} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, rowGap: space[3] },
  thumb: { borderWidth: hairline },
  edge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space[1] },
  // Square, not round: the shutter is the only round element.
  dot: { width: 6, height: 6, borderRadius: 1 },
  pressed: { opacity: 0.7 },
});
