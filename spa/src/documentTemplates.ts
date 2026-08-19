import type { Locale } from "./i18n";

export const DOCUMENT_TEMPLATE_IDS = [
  "meeting-notes",
  "daily-note",
  "weekly-review",
  "todo-list",
  "table",
  "daily-report",
  "weekly-report",
  "okr",
  "kpi",
  "article-outline",
  "project-readme",
  "product-requirements",
  "research-paper",
  "decision-record",
  "technical-design",
] as const;

export type DocumentTemplateId = (typeof DOCUMENT_TEMPLATE_IDS)[number];
export type DocumentTemplateTier = "free" | "lifetime";
export type DocumentTemplateCategory =
  | "everyday"
  | "management"
  | "writing"
  | "product"
  | "technical";

export type DocumentTemplateDefinition = {
  id: DocumentTemplateId;
  tier: DocumentTemplateTier;
  category: DocumentTemplateCategory;
};

export const DOCUMENT_TEMPLATES: readonly DocumentTemplateDefinition[] = [
  { id: "meeting-notes", tier: "free", category: "everyday" },
  { id: "daily-note", tier: "free", category: "everyday" },
  { id: "weekly-review", tier: "free", category: "everyday" },
  { id: "todo-list", tier: "free", category: "everyday" },
  { id: "table", tier: "free", category: "everyday" },
  { id: "daily-report", tier: "lifetime", category: "management" },
  { id: "weekly-report", tier: "lifetime", category: "management" },
  { id: "okr", tier: "lifetime", category: "management" },
  { id: "kpi", tier: "lifetime", category: "management" },
  { id: "article-outline", tier: "lifetime", category: "writing" },
  { id: "research-paper", tier: "lifetime", category: "writing" },
  { id: "project-readme", tier: "lifetime", category: "product" },
  { id: "product-requirements", tier: "lifetime", category: "product" },
  { id: "decision-record", tier: "lifetime", category: "technical" },
  { id: "technical-design", tier: "lifetime", category: "technical" },
] as const;

type TemplateCopy = {
  title: string;
  content: string;
};

const DATE_LOCALES: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  ja: "ja-JP",
  fr: "fr-FR",
};

const TEMPLATE_COPIES: Record<
  DocumentTemplateId,
  Record<Locale, TemplateCopy>
