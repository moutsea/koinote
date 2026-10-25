import { Fragment, Slice, type Node, type Schema } from "@tiptap/pm/model";
import { ReplaceStep, Step, StepMap, StepResult, type Mappable } from "@tiptap/pm/transform";
import { BatchReplaceMap } from "./batchReplaceMap";

/**
 * Apply disjoint replacements against one document snapshot. Rebuilding each
 * textblock once avoids copying a long string for every match. The map still
 * describes each individual edit so untouched selections/decorations survive.
 */
export class BatchReplaceStep extends Step {
  constructor(readonly replacements: readonly ReplaceStep[]) {
    super();
  }

  apply(doc: Node): StepResult {
    let end = 0;
    for (const step of this.replacements) {
      if (step.from < end || step.to < step.from || step.to > doc.content.size) {
        return StepResult.fail("Invalid or overlapping batch replacements");
      }
      end = step.to;
    }

    let index = 0;
    let canRebuild = this.replacements.every((step) => !step.slice.openStart && !step.slice.openEnd);
    const rebuild = (node: Node, contentStart: number): Node => {
      const next = this.replacements[index];
      if (!canRebuild || !next || next.from > contentStart + node.content.size) return node;
      if (node.isTextblock) {
        // The fast path only copies text and inline atoms. Preserve the normal
        // ReplaceStep behavior for schemas with nested inline content as well.
        if (Array.from({ length: node.childCount }, (_, i) => node.child(i)).some((child) => !child.isLeaf)) {
          canRebuild = false;
          return node;
        }
        const contentEnd = contentStart + node.content.size;
        const children: Node[] = [];
        let childIndex = 0;
        let childStart = contentStart;
        let cursor = contentStart;
        // Walk original children monotonically; never repeatedly cut a growing fragment.
        const consume = (until: number, keep: boolean) => {
          while (cursor < until) {
            const child = node.child(childIndex);
            const to = Math.min(until, childStart + child.nodeSize);
            if (keep) children.push(
              cursor === childStart && to === childStart + child.nodeSize
                ? child
                : child.cut(cursor - childStart, to - childStart),
            );
            cursor = to;
            if (cursor === childStart + child.nodeSize) {
              childStart = cursor;
              childIndex++;
            }
          }
        };
        while (index < this.replacements.length) {
          const step = this.replacements[index];
          if (step.from > contentEnd) break;
          if (step.from < contentStart || step.to > contentEnd) {
            canRebuild = false;
            return node;
          }
          consume(step.from, true);
          consume(step.to, false);
          step.slice.content.forEach((child) => children.push(child));
          index++;
        }
        consume(contentEnd, true);
        const content = Fragment.fromArray(children);
        if (!node.type.validContent(content)) canRebuild = false;
        return node.copy(content);
      }
      const children: Node[] = [];
      let changed = false;
      node.forEach((child, offset) => {
        const updated = child.isLeaf ? child : rebuild(child, contentStart + offset + 1);
        children.push(updated);
        changed ||= updated !== child;
      });
      return changed ? node.copy(Fragment.fromArray(children)) : node;
    };

    const updated = canRebuild ? rebuild(doc, 0) : doc;
    if (canRebuild && index === this.replacements.length) return StepResult.ok(updated);

    // History may map an edit across a block split performed outside history.
    // Fall back to standard replacement semantics for those uncommon shapes.
    let current = doc;
    for (const step of [...this.replacements].reverse()) {
      const result = step.apply(current);
      if (result.failed) return result;
      current = result.doc!;
    }
    return StepResult.ok(current);
  }

  getMap(): StepMap {
    if (!this.replacements.length) return StepMap.empty;
    return new BatchReplaceMap(this.replacements.flatMap((step) => [step.from, step.to - step.from, step.slice.size]));
  }

  invert(doc: Node): BatchReplaceStep {
    let offset = 0;
    return new BatchReplaceStep(this.replacements.map((step) => {
      const from = step.from + offset;
      offset += step.slice.size - (step.to - step.from);
      return new ReplaceStep(from, from + step.slice.size, doc.slice(step.from, step.to));
    }));
  }

  map(mapping: Mappable): BatchReplaceStep | null {
    let remaining = false;
    const replacements = this.replacements.map((step) => {
      const mapped = step.map(mapping);
      if (mapped) {
        remaining ||= mapped.from !== mapped.to || mapped.slice.size > 0;
        return mapped;
      }
      // Dropping a slot would change the range indexes used by mirrored
      // history maps. Keep an empty edit where the removed range collapsed.
      const position = mapping.map(step.from, 1);
      return new ReplaceStep(position, position, Slice.empty);
    });
    return remaining ? new BatchReplaceStep(replacements) : null;
  }

  toJSON() {
    return { stepType: "koinoteBatchReplace", replacements: this.replacements.map((step) => step.toJSON()) };
  }

  static fromJSON(schema: Schema, json: ReturnType<BatchReplaceStep["toJSON"]>): BatchReplaceStep {
    if (!Array.isArray(json.replacements)) throw new RangeError("Invalid batch replacements");
    return new BatchReplaceStep(json.replacements.map((value) => {
      const step = Step.fromJSON(schema, value);
      if (!(step instanceof ReplaceStep)) throw new RangeError("Expected a replacement step");
      return step;
    }));
  }
}

Step.jsonID("koinoteBatchReplace", BatchReplaceStep);
