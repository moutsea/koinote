export type TurnstileAPI = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
  reset(id: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

let scriptPromise: Promise<TurnstileAPI> | undefined;

export function loadTurnstile(): Promise<TurnstileAPI> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileAPI>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const fail = () => {
      window.clearTimeout(timer);
      script.onload = script.onerror = null;
      script.remove();
      scriptPromise = undefined;
      reject(new Error("Human verification could not load"));
    };
    const timer = window.setTimeout(fail, 15000);
    script.onerror = fail;
    script.onload = () => {
      if (!window.turnstile) return fail();
      window.clearTimeout(timer);
      script.onload = script.onerror = null;
      resolve(window.turnstile);
    };
    document.head.append(script);
  });
  return scriptPromise;
}