> = {
  "meeting-notes": {
    zh: {
      title: "会议纪要 · {date}",
      content: `# 会议主题

> 日期：{date}<br>
> 参与者：<br>
> 记录人：

## 会议目标

用一两句话说明这次会议需要解决什么。

## 议程

- [ ] 议题一
- [ ] 议题二

## 讨论要点

### 议题一

- 事实与背景：
- 不同观点：
- 结论：

## 决策记录

| 决策 | 原因 | 负责人 |
| --- | --- | --- |
|  |  |  |

## 行动项

- [ ] 事项 — @负责人 — 截止日期

## 待确认问题

- …

## 下次会议

- 时间：
- 需要提前准备：`,
    },
    en: {
      title: "Meeting Notes · {date}",
      content: `# Meeting topic

> Date: {date}<br>
> Attendees:<br>
> Note taker:

## Objective

Describe in one or two sentences what this meeting must resolve.

## Agenda

- [ ] Topic one
- [ ] Topic two

## Discussion

### Topic one

- Facts and context:
- Perspectives:
- Conclusion:

## Decisions

| Decision | Rationale | Owner |
| --- | --- | --- |
|  |  |  |

## Action items

- [ ] Action — @owner — due date

## Open questions

- …

## Next meeting

- Time:
- Preparation:`,
    },
    ja: {
      title: "会議メモ · {date}",
      content: `# 会議テーマ

> 日付：{date}<br>
> 参加者：<br>
> 記録者：

## 目的

この会議で解決することを一、二文で記述します。

## アジェンダ

- [ ] 議題 1
- [ ] 議題 2

## 議論

### 議題 1

- 事実と背景：
- 意見：
- 結論：

## 決定事項

| 決定 | 理由 | 担当者 |
| --- | --- | --- |
|  |  |  |

## アクション

- [ ] 作業 — @担当者 — 期限

## 未解決事項

- …

## 次回

- 日時：
- 事前準備：`,
    },
    fr: {
      title: "Compte rendu · {date}",
      content: `# Sujet de la réunion

> Date : {date}<br>
> Participants :<br>
> Rédacteur :

## Objectif

Décrivez en une ou deux phrases ce que la réunion doit résoudre.

## Ordre du jour

- [ ] Sujet 1
- [ ] Sujet 2

## Discussion

### Sujet 1

- Faits et contexte :
- Points de vue :
- Conclusion :

## Décisions

| Décision | Justification | Responsable |
| --- | --- | --- |
|  |  |  |

## Actions

- [ ] Action — @responsable — échéance

## Questions ouvertes

- …

## Prochaine réunion

- Date :
- Préparation :`,
    },
  },
  "daily-note": {
    zh: {
      title: "每日记录 · {date}",
      content: `# {date}

## 今日重点

- [ ] 最重要的一件事
- [ ] 其他任务

## 过程记录

记录进展、事实、观察或临时决定。

## 灵感与资料

- 想法：
- 链接：

## 今日复盘

- 完成了什么：
- 遇到的阻碍：
- 学到的东西：
- 值得感谢的事：

## 明天先做

- [ ] `,
    },
    en: {
      title: "Daily Note · {date}",
      content: `# {date}

## Today's focus

- [ ] The one thing that matters most
- [ ] Other tasks

## Notes

Capture progress, facts, observations, and temporary decisions.

## Ideas and references

- Idea:
- Link:

## Reflection

- What I completed:
- What blocked me:
- What I learned:
- What I appreciate:

## Start here tomorrow

- [ ] `,
    },
    ja: {
      title: "デイリーノート · {date}",
      content: `# {date}

## 今日の重点

- [ ] 最も重要なこと
- [ ] その他のタスク

## 記録

進捗、事実、観察、暫定的な決定を記録します。

## アイデアと資料

- アイデア：
- リンク：

## 振り返り

- 完了したこと：
- 障害：
- 学んだこと：
- 感謝したこと：

## 明日の最初の一歩

- [ ] `,
    },
    fr: {
      title: "Note quotidienne · {date}",
      content: `# {date}

## Priorité du jour

- [ ] La chose la plus importante
- [ ] Autres tâches

## Notes

Consignez les progrès, faits, observations et décisions provisoires.

## Idées et références

- Idée :
- Lien :

## Bilan

- Réalisé :
- Blocages :
- Apprentissages :
- Gratitude :

## Premier pas demain

- [ ] `,
    },
  },
  "weekly-review": {
    zh: {
      title: "周计划与复盘 · {date}",
      content: `# 本周计划与复盘

> 创建于 {date}

## 本周三个目标

1. …
2. …
3. …

## 关键任务

- [ ] 重要且紧急
- [ ] 重要不紧急
- [ ] 可以委派或延后

## 日程与里程碑

| 日期 | 事项 | 结果标准 |
| --- | --- | --- |
|  |  |  |

## 本周复盘

- 最有价值的进展：
- 没有完成及原因：
- 精力最高/最低的时段：
- 下周需要继续：
- 应该停止做：`,
    },
    en: {
      title: "Weekly Plan & Review · {date}",
      content: `# Weekly plan and review

> Created {date}

## Three outcomes for this week

1. …
2. …
3. …

## Key tasks

- [ ] Important and urgent
- [ ] Important, not urgent
- [ ] Delegate or defer

## Schedule and milestones

| Date | Commitment | Definition of done |
| --- | --- | --- |
|  |  |  |

## Weekly review

- Most valuable progress:
- What was not completed and why:
- Highest/lowest energy periods:
- Carry into next week:
- Stop doing:`,
    },
    ja: {
      title: "週間計画と振り返り · {date}",
      content: `# 週間計画と振り返り

> 作成日：{date}

## 今週の三つの成果

1. …
2. …
3. …

## 主要タスク

- [ ] 重要かつ緊急
- [ ] 重要だが緊急ではない
- [ ] 委任または延期

## 日程とマイルストーン

| 日付 | 予定 | 完了条件 |
| --- | --- | --- |
|  |  |  |

## 週間レビュー

- 最も価値のある進捗：
- 未完了とその理由：
- 集中できた／できなかった時間：
- 来週へ持ち越すこと：
- やめること：`,
    },
    fr: {
      title: "Plan et bilan hebdomadaire · {date}",
      content: `# Plan et bilan hebdomadaire

> Créé le {date}

## Trois résultats pour la semaine

1. …
2. …
3. …

## Tâches clés

- [ ] Important et urgent
- [ ] Important, non urgent
- [ ] Déléguer ou reporter

## Calendrier et jalons

| Date | Engagement | Critère de réussite |
| --- | --- | --- |
|  |  |  |

## Bilan

- Progrès le plus utile :
- Non réalisé et pourquoi :
- Périodes de forte/faible énergie :
- À poursuivre la semaine prochaine :
- À arrêter :`,
    },
  },
  "todo-list": {
    zh: {
      title: "待办清单 · {date}",
      content: `# 待办清单

> 更新于 {date}

## 今天最重要的三件事

- [ ] 第一优先事项 — 完成标准：
- [ ] 第二优先事项 — 完成标准：
- [ ] 第三优先事项 — 完成标准：

## 收集箱

先把所有念头放进来，再决定执行、委派、延后或删除。

- [ ] …

## 按场景执行

### 深度工作

- [ ] 需要连续专注 30 分钟以上的任务

### 快速任务

- [ ] 15 分钟内可以完成的任务

### 沟通与行政

- [ ] 需要回复、预约、提交或确认的任务

## 等待与委派

| 事项 | 对接人 | 发出日期 | 跟进日期 | 状态 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 稍后 / 也许

- [ ] 不需要现在承诺，但值得保留的想法

## 今日收尾

- [ ] 完成项已勾选，未完成项已重新安排
- [ ] 收集箱已清空
- [ ] 明天的第一步已写清楚`,
    },
    en: {
      title: "To-do List · {date}",
      content: `# To-do list

> Updated {date}

## Today's three most important outcomes

- [ ] First priority — definition of done:
- [ ] Second priority — definition of done:
- [ ] Third priority — definition of done:

## Inbox

Capture everything first, then decide whether to do, delegate, defer, or delete it.

- [ ] …

## Work by context

### Deep work

- [ ] Work that needs at least 30 uninterrupted minutes

### Quick tasks

- [ ] Work that can be finished in 15 minutes

### Communication and admin

- [ ] Replies, scheduling, submissions, or confirmations

## Waiting and delegated

| Item | Person | Sent | Follow up | Status |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Someday / maybe

- [ ] Ideas worth keeping without committing now

## End-of-day reset

- [ ] Completed work is checked; unfinished work is rescheduled
- [ ] Inbox is empty
- [ ] Tomorrow's first action is explicit`,
    },
    ja: {
      title: "ToDo リスト · {date}",
      content: `# ToDo リスト

> 更新日：{date}

## 今日最も重要な三つの成果

- [ ] 最優先 — 完了条件：
- [ ] 二番目 — 完了条件：
- [ ] 三番目 — 完了条件：

## インボックス

まず全部を書き出し、実行・委任・延期・削除を後から判断します。

- [ ] …

## 状況別に実行

### 集中作業

- [ ] 30 分以上の連続した集中が必要な作業

### クイックタスク

- [ ] 15 分以内に終えられる作業

### 連絡・事務

- [ ] 返信、予約、提出、確認が必要な作業

## 待機・委任

| 項目 | 相手 | 依頼日 | フォロー日 | 状態 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## いつか / たぶん

- [ ] 今は約束しないが残しておきたいアイデア

## 一日の終了処理

- [ ] 完了を記録し、未完了を再配置した
- [ ] インボックスを空にした
- [ ] 明日の最初の行動を明確にした`,
    },
    fr: {
      title: "Liste de tâches · {date}",
      content: `# Liste de tâches

> Mise à jour le {date}

## Trois résultats essentiels aujourd'hui

- [ ] Première priorité — critère de réussite :
- [ ] Deuxième priorité — critère de réussite :
- [ ] Troisième priorité — critère de réussite :

## Boîte de réception

Capturez tout, puis décidez de faire, déléguer, reporter ou supprimer.

- [ ] …

## Exécution par contexte

### Travail concentré

- [ ] Tâche demandant au moins 30 minutes sans interruption

### Tâches rapides

- [ ] Tâche réalisable en moins de 15 minutes

### Communication et administration

- [ ] Réponse, rendez-vous, envoi ou validation

## En attente et délégué

| Élément | Interlocuteur | Envoi | Relance | Statut |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Un jour / peut-être

- [ ] Idée à conserver sans engagement immédiat

## Clôture de la journée

- [ ] Le travail terminé est coché et le reste replanifié
- [ ] La boîte de réception est vide
- [ ] La première action de demain est explicite`,
    },
  },
  table: {
    zh: {
      title: "通用表格 · {date}",
      content: `# 通用表格

> 创建于 {date}

## 使用说明

1. 先定义每一列的含义和填写规则。
2. 状态、优先级等字段尽量使用固定选项，便于筛选。
3. 定期把关键数字汇总到下方，避免表格只增不复盘。

## 字段定义

| 字段 | 含义 | 允许值 / 格式 | 是否必填 |
| --- | --- | --- | --- |
| 状态 | 当前进度 | 未开始 / 进行中 / 已完成 / 阻塞 | 是 |
| 优先级 | 处理顺序 | P0 / P1 / P2 / P3 | 是 |

## 主表

| ID | 项目 | 分类 | 状态 | 优先级 | 负责人 | 截止日期 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 001 |  |  | 未开始 | P2 |  |  |  |
| 002 |  |  | 未开始 | P2 |  |  |  |

## 常用视图

- 需要立即处理：状态为“阻塞”或优先级为 P0
- 本周到期：截止日期位于本周
- 等待他人：负责人不是自己且状态未完成

## 汇总

| 指标 | 当前值 | 统计口径 | 更新时间 |
| --- | ---: | --- | --- |
| 总数 | 0 | 主表全部数据行 | {date} |
| 已完成 | 0 | 状态为“已完成” | {date} |

## 变更记录

| 日期 | 修改人 | 变更 | 原因 |
| --- | --- | --- | --- |
| {date} |  | 创建表格 |  |`,
    },
    en: {
      title: "General Table · {date}",
      content: `# General table

> Created {date}

## How to use this table

1. Define the meaning and input rules for every column.
2. Use controlled values for status and priority so rows stay filterable.
3. Review the summary regularly instead of letting the table only grow.

## Field definitions

| Field | Meaning | Allowed values / format | Required |
| --- | --- | --- | --- |
| Status | Current progress | Not started / In progress / Done / Blocked | Yes |
| Priority | Order of attention | P0 / P1 / P2 / P3 | Yes |

## Main table

| ID | Item | Category | Status | Priority | Owner | Due date | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 001 |  |  | Not started | P2 |  |  |  |
| 002 |  |  | Not started | P2 |  |  |  |

## Useful views

- Act now: status is Blocked or priority is P0
- Due this week: due date falls in the current week
- Waiting on others: owner is someone else and status is not Done

## Summary

| Metric | Current | Definition | Updated |
| --- | ---: | --- | --- |
| Total | 0 | All data rows in the main table | {date} |
| Done | 0 | Rows whose status is Done | {date} |

## Change log

| Date | Editor | Change | Reason |
| --- | --- | --- | --- |
| {date} |  | Created table |  |`,
    },
    ja: {
      title: "汎用テーブル · {date}",
      content: `# 汎用テーブル

> 作成日：{date}

## 使い方

1. 各列の意味と入力規則を先に定義します。
2. 状態や優先度は固定値を使い、絞り込みやすくします。
3. 表を増やすだけでなく、下の集計を定期的に見直します。

## フィールド定義

| フィールド | 意味 | 許可する値 / 形式 | 必須 |
| --- | --- | --- | --- |
| 状態 | 現在の進捗 | 未着手 / 進行中 / 完了 / ブロック | はい |
| 優先度 | 対応順 | P0 / P1 / P2 / P3 | はい |

## メインテーブル

| ID | 項目 | 分類 | 状態 | 優先度 | 担当者 | 期限 | メモ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 001 |  |  | 未着手 | P2 |  |  |  |
| 002 |  |  | 未着手 | P2 |  |  |  |

## よく使うビュー

- 即時対応：状態が「ブロック」または優先度が P0
- 今週期限：期限が今週内
- 他者待ち：自分以外が担当し、未完了

## 集計

| 指標 | 現在値 | 集計条件 | 更新日 |
| --- | ---: | --- | --- |
| 合計 | 0 | メインテーブルの全データ行 | {date} |
| 完了 | 0 | 状態が「完了」 | {date} |

## 変更履歴

| 日付 | 編集者 | 変更 | 理由 |
| --- | --- | --- | --- |
| {date} |  | テーブル作成 |  |`,
    },
    fr: {
      title: "Tableau générique · {date}",
      content: `# Tableau générique

> Créé le {date}

## Mode d'emploi

1. Définissez le sens et les règles de saisie de chaque colonne.
2. Utilisez des valeurs contrôlées pour le statut et la priorité afin de faciliter les filtres.
3. Revoyez régulièrement la synthèse au lieu de seulement ajouter des lignes.

## Définition des champs

| Champ | Signification | Valeurs / format autorisés | Obligatoire |
| --- | --- | --- | --- |
| Statut | Avancement actuel | Non commencé / En cours / Terminé / Bloqué | Oui |
| Priorité | Ordre de traitement | P0 / P1 / P2 / P3 | Oui |

## Tableau principal

| ID | Élément | Catégorie | Statut | Priorité | Responsable | Échéance | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 001 |  |  | Non commencé | P2 |  |  |  |
| 002 |  |  | Non commencé | P2 |  |  |  |

## Vues utiles

- Agir maintenant : statut Bloqué ou priorité P0
- Échéance cette semaine : date située dans la semaine courante
- En attente d'un tiers : responsable différent et statut non terminé

## Synthèse

| Indicateur | Valeur | Définition | Mise à jour |
| --- | ---: | --- | --- |
| Total | 0 | Toutes les lignes du tableau principal | {date} |
| Terminé | 0 | Lignes dont le statut est Terminé | {date} |

## Historique des modifications

| Date | Éditeur | Modification | Raison |
| --- | --- | --- | --- |
| {date} |  | Création du tableau |  |`,
    },
  },
  "daily-report": {
    zh: {
      title: "工作日报 · {date}",
      content: `# 工作日报

> 日期：{date}<br>
> 姓名 / 团队：<br>
> 今日状态：正常 / 有风险 / 阻塞

## 一句话摘要

用一句话说明今天最重要的结果，而不是罗列活动。

## 今日完成

| 计划事项 | 实际结果 | 证据 / 链接 | 状态 |
| --- | --- | --- | --- |
|  |  |  | 完成 / 部分完成 / 未完成 |

## 关键数据

| 指标 | 昨日 / 基线 | 今日 | 变化 | 说明 |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## 问题、风险与阻塞

| 问题 | 影响 | 已采取措施 | 需要谁支持 | 截止时间 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 今日决策与重要信息

- 决策：
- 原因：
- 影响范围：

## 明日优先事项

1. … — 完成标准：
2. … — 完成标准：
3. … — 完成标准：

## 交接与提醒

- 需要他人知晓：
- 等待回复：
- 相关文档：`,
    },
    en: {
      title: "Daily Work Report · {date}",
      content: `# Daily work report

> Date: {date}<br>
> Person / team:<br>
> Overall status: On track / At risk / Blocked

## One-sentence summary

State the most important outcome of the day instead of listing activity.

## Completed today

| Planned work | Actual outcome | Evidence / link | Status |
| --- | --- | --- | --- |
|  |  |  | Done / Partial / Not done |

## Key data

| Metric | Yesterday / baseline | Today | Change | Explanation |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## Issues, risks, and blockers

| Issue | Impact | Action taken | Support needed | Deadline |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Decisions and important information

- Decision:
- Rationale:
- Affected scope:

## Priorities for tomorrow

1. … — definition of done:
2. … — definition of done:
3. … — definition of done:

## Handoffs and reminders

- Others need to know:
- Waiting for:
- Related documents:`,
    },
    ja: {
      title: "業務日報 · {date}",
      content: `# 業務日報

> 日付：{date}<br>
> 氏名 / チーム：<br>
> 全体状況：順調 / リスクあり / ブロック

## 一文サマリー

活動の羅列ではなく、今日最も重要だった成果を一文で示します。

## 本日の完了事項

| 計画 | 実際の成果 | 根拠 / リンク | 状態 |
| --- | --- | --- | --- |
|  |  |  | 完了 / 一部完了 / 未完了 |

## 主要データ

| 指標 | 前日 / 基準 | 本日 | 変化 | 説明 |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## 問題・リスク・障害

| 問題 | 影響 | 実施した対応 | 必要な支援 | 期限 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 本日の決定と重要情報

- 決定：
- 理由：
- 影響範囲：

## 明日の優先事項

1. … — 完了条件：
2. … — 完了条件：
3. … — 完了条件：

## 引き継ぎと注意事項

- 共有が必要なこと：
- 返信待ち：
- 関連文書：`,
    },
    fr: {
      title: "Rapport quotidien · {date}",
      content: `# Rapport quotidien

> Date : {date}<br>
> Personne / équipe :<br>
> Situation : Conforme / À risque / Bloquée

## Résumé en une phrase

Présentez le résultat le plus important de la journée plutôt qu'une liste d'activités.

## Réalisé aujourd'hui

| Travail prévu | Résultat obtenu | Preuve / lien | Statut |
| --- | --- | --- | --- |
|  |  |  | Terminé / Partiel / Non terminé |

## Données clés

| Indicateur | Hier / référence | Aujourd'hui | Évolution | Explication |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## Problèmes, risques et blocages

| Problème | Impact | Action menée | Soutien requis | Échéance |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Décisions et informations importantes

- Décision :
- Justification :
- Périmètre affecté :

## Priorités de demain

1. … — critère de réussite :
2. … — critère de réussite :
3. … — critère de réussite :

## Transmissions et rappels

- À communiquer :
- En attente de :
- Documents associés :`,
    },
  },
  "weekly-report": {
    zh: {
      title: "工作周报 · {date}",
      content: `# 工作周报

> 周期：<br>
> 姓名 / 团队：<br>
> 更新时间：{date}<br>
> 总体状态：正常 / 有风险 / 阻塞

## 本周摘要

用三句话回答：完成了什么、产生了什么价值、当前最大的风险是什么。

## 关键成果

1. **成果一** — 业务 / 用户价值：
2. **成果二** — 业务 / 用户价值：
3. **成果三** — 业务 / 用户价值：

## 工作流进展

| 工作流 / 项目 | 本周目标 | 实际进展 | 状态 | 下一里程碑 |
| --- | --- | --- | --- | --- |
|  |  |  | 正常 / 有风险 / 阻塞 |  |

## 指标与趋势

| 指标 | 上周 | 本周 | 目标 | 趋势与原因 |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## 偏差与未完成事项

| 原计划 | 当前结果 | 偏差原因 | 调整方案 | 新日期 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 风险、依赖与所需支持

- 风险：
- 外部依赖：
- 需要的决策 / 资源：

## 下周三个优先结果

1. … — 衡量标准：
2. … — 衡量标准：
3. … — 衡量标准：

## 复盘

- 应该继续：
- 应该停止：
- 应该开始：`,
    },
    en: {
      title: "Weekly Work Report · {date}",
      content: `# Weekly work report

> Period:<br>
> Person / team:<br>
> Updated: {date}<br>
> Overall status: On track / At risk / Blocked

## Weekly summary

Answer in three sentences: what was completed, what value it created, and the largest current risk.

## Key outcomes

1. **Outcome one** — business / user value:
2. **Outcome two** — business / user value:
3. **Outcome three** — business / user value:

## Workstream progress

| Workstream / project | Weekly goal | Actual progress | Status | Next milestone |
| --- | --- | --- | --- | --- |
|  |  |  | On track / At risk / Blocked |  |

## Metrics and trends

| Metric | Last week | This week | Target | Trend and reason |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## Variance and unfinished work

| Original plan | Current result | Cause | Adjustment | New date |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Risks, dependencies, and support

- Risk:
- External dependency:
- Decision / resource needed:

## Three priority outcomes for next week

1. … — measure of success:
2. … — measure of success:
3. … — measure of success:

## Retrospective

- Continue:
- Stop:
- Start:`,
    },
    ja: {
      title: "業務週報 · {date}",
      content: `# 業務週報

> 対象期間：<br>
> 氏名 / チーム：<br>
> 更新日：{date}<br>
> 全体状況：順調 / リスクあり / ブロック

## 週間サマリー

完了したこと、生み出した価値、現在最大のリスクを三文で説明します。

## 主な成果

1. **成果 1** — 事業 / ユーザーへの価値：
2. **成果 2** — 事業 / ユーザーへの価値：
3. **成果 3** — 事業 / ユーザーへの価値：

## ワークストリームの進捗

| 項目 / プロジェクト | 今週の目標 | 実際の進捗 | 状態 | 次のマイルストーン |
| --- | --- | --- | --- | --- |
|  |  |  | 順調 / リスクあり / ブロック |  |

## 指標と傾向

| 指標 | 先週 | 今週 | 目標 | 傾向と理由 |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## 予定との差と未完了事項

| 当初計画 | 現在の結果 | 原因 | 調整 | 新しい日付 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## リスク・依存関係・必要な支援

- リスク：
- 外部依存：
- 必要な意思決定 / リソース：

## 来週の三つの優先成果

1. … — 成功指標：
2. … — 成功指標：
3. … — 成功指標：

## 振り返り

- 続けること：
- やめること：
- 始めること：`,
    },
    fr: {
      title: "Rapport hebdomadaire · {date}",
      content: `# Rapport hebdomadaire

> Période :<br>
> Personne / équipe :<br>
> Mise à jour : {date}<br>
> Situation : Conforme / À risque / Bloquée

## Résumé de la semaine

Répondez en trois phrases : ce qui a été réalisé, la valeur créée et le principal risque actuel.

## Résultats clés

1. **Résultat 1** — valeur métier / utilisateur :
2. **Résultat 2** — valeur métier / utilisateur :
3. **Résultat 3** — valeur métier / utilisateur :

## Avancement par chantier

| Chantier / projet | Objectif de la semaine | Avancement réel | Statut | Prochain jalon |
| --- | --- | --- | --- | --- |
|  |  |  | Conforme / À risque / Bloqué |  |

## Indicateurs et tendances

| Indicateur | Semaine précédente | Cette semaine | Cible | Tendance et raison |
| --- | ---: | ---: | ---: | --- |
|  |  |  |  |  |

## Écarts et travail non terminé

| Plan initial | Résultat actuel | Cause | Ajustement | Nouvelle date |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Risques, dépendances et soutien

- Risque :
- Dépendance externe :
- Décision / ressource nécessaire :

## Trois résultats prioritaires la semaine prochaine

1. … — mesure de réussite :
2. … — mesure de réussite :
3. … — mesure de réussite :

## Rétrospective

- Continuer :
- Arrêter :
- Commencer :`,
    },
  },
  okr: {
    zh: {
      title: "OKR 规划与复盘 · {date}",
      content: `# OKR 规划与复盘

> 周期：<br>
> 团队 / 负责人：<br>
> 更新日期：{date}<br>
> 状态：草案 / 已确认 / 执行中 / 已复盘

## 战略背景

- 当前最重要的问题或机会：
- 本周期为什么必须解决：
- 不做什么：

## Objective

**目标：** 用鼓舞人心、方向明确且不直接包含数字的一句话描述想实现的改变。

### 目标质量检查

- [ ] 与团队战略直接相关
- [ ] 聚焦结果而非任务清单
- [ ] 一个周期内具有挑战但可达成
- [ ] 团队成员能用自己的话解释

## Key Results

| KR | 衡量指标与口径 | 基线 | 目标 | 当前值 | 负责人 | 置信度 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| KR1 | 从……提升到…… |  |  |  |  | 50% |
| KR2 | 将……降低到…… |  |  |  |  | 50% |
| KR3 | 达到……且满足…… |  |  |  |  | 50% |

## 关键举措

举措是为了推动 KR 的假设和行动，不要把举措本身写成 KR。

| 举措 | 关联 KR | 负责人 | 里程碑 | 状态 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 每周 Check-in

| 日期 | KR 当前值 | 置信度 | 本周进展 | 风险 / 下一步 |
| --- | --- | ---: | --- | --- |
| {date} |  | 50% |  |  |

## 依赖与风险

- 关键依赖：
- 最大风险：
- 触发调整的信号：

## 周期结束评分

| KR | 完成度（0–1.0） | 结果解释 | 是否真正产生价值 |
| --- | ---: | --- | --- |
| KR1 |  |  |  |

## 复盘

- 最有效的假设：
- 失效的假设：
- 意外结果：
- 下周期延续 / 停止 / 新增：`,
    },
    en: {
      title: "OKR Planning & Review · {date}",
      content: `# OKR planning and review

> Cycle:<br>
> Team / owner:<br>
> Updated: {date}<br>
> Status: Draft / Committed / In progress / Reviewed

## Strategic context

- Most important problem or opportunity:
- Why it matters in this cycle:
- Explicit non-goals:

## Objective

**Objective:** Describe the desired change in one directional, motivating sentence without turning it into a metric.

### Objective quality check

- [ ] Directly supports the team's strategy
- [ ] Describes an outcome, not a task list
- [ ] Ambitious but plausible within one cycle
- [ ] Team members can explain it in their own words

## Key results

| KR | Metric and definition | Baseline | Target | Current | Owner | Confidence |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| KR1 | Increase … from … to … |  |  |  |  | 50% |
| KR2 | Reduce … to … |  |  |  |  | 50% |
| KR3 | Reach … while maintaining … |  |  |  |  | 50% |

## Initiatives

Initiatives are hypotheses and actions intended to move a KR; do not disguise activities as key results.

| Initiative | Related KR | Owner | Milestone | Status |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Weekly check-in

| Date | Current KR value | Confidence | Progress | Risk / next action |
| --- | --- | ---: | --- | --- |
| {date} |  | 50% |  |  |

## Dependencies and risks

- Critical dependency:
- Largest risk:
- Signal that should trigger an adjustment:

## End-of-cycle scoring

| KR | Score (0–1.0) | Explanation | Did it create real value? |
| --- | ---: | --- | --- |
| KR1 |  |  |  |

## Retrospective

- Most useful hypothesis:
- Invalidated hypothesis:
- Unexpected result:
- Continue / stop / add next cycle:`,
    },
    ja: {
      title: "OKR 計画と振り返り · {date}",
      content: `# OKR 計画と振り返り

> 期間：<br>
> チーム / 責任者：<br>
> 更新日：{date}<br>
> 状態：草案 / 合意済み / 実行中 / 振り返り済み

## 戦略的背景

- 最も重要な問題または機会：
- この期間に取り組む理由：
- 明確に対象外とすること：

## Objective

**目標：** 数値そのものではなく、実現したい変化を方向性のある魅力的な一文で表します。

### 目標の品質チェック

- [ ] チーム戦略に直接つながっている
- [ ] タスク一覧ではなく成果を示している
- [ ] 一期間で挑戦的かつ現実的である
- [ ] メンバーが自分の言葉で説明できる

## Key Results

| KR | 指標と定義 | 基準値 | 目標 | 現在値 | 担当者 | 確信度 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| KR1 | …を…から…へ向上 |  |  |  |  | 50% |
| KR2 | …を…まで削減 |  |  |  |  | 50% |
| KR3 | …を維持しながら…を達成 |  |  |  |  | 50% |

## 主要施策

施策は KR を動かす仮説と行動です。活動自体を KR にしないようにします。

| 施策 | 関連 KR | 担当者 | マイルストーン | 状態 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 毎週のチェックイン

| 日付 | KR 現在値 | 確信度 | 今週の進捗 | リスク / 次の行動 |
| --- | --- | ---: | --- | --- |
| {date} |  | 50% |  |  |

## 依存関係とリスク

- 重要な依存：
- 最大のリスク：
- 方針変更を判断するシグナル：

## 期間終了時の採点

| KR | 達成度（0–1.0） | 結果の説明 | 実際の価値を生んだか |
| --- | ---: | --- | --- |
| KR1 |  |  |  |

## 振り返り

- 最も有効だった仮説：
- 無効と分かった仮説：
- 予想外の結果：
- 次期間に続ける / やめる / 追加すること：`,
    },
    fr: {
      title: "Planification et bilan OKR · {date}",
      content: `# Planification et bilan OKR

> Cycle :<br>
> Équipe / responsable :<br>
> Mise à jour : {date}<br>
> Statut : Brouillon / Validé / En cours / Analysé

## Contexte stratégique

- Problème ou opportunité prioritaire :
- Pourquoi agir pendant ce cycle :
- Éléments explicitement hors périmètre :

## Objective

**Objectif :** Décrivez le changement recherché en une phrase motivante et directionnelle, sans le réduire à un chiffre.

### Contrôle qualité de l'objectif

- [ ] Soutient directement la stratégie de l'équipe
- [ ] Décrit un résultat plutôt qu'une liste de tâches
- [ ] Ambitieux mais crédible sur un cycle
- [ ] Chaque membre peut l'expliquer avec ses propres mots

## Key Results

| KR | Indicateur et définition | Référence | Cible | Actuel | Responsable | Confiance |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| KR1 | Faire progresser … de … à … |  |  |  |  | 50 % |
| KR2 | Réduire … jusqu'à … |  |  |  |  | 50 % |
| KR3 | Atteindre … tout en maintenant … |  |  |  |  | 50 % |

## Initiatives

Les initiatives sont des hypothèses et actions destinées à faire évoluer un KR ; ne transformez pas une activité en résultat clé.

| Initiative | KR associé | Responsable | Jalon | Statut |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Suivi hebdomadaire

| Date | Valeur actuelle du KR | Confiance | Progrès | Risque / prochaine action |
| --- | --- | ---: | --- | --- |
| {date} |  | 50 % |  |  |

## Dépendances et risques

- Dépendance critique :
- Risque principal :
- Signal devant déclencher un ajustement :

## Évaluation de fin de cycle

| KR | Score (0–1,0) | Explication | Valeur réellement créée ? |
| --- | ---: | --- | --- |
| KR1 |  |  |  |

## Rétrospective

- Hypothèse la plus utile :
- Hypothèse invalidée :
- Résultat inattendu :
- Continuer / arrêter / ajouter au prochain cycle :`,
    },
  },
  kpi: {
    zh: {
      title: "KPI 指标看板 · {date}",
      content: `# KPI 指标看板

> 统计周期：<br>
> 团队 / 负责人：<br>
> 更新时间：{date}

## 业务目标与指标边界

- KPI 服务的业务目标：
- 适用范围：
- 不应被该指标驱动的行为：

## KPI 定义表

| KPI | 业务含义 | 计算公式 | 数据源 | 基线 | 目标 | 当前值 | 频率 | 负责人 | 状态 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
|  |  |  |  |  |  |  | 日 / 周 / 月 |  | 正常 / 预警 / 异常 |

## 护栏指标

主指标变好时，下列指标不能明显恶化。

| 护栏指标 | 可接受范围 | 当前值 | 状态 | 说明 |
| --- | --- | ---: | --- | --- |
|  |  |  |  |  |

## 阈值与响应

| 级别 | 触发条件 | 响应动作 | 负责人 | 响应时限 |
| --- | --- | --- | --- | --- |
| 预警 | 偏离目标 …% | 分析原因并记录 |  |  |
| 异常 | 连续 … 个周期低于阈值 | 启动专项行动 |  |  |

## 本期解读

- 变化最大的指标及原因：
- 一次性波动还是持续趋势：
- 数据是否完整、延迟或存在偏差：
- 与业务结果是否一致：

## 行动计划

| 行动 | 关联 KPI | 预期影响 | 负责人 | 截止日期 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## 数据质量检查

- [ ] 公式、单位、时区与统计窗口明确
- [ ] 数据源可追溯且刷新正常
- [ ] 异常值、缺失值和口径变更已说明
- [ ] 指标没有被重复计算或选择性呈现

## 口径变更记录

| 日期 | KPI | 旧口径 | 新口径 | 原因 | 影响 |
| --- | --- | --- | --- | --- | --- |
| {date} |  |  |  |  |  |`,
    },
    en: {
      title: "KPI Dashboard · {date}",
      content: `# KPI dashboard

> Reporting period:<br>
> Team / owner:<br>
> Updated: {date}

## Business goal and metric boundaries

- Business goal supported by these KPIs:
- Scope:
- Behaviors this metric must not encourage:

## KPI definitions

| KPI | Business meaning | Formula | Data source | Baseline | Target | Current | Frequency | Owner | Status |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
|  |  |  |  |  |  |  | Daily / Weekly / Monthly |  | Healthy / Warning / Critical |

## Guardrail metrics

The following metrics must not materially worsen while the primary KPI improves.

| Guardrail | Acceptable range | Current | Status | Notes |
| --- | --- | ---: | --- | --- |
|  |  |  |  |  |

## Thresholds and response

| Level | Trigger | Response | Owner | Response time |
| --- | --- | --- | --- | --- |
| Warning | Deviation of …% from target | Analyze and document cause |  |  |
| Critical | Below threshold for … periods | Start a focused action plan |  |  |

## Period interpretation

- Metric with the largest change and why:
- One-off variation or sustained trend:
- Data completeness, delay, or bias:
- Alignment with the actual business outcome:

## Action plan

| Action | Related KPI | Expected impact | Owner | Due date | Validation |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Data-quality checklist

- [ ] Formula, unit, time zone, and reporting window are explicit
- [ ] Data source is traceable and refreshing normally
- [ ] Outliers, missing data, and definition changes are documented
- [ ] Metrics are not double-counted or selectively presented

## Definition change log

| Date | KPI | Previous definition | New definition | Reason | Impact |
| --- | --- | --- | --- | --- | --- |
| {date} |  |  |  |  |  |`,
    },
    ja: {
      title: "KPI ダッシュボード · {date}",
      content: `# KPI ダッシュボード

> 集計期間：<br>
> チーム / 責任者：<br>
> 更新日：{date}

## 事業目標と指標の境界

- KPI が支える事業目標：
- 適用範囲：
- この指標で促してはいけない行動：

## KPI 定義

| KPI | 事業上の意味 | 計算式 | データソース | 基準値 | 目標 | 現在値 | 頻度 | 担当者 | 状態 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
|  |  |  |  |  |  |  | 日次 / 週次 / 月次 |  | 正常 / 警告 / 異常 |

## ガードレール指標

主要 KPI が改善しても、次の指標を大きく悪化させてはいけません。

| ガードレール | 許容範囲 | 現在値 | 状態 | メモ |
| --- | --- | ---: | --- | --- |
|  |  |  |  |  |

## しきい値と対応

| レベル | 発動条件 | 対応 | 担当者 | 対応期限 |
| --- | --- | --- | --- | --- |
| 警告 | 目標から …% 乖離 | 原因を分析し記録 |  |  |
| 異常 | … 期間連続でしきい値未満 | 集中改善を開始 |  |  |

## 今期の解釈

- 最も変化した指標と理由：
- 一時的な変動か継続的な傾向か：
- データの欠損、遅延、偏り：
- 実際の事業成果との整合性：

## アクションプラン

| 行動 | 関連 KPI | 期待効果 | 担当者 | 期限 | 検証方法 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## データ品質チェック

- [ ] 計算式、単位、タイムゾーン、集計期間が明確
- [ ] データソースを追跡でき、正常に更新されている
- [ ] 外れ値、欠損、定義変更を説明している
- [ ] 二重計上や選択的な提示がない

## 定義変更履歴

| 日付 | KPI | 旧定義 | 新定義 | 理由 | 影響 |
| --- | --- | --- | --- | --- | --- |
| {date} |  |  |  |  |  |`,
    },
    fr: {
      title: "Tableau de bord KPI · {date}",
      content: `# Tableau de bord KPI

> Période de mesure :<br>
> Équipe / responsable :<br>
> Mise à jour : {date}

## Objectif métier et limites des indicateurs

- Objectif métier soutenu par ces KPI :
- Périmètre :
- Comportements que l'indicateur ne doit pas encourager :

## Définition des KPI

| KPI | Sens métier | Formule | Source | Référence | Cible | Actuel | Fréquence | Responsable | Statut |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
|  |  |  |  |  |  |  | Quotidienne / Hebdomadaire / Mensuelle |  | Normal / Alerte / Critique |

## Indicateurs garde-fous

Les indicateurs suivants ne doivent pas se dégrader sensiblement lorsque le KPI principal progresse.

| Garde-fou | Plage acceptable | Actuel | Statut | Notes |
| --- | --- | ---: | --- | --- |
|  |  |  |  |  |

## Seuils et réponses

| Niveau | Déclencheur | Réponse | Responsable | Délai |
| --- | --- | --- | --- | --- |
| Alerte | Écart de … % à la cible | Analyser et documenter la cause |  |  |
| Critique | Sous le seuil pendant … périodes | Lancer un plan d'action dédié |  |  |

## Interprétation de la période

- Indicateur ayant le plus évolué et pourquoi :
- Variation ponctuelle ou tendance durable :
- Complétude, retard ou biais des données :
- Cohérence avec le résultat métier réel :

## Plan d'action

| Action | KPI associé | Impact attendu | Responsable | Échéance | Validation |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Contrôle de qualité des données

- [ ] Formule, unité, fuseau horaire et fenêtre de mesure explicites
- [ ] Source traçable et correctement actualisée
- [ ] Valeurs aberrantes, données manquantes et changements documentés
- [ ] Aucun double comptage ni présentation sélective

## Historique des définitions

| Date | KPI | Ancienne définition | Nouvelle définition | Raison | Impact |
| --- | --- | --- | --- | --- | --- |
| {date} |  |  |  |  |  |`,
    },
  },
  "article-outline": {
    zh: {
      title: "文章策划 · {date}",
      content: `# 文章标题

> 一句话价值：读者看完后能获得什么？

## 目标读者

- 谁会读：
- 他们当前的困惑：
- 希望他们读完采取什么行动：

## 标题候选

1. 结果 + 明确对象
2. 冲突/反常识 + 收益
3. 具体数字 + 可验证承诺

## 开头钩子

用场景、冲突、数据或问题在前三句建立阅读理由。

## 核心观点

一句话写清文章唯一要证明的主张。

## 正文结构

### 一、问题为什么值得关注

- 真实场景：
- 常见误区：

### 二、核心方法或解释

- 观点：
- 证据/案例：
- 对读者的意义：

### 三、如何行动

1. 第一步
2. 第二步
3. 第三步

## 结尾

- 重申价值：
- 行动号召：
- 留给读者的问题：

## 发布前检查

- [ ] 标题与正文承诺一致
- [ ] 每个结论都有案例、数据或推理支撑
- [ ] 删除重复段落与空泛表达
- [ ] 小标题单独浏览也能理解逻辑
- [ ] 移动端段落不过长`,
    },
    en: {
      title: "Article Brief · {date}",
      content: `# Article title

> One-sentence value: what will the reader gain?

## Audience

- Who is this for:
- Their current struggle:
- Desired action after reading:

## Title candidates

1. Outcome + specific audience
2. Tension or counter-intuition + benefit
3. Concrete number + verifiable promise

## Opening hook

Use a scene, tension, fact, or question to earn attention in three sentences.

## Central claim

State the single idea this article will prove.

## Structure

### 1. Why the problem matters

- Real situation:
- Common misconception:

### 2. The method or explanation

- Claim:
- Evidence/example:
- Why it matters to the reader:

### 3. How to act

1. First step
2. Second step
3. Third step

## Ending

- Restate the value:
- Call to action:
- Question for the reader:

## Pre-publish checklist

- [ ] The title's promise matches the article
- [ ] Every conclusion has evidence or reasoning
- [ ] Repetition and vague language are removed
- [ ] Headings alone communicate the logic
- [ ] Paragraphs remain readable on mobile`,
    },
    ja: {
      title: "記事企画 · {date}",
      content: `# 記事タイトル

> 一文の価値：読者は何を得られますか？

## 読者

- 対象：
- 現在の悩み：
- 読後に取ってほしい行動：

## タイトル候補

1. 成果 + 明確な対象
2. 意外性・対立 + 利益
3. 具体的な数字 + 検証可能な約束

## 冒頭のフック

場面、対立、データ、問いを使い、三文以内で読む理由を作ります。

## 中心となる主張

この記事で証明する一つの考えを書きます。

## 本文構成

### 1. なぜ重要か

- 実際の場面：
- よくある誤解：

### 2. 方法または説明

- 主張：
- 根拠・事例：
- 読者への意味：

### 3. 行動方法

1. 最初の一歩
2. 二番目の一歩
3. 三番目の一歩

## 結び

- 価値の再提示：
- 行動喚起：
- 読者への問い：

## 公開前チェック

- [ ] タイトルの約束と本文が一致している
- [ ] 結論に根拠または推論がある
- [ ] 重複や曖昧な表現を削除した
- [ ] 見出しだけでも論理が伝わる
- [ ] モバイルで段落が長すぎない`,
    },
    fr: {
      title: "Plan d’article · {date}",
      content: `# Titre de l’article

> Valeur en une phrase : que gagnera le lecteur ?

## Public

- Pour qui :
- Difficulté actuelle :
- Action souhaitée après lecture :

## Titres possibles

1. Résultat + public précis
2. Tension ou idée contre-intuitive + bénéfice
3. Nombre concret + promesse vérifiable

## Accroche

Utilisez une scène, une tension, un fait ou une question dans les trois premières phrases.

## Thèse centrale

Énoncez l’unique idée que l’article doit démontrer.

## Structure

### 1. Pourquoi le problème compte

- Situation réelle :
- Idée reçue :

### 2. Méthode ou explication

- Idée :
- Preuve/exemple :
- Conséquence pour le lecteur :

### 3. Passer à l’action

1. Première étape
2. Deuxième étape
3. Troisième étape

## Conclusion

- Rappeler la valeur :
- Appel à l’action :
- Question au lecteur :

## Vérification avant publication

- [ ] La promesse du titre correspond au contenu
- [ ] Chaque conclusion est étayée
- [ ] Les répétitions et formulations vagues sont supprimées
- [ ] Les titres seuls montrent la logique
- [ ] Les paragraphes restent lisibles sur mobile`,
    },
  },
  "project-readme": {
    zh: {
      title: "项目 README", content: `# 项目名称

一句话说明项目为谁解决什么问题。

## 功能亮点

- 核心能力一
- 核心能力二
- 与同类方案的关键差异

## 演示

添加截图、在线演示地址或简短使用示例。

## 快速开始

### 环境要求

- 运行环境与最低版本
- 外部服务或系统依赖

### 安装

\`\`\`bash
# 安装命令
\`\`\`

### 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
|  |  |  |

## 使用方法

\`\`\`bash
# 最小可运行示例
\`\`\`

## 架构与目录

说明关键模块、数据流和重要目录。

## 路线图

- [x] 已完成
- [ ] 下一步

## 贡献

说明如何报告问题、提交修改与运行测试。

## 许可证与联系

- License：
- Maintainer：`,
    },
    en: {
      title: "Project README", content: `# Project name

One sentence explaining who this project helps and what it solves.

## Highlights

- Core capability one
- Core capability two
- The key difference from alternatives

## Demo

Add a screenshot, live demo, or concise usage example.

## Quick start

### Requirements

- Runtime and minimum version
- External services or system dependencies

### Installation

\`\`\`bash
# install command
\`\`\`

### Configuration

| Variable | Required | Description |
| --- | --- | --- |
|  |  |  |

## Usage

\`\`\`bash
# minimal working example
\`\`\`

## Architecture and structure

Explain the main modules, data flow, and important directories.

## Roadmap

- [x] Completed
- [ ] Next

## Contributing

Explain how to report issues, submit changes, and run tests.

## License and contact

- License:
- Maintainer:`,
    },
    ja: {
      title: "プロジェクト README", content: `# プロジェクト名

誰のどの問題を解決するプロジェクトかを一文で説明します。

## 主な機能

- 中心機能 1
- 中心機能 2
- 他の選択肢との重要な違い

## デモ

スクリーンショット、デモ URL、短い使用例を追加します。

## クイックスタート

### 必要条件

- 実行環境と最低バージョン
- 外部サービスまたはシステム依存

### インストール

\`\`\`bash
# インストールコマンド
\`\`\`

### 設定

| 変数 | 必須 | 説明 |
| --- | --- | --- |
|  |  |  |

## 使い方

\`\`\`bash
# 最小の実行例
\`\`\`

## アーキテクチャと構成

主要モジュール、データフロー、重要なディレクトリを説明します。

## ロードマップ

- [x] 完了
- [ ] 次のステップ

## コントリビューション

問題報告、変更の提出、テスト方法を説明します。

## ライセンスと連絡先

- License：
- Maintainer：`,
    },
    fr: {
      title: "README du projet", content: `# Nom du projet

Une phrase indiquant pour qui est le projet et quel problème il résout.

## Points forts

- Fonction principale 1
- Fonction principale 2
- Différence essentielle avec les alternatives

## Démonstration

Ajoutez une capture, une démo en ligne ou un exemple court.

## Démarrage rapide

### Prérequis

- Environnement et version minimale
- Services externes ou dépendances système

### Installation

\`\`\`bash
# commande d’installation
\`\`\`

### Configuration

| Variable | Requise | Description |
| --- | --- | --- |
|  |  |  |

## Utilisation

\`\`\`bash
# exemple minimal
\`\`\`

## Architecture et structure

Décrivez les modules, les flux de données et les dossiers importants.

## Feuille de route

- [x] Terminé
- [ ] Prochaine étape

## Contribution

Expliquez comment signaler un problème, proposer un changement et lancer les tests.

## Licence et contact

- Licence :
- Mainteneur :`,
    },
  },
  "product-requirements": {
    zh: {
      title: "产品需求文档 · {date}", content: `# 产品/功能名称

> 负责人：<br>
> 状态：草案<br>
> 更新时间：{date}

## 背景与问题

- 用户现在如何完成这件事？
- 最痛的阻碍是什么？
- 有哪些数据或反馈证明问题存在？

## 目标与非目标

### 目标

- 可量化目标一
- 可量化目标二

### 非目标

- 这次明确不解决什么

## 用户与场景

| 用户 | 场景 | 当前困难 | 期望结果 |
| --- | --- | --- | --- |
|  |  |  |  |

## 用户故事与验收标准

### 故事一

作为……，我希望……，从而……

- [ ] Given / When / Then 验收条件
- [ ] 边界与失败状态

## 需求范围

| 优先级 | 需求 | 说明 |
| --- | --- | --- |
| P0 |  |  |
| P1 |  |  |

## 体验流程

1. 入口
2. 主流程
3. 成功状态
4. 异常与恢复

## 成功指标

- 核心指标：
- 护栏指标：
- 观察周期：

## 风险、依赖与发布

- 风险与缓解：
- 外部依赖：
- 灰度与回滚：
- 里程碑：

## 未决问题

- [ ] `,
    },
    en: {
      title: "Product Requirements · {date}", content: `# Product or feature name

> Owner:<br>
> Status: Draft<br>
> Updated: {date}

## Context and problem

- How do users accomplish this today?
- What is the most painful obstacle?
- What evidence shows the problem is real?

## Goals and non-goals

### Goals

- Measurable goal one
- Measurable goal two

### Non-goals

- What this release explicitly will not solve

## Users and scenarios

| User | Scenario | Current pain | Desired outcome |
| --- | --- | --- | --- |
|  |  |  |  |

## User stories and acceptance criteria

### Story one

As a …, I want …, so that …

- [ ] Given / When / Then acceptance criterion
- [ ] Boundary and failure states

## Scope

| Priority | Requirement | Notes |
| --- | --- | --- |
| P0 |  |  |
| P1 |  |  |

## Experience flow

1. Entry point
2. Primary flow
3. Success state
4. Failure and recovery

## Success metrics

- Primary metric:
- Guardrail metric:
- Measurement window:

## Risks, dependencies, and release

- Risk and mitigation:
- External dependencies:
- Rollout and rollback:
- Milestones:

## Open questions

- [ ] `,
    },
    ja: {
      title: "製品要件 · {date}", content: `# 製品・機能名

> 担当者：<br>
> 状態：草案<br>
> 更新日：{date}

## 背景と問題

- ユーザーは現在どう達成していますか？
- 最大の障害は何ですか？
- 問題を示すデータや声はありますか？

## 目標と対象外

### 目標

- 測定可能な目標 1
- 測定可能な目標 2

### 対象外

- 今回明確に解決しないこと

## ユーザーと利用場面

| ユーザー | 場面 | 現在の課題 | 期待する結果 |
| --- | --- | --- | --- |
|  |  |  |  |

## ユーザーストーリーと受入条件

### ストーリー 1

……として、……したい。なぜなら……。

- [ ] Given / When / Then の受入条件
- [ ] 境界・失敗状態

## スコープ

| 優先度 | 要件 | 説明 |
| --- | --- | --- |
| P0 |  |  |
| P1 |  |  |

## 体験フロー

1. 入口
2. 主な流れ
3. 成功状態
4. 失敗と復旧

## 成功指標

- 主要指標：
- ガードレール指標：
- 観測期間：

## リスク、依存、公開

- リスクと対策：
- 外部依存：
- 段階公開とロールバック：
- マイルストーン：

## 未決事項

- [ ] `,
    },
    fr: {
      title: "Exigences produit · {date}", content: `# Nom du produit ou de la fonction

> Responsable :<br>
> Statut : Brouillon<br>
> Mise à jour : {date}

## Contexte et problème

- Comment les utilisateurs procèdent-ils aujourd’hui ?
- Quel est l’obstacle le plus pénible ?
- Quelles données ou remarques confirment le problème ?

## Objectifs et exclusions

### Objectifs

- Objectif mesurable 1
- Objectif mesurable 2

### Hors périmètre

- Ce que cette version ne résoudra pas

## Utilisateurs et scénarios

| Utilisateur | Scénario | Difficulté actuelle | Résultat attendu |
| --- | --- | --- | --- |
|  |  |  |  |

## Récits utilisateur et critères d’acceptation

### Récit 1

En tant que …, je veux … afin de …

- [ ] Critère Given / When / Then
- [ ] Limites et états d’échec

## Périmètre

| Priorité | Exigence | Notes |
| --- | --- | --- |
| P0 |  |  |
| P1 |  |  |

## Parcours

1. Point d’entrée
2. Parcours principal
3. État de réussite
4. Échec et reprise

## Indicateurs de réussite

- Indicateur principal :
- Garde-fou :
- Période d’observation :

## Risques, dépendances et lancement

- Risque et atténuation :
- Dépendances externes :
- Déploiement et retour arrière :
- Jalons :

## Questions ouvertes

- [ ] `,
    },
  },
  "research-paper": {
    zh: {
      title: "论文阅读笔记 · {date}", content: `# 论文标题

> 作者：<br>
> 年份/会议：<br>
> DOI/链接：<br>
> 阅读日期：{date}

## 一句话摘要

这篇论文用什么方法解决了什么问题，得到什么结论？

## 研究问题与背景

- 研究问题：
- 为什么重要：
- 现有方法的缺口：

## 方法

- 核心思想：
- 数据/样本：
- 实验或分析步骤：
- 关键假设：

## 主要发现

1. 发现与对应证据
2. 发现与对应证据

## 图表与关键引用

> 记录页码，并用自己的话解释为什么重要。

## 批判性评估

- 优点：
- 局限：
- 可能的混淆因素：
- 结论是否被证据充分支持：

## 与我的工作连接

- 可复用的方法：
- 与其他文献的关系：
- 新的问题或实验：

## 后续行动

- [ ] 阅读引用文献
- [ ] 复现实验/验证数据
- [ ] 写入主题综述`,
    },
    en: {
      title: "Research Paper Notes · {date}", content: `# Paper title

> Authors:<br>
> Year/venue:<br>
> DOI/link:<br>
> Read on: {date}

## One-sentence summary

What problem is solved, by what method, and with what result?

## Research question and context

- Research question:
- Why it matters:
- Gap in existing work:

## Method

- Core idea:
- Data/sample:
- Experimental or analytical procedure:
- Key assumptions:

## Main findings

1. Finding and supporting evidence
2. Finding and supporting evidence

## Figures and key quotations

> Record the page and explain in your own words why it matters.

## Critical assessment

- Strengths:
- Limitations:
- Possible confounders:
- Does the evidence support the conclusion?

## Connection to my work

- Reusable method:
- Relationship to other literature:
- New question or experiment:

## Follow-up

- [ ] Read cited work
- [ ] Reproduce or validate
- [ ] Add to literature synthesis`,
    },
    ja: {
      title: "論文読書ノート · {date}", content: `# 論文タイトル

> 著者：<br>
> 年・会議：<br>
> DOI・リンク：<br>
> 読了日：{date}

## 一文要約

どの問題を、どの方法で解き、どの結果を得た論文ですか？

## 研究課題と背景

- 研究課題：
- 重要な理由：
- 既存研究の不足：

## 方法

- 中心的な考え：
- データ・サンプル：
- 実験・分析手順：
- 主要な仮定：

## 主な発見

1. 発見と根拠
2. 発見と根拠

## 図表と重要な引用

> ページを記録し、重要な理由を自分の言葉で説明します。

## 批判的評価

- 長所：
- 限界：
- 交絡要因：
- 根拠は結論を十分に支えているか：

## 自分の仕事との接続

- 再利用できる方法：
- 他の文献との関係：
- 新しい問い・実験：

## 次の行動

- [ ] 引用文献を読む
- [ ] 再現・検証する
- [ ] 文献レビューへ追加する`,
    },
    fr: {
      title: "Notes de lecture scientifique · {date}", content: `# Titre de l’article

> Auteurs :<br>
> Année/conférence :<br>
> DOI/lien :<br>
> Lu le : {date}

## Résumé en une phrase

Quel problème est résolu, par quelle méthode et avec quel résultat ?

## Question et contexte

- Question de recherche :
- Importance :
- Lacune des travaux existants :

## Méthode

- Idée centrale :
- Données/échantillon :
- Procédure expérimentale ou analytique :
- Hypothèses clés :

## Résultats principaux

1. Résultat et preuve associée
2. Résultat et preuve associée

## Figures et citations clés

> Notez la page et expliquez avec vos mots pourquoi elle compte.

## Évaluation critique

- Forces :
- Limites :
- Facteurs de confusion :
- Les preuves soutiennent-elles la conclusion ?

## Lien avec mon travail

- Méthode réutilisable :
- Relation avec d’autres travaux :
- Nouvelle question ou expérience :

## Suivi

- [ ] Lire les références citées
- [ ] Reproduire ou valider
- [ ] Ajouter à la synthèse bibliographique`,
    },
  },
  "decision-record": {
    zh: {
      title: "决策记录 · {date}", content: `# 决策标题

> 状态：提议<br>
> 日期：{date}<br>
> 决策人：<br>
> 参与咨询：

## 背景与问题

描述当前约束、触发决策的事件，以及不做决定的后果。

## 决策驱动因素

- 必须满足的条件
- 质量、成本、时间或合规约束

## 备选方案

| 方案 | 优点 | 缺点 | 风险 |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## 决策

选择方案……，因为……。

## 后果

### 正向

- …

### 负向与取舍

- …

## 验证方式

用指标、测试、评审或截止日期确认决策有效。

## 后续行动与复审

- [ ] 行动 — 负责人 — 日期
- 复审条件：`,
    },
    en: {
      title: "Decision Record · {date}", content: `# Decision title

> Status: Proposed<br>
> Date: {date}<br>
> Decision makers:<br>
> Consulted:

## Context and problem

Describe the constraints, the event that triggered this decision, and the cost of not deciding.

## Decision drivers

- Non-negotiable requirement
- Quality, cost, schedule, or compliance constraint

## Considered options

| Option | Benefits | Drawbacks | Risks |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## Decision

Choose option … because ….

## Consequences

### Positive

- …

### Negative and trade-offs

- …

## Validation

Define the metric, test, review, or date that will confirm the decision works.

## Follow-up and review

- [ ] Action — owner — date
- Revisit when:`,
    },
    ja: {
      title: "意思決定記録 · {date}", content: `# 決定タイトル

> 状態：提案<br>
> 日付：{date}<br>
> 決定者：<br>
> 相談した人：

## 背景と問題

制約、決定のきっかけ、決めない場合の影響を記述します。

## 決定要因

- 必須条件
- 品質、コスト、日程、コンプライアンスの制約

## 選択肢

| 選択肢 | 利点 | 欠点 | リスク |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## 決定

……を選ぶ。理由は……。

## 結果

### 良い影響

- …

### 悪い影響とトレードオフ

- …

## 検証

有効性を確認する指標、テスト、レビュー、日付を定義します。

## フォローアップと見直し

- [ ] 作業 — 担当 — 日付
- 見直す条件：`,
    },
    fr: {
      title: "Registre de décision · {date}", content: `# Titre de la décision

> Statut : Proposée<br>
> Date : {date}<br>
> Décideurs :<br>
> Consultés :

## Contexte et problème

Décrivez les contraintes, le déclencheur et le coût de l’absence de décision.

## Facteurs de décision

- Exigence non négociable
- Contrainte de qualité, coût, délai ou conformité

## Options étudiées

| Option | Avantages | Inconvénients | Risques |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## Décision

Choisir l’option … parce que ….

## Conséquences

### Positives

- …

### Négatives et compromis

- …

## Validation

Définissez l’indicateur, le test, la revue ou la date qui confirmera la décision.

## Suivi et révision

- [ ] Action — responsable — date
- À reconsidérer si :`,
    },
  },
  "technical-design": {
    zh: {
      title: "技术方案 · {date}", content: `# 技术方案名称

> 作者：<br>
> 状态：草案<br>
> 更新：{date}

## 摘要

用不超过五句话说明问题、方案和最重要的取舍。

## 背景

- 当前系统如何工作：
- 已知问题与数据：
- 为什么现在要改：

## 目标与非目标

### 目标

- …

### 非目标

- …

## 方案概览

描述组件职责、边界以及端到端数据流。

## 详细设计

### 接口与数据模型

| 名称 | 输入 | 输出 | 错误/约束 |
| --- | --- | --- | --- |
|  |  |  |  |

### 状态与一致性

- 数据真值：
- 并发与幂等：
- 失败恢复：

### 安全与隐私

- 鉴权/授权：
- 敏感数据与日志：
- 滥用与限流：

### 性能与容量

- 延迟目标：
- 峰值负载：
- 存储增长与上限：

## 迁移、发布与回滚

1. 数据或配置迁移
2. 灰度与兼容窗口
3. 监控与放量条件
4. 回滚步骤

## 可观测性与测试

- 指标、日志与告警：
- 单元/集成/端到端测试：
- 故障演练：

## 替代方案与未决问题

- 被否决的方案及原因：
- [ ] 未决问题`,
    },
    en: {
      title: "Technical Design · {date}", content: `# Technical design title

> Author:<br>
> Status: Draft<br>
> Updated: {date}

## Summary

Explain the problem, proposal, and most important trade-off in no more than five sentences.

## Context

- How the system works today:
- Known problems and evidence:
- Why change now:

## Goals and non-goals

### Goals

- …

### Non-goals

- …

## Proposal overview

Describe component responsibilities, boundaries, and end-to-end data flow.

## Detailed design

### Interfaces and data model

| Name | Input | Output | Errors/constraints |
| --- | --- | --- | --- |
|  |  |  |  |

### State and consistency

- Source of truth:
- Concurrency and idempotency:
- Failure recovery:

### Security and privacy

- Authentication/authorization:
- Sensitive data and logs:
- Abuse prevention and rate limits:

### Performance and capacity

- Latency target:
- Peak load:
- Storage growth and bounds:

## Migration, rollout, and rollback

1. Data or configuration migration
2. Staged rollout and compatibility window
3. Monitoring and promotion criteria
4. Rollback procedure

## Observability and testing

- Metrics, logs, and alerts:
- Unit/integration/end-to-end tests:
- Failure drills:

## Alternatives and open questions

- Rejected option and reason:
- [ ] Open question`,
    },
    ja: {
      title: "技術設計 · {date}", content: `# 技術設計タイトル

> 作成者：<br>
> 状態：草案<br>
> 更新日：{date}

## 要約

問題、提案、最重要のトレードオフを五文以内で説明します。

## 背景

- 現在の動作：
- 既知の問題と根拠：
- 今変更する理由：

## 目標と対象外

### 目標

- …

### 対象外

- …

## 提案の概要

コンポーネントの責任、境界、端から端までのデータフローを説明します。

## 詳細設計

### インターフェースとデータモデル

| 名前 | 入力 | 出力 | エラー・制約 |
| --- | --- | --- | --- |
|  |  |  |  |

### 状態と整合性

- 正のデータ：
- 並行性と冪等性：
- 障害復旧：

### セキュリティとプライバシー

- 認証・認可：
- 機密データとログ：
- 不正利用防止とレート制限：

### 性能と容量

- レイテンシ目標：
- ピーク負荷：
- ストレージ増加と上限：

## 移行、公開、ロールバック

1. データまたは設定の移行
2. 段階公開と互換期間
3. 監視と拡大条件
4. ロールバック手順

## 可観測性とテスト

- 指標、ログ、アラート：
- 単体・統合・E2E テスト：
- 障害演習：

## 代替案と未決事項

- 却下した案と理由：
- [ ] 未決事項`,
    },
    fr: {
      title: "Conception technique · {date}", content: `# Titre de la conception

> Auteur :<br>
> Statut : Brouillon<br>
> Mise à jour : {date}

## Résumé

Décrivez le problème, la proposition et le compromis principal en cinq phrases maximum.

## Contexte

- Fonctionnement actuel :
- Problèmes connus et preuves :
- Pourquoi changer maintenant :

## Objectifs et exclusions

### Objectifs

- …

### Hors périmètre

- …

## Vue d’ensemble

Décrivez les responsabilités, les frontières et le flux de données de bout en bout.

## Conception détaillée

### Interfaces et modèle de données

| Nom | Entrée | Sortie | Erreurs/contraintes |
| --- | --- | --- | --- |
|  |  |  |  |

### État et cohérence

- Source de vérité :
- Concurrence et idempotence :
- Reprise après échec :

### Sécurité et confidentialité

- Authentification/autorisation :
- Données sensibles et journaux :
- Prévention des abus et limites :

### Performance et capacité

- Objectif de latence :
- Charge de pointe :
- Croissance et limites de stockage :

## Migration, déploiement et retour arrière

1. Migration des données ou de la configuration
2. Déploiement progressif et période de compatibilité
3. Supervision et critères de généralisation
4. Procédure de retour arrière

## Observabilité et tests

- Indicateurs, journaux et alertes :
- Tests unitaires, intégration et bout en bout :
- Exercices de panne :

## Alternatives et questions ouvertes

- Option rejetée et raison :
- [ ] Question ouverte`,
    },
  },
};

export function documentTemplateById(
  templateId: DocumentTemplateId,
): DocumentTemplateDefinition {
  const template = DOCUMENT_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`Unknown document template: ${templateId}`);
  return template;
}

export function canUseDocumentTemplate(
  template: DocumentTemplateDefinition,
  membershipTier: "free" | "lifetime",
  localMode = false,
): boolean {
  if (template.tier === "free") return true;
  return membershipTier === "lifetime" && !localMode;
}

export function buildDocumentFromTemplate(
  templateId: DocumentTemplateId,
  locale: Locale,
  now = new Date(),
): TemplateCopy {
  const copy = TEMPLATE_COPIES[templateId][locale];
  const date = new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return {
    title: copy.title.replaceAll("{date}", date),
    content: copy.content.replaceAll("{date}", date).trim(),
  };
}
