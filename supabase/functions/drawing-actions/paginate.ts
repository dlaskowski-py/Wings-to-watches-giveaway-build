/**
 * PostgREST returns at most 1000 rows per request and gives no signal that it
 * truncated the result.
 *
 * For this system that is not a theoretical limit. A ~1000-member quarter has
 * more payment rows than that, and a silently short read while building the
 * frozen entrant list would drop real people's tickets out of the draw — the
 * single worst failure this codebase could have. Every list that can exceed
 * 1000 rows goes through here.
 */
const PAGE_SIZE = 1000

export async function fetchAllPages<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Loading ${what}: ${error.message}`)
    const batch = (data ?? []) as T[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}
