/**
 * Stage AND pipeline names keyed by id (snowflake ids never collide across the
 * two tables): what `describeActivity` resolves a `stageMoved` / `created`
 * stage id and a `pipelineMoved` (s196) pipeline id with.
 */
export function namesById(
  pipelines: readonly {
    id: string
    name: string
    stages: readonly { id: string; name: string }[]
  }[],
): Map<string, string> {
  return new Map(
    pipelines.flatMap((p) => [
      [p.id, p.name] as const,
      ...p.stages.map((s) => [s.id, s.name] as const),
    ]),
  )
}
