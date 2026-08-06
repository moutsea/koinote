/**
 * 文件树的缩进几何。
 *
 * 抽出来是因为文件夹行和文档行的内部结构不一样：文件夹行在图标前面还有一个
 * chevron，文档行没有。两种行如果用同一个 paddingLeft 基准，同一层的图标就不会对齐
 * —— 更糟的是子文档的图标会落在父文件夹图标的**左边**，层级看起来是平的。
 *
 * 所以文档行要额外补上 chevron 的宽度和它后面的间隙。
 */

/**
 * 每层缩进。
 *
 * 下限是 15px：文件夹图标的右沿在 folderPad(d) + 40，子文档图标在 folderPad(d+1) + 26，
 * 步长不超过 14 的话子项就顶不到父图标右边，层级又会看起来是平的。
 *
 * 曾经试过深层收窄步长来给窄侧栏省地方，但收窄到 12px 正好破掉上面这条，所以整棵树
 * 统一用一个步长。深到 8 层时标题会被截断 —— 侧栏本身可以拖宽（最多 520px），把这个
 * 交给用户比让层级看不出来更好。
 */
const STEP = 28;
/** 行内左内边距，对应文件夹行内层按钮的 px-2 */
const ROW_PAD = 8;
/** chevron 宽度，对应 h-3 w-3 */
const CHEVRON = 12;
/** chevron 与图标之间的间隙，对应 gap-1.5 */
const GAP = 6;
/** 图标宽度，对应 h-3.5 w-3.5 */
const ICON = 14;

/** 文件夹行的 paddingLeft。加在外层 div 上，内层按钮自己还有 px-2 */
export function folderPad(depth: number): number {
  return depth * STEP;
}

/**
 * 文档行的 paddingLeft。直接加在按钮上，所以要把文件夹行里的 px-2 一并算进来，
 * 再补 chevron + 间隙 —— 这样文档图标才和同层的文件夹图标对齐。
 */
export function docPad(depth: number): number {
  return folderPad(depth) + ROW_PAD + CHEVRON + GAP;
}

/**
 * 竖直引导线的 x 坐标。传父文件夹的 depth，线落在它 chevron 的中心，
 * 从视觉上把展开的子项收拢到这个文件夹下面。
 */
export function guideX(parentDepth: number): number {
  return folderPad(parentDepth) + ROW_PAD + CHEVRON / 2;
}

// 下面几个只用于断言，运行时不需要。
/** 文件夹行 chevron 的左沿 */
export function chevronX(depth: number): number {
  return folderPad(depth) + ROW_PAD;
}
/** 文件夹图标的左沿 */
export function folderIconX(depth: number): number {
  return folderPad(depth) + ROW_PAD + CHEVRON + GAP;
}
/** 文件夹图标的右沿 */
export function folderIconRightX(depth: number): number {
  return folderIconX(depth) + ICON;
}
/** 文档图标的左沿 */
export function docIconX(depth: number): number {
  return docPad(depth);
}
