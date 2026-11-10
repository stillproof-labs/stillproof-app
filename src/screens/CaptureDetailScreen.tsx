import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { deleteCapture, photoFile, receiptFile, submit, useCaptures } from '../captures';
import { Hash } from '../components/Fingerprint';
import { PrintFrame } from '../components/PrintFrame';
import { ProofStrip } from '../components/ProofStrip';
import { Blank, Body, Button, EdgeLabel, ErrorText, Field, Rule, Screen } from '../components/ui';
import { edge, edgeTime, frameNumber } from '../design/format';
import type { ScreenProps } from '../navigation';
import { parseSignedClaim } from '../protocol/claim';
import { KEY_LEVEL, formatCaptured, horizonFetchTx, parseReceipt, verifyReceipt, type Receipt, type Verdict } from '../protocol/receipt';
import { space } from '../theme';

export default function CaptureDetailScreen({ route, navigation }: ScreenProps<'Detail'>) {
  const captures = useCaptures();
  const index = captures.findIndex((x) => x.id === route.params.id);
  const capture = captures[index];
  const [receipt, setReceipt] = useState<Receipt>();
  const [verdict, setVerdict] = useState<Verdict>();
  const [verifyError, setVerifyError] = useState<string>();
  const [shareError, setShareError] = useState<string>();
  const anchored = capture?.status === 'anchored';

  useEffect(() => {
    if (!capture || !anchored) return;
    let live = true;
    (async () => {
      const bytes = await photoFile(capture).bytes();
      const r = parseReceipt(await receiptFile(capture).text());
      if (live) setReceipt(r);
      const v = await verifyReceipt(bytes, r, horizonFetchTx());
      if (live) setVerdict(v);
    })().catch((e) => live && setVerifyError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // Re-verify only when the capture becomes anchored, not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture?.id, anchored]);

  if (!capture) {
    return (
      <Blank>
        <ErrorText>This frame no longer exists.</ErrorText>
      </Blank>
    );
  }

  const frame = frameNumber(captures.length - index);
  const time = edgeTime(Number(capture.captured)) ?? formatCaptured(BigInt(capture.captured));
  const fileHash = parseSignedClaim(capture.signed).sha256;

  const share = async (uri: string, mimeType: string) => {
    setShareError(undefined);
    try {
      await Sharing.shareAsync(uri, { mimeType });
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Screen>
      <PrintFrame
        uri={photoFile(capture).uri}
        label={`Frame ${frame}, the captured photo`}
        edge={edge(`Frame ${frame}`, time, receipt && `Ledger ${receipt.anchor.ledger}`)}
      />

      {capture.status === 'pending' && (
        <View style={styles.block}>
          <EdgeLabel>Pending</EdgeLabel>
          <Body>Signed on this phone. Waiting for the service to anchor the claim on Stellar.</Body>
        </View>
      )}
      {capture.status === 'failed' && (
        <View style={styles.block}>
          <EdgeLabel>Not anchored</EdgeLabel>
          {capture.error && <ErrorText>{capture.error}</ErrorText>}
          <Button primary title="Submit again" label="Submit the claim again" onPress={() => void submit(capture)} />
        </View>
      )}
      {anchored && !verifyError && <ProofStrip verdict={verdict ?? 'checking'} />}
      {verifyError && <ErrorText>Could not check the receipt: {verifyError}</ErrorText>}

      <Rule />
      <Hash label="File SHA-256" sha256={fileHash} />
      <Hash label="Claim id" sha256={capture.id} />
      <Field label="Device clock at capture" value={time} />
      {!anchored && <Field label="Key level" value={KEY_LEVEL} />}

      <Rule />
      <View style={styles.block}>
        <Button title="Share photo" onPress={() => void share(photoFile(capture).uri, capture.type)} />
        {anchored && (
          <Button title="Share receipt" onPress={() => void share(receiptFile(capture).uri, 'application/json')} />
        )}
        {anchored && <Body muted>Send both files. The receipt only verifies with the original photo.</Body>}
        {shareError && <ErrorText>Could not share: {shareError}</ErrorText>}
      </View>

      <Rule />
      <Button
        title="Delete"
        label="Delete frame"
        onPress={() =>
          Alert.alert(
            'Delete frame',
            'This removes the photo and any receipt from this phone only. It never contacts the anchoring service, so any anchored hash stays on Stellar. The receipt will not verify without this exact photo — consider sharing both files first.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  deleteCapture(capture.id);
                  navigation.goBack();
                },
              },
            ],
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: space[2] },
});
