import { createLowlight, common } from "lowlight";

// 共享的 lowlight 实例，注册常见语言的语法高亮
export const lowlight = createLowlight(common);
