/**
 * 表格结构编辑（纯 DOM）。
 *
 * 编辑器里的表格是作者已经写进正文的 HTML：插入表格只是开始，之后常常要加一行、
 * 删一列、改表头或把某一格居中。这些操作如果都走 `execCommand`，要么没有对应命令，
 * 要么会把整张表换掉、光标与撤销栈一起丢失。所以这里全部是直接操作 DOM 的小函数：
 *
 * - 只接收 DOM 节点，不依赖 React、不读全局状态，便于单测与复用；
 * - 找不到目标（空表、光标不在单元格、参数为 null）一律返回 null / false，绝不抛异常；
 * - 含 `colspan` / `rowspan` 的合并单元格会让行列号失去意义，增删行列时安全拒绝，
 *   由界面把按钮置灰；
 * - 对齐只写 class（`pp-align-left|center|right`）。服务端清洗只保留 `class` 与
 *   白名单属性、会剥掉 `style`，行内样式在公开页活不下来。
 *
 * 每个会改动 DOM 的函数都返回「光标应该留在哪一格」：插入行列时就是原来的单元格，
 * 删除/表头切换时是重建后对应的那一格，调用方把选区放进去即可继续输入。
 */

export type CellAlign = 'left' | 'center' | 'right';

/** 对齐 class 的固定顺序，便于替换时一次清干净。 */
export const TABLE_ALIGN_CLASSES = ['pp-align-left', 'pp-align-center', 'pp-align-right'] as const;

const ALIGN_VALUES: readonly CellAlign[] = ['left', 'center', 'right'];

/** 分栏 / 图集也是用 `<table>` 实现的：它们有自己的版式，不能按数据表格增删行列。 */
const LAYOUT_TABLE_CLASSES = ['pp-columns', 'pp-gallery'];

export interface TableCapabilities {
  rowCount: number;
  columnCount: number;
  /** 已有表头：`thead` 有行，或首行全是 `th`（旧内容常见写法）。 */
  hasHeader: boolean;
  /** 存在跨行 / 跨列单元格，结构操作不可用。 */
  hasMergedCells: boolean;
  align: CellAlign | null;
  canInsertRow: boolean;
  canInsertColumn: boolean;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
  canToggleHeader: boolean;
}

export interface TableContext {
  table: HTMLTableElement;
  cell: HTMLTableCellElement;
  capabilities: TableCapabilities;
}

/* ------------------------------ 基础查找 ------------------------------ */

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  // 1 = Node.ELEMENT_NODE；不写全局常量，方便在没有 Node 全局的环境里复用。
  if (node.nodeType === 1) return node as Element;
  return node.parentElement;
}

/** 光标所在的单元格；节点不在 td / th 里时返回 null。 */
export function findCell(node: Node | null): HTMLTableCellElement | null {
  const element = elementOf(node);
  const cell = element?.closest('td,th') ?? null;
  if (!cell) return null;
  const tag = cell.tagName;
  return tag === 'TD' || tag === 'TH' ? (cell as HTMLTableCellElement) : null;
}

/** 光标所在的表格（嵌套表格取最内层）；节点不在表格里时返回 null。 */
export function findTable(node: Node | null): HTMLTableElement | null {
  const element = elementOf(node);
  const table = element?.closest('table') ?? null;
  return table && table.tagName === 'TABLE' ? (table as HTMLTableElement) : null;
}

/** 分栏 / 图集这类「用表格排版」的区块不参与表格工具条。 */
export function isLayoutTable(table: HTMLTableElement | null): boolean {
  if (!table) return false;
  return LAYOUT_TABLE_CLASSES.some((name) => table.classList.contains(name));
}

function tableOf(cell: HTMLTableCellElement | null): HTMLTableElement | null {
  if (!cell) return null;
  return findTable(cell);
}

function rowOf(cell: HTMLTableCellElement): HTMLTableRowElement | null {
  const row = cell.parentElement;
  return row && row.tagName === 'TR' ? (row as HTMLTableRowElement) : null;
}

/** 直接子元素里指定标签的节点：不会把嵌套表格的行/格算进来。 */
function directChildren(parent: Element, tags: readonly string[]): HTMLElement[] {
  return Array.from(parent.children).filter((child) =>
    tags.includes(child.tagName),
  ) as HTMLElement[];
}

/** 容器直属的所有行（thead / tbody / table 都行，排除单元格中嵌套表格的行）。 */
function tableRows(container: Element): HTMLTableRowElement[] {
  const owner = container.tagName === 'TABLE' ? container : container.closest('table');
  return Array.from(container.querySelectorAll('tr')).filter(
    (row) => row.closest('table') === owner,
  ) as HTMLTableRowElement[];
}

