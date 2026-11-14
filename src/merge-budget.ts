const encoder = new TextEncoder()

// A conservative budgeting unit for multilingual text, independent of the
// provider's tokenizer. The protocol also reserves room for request framing.
export function textSize(text: string): number {
  return encoder.encode(text).length
}

export function fitText(text: string, limit: number): string {
  if (textSize(text) <= limit) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (textSize(text.slice(0, mid)) <= limit) low = mid
    else high = mid - 1
  }
  if (/[\uD800-\uDBFF]/.test(text[low - 1] ?? '')) low--
  return text.slice(0, low)
}

export function mergeBudget(window: number): number {
  return Math.min(12000, Math.floor(window / 8))
}

export function sourceBudgets(sizes: readonly number[], total: number): number[] {
  const count = sizes.filter(size => size > 0).length
  if (count === 0) return sizes.map(() => 0)
  if (total < count) throw new Error('模型预算不足以覆盖所选会话，请减少会话数量')

  // Give every nonempty source a floor, then distribute by original size.
  // Short sources release any quota above the size of their original text.
  const floor = Math.min(256, Math.max(1, Math.floor(total / count / 2)))
  const budgets = sizes.map(size => Math.min(size, floor))
  let remaining = total - budgets.reduce((sum, value) => sum + value, 0)
  while (remaining > 0) {
    const active = sizes.flatMap((size, index) => size > budgets[index] ? [{ index, size }] : [])
    if (!active.length) break
    const weight = active.reduce((sum, item) => sum + item.size, 0)
    const shares = active.map(({ index, size }) => {
      const exact = remaining * size / weight
      const whole = Math.floor(exact)
      return { index, add: Math.min(size - budgets[index], whole), fraction: exact - whole }
    })
    for (const { index, add } of shares) {
      budgets[index] += add
      remaining -= add
    }
    shares.sort((left, right) => right.fraction - left.fraction || sizes[right.index] - sizes[left.index])
    for (const { index } of shares) {
      if (!remaining) break
      if (budgets[index] === sizes[index]) continue
      budgets[index]++
      remaining--
    }
  }
  return budgets
}
