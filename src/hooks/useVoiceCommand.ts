// useVoiceCommand — Web Speech API + AnalyserNode bound to the Command
// Center's onCommand surface. Sprint 5s+ "voice 기능 추가".
//
// Architecture:
//   • SpeechRecognition (Chrome/Edge: webkitSpeechRecognition, Safari 14+:
//     SpeechRecognition) handles continuous transcription. Per-segment
//     `onresult` fires with interim + final results; we scan the final
//     transcript for vocab keywords and fire onCommand for the first
//     match. Continuous mode + auto-restart on `onend` keeps the mic open
//     even when the recognizer momentarily times out.
//   • AnalyserNode on a MediaStreamSource (getUserMedia → AudioContext)
//     gives real-time amplitude. The waveform in CommandCenter reads
//     this value via `amplitude` to drive bar heights so visualization
//     reacts to actual mic input, not a placeholder CSS animation.
//   • Toggle ON requires a user gesture (browser security). On enable
//     we request mic permission, then start both pipes; on disable
//     we close both cleanly.
//
// Browser support:
//   • Chrome / Edge / Brave: ✓ (webkitSpeechRecognition)
//   • Safari 14.1+: ✓
//   • Firefox: ✗ (no SpeechRecognition shipping as of 2026-05). Hook
//     reports `supported=false`; CommandCenter renders a graceful
//     "VOICE · UNSUPPORTED" pill instead of a toggle.
//
// Vocabulary is bilingual (English + Korean) so a Korean operator can
// say "분석" and an English operator "analyze" and both fire ⌘A.