function rowCells(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return directChildren(row, ['TD', 'TH']) as HTMLTableCellElement[];
}

function cellColumnIndex(cell: HTMLTableCellElement): number {
  const row = rowOf(cell);
  return row ? rowCells(row).indexOf(cell) : -1;
}

function sectionOf(table: HTMLTableElement, tag: 'THEAD' | 'TBODY'): HTMLElement | null {
  return directChildren(table, [tag])[0] ?? null;
}

/** 是否是合并单元格；嵌套表格里的合并与当前表格无关。 */
function hasMergedCells(table: HTMLTableElement): boolean {
  return tableRows(table).some((row) =>
    rowCells(row).some((cell) => cell.hasAttribute('colspan') || cell.hasAttribute('rowspan')),
  );
}

function columnCountOf(table: HTMLTableElement): number {
  return tableRows(table).reduce((max, row) => Math.max(max, rowCells(row).length), 0);
}

/** 表头行：优先 `thead`，否则把「首行全是 th」当作旧式表头。 */
function headerRowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  const thead = sectionOf(table, 'THEAD');
  if (thead) return tableRows(thead);
  const first = tableRows(table)[0];
  if (!first) return [];
  const cells = rowCells(first);
  return cells.length > 0 && cells.every((cell) => cell.tagName === 'TH') ? [first] : [];
}

function cellAlignOf(cell: HTMLTableCellElement): CellAlign | null {
  for (const align of ALIGN_VALUES) {
    if (cell.classList.contains(`pp-align-${align}`)) return align;
  }
  return null;
}

/* ------------------------------ 结构修改 ------------------------------ */

/** 新建空单元格。放一个 `<br />`：空 td 在很多浏览器里点不进去，光标无处落。 */
function blankCell(tag: 'td' | 'th'): HTMLTableCellElement {
  const cell = document.createElement(tag) as HTMLTableCellElement;
  cell.appendChild(document.createElement('br'));
  return cell;
}

/** 新行沿用当前行的单元格类型：表头行插 th，正文行插 td。 */
function cellTagForRow(row: HTMLTableRowElement): 'td' | 'th' {
  if (row.parentElement?.tagName === 'THEAD') return 'th';
  const first = rowCells(row)[0];
  return first?.tagName === 'TH' ? 'th' : 'td';
}

/**
 * 取（必要时创建）tbody。
 *
 * 直接挂在 `<table>` 下的 `tr` 在浏览器解析时通常会被塞进 tbody，但粘贴/导入的 HTML
 * 也可能先于解析出现，一并搬进去，后续插入才有稳定的父节点。
 */
function ensureTbody(table: HTMLTableElement): HTMLElement {
  const existing = sectionOf(table, 'TBODY');
  if (existing) return existing;
  const tbody = document.createElement('tbody');
  for (const row of directChildren(table, ['TR'])) tbody.appendChild(row);
  table.appendChild(tbody);
  return tbody;
}

function insertRow(cell: HTMLTableCellElement | null, where: 'above' | 'below'): HTMLTableCellElement | null {
  if (!cell) return null;
  const table = tableOf(cell);
  const row = rowOf(cell);
  if (!table || !row || row.closest('table') !== table) return null;
  if (hasMergedCells(table)) return null;
  const cells = rowCells(row);
  if (!cells.length) return null;
  const parent = row.parentElement;
  if (!parent) return null;

  if (where === 'above') {
    const newRow = document.createElement('tr');
    const tag = cellTagForRow(row);
    for (let index = 0; index < cells.length; index += 1) newRow.appendChild(blankCell(tag));
    parent.insertBefore(newRow, row);
    return cell;
  }

  // 表头最后一行下方插的是正文行：只有表头没有正文的表格，插行才真正有用。
  const isHeadRow = parent.tagName === 'THEAD';
  if (isHeadRow) {
    const headRows = tableRows(table).filter((candidate) => candidate.parentElement?.tagName === 'THEAD');
    if (headRows[headRows.length - 1] === row) {
      const tbody = ensureTbody(table);
      const bodyRow = document.createElement('tr');
      for (let index = 0; index < cells.length; index += 1) bodyRow.appendChild(blankCell('td'));
      tbody.insertBefore(bodyRow, tbody.firstChild);
      return cell;
    }
  }

  const newRow = document.createElement('tr');
  const tag = cellTagForRow(row);
  for (let index = 0; index < cells.length; index += 1) newRow.appendChild(blankCell(tag));
  parent.insertBefore(newRow, row.nextSibling);
  return cell;
}

