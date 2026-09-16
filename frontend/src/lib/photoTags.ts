export function normalizePhotoTags(tags: string[] | null | undefined): string[] {
  return Array.from(new Set(
    (tags ?? [])
      .map(tag => tag.trim())
      .filter(tag => tag && tag !== '全部' && tag.toLocaleLowerCase() !== 'all'),
  ))
}