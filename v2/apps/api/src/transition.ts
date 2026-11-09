import { conflict, MACHINES, refusalMessage, sourcesFor, type Machine, type MachineState } from "@pi/domain";

/**
 * One compare-and-set move. `apply` must be a single updateMany whose `where`
 * requires the column to be one of `sources` (the states that may move to
 * `to`), plus whatever else the caller already guarded (version, revision,
 * claim). On zero rows the row is re-read and a 409 is thrown. Pass `message`
 * to keep an existing sentence; otherwise the text names the current state.
 * `allowEmpty` is for "move every matching row", where zero rows is success.
 */
export async function transition<M extends Machine>(input: {
  machine: M;
  to: MachineState<M>;
  /** Narrow the legal sources. Each value must itself be allowed to move to `to`. */
  from?: readonly MachineState<M>[];
  label: string;
  message?: string;
  allowEmpty?: boolean;
  apply: (sources: MachineState<M>[], to: MachineState<M>) => Promise<number>;
  current: () => Promise<string | null>;
}): Promise<number> {
  const legal = sourcesFor(input.machine, input.to);
  const sources = input.from ? input.from.filter((state): state is MachineState<M> => legal.includes(state)) : legal;
  const refuse = async (): Promise<never> => {
    if (input.message) throw conflict(input.message);
    const now = await input.current();
    if (now == null) throw conflict(`${input.label} was not found`);
    const edges = MACHINES[input.machine].edges as Record<string, readonly string[]>;
    throw conflict(refusalMessage(input.label, now, edges[now] ?? []));
  };
  if ((input.from && sources.length !== input.from.length) || sources.length === 0) await refuse();
  const count = await input.apply(sources, input.to);
  if (count > 0 || input.allowEmpty) return count;
  return refuse();
}