function insertColumn(
  cell: HTMLTableCellElement | null,
  where: 'left' | 'right',
): HTMLTableCellElement | null {
  if (!cell) return null;
  const table = tableOf(cell);
  const row = rowOf(cell);
  if (!table || !row) return null;
  if (hasMergedCells(table)) return null;
  const rows = tableRows(table);
  if (!rows.length) return null;
  const index = cellColumnIndex(cell);
  if (index < 0 || columnCountOf(table) === 0) return null;
  const insertAt = where === 'left' ? index : index + 1;

  for (const targetRow of rows) {
    const cells = rowCells(targetRow);
    // 表头（及旧式首行 th）插 th，其余正文行插 td，和已有列保持一致。
    const tag: 'td' | 'th' =
      targetRow.parentElement?.tagName === 'THEAD' || cells[0]?.tagName === 'TH' ? 'th' : 'td';
    targetRow.insertBefore(blankCell(tag), cells[insertAt] ?? null);
  }
  return cell;
}

function removeEmptySections(table: HTMLTableElement): void {
  for (const tag of ['THEAD', 'TBODY'] as const) {
    for (const section of directChildren(table, [tag])) {
      if (!directChildren(section, ['TR']).length) section.remove();
    }
  }
}

function deleteRow(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  if (!cell) return null;
  const table = tableOf(cell);
  const row = rowOf(cell);
  if (!table || !row) return null;
  if (hasMergedCells(table)) return null;
  const rows = tableRows(table);
  if (rows.length <= 1) return null; // 最后一行用「删除表格」，不能留下空表
  const rowIndex = rows.indexOf(row);
  if (rowIndex < 0) return null;
  const columnIndex = Math.max(0, cellColumnIndex(cell));

  row.remove();
  removeEmptySections(table);

  const remaining = tableRows(table);
  if (!remaining.length) return null;
  const targetRow = remaining[Math.min(rowIndex, remaining.length - 1)];
  const targetCells = rowCells(targetRow);
  return targetCells[Math.min(columnIndex, targetCells.length - 1)] ?? targetCells[0] ?? null;
}

function deleteColumn(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  if (!cell) return null;
  const table = tableOf(cell);
  const row = rowOf(cell);
  if (!table || !row) return null;
  if (hasMergedCells(table)) return null;
  if (columnCountOf(table) <= 1) return null; // 最后一列同上
  const index = cellColumnIndex(cell);
  if (index < 0) return null;

  const rows = tableRows(table);
  for (const targetRow of rows) {
    rowCells(targetRow)[index]?.remove();
  }

  const targetCells = rowCells(row);
  if (targetCells.length) return targetCells[Math.min(index, targetCells.length - 1)] ?? null;
  const fallback = rows.flatMap((targetRow) => rowCells(targetRow))[0];
  return fallback ?? null;
}

/** 用新标签重建一个单元格，保留原有属性（对齐 class 等）与子节点；返回新节点。 */
function convertCellTag(cell: HTMLTableCellElement, tag: 'td' | 'th'): HTMLTableCellElement {
  const next = document.createElement(tag) as HTMLTableCellElement;
  for (const attribute of Array.from(cell.attributes)) {
    next.setAttribute(attribute.name, attribute.value);
  }
  while (cell.firstChild) next.appendChild(cell.firstChild);
  cell.replaceWith(next);
  return next;
}

function convertRowCells(
  row: HTMLTableRowElement,
  tag: 'td' | 'th',
  replaced?: Map<HTMLTableCellElement, HTMLTableCellElement>,
): void {
  for (const cell of rowCells(row)) {
    const next = cell.tagName === tag.toUpperCase() ? cell : convertCellTag(cell, tag);
    replaced?.set(cell, next);
  }
}

