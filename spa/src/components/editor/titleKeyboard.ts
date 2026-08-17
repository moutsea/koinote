export type TitleKeyDownState = {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
};

export function shouldLeaveTitleOnEnter(event: TitleKeyDownState): boolean {
  return (
    event.key === "Enter" &&
    event.isComposing !== true &&
    event.keyCode !== 229
  );
}
