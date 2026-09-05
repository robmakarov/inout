/**
 * WebCodecs' AV1 encode options, which TypeScript's DOM library does not carry
 * yet (task J9, 2026-09-05).
 *
 * `VideoEncoderEncodeOptions` in lib.dom.d.ts has `avc` and nothing else, so
 * the per-frame quantizer — the only way `bitrateMode: 'quantizer'` takes a
 * value — is untypeable for AV1 without this. It is declared rather than cast
 * at each call site deliberately: a cast at the call site is how the AVC path
 * would have silently accepted `{ av1: … }` on an AVC encoder, which the
 * encoder ignores in silence and which no test can see.
 *
 * The shape is the spec's `VideoEncoderEncodeOptionsForAv1`
 * (https://www.w3.org/TR/webcodecs-av1-codec-registration/): one optional
 * `quantizer`, 0-63. Delete this file when the DOM lib ships it.
 */
interface VideoEncoderEncodeOptionsForAv1 {
  quantizer?: number
}

interface VideoEncoderEncodeOptions {
  av1?: VideoEncoderEncodeOptionsForAv1
}

interface Av1EncoderConfig {
  txMode?: string
}

interface VideoEncoderConfig {
  av1?: Av1EncoderConfig
}
