import { useCallback, useEffect, useState } from "react";

/**
 * Settings for Alexa, the voice interviewer that places live calls through the
 * Higgs Realtime backend (see src/call/CallController.ts at the repo root).
 * Stored in this browser only, like the rest of the dashboard.
 *
 * `{company}` in either text is replaced with the project's company name.
 */
export interface AlexaSettings {
  /** Greeting / system instructions, sent in the first session.update. */
  instructions: string;
  /** Said after the last question, or straight after a declined greeting; the call then ends. */
  closing: string;
  /** Higgs Avatar to show; "" for voice only. */
  avatarId: string;
}

export const DEFAULT_ALEXA_SETTINGS: AlexaSettings = {
  instructions:
    'You are Alexa from a private equity firm. Say exactly: "Hi, I\'m Alexa from a private equity firm. Do you have one minute for a few quick questions about {company}?" Nothing else.',
  closing: "That's all my questions. Thank you so much for your time, have a great day!",
  avatarId: "builtin_claire_v1",
};

export const AVATAR_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "builtin_claire_v1", label: "Claire" },
  { id: "builtin_emma_v1", label: "Emma" },
  { id: "builtin_james_v1", label: "James" },
  { id: "", label: "No avatar (voice only)" },
];

const KEY = "diligence-live:alexa:v1";

export function fillCompany(text: string, company: string): string {
  return text.split("{company}").join(company);
}

export function useAlexaSettings() {
  const [settings, setSettings] = useState<AlexaSettings>(DEFAULT_ALEXA_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSettings({ ...DEFAULT_ALEXA_SETTINGS, ...(JSON.parse(raw) as Partial<AlexaSettings>) });
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  const save = useCallback((next: AlexaSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const reset = useCallback(() => save(DEFAULT_ALEXA_SETTINGS), [save]);

  return { settings, save, reset, hydrated };
}
