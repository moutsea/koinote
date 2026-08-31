function isListItem(element: Element): element is HTMLLIElement {
  return element.tagName.toLowerCase() === "li";
}

function isTaskItem(element: HTMLLIElement): boolean {
  return element.classList.contains("task-list-item");
}

/**
 * markdown-it-task-lists marks a whole <ul> when only some of its items are
 * tasks. Split those mixed lists before tiptap-markdown maps the DOM to its
 * homogeneous list node types.
 */
export function splitMixedTaskLists(root: Element): void {
  const lists = Array.from(root.querySelectorAll("ul.contains-task-list"));

  for (const list of lists) {
    const items = Array.from(list.children).filter(isListItem);
    if (items.length === 0) continue;

    const groups: HTMLLIElement[][] = [];
    for (const item of items) {
      const group = groups[groups.length - 1];
      if (group && isTaskItem(group[0]) === isTaskItem(item)) {
        group.push(item);
      } else {
        groups.push([item]);
      }
    }

    if (groups.length === 1) {
      if (isTaskItem(groups[0][0])) {
        list.setAttribute("data-type", "taskList");
      } else {
        list.removeAttribute("data-type");
      }
      continue;
    }

    const fragment = list.ownerDocument.createDocumentFragment();
    for (const group of groups) {
      const replacement = list.cloneNode(false) as HTMLUListElement;
      replacement.removeAttribute("data-type");
      if (isTaskItem(group[0])) {
        replacement.setAttribute("data-type", "taskList");
      }
      for (const item of group) replacement.appendChild(item);
      fragment.appendChild(replacement);
    }
    list.replaceWith(fragment);
  }
}
