export function installDropNavigationGuard(
  target: EventTarget = window,
): () => void {
  const preventNavigation = (event: Event) => event.preventDefault();
  const options = { capture: true };
  target.addEventListener("dragover", preventNavigation, options);
  target.addEventListener("drop", preventNavigation);
  return () => {
    target.removeEventListener("dragover", preventNavigation, options);
    target.removeEventListener("drop", preventNavigation);
  };
}
