/**
 * This driver's unique registry id and the default host selection source.
 * Compatible editors share the structural registry/provider contract; their
 * own settings namespace is selected through editorSettingsNamespace.
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
 * Default namespace for the bundled editor; editorSettingsNamespace can name
 * another compatible editor's namespace. The bridge field remains the shared
 * selection contract: the editor writes it and the host reads it before
 * registering tools and skills. See `host/activation.ts`.
 *
 * If the editor renames either, tools remain unavailable until an explicit
 * selection can be read.
 */
export const EDITOR_SETTINGS_NAMESPACE = 'spreadjs-editor'
export const BRIDGE_FIELD = 'bridge'
