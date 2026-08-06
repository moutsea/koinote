/**
 * 保存快捷键的匹配，纯函数。
 *
 * 抽出来是因为这里几乎全是边界情况，而判错的表现都很难靠手试发现：
 *   - 漏判 IME 组合态：中文/日文输入法拼字时按 s 会被当成保存，输入被打断
 *   - 漏判 repeat：按住不放会连发几十次 PUT
 *   - 多判 Ctrl+Shift+S：那是很多应用的「另存为」，抢掉它不合适
 * 这些都不会报错，只会偶尔表现得很怪。
 */

/** 匹配需要的字段。只取这几个，测试里不必造完整的 KeyboardEvent */
export type SaveKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 输入法组合态。KeyboardEvent 上是 isComposing */
  isComposing?: boolean;
  /** 按住不放时的重复触发 */
  repeat?: boolean;
};

/**
 * 是不是「保存」快捷键。
 *
 * Windows/Linux 上是 Ctrl+S，macOS 上是 Cmd+S。两个都收 —— Mac 上 Ctrl+S 本来没有
 * 别的含义，接受它对接外接键盘或从 Windows 过来的用户更友好，代价为零。
 *
 * 用 key 而不是 code/keyCode：key 反映的是用户实际打出的字符，换键盘布局（Dvorak、
 * AZERTY）时仍然对得上；code 是物理键位，Dvorak 下 KeyS 的位置根本不是 s。
 */
export function isSaveShortcut(e: SaveKeyEvent): boolean {
  // 输入法正在拼字，这时的按键属于候选词交互，不能拦
  if (e.isComposing) return false;
  // 按住不放只算一次。少了这条，长按会连发几十次请求
  if (e.repeat) return false;

  // 大小写都收：按 Shift 时 key 是 "S"。但 Shift 本身在下面会被拒
  if (e.key.toLowerCase() !== "s") return false;

  // 必须有且只有一个主修饰键。同时按住 Ctrl 和 Cmd 多半是误触
  const ctrl = e.ctrlKey;
  const meta = e.metaKey;
  if (ctrl === meta) return false; // 都没按，或都按了

  // Alt/Shift 的组合留给别人：Ctrl+Shift+S 是常见的「另存为」，
  // Ctrl+Alt+S 在一些 IDE 里是设置。抢掉它们会让用户很意外
  if (e.altKey || e.shiftKey) return false;

  return true;
}
