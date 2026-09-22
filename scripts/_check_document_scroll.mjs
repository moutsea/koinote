import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["spa/src/components/editor/documentScrollPosition.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
let moduleVersion = 0;
async function loadTracker() {
  const source = bundle.outputFiles[0].text + `\nvoid ${moduleVersion++};`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const stored = new Map();
const frames = new Map();
const timers = new Map();
const observers = new Set();
let nextID = 0;
let storageBlocked = false;
let storageWrites = 0;
const testWindow = new EventTarget();
Object.assign(testWindow, {
  localStorage: {
    get length() { return stored.size; },
    key(index) { return [...stored.keys()][index] ?? null; },
    removeItem(key) {
      if (storageBlocked) throw new Error("storage unavailable");
      stored.delete(key);
    },
    getItem(key) {
      if (storageBlocked) throw new Error("storage unavailable");
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      if (storageBlocked) throw new Error("storage unavailable");
      storageWrites += 1;
      stored.set(key, value);
    },
  },
  requestAnimationFrame(callback) {
    frames.set(++nextID, callback);
    return nextID;
  },
  cancelAnimationFrame(frame) { frames.delete(frame); },
  setTimeout(callback) {
    timers.set(++nextID, callback);
    return nextID;
  },
  clearTimeout(timer) { timers.delete(timer); },
});
globalThis.window = testWindow;
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.add(this);
  }
  observe() {}
  disconnect() { observers.delete(this); }
};

class ScrollContainer extends EventTarget {
  visible = true;
  contentHeight = 5000;
  position = 0;
  scrollLeft = 0;
  get clientHeight() { return this.visible ? 600 : 0; }
  get scrollTop() { return this.visible ? this.position : 0; }
  set scrollTop(value) {
    this.position = this.visible
      ? Math.max(0, Math.min(value, this.contentHeight - this.clientHeight))
      : 0;
  }
  querySelector() { return {}; }
  scrollToPosition(top, left = 0) {
    this.scrollTop = top;
    this.scrollLeft = left;
    this.dispatchEvent(new Event("scroll"));
  }
}

function runFrames() {
  for (let tick = 0; tick < 2; tick += 1) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
}

function resizeContent() {
  for (const observer of [...observers]) observer.callback();
}

function savedPosition(docId) {
  return JSON.parse(stored.get(`koinote:document-scroll:${docId}`));
}

function savedScopedPosition(scope, docId) {
  return JSON.parse(stored.get(
    `koinote:document-scroll:${encodeURIComponent(scope)}:${encodeURIComponent(docId)}`,
  ));
}

const { trackDocumentScrollPosition, pruneDocumentScrollPositions } = await loadTracker();

const first = new ScrollContainer();
let releaseFirst = trackDocumentScrollPosition("first", first);
first.scrollToPosition(1250, 25);
assert.equal(storageWrites, 0, "scrolling must not synchronously write storage on every event");
first.visible = false;
first.scrollToPosition(0);
releaseFirst();
assert.deepEqual(savedPosition("first"), { scrollTop: 1250, scrollLeft: 25 }, "hiding a tab must not overwrite its remembered position with zero");

const second = new ScrollContainer();
const releaseSecond = trackDocumentScrollPosition("second", second);
second.scrollToPosition(840);
releaseSecond();
first.visible = true;
releaseFirst = trackDocumentScrollPosition("first", first);
runFrames();
assert.equal(first.scrollTop, 1250, "switching back restores the original document independently");
assert.equal(first.scrollLeft, 25);
releaseFirst();

const remounted = new ScrollContainer();
const releaseRemounted = trackDocumentScrollPosition("first", remounted);
runFrames();
assert.equal(remounted.scrollTop, 1250, "evicting an editor from the mount pool must not lose its position");
releaseRemounted();

const reloadedTracker = await loadTracker();
const reloaded = new ScrollContainer();
const releaseReloaded = reloadedTracker.trackDocumentScrollPosition("first", reloaded);
runFrames();
assert.equal(reloaded.scrollTop, 1250, "a fresh module restores the position from local storage");
releaseReloaded();

const scopedFirst = new ScrollContainer();
const releaseScopedFirst = trackDocumentScrollPosition("same", scopedFirst, "account-a");
scopedFirst.scrollToPosition(310);
releaseScopedFirst();
const scopedSecond = new ScrollContainer();
const releaseScopedSecond = trackDocumentScrollPosition("same", scopedSecond, "account-b");
runFrames();
assert.equal(scopedSecond.scrollTop, 0, "different accounts must not share a document scroll position");
scopedSecond.scrollToPosition(720);
releaseScopedSecond();
assert.equal(savedScopedPosition("account-a", "same").scrollTop, 310);
assert.equal(savedScopedPosition("account-b", "same").scrollTop, 720);

