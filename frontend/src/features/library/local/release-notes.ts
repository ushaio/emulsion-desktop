/**
 * What each local library schema version brings, keyed by the database
 * structure version the entry belongs to.
 *
 * The upgrade dialog shows the entries for the version being upgraded to, so
 * the user sees what the upgrade is for rather than a bare version number.
 *
 * Write these for the person clicking 开始升级, not for whoever maintains the
 * migration: one short line per user-visible change, in the terms the UI
 * already uses. No table or column names, no status values.
 *
 * Add an entry for every `currentSchemaVersion` bump in
 * local_library/store.go. Use the schema version as the key, not the app
 * version: the dialog compares the schema version, and app releases that do not
 * touch the database must not appear here.
 */
export const localLibraryReleaseNotes: Record<number, string[]> = {
  16: ['支持把 BMP 识别为图片文件'],
  17: ['支持把 3FR 识别为图片文件'],
  18: ['修复大尺寸 RAW 照片无法显示预览的问题'],
}

/** Notes for the version being upgraded to, or an empty list when there are none. */
export function releaseNotesFor(version: number): string[] {
  return localLibraryReleaseNotes[version] ?? []
}
