// Lightweight non-blocking toast notifications (replaces blocking alert()).

let container: HTMLElement | null = null;

function ensure(): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function toast(
  message: string,
  kind: "info" | "error" | "success" = "info",
  ms = 3400
) {
  const c = ensure();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}
