import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { CheckCircle2, ExternalLink, Send, X } from "lucide-react";
import { AGENT_CREDITS_QUERY_KEY, ApiError } from "../api";
import { KOINOTE_IMAGE_ORIGIN, koinoteImageObjectKey } from "./editor/imageLoading";
import { actOnAgentPublication, getAgentPublication, type AgentPublication } from "../agentSessions";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";
import "./AgentPublicationCard.css";

const geoCopy = {
  zh: { included: "将携带 GEO 隐藏摘要", excluded: "本次不携带 GEO 隐藏摘要", view: "查看将发送的 GEO 摘要" },
  en: { included: "Includes a GEO hidden summary", excluded: "No GEO hidden summary in this draft", view: "View the GEO summary to send" },
  fr: { included: "Résumé GEO masqué inclus", excluded: "Aucun résumé GEO masqué dans ce brouillon", view: "Voir le résumé GEO à envoyer" },
  ja: { included: "GEO 非表示要約を含みます", excluded: "今回は GEO 非表示要約を含みません", view: "送信する GEO 要約を見る" },
};
const copy = {
  zh: { stopped: "本轮任务未完成，请发送新消息重新准备发布预览。", dismiss: "关闭", record: "查看发布记录", expired: "预览已超过 24 小时，请让 Koi 重新准备。", title: "确认发布内容", preview: "预览并确认", close: "暂不发送", reject: "取消这次发布", send: "确认发送", wechatSend: "确认保存草稿", wechat: "公众号草稿箱", x: "X Article", custom: "自定义渠道", pending: "等待你确认", sending: "正在发送，请勿重复操作", sent: "发送完成", draft: "草稿已保存", delivered: "已送达渠道", rejected: "已取消", failed: "未能完成发送", uncertain: "发送结果待核对", loadError: "发布预览暂时无法读取", reload: "刷新状态", result: "查看结果", content: "将发送的正文", source: "查看 Markdown 原文", cost: "预计发布费用", noCost: "Koinote 不另扣发布 Credits；渠道费用以对方为准。", modelCost: "对话的模型费用另计。", wechatNote: "仅保存到此公众号的草稿箱，不会直接对外发布。", xNote: "确认后将发布为 X Article；账号需要具备对应权限。", customNote: "确认后发送到此渠道；发布或保存草稿由渠道接口决定。", review: "请核对目标、标题和正文。使用文章的已保存版本，目标平台的排版可能不同。", notReady: "等待 Koi 完成本轮任务后即可确认。", changed: "文章或渠道已变化，请让 Koi 重新准备发布预览。", failedNote: "请检查账号、余额和渠道设置，再发新消息重新准备。", uncertainNote: "请先到目标平台检查是否已收到，避免重复发送。不要直接重试。", check: "前往微信后台", cover: "文章封面", defaultCover: "使用默认封面", actionError: "操作未完成，请刷新状态后核对。" },
  en: { stopped: "This task did not complete. Ask Koi for a new publication preview.", dismiss: "Close", record: "View publication record", expired: "This preview is over 24 hours old. Ask Koi for a new one.", title: "Review publication", preview: "Preview and confirm", close: "Not now", reject: "Cancel publication", send: "Confirm send", wechatSend: "Save draft", wechat: "WeChat drafts", x: "X Article", custom: "Custom channel", pending: "Awaiting your confirmation", sending: "Sending — do not send again", sent: "Sent", draft: "Draft saved", delivered: "Delivered to channel", rejected: "Cancelled", failed: "Send not completed", uncertain: "Delivery needs checking", loadError: "Publication preview could not be loaded", reload: "Refresh status", result: "View result", content: "Article to send", source: "View Markdown source", cost: "Estimated publication cost", noCost: "Koinote charges no publication Credits. The channel may charge separately.", modelCost: "Conversation model usage is billed separately.", wechatNote: "Saves to this account's draft box only; does not publish publicly.", xNote: "Publishes an X Article after confirmation. Your account needs the required access.", customNote: "Sends to this channel. Its endpoint decides whether to publish or save a draft.", review: "Check the destination, title and body. Uses the saved article; platform formatting may differ.", notReady: "You can confirm once Koi finishes this task.", changed: "The article or channel changed. Ask Koi for a new preview.", failedNote: "Check the account, balance and channel settings, then request a new preview.", uncertainNote: "Check the destination before sending again to avoid duplicates. Do not retry directly.", check: "Open WeChat dashboard", cover: "Article cover", defaultCover: "Default cover", actionError: "The action did not complete. Refresh and check the status." },
  fr: { stopped: "Cette tâche n’a pas abouti. Demandez un nouvel aperçu d’envoi à Koi.", dismiss: "Fermer", record: "Voir l’envoi", expired: "Cet aperçu a plus de 24 heures. Demandez-en un nouveau à Koi.", title: "Vérifier la publication", preview: "Prévisualiser et confirmer", close: "Pas maintenant", reject: "Annuler la publication", send: "Confirmer l’envoi", wechatSend: "Enregistrer le brouillon", wechat: "Brouillons WeChat", x: "X Article", custom: "Canal personnalisé", pending: "En attente de confirmation", sending: "Envoi en cours — ne pas répéter", sent: "Envoyé", draft: "Brouillon enregistré", delivered: "Transmis au canal", rejected: "Annulé", failed: "Envoi non terminé", uncertain: "Résultat à vérifier", loadError: "Impossible de charger l’aperçu", reload: "Actualiser l’état", result: "Voir le résultat", content: "Article à envoyer", source: "Voir le Markdown", cost: "Coût de publication estimé", noCost: "Koinote ne prélève pas de Credits de publication. Le canal peut facturer séparément.", modelCost: "L’utilisation du modèle est facturée séparément.", wechatNote: "Enregistre uniquement un brouillon pour ce compte, sans publication publique.", xNote: "Publie un X Article après confirmation. Le compte doit disposer des droits requis.", customNote: "Transmet au canal. Son interface décide de publier ou d’enregistrer un brouillon.", review: "Vérifiez la destination, le titre et le texte enregistrés. La mise en page peut différer.", notReady: "Confirmez une fois cette tâche terminée.", changed: "L’article ou le canal a changé. Demandez un nouvel aperçu à Koi.", failedNote: "Vérifiez le compte, le solde et le canal avant de demander un nouvel aperçu.", uncertainNote: "Vérifiez la destination pour éviter un doublon. Ne relancez pas directement.", check: "Ouvrir WeChat", cover: "Couverture", defaultCover: "Couverture par défaut", actionError: "Action non terminée. Actualisez et vérifiez l’état." },
  ja: { stopped: "このタスクは完了しませんでした。Koi に新しい送信プレビューを依頼してください。", dismiss: "閉じる", record: "送信記録を見る", expired: "プレビューは 24 時間で期限切れになります。Koi に新しいものを依頼してください。", title: "公開内容の確認", preview: "プレビューして確認", close: "今は送信しない", reject: "今回の送信を取り消す", send: "確認して送信", wechatSend: "下書きを保存", wechat: "WeChat 下書き", x: "X Article", custom: "カスタムチャネル", pending: "確認待ち", sending: "送信中です。再送信しないでください", sent: "送信完了", draft: "下書きを保存しました", delivered: "チャネルに送信済み", rejected: "取り消し済み", failed: "送信が完了しませんでした", uncertain: "送信結果を確認してください", loadError: "プレビューを読み込めません", reload: "状態を更新", result: "結果を見る", content: "送信する本文", source: "Markdown 原文を見る", cost: "送信料金の見積もり", noCost: "Koinote の追加送信 Credits は不要です。チャネル側の料金は別途適用されます。", modelCost: "会話のモデル利用料金は別途発生します。", wechatNote: "このアカウントの下書きに保存します。一般公開はしません。", xNote: "確認後に X Article を公開します。対応するアカウント権限が必要です。", customNote: "このチャネルに送信します。公開または下書き保存はチャネル側で決まります。", review: "送信先、タイトル、保存済みの本文を確認してください。公開先では書式が異なる場合があります。", notReady: "Koi の今回のタスクが完了したら確認できます。", changed: "記事またはチャネルが変わりました。Koi に新しいプレビューを依頼してください。", failedNote: "アカウント、残高、設定を確認してから新しいプレビューを依頼してください。", uncertainNote: "重複送信を防ぐため送信先を先に確認してください。そのまま再試行しないでください。", check: "WeChat 管理画面へ", cover: "記事のカバー", defaultCover: "既定のカバー", actionError: "操作が完了しませんでした。状態を更新して確認してください。" },
};