import { useCallback, useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/*  Vocabulary — phrase → command id                                   */
/* ------------------------------------------------------------------ */

/** Each command maps to multiple trigger phrases (English + Korean).
 *  Matching is case-insensitive substring; the FIRST match in this
 *  iteration order wins so a longer phrase isn't masked by a shorter
 *  one. Add new triggers here without touching the recognizer. */
const VOCAB: ReadonlyArray<{ id: string; phrases: ReadonlyArray<string> }> = [
  // Long phrases first so "simulate alert" beats a bare "alert" only
  // when both appear, but a single-word "alert" still fires alone.
  { id: 'snapshot', phrases: ['snapshot', 'capture snapshot', 'capture', '스냅샷', '캡처'] },
  { id: 'analyze',  phrases: ['analyze cluster', 'analyze', '분석', '클러스터 분석'] },
  { id: 'isolate',  phrases: ['isolate entity', 'isolate', '격리'] },
  { id: 'trace',    phrases: ['trace flow', 'trace path', 'trace', '추적', '경로 추적'] },
  { id: 'audit',    phrases: ['audit transactions', 'audit', '감사', '트랜잭션 감사'] },
  { id: 'replay',   phrases: ['replay shock', 'replay', '재생', '리플레이'] },
  { id: 'alert',    phrases: ['raise alert', 'simulate shock', 'alert', 'shock', '알람', '경보', '충격'] },
  { id: 'tour',     phrases: ['show help', 'show tour', 'help', 'tour', '도움말', '튜어'] },
];

/** Match the most-specific vocab phrase against a transcript. Returns
 *  the command id of the first hit, or null when nothing recognizes.
 *  Exported for unit testing — keeping the matcher pure (string in,
 *  id out) sidesteps the entire recognizer/audio stack in tests. */
export function matchVoiceCommand(transcript: string): string | null {
  const t = transcript.toLowerCase().trim();
  if (!t) return null;
  for (const entry of VOCAB) {
    for (const phrase of entry.phrases) {
      if (t.includes(phrase.toLowerCase())) {
        return entry.id;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  SpeechRecognition type shim                                        */
/* ------------------------------------------------------------------ */

/** Minimal structural type for the browser's SpeechRecognition. The
 *  W3C type is partial in TS lib.dom; we only need what we touch. */
interface MinimalSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionResultLikeEvent) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionResultLikeEvent {
  results: ArrayLike<{
    isFinal: boolean;
    [index: number]: { transcript: string; confidence: number };
  }>;
  resultIndex: number;
}
type SRConstructor = new () => MinimalSpeechRecognition;

function getSRCtor(): SRConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export interface VoiceCommandState {
  /** Whether the API is supported in this browser at all. */
  supported: boolean;
  /** Whether the mic is currently armed + the recognizer running. */
  enabled: boolean;
  /** Last error code (e.g. 'not-allowed', 'no-speech'). */
  error: string | null;
  /** Real-time mic amplitude, 0..1. Useful for driving waveforms. */
  amplitude: number;
  /** Last transcript we recognized a command from (empty when none). */
  lastPhrase: string;
  /** Last command id fired. Resets after `lastResetMs` so consumers can
   *  show a fading "VOICE: snapshot ✓" status. */
  lastCommand: string | null;
}

export interface UseVoiceCommandOptions {
  onCommand: (id: string) => void;
  /** BCP-47 language tag for recognition. Defaults to `ko-KR` because
   *  the operator base is bilingual and Korean phrases benefit from
   *  native model weights; English phrases are recognized correctly
   *  in Korean mode by Chrome's SpeechRecognition. */
  lang?: string;
}

export function useVoiceCommand(opts: UseVoiceCommandOptions): VoiceCommandState & { toggle: () => void } {
  const { onCommand, lang = 'ko-KR' } = opts;

  const [supported] = useState<boolean>(() => getSRCtor() !== null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [lastPhrase, setLastPhrase] = useState('');
  const [lastCommand, setLastCommand] = useState<string | null>(null);

  // Refs for the live audio + recognizer pipes — non-reactive state we
  // need to tear down deterministically on toggle-off.
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const userStoppedRef = useRef(false);
  const onCommandRef = useRef(onCommand);
  // Keep the latest onCommand without re-arming the recognizer on every
  // parent re-render.
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);

  const stop = useCallback(() => {
    userStoppedRef.current = true;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.stop(); } catch { /* ok */ }
      recognitionRef.current = null;
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch { /* ok */ }
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      try { void audioCtxRef.current.close(); } catch { /* ok */ }
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch { /* ok */ }
      }
      streamRef.current = null;
    }
    setAmplitude(0);
    setEnabled(false);
  }, []);

  const start = useCallback(async () => {
    const Ctor = getSRCtor();
    if (!Ctor) {
      setError('unsupported');
      return;
    }
    setError(null);
    userStoppedRef.current = false;

    // ── 1. Mic stream + AnalyserNode for amplitude visualization ──
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: unknown) {
      // Most likely 'NotAllowedError' (user denied) or 'NotFoundError'
      // (no input device). Either way: disable, surface the cause.
      const name = (e instanceof Error ? e.name : null) || 'mic-error';
      setError(name);
      return;
    }
    streamRef.current = stream;

    // AudioContext must be (re-)created per session because suspending
    // an old one and reusing produces silent FFT buffers in Chrome.
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    audioCtxRef.current = ctx;
    // Some browsers boot the context suspended; resume() unblocks it.
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ok */ }
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;       // smaller bin = faster amplitude update
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyserRef.current = analyser;

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (analyserRef.current === null) return;
      analyserRef.current.getByteTimeDomainData(buf);
      // Compute amplitude as max deviation from the 128 midpoint, /128
      // → range [0, 1]. Time-domain (not frequency-domain) so the
      // value tracks loudness, not pitch.
      let max = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs((buf[i] ?? 128) - 128);
        if (v > max) max = v;
      }
      setAmplitude(Math.min(1, max / 128));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    // ── 2. SpeechRecognition ──
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = lang;
    rec.onresult = (ev: SpeechRecognitionResultLikeEvent) => {
      // Scan all final results we haven't seen yet for any vocab phrase.
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (!r || !r.isFinal) continue;
        const transcript = r[0]?.transcript ?? '';
        const id = matchVoiceCommand(transcript);
        if (id) {
          setLastPhrase(transcript.trim());
          setLastCommand(id);
          // Defer to the latest onCommand to avoid stale closures.
          onCommandRef.current(id);
          break;
        }
      }
    };
    rec.onerror = (ev: { error?: string }) => {
      // 'no-speech' / 'aborted' fire often and are not user-actionable —
      // surface only the genuinely informative codes.
      const code = ev.error ?? 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        setError(code);
        stop();
      }
    };
    rec.onend = () => {
      // The recognizer auto-times-out every ~1 minute in Chrome. Restart
      // it so the mic stays warm — unless the operator explicitly toggled
      // OFF, in which case respect that and don't fight them.
      if (!userStoppedRef.current && recognitionRef.current === rec) {
        try { rec.start(); } catch { /* already starting */ }
      }
    };
    try {
      rec.start();
    } catch (e: unknown) {
      // 'InvalidStateError' if a prior recognizer is still alive — stop
      // and rethrow upstream as a soft error.
      setError((e instanceof Error ? e.name : null) || 'start-failed');
      stop();
      return;
    }
    recognitionRef.current = rec;
    setEnabled(true);
  }, [lang, stop]);

  const toggle = useCallback(() => {
    if (enabled) stop();
    else void start();
  }, [enabled, start, stop]);

  // Clean teardown on unmount — mic must NOT keep streaming after the
  // component leaves the tree.
  useEffect(() => () => stop(), [stop]);

  return { supported, enabled, error, amplitude, lastPhrase, lastCommand, toggle };
}
