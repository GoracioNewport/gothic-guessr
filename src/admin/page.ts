/** The contract between the admin shell (main.ts) and its pages (pages/*.ts). */

export interface PageContext {
  /** The page's own element; the page renders into it. */
  root: HTMLElement;
  /** Path segments after the section (`/<ADMIN_PATH>/players/<id>` → [id]). */
  params: string[];
  navigate(path: string, replace?: boolean): void;
  /** False once the user navigated away (ignore late responses). */
  isCurrent(): boolean;
}

/** Renders a page; may return a cleanup (timers) that runs on navigation. */
export type Page = (ctx: PageContext) => Promise<void | (() => void)>;
