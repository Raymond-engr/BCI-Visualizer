import { request } from "./client"
import type { PreferenceOptions, Preferences, PreferencesUpdate } from "./types"

/** Upserts defaults on first read, so this never resolves to null. */
export function getPreferences(): Promise<Preferences> {
  return request<Preferences>("/preferences")
}

export function updatePreferences(input: PreferencesUpdate): Promise<Preferences> {
  return request<Preferences>("/preferences", { method: "PUT", body: input })
}

/**
 * The bandpass bands this deployment has precomputed coefficients for. The
 * server rejects anything else, so the settings UI offers these rather than a
 * free-text field.
 */
export function getPreferenceOptions(): Promise<PreferenceOptions> {
  return request<PreferenceOptions>("/preferences/options")
}
