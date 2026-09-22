/**
 * The two names that tie this plugin to the editor's roster, shared by both
 * halves because they must agree and cannot import each other's modules.
 *
 * They are also the plugin's entire coupling to the editor. Everything else —
 * the registry's methods, the entry's shape — is read off the contract at
 * runtime; these two are the only strings either side is allowed to assume.
 */

/**
 * The id this plugin registers under in the editor's roster.
 *
 * The package name, deliberately: it is unique, it is already the identity
 * everything else uses (the client-module registration, the loader row), and a
 * second implementation cannot accidentally claim it.
 */
export const BRIDGE_ID = '@grapecity-software/dsh-spreadjs-driver'

/**
 * The settings namespace the EDITOR owns, and the field in it that holds the
 * chosen bridge.
 *
 * A second plugin's namespace, hardcoded here — which is worth stating plainly,
 * because it is the one place this plugin reaches into another's configuration.
 * It is how the two halves of the choice meet: the editor writes it from the
 * browser, and this plugin's host half READS it to decide whether it should be
 * present at all. See `host/activation.ts`.
 *
 * If the editor ever renames either, this plugin stops letting go of the roster
 * when someone else is chosen — a degradation, not a crash: the read fails open.
 */
export const EDITOR_SETTINGS_NAMESPACE = 'spreadjs-editor'
export const BRIDGE_FIELD = 'bridge'
