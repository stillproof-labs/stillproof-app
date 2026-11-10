# Stillproof app

**Prove a photo is unedited, and when it was taken.** This is the Stillproof
capture app, built with React Native and Expo. It takes a photo, fingerprints
the file on the phone, signs the fingerprint with a key held on the phone, and
sends the signed claim to an anchoring service. The service batches claims
into a Merkle tree and records the root on Stellar, then returns a receipt.
Anyone can check the photo and its receipt, with no account and no trust in
us.

The protocol is defined in the core repository's
[`SPEC.md`](https://github.com/stillproof-labs/stillproof/blob/main/SPEC.md).
This app implements protocol v0 and is tested against the same
[test vectors](src/protocol/__fixtures__/vectors.json) as the Go
implementation, so both produce identical bytes.

## What a receipt proves, and what it doesn't

A valid receipt proves three things:
- the file is unchanged since the device signed it;
- which device key signed it;
- that it existed no later than a specific Stellar ledger's close time.

It does not prove the scene is genuine: a photo of a screen verifies too.

Two more limits apply to this version:
- The capture time on the device clock is only a claim. The ledger close time
  is the evidence.
- Where it can, the app makes a hardware key: AndroidKeyStore (StrongBox,
  else the TEE) with a key attestation chain, or a Secure Enclave key bound to
  the app by App Attest (`modules/stillproof-keys`). It registers the
  attestation with `POST /v1/keys` (SPEC §8.4). Until the anchoring service
  accepts it, the key is labelled **software**, and so is a key the service
  rejects. Without hardware the app uses a software key in the operating
  system's secure storage. An existing software key stays until you tap
  **New key**.

## What it does

- **Capture:** in-app camera only. Photos can't be imported. The app copies
  the camera's file into its document directory, hashes those exact bytes,
  signs the claim and posts it to `POST /v1/claims`.
- **Captures:** every capture with its status (pending, anchored, failed).
  Pending captures poll `GET /v1/receipts/{id}` until the receipt arrives.
- **Capture detail:** the verdict once anchored, and sharing of the photo and
  its receipt (`<id>.stillproof.json`).
- **Check a photo:** pick a photo from the library or Files, with or without
  a receipt file, and check it (SPEC §6). With no receipt file, the app reads
  a receipt embedded as C2PA and checks its `c2pa.hash.data` hard binding
  (SPEC §8.3, leaving the C2PA signature unchecked), or else looks the file's
  SHA-256 up with `GET /v1/receipts?sha256=` (SPEC §8.4). Checking never anchors
  anything. Only the anchor transaction is read from Stellar's Horizon API.
  The app reads receipt v1 fields but doesn't verify attestation chains or
  Externalize proofs: it shows a claimed key level as claimed and points to
  the [web verifier](https://stillproof-labs.github.io/stillproof/).
- **Key and service:** the public key, its level, the attestation's status,
  **New key**, and the anchoring service URL, which can be changed at runtime.

The look follows the core repository's
[`docs/DESIGN.md`](https://github.com/stillproof-labs/stillproof/blob/main/docs/DESIGN.md):
darkroom (dark, the default) and print (light, when the system is light).


## Layout

| Path | Contents |
|---|---|
| `src/protocol/` | Pure TypeScript protocol code with no React: `claim.ts` (build, sign, parse, verify), `merkle.ts` (inclusion proofs), `receipt.ts` (receipt v0 and v1 parsing, verification and verdicts), `c2pa.ts` (reads an embedded receipt and checks `c2pa.hash.data`) |
| `src/keys.ts` | The device key: hardware where the device and the anchoring service allow, else software |
| `modules/stillproof-keys/` | Local Expo module: the Android Keystore (Kotlin) and Secure Enclave / App Attest (Swift) key |
| `src/captures.ts`, `src/api.ts`, `src/anchorUrl.ts` | Local capture storage, the anchoring service client and its stored URL |
| `src/check.ts` | Checking a photo you didn't take |
| `src/theme.ts`, `src/design/`, `src/components/` | The design system |
| `src/screens/` | The screens |

## Running

You need Node 24. Install dependencies:

```sh
npm ci
```

The app talks to the anchoring service at `EXPO_PUBLIC_ANCHOR_URL` unless
the URL is changed on the Key and service screen (stored on the device). The
build-time default, `http://10.0.2.2:8080`, is the host machine as seen from the Android
emulator, so a local `stillproof-anchor` on port 8080 works out of the box.
For a phone or another setup, set the variable when starting Metro:

```sh
EXPO_PUBLIC_ANCHOR_URL=https://anchor.example.org npx expo start
```

Receipts must be anchored on Stellar **testnet**.

The camera and secure storage are native modules, so run the app in a
development build rather than Expo Go:

```sh
npx expo run:android   # or: npx expo run:ios (macOS only)
```

This requires the Android SDK or Xcode. Android blocks plain `http://`
traffic in release builds, so use an `https://` service URL there.

## Testing

```sh
npm test               # Jest: protocol code against the shared vectors
npx tsc --noEmit       # typecheck
npx expo lint          # lint
npx expo-doctor        # Expo dependency and config checks
```

CI runs all four on every push and pull request.

## License

[Apache-2.0](LICENSE)