export function AgentPublicationCard({ item, taskStatus }: { item: AgentPublication; taskStatus: string }) {
  const { locale, t } = useI18n();
  const text = copy[locale];
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const detail = useQuery({
    queryKey: ["agent-publication", item.id], queryFn: () => getAgentPublication(item.id),
    enabled: open || tracking || item.status === "sending",
    refetchInterval: query => query.state.data?.publication.status === "sending" ? 2500 : false,
  });
  const current = detail.data?.publication ?? item;
  const channel = text[current.channel];
  const sent = current.status === "sent";
  const pending = current.status === "pending";
  const readiness = taskStatus === "failed" || taskStatus === "cancelled" ? text.stopped : text.notReady;
  const status = sent ? current.channel === "wechat" ? text.draft : current.channel === "custom" ? text.delivered : text.sent : text[current.status];
  const note = current.channel === "wechat" ? text.wechatNote : current.channel === "x" ? text.xNote : text.customNote;

  useEffect(() => {
    if (!open) return;
    const release = pushModal();
    return release;
  }, [open]);

  useEffect(() => {
    if (current.status === "pending" || current.status === "sending") return;
    void client.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    void client.invalidateQueries({ queryKey: ["agent-session"] });
    void client.invalidateQueries({ queryKey: ["article-koi-session"] });
  }, [client, current.status]);

  function show() {
    setError(""); setOpen(true);
    dialog.current?.showModal();
    void detail.refetch();
  }
  async function act(action: "confirm" | "reject") {
    if (locked.current || !pending) return;
    locked.current = true; setWorking(true); setError("");
    if (action === "confirm") {
      setTracking(true);
      client.setQueryData(["agent-publication", item.id], (old: Awaited<ReturnType<typeof getAgentPublication>> | undefined) => old ? { ...old, publication: { ...old.publication, status: "sending" } } : undefined);
    }
    try {
      const result = await actOnAgentPublication(current, action);
      client.setQueryData(["agent-publication", item.id], (old: Awaited<ReturnType<typeof getAgentPublication>> | undefined) => old ? { ...old, publication: result.publication } : undefined);
      await detail.refetch();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "publication_changed" ? text.changed
        : caught instanceof ApiError && caught.code === "publication_expired" ? text.expired
        : caught instanceof ApiError && caught.code === "publication_not_ready" ? readiness
        : caught instanceof ApiError && caught.code === "publication_uncertain" ? text.uncertainNote : caught instanceof ApiError && caught.code && (t.errors as Record<string, string>)[caught.code] || text.actionError);
      void detail.refetch();
    } finally { locked.current = false; setWorking(false); }
  }
  const failure = current.errorCode === "publication_changed" ? text.changed
    : (current.status === "failed" || current.errorCode === "x_article_draft_only") && current.errorCode && (t.errors as Record<string, string>)[current.errorCode];
  return <section className="agent-publication-card" data-publication={item.id}>
    <div className="agent-publication-top"><span className="agent-publication-channel"><Send size={14} aria-hidden="true" />{channel} · {current.targetLabel}</span><span className="agent-publication-state" data-status={current.status}>{sent && <CheckCircle2 size={13} aria-hidden="true" />}{status}</span></div>
    <p className="agent-publication-title">{current.title}</p>
    <p className="agent-publication-note">{note}</p>
    <div className="agent-publication-actions">
      <button type="button" onClick={show}>{pending ? text.preview : text.record}</button>
      {sent && current.resultUrl && <a href={current.resultUrl} target="_blank" rel="noreferrer">{text.result}<ExternalLink size={12} aria-hidden="true" /></a>}
    </div>
    <dialog ref={dialog} className="agent-publication-dialog" aria-labelledby={heading} onClose={() => setOpen(false)}>
      <header><div><h2 id={heading}>{text.title}</h2><p>{channel} · {current.targetLabel}</p></div><button type="button" aria-label={text.dismiss} onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button></header>
      <div className="agent-publication-preview">
        <p className="agent-publication-note">{text.review}</p>
        {detail.isPending && <progress aria-label={text.preview} />}
        {detail.isError && <p role="alert">{text.loadError} <button type="button" onClick={() => void detail.refetch()}>{text.reload}</button></p>}
        {detail.data && <>
          <h3>{current.title}</h3>
          {detail.data.cover ? <p className="agent-publication-note">{text.cover}: <a href={detail.data.cover} target="_blank" rel="noreferrer">{text.result}</a></p> : current.channel === "wechat" && <p className="agent-publication-note">{text.defaultCover}</p>}
          <div className="prose prose-sm max-w-none break-words dark:prose-invert" aria-label={text.content}><Markdown urlTransform={url => {
            const key = koinoteImageObjectKey(url);
            return defaultUrlTransform(key ? `${KOINOTE_IMAGE_ORIGIN}/${key}` : url);
          }} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{detail.data.markdown}</Markdown></div>
          {current.channel === "wechat" && <>
            <p className="agent-publication-note">{detail.data.geoText ? geoCopy[locale].included : geoCopy[locale].excluded}</p>
            {detail.data.geoText && <details className="agent-publication-source"><summary>{geoCopy[locale].view}</summary><pre>{detail.data.geoText}</pre></details>}
          </>}
          <details className="agent-publication-source"><summary>{text.source}</summary><pre>{detail.data.markdown}</pre></details>
        </>}
      </div>
      <footer>
        <p>{note}</p>
        <p className="agent-publication-cost">{current.credits ? `${text.cost}：${current.credits} Credits` : text.noCost} <span>{text.modelCost}</span></p>
        {!pending && <p role="status">{status}</p>}
        {(current.status === "uncertain" || current.status === "failed") && <p role="alert">{failure || ""} {current.status === "uncertain" ? text.uncertainNote : text.failedNote}</p>}
        {pending && error && <p role="alert">{error}</p>}
        {pending && taskStatus !== "completed" && <p>{readiness}</p>}
        <div className="agent-publication-actions">
          {pending && <button type="button" disabled={working} onClick={() => void act("reject")}>{text.reject}</button>}
          <button type="button" autoFocus onClick={() => dialog.current?.close()}>{pending ? text.close : text.dismiss}</button>
          {pending && <button type="button" className="agent-publication-confirm" disabled={working || !detail.isSuccess || detail.isFetching || taskStatus !== "completed"} aria-busy={working} onClick={() => void act("confirm")}>{working ? text.sending : current.channel === "wechat" ? text.wechatSend : text.send}</button>}
          {sent && current.channel === "wechat" && <a href="https://mp.weixin.qq.com/" target="_blank" rel="noreferrer">{text.check}<ExternalLink size={12} aria-hidden="true" /></a>}
          {sent && current.resultUrl && <a href={current.resultUrl} target="_blank" rel="noreferrer">{text.result}<ExternalLink size={12} aria-hidden="true" /></a>}
        </div>
      </footer>
    </dialog>
  </section>;
}
