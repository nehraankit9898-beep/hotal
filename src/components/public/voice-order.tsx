"use client";

/**
 * Phase 18 — VOICE ORDER SUPPORT (public menu, mobile-first).
 *
 * Privacy & safety contract:
 *  - Speech recognition runs in the BROWSER (Web Speech API) behind an
 *    explicit user tap + browser mic permission. RAW AUDIO NEVER LEAVES THE
 *    DEVICE — only the recognized text transcript hits our server, it is
 *    parsed in memory and never stored.
 *  - The parsed cart is a PROPOSAL: it is always shown visually with prices
 *    for explicit human confirmation. Voice alone NEVER submits an order and
 *    can never trigger a payment.
 *  - Accessible text fallback: a plain text field drives the SAME parser and
 *    flow — the feature is fully usable without a microphone (and on
 *    browsers/devices without Web Speech support the voice button is hidden
 *    and the text box remains).
 *  - Unsupported browser / permission denied → honest inline state with the
 *    text fallback offered, never a fake "listening" spinner.
 */

import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Mic, MicOff, Keyboard, Loader2, AlertTriangle } from "lucide-react";

interface VoiceLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

interface VoiceParseResponse {
  ok: boolean;
  lines: VoiceLine[];
  unrecognized: string[];
  needsConfirmation: true;
}

export interface VoiceOrderProps {
  code: string;
  onConfirm: (lines: Array<{ menuItemId: string; quantity: number }>) => void;
  formatMoney: (minor: number) => string;
}

/* Minimal Web Speech typings (not all TS libs ship them). */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceOrder({ code, onConfirm, formatMoney }: VoiceOrderProps) {
  const supported = getSpeechRecognition() !== null;
  const [mode, setMode] = useState<"voice" | "text">(supported ? "voice" : "text");
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [proposal, setProposal] = useState<VoiceParseResponse | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const parse = useMutation({
    mutationFn: (t: string) =>
      fetch(`/api/public/menu/${encodeURIComponent(code)}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: t }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Voice parsing failed.");
        }
        return res.json() as Promise<VoiceParseResponse>;
      }),
    onSuccess: (data) => setProposal(data),
  });

  // Stop recognition when the component unmounts.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch { /* already stopped */ }
    };
  }, []);

  const startListening = () => {
    setMicError(null);
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setMode("text");
      return;
    }
    try {
      const rec = new Ctor();
      recognitionRef.current = rec;
      rec.lang = "en-IN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      rec.onresult = (event) => {
        const result = event.results?.[0]?.[0]?.transcript ?? "";
        setTranscript(result);
        if (result.trim()) parse.mutate(result);
      };
      rec.onerror = (event) => {
        const err = event?.error ?? "unknown";
        setMicError(
          err === "not-allowed" || err === "service-not-allowed"
            ? "Microphone permission was denied. Use the text box instead — it works exactly the same."
            : err === "no-speech"
              ? "Didn't catch that — tap the mic and try again, or type below."
              : "Voice input failed. Use the text box instead.",
        );
        setListening(false);
      };
      rec.onend = () => setListening(false);
      rec.start();
      setListening(true);
    } catch {
      setMicError("Voice input is not available on this device. Use the text box below.");
      setMode("text");
    }
  };

  const stopListening = () => {
    try {
      recognitionRef.current?.stop();
    } catch { /* ignore */ }
    setListening(false);
  };

  const total = (proposal?.lines ?? []).reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <Mic className="h-3.5 w-3.5" /> Voice / text ordering
        </p>
        {supported && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode(mode === "voice" ? "text" : "voice")}
            className="h-7 text-xs"
          >
            {mode === "voice" ? <><Keyboard className="h-3 w-3" /> Type instead</> : <><Mic className="h-3 w-3" /> Use voice</>}
          </Button>
        )}
      </div>

      {mode === "voice" && supported ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={listening ? "destructive" : "default"}
            onClick={listening ? stopListening : startListening}
            disabled={parse.isPending}
            className="min-h-11"
            aria-label={listening ? "Stop listening" : "Start listening"}
          >
            {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            {listening ? "Listening… tap to stop" : "Tap to speak"}
          </Button>
          {parse.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-label="Parsing" />}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (transcript.trim()) parse.mutate(transcript);
          }}
        >
          <Input
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder='e.g. "2 masala dosa and 1 filter coffee"'
            aria-label="Type your order"
            className="min-h-11"
          />
          <Button type="submit" size="sm" disabled={parse.isPending || !transcript.trim()} className="min-h-11">
            Parse
          </Button>
        </form>
      )}

      {micError && (
        <p className="text-xs text-destructive flex items-start gap-1" role="alert">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {micError}
        </p>
      )}

      {/* Proposal — ALWAYS explicit confirmation; voice never submits alone. */}
      {proposal && (
        <div className="rounded-lg border bg-background p-3 space-y-2" role="region" aria-label="Recognized cart — review before adding">
          <p className="text-xs font-medium text-muted-foreground">
            Did you mean: (please confirm — nothing is added yet)
          </p>
          {proposal.lines.length === 0 && proposal.unrecognized.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recognized — try naming a dish from the menu.</p>
          ) : (
            <>
              {proposal.lines.map((l) => (
                <div key={l.menuItemId} className="flex justify-between text-sm">
                  <span>{l.quantity} × {l.name}</span>
                  <span>{formatMoney(l.unitPriceMinor * l.quantity)}</span>
                </div>
              ))}
              {proposal.unrecognized.map((u, i) => (
                <p key={i} className="text-xs text-muted-foreground">Not on the menu: “{u}”</p>
              ))}
              {proposal.lines.length > 0 && (
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-sm font-semibold">Proposed total {formatMoney(total)}</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      onConfirm(proposal.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })));
                      setProposal(null);
                      setTranscript("");
                    }}
                  >
                    Add to cart
                  </Button>
                </div>
              )}
            </>
          )}
          <Badge variant="outline" className="text-[10px]">Processed as text — audio never leaves your device</Badge>
        </div>
      )}
    </div>
  );
}
