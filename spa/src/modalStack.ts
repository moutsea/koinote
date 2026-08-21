let modalDepth = 0;

export function pushModal(): () => void {
  modalDepth += 1;
  let active = true;

  return () => {
    if (!active) return;
    active = false;
    modalDepth = Math.max(0, modalDepth - 1);
  };
}

export function isModalOpen(): boolean {
  return modalDepth > 0;
}

export function isOnlyModalOpen(): boolean {
  return modalDepth === 1;
}
