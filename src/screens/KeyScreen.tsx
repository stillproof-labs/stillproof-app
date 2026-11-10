import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { useCaptures } from '../captures';
import { AnchorSetting } from '../components/AnchorSetting';
import { Blank, Body, Busy, Button, EdgeLabel, ErrorText, Field, Rule, Screen } from '../components/ui';
import { NETWORK } from '../config';
import { pickAndExportCaptures, type ExportProgress, type ExportSummary } from '../export';
import { deviceKey, newKey, retryRegistration, type DeviceKey, type Registration } from '../keys';

const registrationText: Record<Registration['status'], string> = {
  none: 'No attestation',
  pending: 'Not registered yet',
  registered: 'Attestation accepted',
  rejected: 'Attestation rejected',
};

export default function KeyScreen() {
  const captures = useCaptures();
  const [key, setKey] = useState<DeviceKey>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress>();
  const [exportSummary, setExportSummary] = useState<ExportSummary>();
  const [exportError, setExportError] = useState<string>();

  useEffect(() => {
    deviceKey().then(setKey, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const replace = (next: () => Promise<DeviceKey>) => {
    setBusy(true);
    next()
      .then(setKey, (e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const runExport = async () => {
    setExporting(true);
    setExportError(undefined);
    setExportSummary(undefined);
    setExportProgress(undefined);
    try {
      const summary = await pickAndExportCaptures({ captures, onProgress: setExportProgress });
      if (summary) setExportSummary(summary);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportProgress(undefined);
      setExporting(false);
    }
  };

  if (error) {
    return (
      <Blank>
        <ErrorText>Could not load the device key: {error}</ErrorText>
      </Blank>
    );
  }
  if (!key) {
    return (
      <Blank>
        <Busy label="Loading the device key" />
      </Blank>
    );
  }

  const r = key.registration;
  const detail = r.status === 'pending' ? `: ${r.error}` : r.status === 'rejected' ? `: ${r.reason}` : '';

  return (
    <Screen>
      <Field label="Public key · P-256 · SEC1 uncompressed" value={key.publicKey()} mono />
      <Field label="Key level" value={key.level} />
      <Field label="Device claims" value={key.claimed} />
      <Field label="Attestation" value={registrationText[r.status] + detail} />
      <Body muted>
        Receipts show a hardware level only for a hardware key whose attestation the anchoring service accepted.
        Otherwise they show software.
      </Body>
      {r.status === 'pending' ? (
        <Button title="Retry registration" disabled={busy || exporting} onPress={() => replace(retryRegistration)} />
      ) : null}
      <Button
        title="New key"
        disabled={busy || exporting}
        onPress={() =>
          Alert.alert('New key', 'This key is deleted. Photos already signed keep their receipts.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'New key', style: 'destructive', onPress: () => replace(newKey) },
          ])
        }
      />
      <Rule />
      <AnchorSetting />
      <Field label="Network" value={NETWORK} />
      <Rule />
      <EdgeLabel>Captures backup</EdgeLabel>
      <Body muted>
        {captures.length === 0
          ? 'No captures to export yet.'
          : 'Copy every photo and receipt to a folder you choose, with pending and failed claims in captures.json.'}
      </Body>
      <Button
        title="Export all"
        label="Export all captures to a folder"
        disabled={busy || exporting || captures.length === 0}
        onPress={() => void runExport()}
      />
      {exportProgress && <Busy label={`Exporting ${exportProgress.done} / ${exportProgress.total}`} />}
      {exportSummary && (
        <Body muted>
          {`Exported: ${exportSummary.copied} copied, ${exportSummary.skipped} skipped, ${exportSummary.failed} failed.`}
        </Body>
      )}
      {exportSummary && exportSummary.errors.length > 0 && <ErrorText>{exportSummary.errors[0]}</ErrorText>}
      {exportError && <ErrorText>Could not export: {exportError}</ErrorText>}
    </Screen>
  );
}
