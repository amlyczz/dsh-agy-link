// Extract the model ids a `session/new|resume|load` response advertises.
//
// agy replies with `models.availableModels` (objects carrying `modelId`,
// occasionally bare strings). An id that already embeds the effort
// (`gemini-4-hydrogen-xhigh`) lets one atomic `session/set_model` replace the
// model→thought_level double switch (issue #167).
export function collectAdvertisedModelIds(result: Record<string, unknown>): Set<string> {
  const ids = new Set<string>()
  const models = result.models
  if (models === null || typeof models !== 'object') return ids
  const avail = (models as Record<string, unknown>).availableModels
  if (!Array.isArray(avail)) return ids
  for (const entry of avail) {
    if (typeof entry === 'string' && entry !== '') {
      ids.add(entry)
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const id = (entry as Record<string, unknown>).modelId
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids
}
