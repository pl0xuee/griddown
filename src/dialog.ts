/**
 * Asking the user a question, in the app rather than through the platform.
 *
 * The browser globals are not an option here. Tauri shims `window.confirm` onto
 * an IPC command, and shims it as an *async* function — so `if (!confirm(...))`
 * tests a Promise, which is always truthy, and the guard silently never fires.
 * That shipped, and it meant deleting a pack and restoring a backup over every
 * pin and track both went ahead without asking. `window.prompt` is worse: it is
 * not shimmed at all and WKWebView implements no text-input panel, so on iOS it
 * returns null immediately and the feature just does nothing.
 *
 * So both questions are asked with our own DOM. That removes the dependency on
 * a shim that has already broken once, looks the same on every platform, and —
 * the reason it is worth the code — can actually be tested, which neither the
 * globals nor the plugin round-trip could be.
 *
 * Both resolve rather than reject. A dialog that throws is how a floating
 * promise turns into a button that appears dead.
 */

export interface PromptOptions {
  /** Pre-filled value, e.g. the current name when renaming. */
  value?: string;
  placeholder?: string;
  okLabel?: string;
}

interface Built {
  overlay: HTMLDivElement;
  input?: HTMLInputElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

function build(message: string, opts: PromptOptions | null): Built {
  const overlay = document.createElement("div");
  overlay.className = "ask";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const card = document.createElement("div");
  card.className = "ask-card";

  const text = document.createElement("p");
  text.className = "ask-message";
  // textContent, not innerHTML: these messages carry file names and error text
  // from the network.
  text.textContent = message;
  card.appendChild(text);

  let input: HTMLInputElement | undefined;
  if (opts) {
    input = document.createElement("input");
    input.type = "text";
    input.className = "ask-input";
    input.value = opts.value ?? "";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    overlay.setAttribute("aria-label", message);
    card.appendChild(input);
  }

  const row = document.createElement("div");
  row.className = "ask-row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ask-btn";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "ask-btn ask-btn--go";
  ok.textContent = opts?.okLabel ?? "OK";
  // Cancel first in the DOM so it is the first tab stop: the safe choice should
  // be the one you land on, since these guard deletions and overwrites.
  row.appendChild(cancel);
  row.appendChild(ok);
  card.appendChild(row);
  overlay.appendChild(card);

  return { overlay, input, ok, cancel };
}

/**
 * Show `message` and resolve with what the user chose. `opts` present means ask
 * for text (resolving to the string, or null if cancelled); absent means ask
 * yes/no (resolving true/false).
 */
function ask(message: string, opts: PromptOptions | null): Promise<string | null | boolean> {
  return new Promise((resolve) => {
    const { overlay, input, ok, cancel } = build(message, opts);
    // Restore focus to whatever opened this, so keyboard users are not dumped
    // back at the top of the document.
    const opener = document.activeElement as HTMLElement | null;
    let done = false;

    const close = (result: string | null | boolean) => {
      if (done) return; // Enter and click can both land before removal.
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      opener?.focus?.();
      resolve(result);
    };

    const accept = () => close(opts ? (input?.value ?? "") : true);
    const reject = () => close(opts ? null : false);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        reject();
      } else if (e.key === "Enter" && (opts || document.activeElement !== cancel)) {
        e.preventDefault();
        accept();
      }
    }

    ok.addEventListener("click", accept);
    cancel.addEventListener("click", reject);
    // Clicking the backdrop cancels; clicking inside the card must not.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) reject();
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    (input ?? ok).focus();
    input?.select();
  });
}

/** Yes/no. Resolves false if dismissed — never rejects. */
export async function confirmAction(message: string): Promise<boolean> {
  return (await ask(message, null)) as boolean;
}

/** Ask for text. Resolves null if cancelled — never rejects. */
export async function promptAction(message: string, opts: PromptOptions = {}): Promise<string | null> {
  return (await ask(message, opts)) as string | null;
}