function toggleHeaderRow(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  if (!cell) return null;
  const table = tableOf(cell);
  if (!table) return null;
  const rows = tableRows(table);
  if (!rows.length) return null;

  const headerRows = headerRowsOf(table);
  if (headerRows.length) {
    const thead = sectionOf(table, 'THEAD');
    const replaced = new Map<HTMLTableCellElement, HTMLTableCellElement>();
    if (thead) {
      // 取消表头：把 thead 的行按顺序挪进 tbody 顶部，并还原成 td。
      const tbody = ensureTbody(table);
      const anchor = tbody.firstChild;
      for (const headRow of headerRows) {
        tbody.insertBefore(headRow, anchor);
        convertRowCells(headRow, 'td', replaced);
      }
      thead.remove();
    } else {
      // 旧式表头（首行全是 th，没有 thead）：只把单元格还原成 td。
      convertRowCells(headerRows[0], 'td', replaced);
    }
    return replaced.get(cell) ?? (cell.isConnected ? cell : null);
  }

  // 设为表头：把首行移进 thead（已有空 thead 就复用），单元格换成 th。
  const firstRow = rows[0];
  let thead = sectionOf(table, 'THEAD');
  if (!thead) {
    thead = document.createElement('thead');
    table.insertBefore(thead, table.firstChild);
  }
  thead.appendChild(firstRow);
  const replaced = new Map<HTMLTableCellElement, HTMLTableCellElement>();
  convertRowCells(firstRow, 'th', replaced);
  return replaced.get(cell) ?? (cell.isConnected ? cell : null);
}

function alignCell(cell: HTMLTableCellElement | null, align: CellAlign): HTMLTableCellElement | null {
  if (!cell || !ALIGN_VALUES.includes(align)) return null;
  if (!tableOf(cell)) return null;
  for (const name of TABLE_ALIGN_CLASSES) cell.classList.remove(name);
  cell.classList.add(`pp-align-${align}`);
  return cell;
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 光标在表格里时返回表格、单元格与按钮可用状态；否则 null。 */
export function tableContextAt(node: Node | null): TableContext | null {
  const cell = findCell(node);
  if (!cell) return null;
  const table = tableOf(cell);
  if (!table) return null;
  const capabilities = tableCapabilities(table, cell);
  if (!capabilities) return null;
  return { table, cell, capabilities };
}

/** 表格当前的结构与按钮可用状态；空表、单元格不在表内时返回 null。 */
export function tableCapabilities(
  table: HTMLTableElement | null,
  cell: HTMLTableCellElement | null,
): TableCapabilities | null {
  if (!table || table.tagName !== 'TABLE' || !cell || !table.contains(cell)) return null;
  const rows = tableRows(table);
  const columnCount = columnCountOf(table);
  const merged = hasMergedCells(table);
  const currentRow = rowOf(cell);
  const currentCells = currentRow ? rowCells(currentRow) : [];
  const index = currentCells.indexOf(cell);

  return {
    rowCount: rows.length,
    columnCount,
    hasHeader: headerRowsOf(table).length > 0,
    hasMergedCells: merged,
    align: cellAlignOf(cell),
    canInsertRow: !merged && rows.length > 0 && currentCells.length > 0,
    canInsertColumn: !merged && columnCount > 0 && index >= 0,
    canDeleteRow: !merged && rows.length > 1,
    canDeleteColumn: !merged && columnCount > 1,
    canToggleHeader: rows.length > 0,
  };
}

/** 在当前单元格上方插入一行；光标留在原单元格。 */
export function insertRowAbove(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return insertRow(cell, 'above');
}

/** 在当前单元格下方插入一行；表头最后一行下方插入的是正文行。 */
export function insertRowBelow(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return insertRow(cell, 'below');
}

/** 在当前单元格左侧插入一列；光标留在原单元格。 */
export function insertColumnLeft(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return insertColumn(cell, 'left');
}

/** 在当前单元格右侧插入一列；光标留在原单元格。 */
export function insertColumnRight(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return insertColumn(cell, 'right');
}

/** 删除当前行；返回相邻行里同一列（或最近一格）的单元格。最后一行拒绝。 */
export function deleteCurrentRow(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return deleteRow(cell);
}

/** 删除当前列；返回同一行里相邻列的单元格。最后一列拒绝。 */
export function deleteCurrentColumn(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return deleteColumn(cell);
}

/** 切换表头：首行 td ↔ th，必要时包 / 拆 thead；返回重建后的当前单元格。 */
export function toggleHeader(cell: HTMLTableCellElement | null): HTMLTableCellElement | null {
  return toggleHeaderRow(cell);
}

/** 设置当前单元格对齐方式（只写 class，不写行内 style）。 */
export function setCellAlign(
  cell: HTMLTableCellElement | null,
  align: CellAlign,
): HTMLTableCellElement | null {
  return alignCell(cell, align);
}

/** 删除整张表格；表格已脱离文档（没有父节点）时返回 false。 */
export function deleteTable(table: HTMLTableElement | null): boolean {
  if (!table || table.tagName !== 'TABLE' || !table.parentNode) return false;
  table.remove();
  return true;
}
