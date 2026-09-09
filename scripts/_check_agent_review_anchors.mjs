import assert from "node:assert/strict";
import { matchAgentReviewAnchors } from "./_agent_review_anchors_bundle.mjs";

function textNode(text) {
  return { isText: true, isInline: true, isLeaf: true, isTextblock: false, text };
}

function imageNode() {
  return { isText: false, isInline: true, isLeaf: true, isTextblock: false };
}

function documentWithBlocks(blocks) {
  return {
    descendants(callback) {
      for (const block of blocks) {
        callback(
          { isText: false, isInline: false, isLeaf: false, isTextblock: true },
          block.position,
        );
        for (const child of block.children) callback(child.node, child.position);
      }
    },
  };
}

const document = documentWithBlocks([
  {
    position: 0,
    children: [
      { node: textNode("prefix"), position: 1 },
      { node: textNode("   spaced\nvalue"), position: 100 },
      { node: textNode("left"), position: 120 },
      { node: imageNode(), position: 124 },
      { node: textNode("right"), position: 125 },
      { node: textNode("styled phrase"), position: 131 },
    ],
  },
  {
    position: 200,
    children: [{ node: textNode("same text"), position: 201 }],
  },
  {
    position: 220,
    children: [{ node: textNode("same text"), position: 221 }],
  },
]);

const matches = matchAgentReviewAnchors(document, [
  { suggestionId: "whitespace", before: "spaced\nvalue" },
  { suggestionId: "image", before: "left ![photo](image.png) right" },
  { suggestionId: "formatting", before: "**styled phrase**" },
  { suggestionId: "duplicate", before: "same text" },
]);

assert.deepEqual(
  matches.map((match) => match.suggestionId),
  ["whitespace", "image", "formatting"],
);
assert.deepEqual(
  matches.find((match) => match.suggestionId === "whitespace"),
  { suggestionId: "whitespace", from: 103, to: 115 },
);
assert.ok(
  matches.find((match) => match.suggestionId === "image").to >
    matches.find((match) => match.suggestionId === "image").from,
);
assert.ok(
  matches.find((match) => match.suggestionId === "formatting").to >
    matches.find((match) => match.suggestionId === "formatting").from,
);

console.log("agent review anchor behavior checks passed");
