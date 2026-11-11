/**
 * Two things every page needs and no page should have to remember:
 * - each table cell knows its column heading (`data-label`), so a table can
 *   stack into labelled cards on a phone (theme.css, "Tables become cards");
 * - the browser tab is named after the page's heading (WCAG 2.4.2).
 */
function labelTables() {
  for (const table of document.querySelectorAll<HTMLTableElement>("table.mantine-Table-table")) {
    const heads = [...table.querySelectorAll(":scope > thead th")].map((th) => th.textContent?.trim() ?? "");
    if (heads.length === 0) continue;
    for (const row of table.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr, :scope > tfoot > tr")) {
      let col = 0;
      for (const cell of row.cells) {
        const label = cell.colSpan === 1 ? (heads[col] ?? "") : "";
        if (label && cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
        col += cell.colSpan;
      }
    }
  }
}

function nameTab() {
  const heading = document.querySelector("main h1, .ob-title")?.textContent?.trim();
  const title = heading ? `${heading} · ProfitIndex` : "ProfitIndex";
  if (document.title !== title) document.title = title;
}

export function watchDom() {
  let queued = false;
  const run = () => { queued = false; labelTables(); nameTab(); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
}
