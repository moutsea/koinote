import { MapResult, StepMap } from "@tiptap/pm/transform";

// ProseMirror's Mapping uses the range index and offset in `recover` to pair
// mirrored history maps. Keep its encoding and MapResult flags, including when
// ranges collapse onto one position after a deletion outside history.
const RECOVERY_FACTOR = 0x10000;
const DEL_BEFORE = 1, DEL_AFTER = 2, DEL_ACROSS = 4, DEL_SIDE = 8;
// The runtime constructor is exported, but its arguments are marked internal
// in ProseMirror's declaration file. Keep this compatibility boundary here.
const Result = MapResult as unknown as {
  new (pos: number, delInfo: number, recover: number | null): MapResult;
};

/** StepMap with stable range identities and both biases at touching ranges. */
export class BatchReplaceMap extends StepMap {
  constructor(
    private readonly edits: readonly number[],
    private readonly reverse = false,
  ) {
    super(edits, reverse);
  }

  map(pos: number, assoc = 1): number {
    return this.mapResult(pos, assoc).pos;
  }

  mapResult(pos: number, assoc = 1): MapResult {
    let diff = 0;
    const oldIndex = this.reverse ? 2 : 1;
    const newIndex = this.reverse ? 1 : 2;
    for (let i = 0; i < this.edits.length; i += 3) {
      const start = this.edits[i] - (this.reverse ? diff : 0);
      if (start > pos) break;
      const oldSize = this.edits[i + oldIndex];
      const newSize = this.edits[i + newIndex];
      // Empty slots preserve mirror indexes for edits removed by remapping.
      if (!oldSize && !newSize) continue;
      const end = start + oldSize;
      const nextDiff = diff + newSize - oldSize;
      if (pos <= end) {
        // Unlike StepMap's first-range rule, right-biased positions must pass
        // every insertion at this position and use the right-hand range at
        // an adjacent replacement boundary. Left bias keeps the first range.
        let next = i + 3;
        while (next < this.edits.length && !this.edits[next + 1] && !this.edits[next + 2]) next += 3;
        const nextStart = this.edits[next] - (this.reverse ? nextDiff : 0);
        if (assoc > 0 && pos === end && next < this.edits.length && nextStart === pos) {
          diff = nextDiff;
          continue;
        }
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc;
        const mapped = start + diff + (side < 0 ? 0 : newSize);
        const recover = pos === (assoc < 0 ? start : end)
          ? null : i / 3 + (pos - start) * RECOVERY_FACTOR;
        let deleted = pos === start ? DEL_AFTER : pos === end ? DEL_BEFORE : DEL_ACROSS;
        if (assoc < 0 ? pos !== start : pos !== end) deleted |= DEL_SIDE;
        return new Result(mapped, deleted, recover);
      }
      diff = nextDiff;
    }
    return new Result(pos + diff, 0, null);
  }

  // Called by ProseMirror Mapping when it reaches this map's mirrored step.
  recover(value: number): number {
    const index = value % RECOVERY_FACTOR;
    const offset = Math.floor(value / RECOVERY_FACTOR);
    let diff = 0;
    if (!this.reverse) {
      for (let i = 0; i < index; i++) diff += this.edits[i * 3 + 2] - this.edits[i * 3 + 1];
    }
    const restoredSize = this.edits[index * 3 + (this.reverse ? 1 : 2)];
    return this.edits[index * 3] + diff + Math.min(offset, restoredSize);
  }

  invert(): BatchReplaceMap {
    return new BatchReplaceMap(this.edits, !this.reverse);
  }
}
