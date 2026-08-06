// 保存快捷键的匹配。这里几乎全是边界情况，判错的表现都不报错、只是偶尔很怪：
// 拦了 IME 组合态会打断中文输入，漏判 repeat 会让长按连发几十次 PUT。
import { isSaveShortcut } from "./_save_shortcut_bundle.mjs";

let pass = 0;
let fail = 0;

/** 造一个事件。默认没按任何修饰键 */
function ev(over = {}) {
  return {
    key: "s",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...over,
  };
}

function hit(label, over) {
  if (isSaveShortcut(ev(over))) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  应触发: ${label}`);
  }
}

function miss(label, over) {
  if (!isSaveShortcut(ev(over))) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  不应触发: ${label}`);
  }
}

// ---------- 应该触发 ----------
hit("Ctrl+S（Windows/Linux）", { ctrlKey: true });
hit("Cmd+S（macOS）", { metaKey: true });
// 有些布局/状态下 key 会是大写
hit("Ctrl+S 且 key 为大写 S", { ctrlKey: true, key: "S" });
hit("Cmd+S 且 key 为大写 S", { metaKey: true, key: "S" });
// isComposing / repeat 缺省（老浏览器或合成事件里可能没有这两个字段）
hit("字段缺省时按 Ctrl+S", { ctrlKey: true, isComposing: undefined, repeat: undefined });

// ---------- 修饰键 ----------
miss("只按 s，没有修饰键", {});
miss("Shift+S（就是打一个大写 S）", { shiftKey: true, key: "S" });
miss("Alt+S", { altKey: true });
// Ctrl+Shift+S 是常见的「另存为」，不该被抢
miss("Ctrl+Shift+S", { ctrlKey: true, shiftKey: true, key: "S" });
miss("Cmd+Shift+S", { metaKey: true, shiftKey: true, key: "S" });
// Ctrl+Alt+S 在一些 IDE 里是设置
miss("Ctrl+Alt+S", { ctrlKey: true, altKey: true });
miss("Cmd+Alt+S", { metaKey: true, altKey: true });
// 同时按住 Ctrl 和 Cmd 多半是误触
miss("Ctrl+Cmd+S", { ctrlKey: true, metaKey: true });

// ---------- 别的键 ----------
for (const key of ["a", "d", "w", "z", "Enter", "Escape", "Tab", " ", "F5"]) {
  miss(`Ctrl+${key}`, { ctrlKey: true, key });
}
miss("Ctrl 加空字符串", { ctrlKey: true, key: "" });

// ---------- 输入法组合态 ----------
//
// 这条最要紧：应用支持中文与日文，拼字过程中按 s 是在选候选词。拦下来的话
// 输入会被打断，而用户完全不知道发生了什么
miss("拼音输入法组合中按 Ctrl+S", { ctrlKey: true, isComposing: true });
miss("日文输入法组合中按 Cmd+S", { metaKey: true, isComposing: true });

// ---------- 长按 ----------
miss("按住 Ctrl+S 不放的重复事件", { ctrlKey: true, repeat: true });
miss("按住 Cmd+S 不放的重复事件", { metaKey: true, repeat: true });

// ---------- 不变量 ----------
// 恰好一个主修饰键才成立
{
  for (const ctrlKey of [true, false]) {
    for (const metaKey of [true, false]) {
      const want = ctrlKey !== metaKey;
      const got = isSaveShortcut(ev({ ctrlKey, metaKey }));
      if (got === want) pass += 1;
      else {
        fail += 1;
        console.error(
          `FAIL  ctrl=${ctrlKey} meta=${metaKey} 期望 ${want}，得到 ${got}`,
        );
      }
    }
  }
}

// 任何 s 之外的键，在任何修饰键组合下都不该触发
{
  let leaked = null;
  for (const key of ["a", "S ", "ss", "Save", "5"]) {
    for (const ctrlKey of [true, false]) {
      for (const metaKey of [true, false]) {
        if (isSaveShortcut(ev({ key, ctrlKey, metaKey }))) {
          leaked = `${key} ctrl=${ctrlKey} meta=${metaKey}`;
        }
      }
    }
  }
  if (leaked === null) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  非 s 键触发了保存: ${leaked}`);
  }
}

// isComposing 与 repeat 是一票否决：其余条件全满足也不能触发
{
  for (const veto of ["isComposing", "repeat"]) {
    for (const mod of ["ctrlKey", "metaKey"]) {
      const got = isSaveShortcut(ev({ [mod]: true, [veto]: true }));
      if (!got) pass += 1;
      else {
        fail += 1;
        console.error(`FAIL  ${veto}=true 时 ${mod} 仍触发了保存`);
      }
    }
  }
}

console.log(`\nsave shortcut: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
