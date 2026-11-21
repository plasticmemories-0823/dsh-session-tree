export type Translate = (english: string, chinese: string) => string

export function translator(locale?: string): Translate {
  const chinese = /^zh(?:-|$)/i.test(locale ?? '')
  return (english, translation) => chinese ? translation : english
}

export const generatedTitles = {
  child: ['Child Session', '子会话'],
  merged: ['Merged Session', '合并会话'],
  parent: ['Shared Parent Session', '共同父会话'],
  copySuffix: [' (Copy)', '（副本）'],
} as const

export function localizedGeneratedTitle(title: string, locale: string, generated: ReadonlySet<string>): string {
  const t = translator(locale)
  for (const pair of [generatedTitles.child, generatedTitles.merged, generatedTitles.parent]) {
    if (title === pair[0] || title === pair[1]) return t(pair[0], pair[1])
  }
  const suffix = generatedTitles.copySuffix.find(part => title.endsWith(part))
  if (!suffix) return title
  const source = title.slice(0, -suffix.length)
  const base = generated.has(source) ? localizedGeneratedTitle(source, locale, generated) : source
  return base + t(...generatedTitles.copySuffix)
}
