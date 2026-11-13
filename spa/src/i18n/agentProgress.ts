import type { ProgressAction, ProgressPhase } from "../agentProgress";
import type { Locale } from "./types";

type ProgressText = {
  title: string;
  recent: string;
  stepFailed: string;
  phases: Record<ProgressPhase, string>;
  actions: Record<ProgressAction, string>;
};

export const agentProgressText: Record<Locale, ProgressText> = {
  zh: {
    title: "执行进度", recent: "最近进展", stepFailed: "本步未完成",
    phases: {
      preparing: "正在准备任务", queued: "任务已排队，等待开始", running: "正在处理任务",
      thinking: "正在分析任务与下一步", finishing: "正在汇总任务结果",
      retrying: "正在调整处理方式", cancelling: "正在停止任务",
      awaiting_approval: "等待你审批", completed: "任务已完成", failed: "任务未完成，请查看错误信息",
      cancelled: "任务已停止", clarification: "有问题需要你确认", partial: "部分完成，请查看改动结果",
      documents: "正在查找相关文档", folders: "正在查看目录结构", read: "正在阅读文档内容",
      proposal: "正在准备改动方案", review: "正在核对改动状态", conversation: "正在回顾会话要求",
      references: "正在查阅参考资料", search: "正在搜索相关资料", web: "正在阅读网页资料",
      compute: "正在处理任务资料", save: "正在保存生成结果", cover: "正在生成封面图", work: "正在处理任务",
    },
    actions: {
      documents: "查找相关文档", folders: "查看目录结构", read: "阅读文档内容",
      proposal: "准备改动方案", review: "核对改动状态", conversation: "回顾会话要求",
      references: "查阅参考资料", search: "搜索相关资料", web: "阅读网页资料",
      compute: "处理任务资料", save: "保存生成结果", cover: "生成封面图", work: "处理任务",
    },
  },
  en: {
    title: "Task progress", recent: "Recent activity", stepFailed: "Step did not finish",
    phases: {
      preparing: "Preparing your task", queued: "Queued, waiting to start", running: "Working on your task",
      thinking: "Considering the task and next steps", finishing: "Putting the results together",
      retrying: "Adjusting the approach", cancelling: "Stopping the task",
      awaiting_approval: "Waiting for your approval", completed: "Task completed", failed: "Task did not finish. See the error details",
      cancelled: "Task stopped", clarification: "Your input is needed", partial: "Partially completed. Review the changes",
      documents: "Finding relevant documents", folders: "Looking through your folders", read: "Reading document content",
      proposal: "Preparing proposed changes", review: "Checking change status", conversation: "Reviewing your conversation",
      references: "Consulting reference material", search: "Searching for information", web: "Reading web sources",
      compute: "Processing task material", save: "Saving generated results", cover: "Generating a cover image", work: "Working on your task",
    },
    actions: {
      documents: "Find relevant documents", folders: "Review folder structure", read: "Read document content",
      proposal: "Prepare proposed changes", review: "Check change status", conversation: "Review your conversation",
      references: "Consult reference material", search: "Search for information", web: "Read web sources",
      compute: "Process task material", save: "Save generated results", cover: "Generate a cover image", work: "Work on your task",
    },
  },
  fr: {
    title: "Progression", recent: "Activité récente", stepFailed: "Étape non terminée",
    phases: {
      preparing: "Préparation de la tâche", queued: "En attente de démarrage", running: "Traitement de la tâche",
      thinking: "Analyse de la tâche et des prochaines étapes", finishing: "Récapitulatif des résultats en cours",
      retrying: "Ajustement de la méthode", cancelling: "Arrêt de la tâche en cours",
      awaiting_approval: "En attente de votre approbation", completed: "Tâche terminée", failed: "Tâche non terminée. Consultez les erreurs",
      cancelled: "Tâche arrêtée", clarification: "Votre avis est nécessaire", partial: "Résultat partiel. Vérifiez les modifications",
      documents: "Recherche des documents pertinents", folders: "Examen des dossiers", read: "Lecture des documents",
      proposal: "Préparation des modifications proposées", review: "Vérification de l’état des modifications", conversation: "Relecture de la conversation",
      references: "Consultation des références", search: "Recherche d’informations", web: "Lecture des sources web",
      compute: "Traitement des données", save: "Enregistrement des résultats", cover: "Génération de la couverture", work: "Traitement de la tâche",
    },
    actions: {
      documents: "Rechercher les documents", folders: "Examiner les dossiers", read: "Lire les documents",
      proposal: "Préparer les modifications", review: "Vérifier les modifications", conversation: "Relire la conversation",
      references: "Consulter les références", search: "Rechercher des informations", web: "Lire les sources web",
      compute: "Traiter les données", save: "Enregistrer les résultats", cover: "Générer la couverture", work: "Traiter la tâche",
    },
  },
  ja: {
    title: "進捗", recent: "最近の作業", stepFailed: "この手順は未完了です",
    phases: {
      preparing: "タスクを準備しています", queued: "開始を待っています", running: "タスクを処理しています",
      thinking: "依頼と次の手順を検討しています", finishing: "結果をまとめています",
      retrying: "進め方を調整しています", cancelling: "タスクを停止しています",
      awaiting_approval: "承認をお待ちしています", completed: "タスクが完了しました", failed: "タスクは未完了です。エラーをご確認ください",
      cancelled: "タスクを停止しました", clarification: "確認が必要です", partial: "一部完了しました。変更結果をご確認ください",
      documents: "関連する文書を探しています", folders: "フォルダー構成を確認しています", read: "文書の内容を読んでいます",
      proposal: "変更案を準備しています", review: "変更の状態を確認しています", conversation: "会話の依頼内容を確認しています",
      references: "参考資料を確認しています", search: "関連情報を検索しています", web: "ウェブの資料を読んでいます",
      compute: "資料を処理しています", save: "生成した結果を保存しています", cover: "カバー画像を生成しています", work: "タスクを処理しています",
    },
    actions: {
      documents: "関連文書の検索", folders: "フォルダー構成の確認", read: "文書の読み取り",
      proposal: "変更案の準備", review: "変更状態の確認", conversation: "会話の確認",
      references: "参考資料の確認", search: "情報の検索", web: "ウェブ資料の読み取り",
      compute: "資料の処理", save: "生成結果の保存", cover: "カバー画像の生成", work: "タスクの処理",
    },
  },
};
