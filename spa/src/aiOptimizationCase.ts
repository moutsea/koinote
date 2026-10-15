// AI 优化案例的审阅前原文。案例页（AIOptimizationCasePage）用编辑器渲染它，
// Worker 边缘渲染（worker/seo.ts）把同一份文本写进静态正文，所以单独放在这个
// 不依赖 React / TipTap 的模块里。
export const CASE_ORIGINAL_MARKDOWN = `上周和大家分享了正在进行的在线 markdown 项目，没想到反响意外地不错，800 多的阅读，竟然有 21 条评论。

![](https://koinote.app/images/cases/ai-optimization/reader-response.png)

今天非常欣喜地宣布，koinote（锦鲤笔记）的 1.0 已经完成并且上线了，欢迎大家试用，多提意见。

![https://koinote.app](https://koinote.app/images/cases/ai-optimization/koinote-home.png)

并且完整的代码库也都开源了：

![https://github.com/moutsea/koinote](https://koinote.app/images/cases/ai-optimization/github-repository.png)

欢迎各位大佬多提 issue 和 PR。

上线之后我特地看了一下 \`claude\`的消耗，从立项之初的文档设计，再到上线之前的打磨修复问题，搭建发布链路等，一共刚好烧掉了价值 1000 刀的 token。

![](https://koinote.app/images/cases/ai-optimization/claude-cost.png)

1000 刀换一个中小型的项目，我觉得还是挺划算的。否则如果纯依赖人力古法编程的话，以我拙劣的前端水平，可能现在首页都还没有做完。

目前上线的第一版，只做了markdown 在线编辑，图床等核心功能，连会员体系、付费系统都没有做。

还做了十来个主题，这是我复用了追问 agent 里的。我发现手上项目多了还是挺有好处的，一个功能可以到处搬，一次开发，多次利用。

![](https://koinote.app/images/cases/ai-optimization/editor-themes.png)

所以目前是完全免费的，感谢赛博菩萨 cloudflare 低廉的存储价格，并且还免流量费，让我能为每个用户设置 500MB 的存储空间，对于大多数轻量级用户来说，这个容量应该完全够用了。

下一步打算完善一下会员体系，之后就是大家都期待的 AI 能力了。

关于 AI 这块，不知道大家都有哪些点子呢？

老实讲我当前的想法挺多的，很多功能都能往里面加，但我有点摸不准，还是想要看一看市场需求，用户的呼声。

所以欢迎给我留言，说说你们想要的功能，如果评估合理的话，一定都会加上的。`;