const delayed = new ScrollContainer();
delayed.contentHeight = 700;
const releaseDelayed = trackDocumentScrollPosition("first", delayed);
runFrames();
assert.equal(delayed.scrollTop, 100);
delayed.dispatchEvent(new Event("scroll"));
delayed.contentHeight = 5000;
resizeContent();
assert.equal(delayed.scrollTop, 1250, "late content growth retries the original target after an initial clamp");
releaseDelayed();

const interrupted = new ScrollContainer();
interrupted.contentHeight = 700;
const releaseInterrupted = trackDocumentScrollPosition("first", interrupted);
runFrames();
interrupted.dispatchEvent(new Event("wheel"));
interrupted.scrollToPosition(40);
interrupted.contentHeight = 5000;
resizeContent();
runFrames();
assert.equal(interrupted.scrollTop, 40, "user scrolling cancels pending restoration");
releaseInterrupted();

const leaving = new ScrollContainer();
const releaseLeaving = trackDocumentScrollPosition("leaving", leaving);
leaving.scrollToPosition(940);
testWindow.dispatchEvent(new Event("pagehide"));
assert.equal(savedPosition("leaving").scrollTop, 940, "pagehide persists pending positions before the debounce fires");
releaseLeaving();

const pendingScroll = new ScrollContainer();
const releasePendingScroll = trackDocumentScrollPosition("pending-scroll", pendingScroll);
pendingScroll.scrollTop = 780;
testWindow.dispatchEvent(new Event("pagehide"));
assert.equal(savedPosition("pending-scroll").scrollTop, 780, "pagehide captures scrolling before the browser delivers a scroll event");
pendingScroll.scrollTop = 960;
releasePendingScroll();
assert.equal(savedPosition("pending-scroll").scrollTop, 960, "unmount captures the final visible viewport even without a scroll event");

const cancelled = new ScrollContainer();
const releaseCancelled = trackDocumentScrollPosition("second", cancelled);
releaseCancelled();
cancelled.scrollTop = 12;
runFrames();
resizeContent();
assert.equal(cancelled.scrollTop, 12, "unmount cancels all delayed restoration work");

storageBlocked = true;
const memoryOnly = new ScrollContainer();
const releaseMemoryOnly = trackDocumentScrollPosition("memory-only", memoryOnly);
memoryOnly.scrollToPosition(456);
releaseMemoryOnly();
const memoryRemount = new ScrollContainer();
const releaseMemoryRemount = trackDocumentScrollPosition("memory-only", memoryRemount);
runFrames();
assert.equal(memoryRemount.scrollTop, 456, "blocked storage still preserves positions across editor remounts");
releaseMemoryRemount();
storageBlocked = false;

for (const invalid of ["invalid JSON", "null", '{"scrollTop":-5,"scrollLeft":0}', '{"scrollTop":"900","scrollLeft":0}']) {
  const docId = `invalid-${invalid}`;
  stored.set(`koinote:document-scroll:${docId}`, invalid);
  const container = new ScrollContainer();
  const release = trackDocumentScrollPosition(docId, container);
  runFrames();
  assert.equal(container.scrollTop, 0, "invalid persisted positions must be ignored");
  release();
}

const beginning = new ScrollContainer();
const releaseBeginning = trackDocumentScrollPosition("first", beginning);
runFrames();
beginning.scrollToPosition(0);
releaseBeginning();
assert.equal(savedPosition("first").scrollTop, 0, "deliberately returning to the beginning overwrites the previous position");
pruneDocumentScrollPositions(["first"]);
assert.equal(stored.has("koinote:document-scroll:second"), false, "deleted documents lose persisted positions");
assert.equal(savedPosition("first").scrollTop, 0);
assert.equal(savedScopedPosition("account-a", "same").scrollTop, 310, "unscoped pruning preserves account positions");
pruneDocumentScrollPositions([], "account-a");
assert.equal(stored.has("koinote:document-scroll:account-a:same"), false);
assert.equal(savedScopedPosition("account-b", "same").scrollTop, 720, "pruning one account preserves other accounts");
const removed = new ScrollContainer();
const releaseRemoved = trackDocumentScrollPosition("same", removed, "account-a");
runFrames();
assert.equal(removed.scrollTop, 0, "pruning also removes the in-memory position");
releaseRemoved();
assert.equal(frames.size, 0);
assert.equal(timers.size, 0);
assert.equal(observers.size, 0);
console.log("document scroll position checks passed");
