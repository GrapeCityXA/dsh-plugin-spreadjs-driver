# Editor-only validation

Automated: run pnpm run ci after installing dependencies. This checks the authenticated channel, bridge selection, attached-instance execution, error handling and packed distribution.

Manual integration:

1. Start DSH with editor and driver in a web profile; configure licenses for its actual origin.
2. With no selection, confirm no driver tools/skill are offered. Select this driver in editor settings.
3. With no workbook open, confirm status offers no runnable Workbook and execution fails explicitly.
4. Open a workbook and wait for loading; change A1 through sjs_live_execute and confirm the same editor instance updates.
5. Verify the file is untouched by default, and save: true uses the editor save path and conflict checks.
6. While loading or saving, confirm the editor does not expose the Workbook. A failed load must not expose the initial blank instance.
7. Close/reload the editor and verify errors after heartbeat expiry, with no server browser process or fallback tools.
8. Check SpreadJS/Designer licensing in the actual browser origin. Automated tests do not validate a commercial license.
